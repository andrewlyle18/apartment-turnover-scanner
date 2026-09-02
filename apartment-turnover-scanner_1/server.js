const express = require('express');
const multer = require('multer');
const path = require('path');
const XLSX = require('xlsx');
const { pool, initSchema } = require('./db');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

app.use(express.json({ limit: '4mb' })); // frames are small (resized client-side) but leave headroom
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Projects ----------
app.get('/api/projects', async (req, res) => {
  const projectsResult = await pool.query('SELECT id, name, created_at FROM projects ORDER BY created_at DESC');
  const statsResult = await pool.query(`
    SELECT u.project_id,
           COUNT(DISTINCT u.id)::int AS total_units,
           COUNT(DISTINCT u.id) FILTER (
             WHERE i.id IS NOT NULL AND NOT EXISTS (
               SELECT 1 FROM items i2 WHERE i2.unit_id = u.id AND i2.status <> 'done'
             )
           )::int AS complete_units,
           COUNT(i.id)::int AS total_items,
           COUNT(i.id) FILTER (WHERE i.status = 'done')::int AS done_items
    FROM units u
    LEFT JOIN items i ON i.unit_id = u.id
    GROUP BY u.project_id
  `);
  const statsByProject = new Map(statsResult.rows.map((r) => [r.project_id, r]));

  const projects = projectsResult.rows.map((p) => {
    const s = statsByProject.get(p.id) || { total_units: 0, complete_units: 0, total_items: 0, done_items: 0 };
    return {
      id: p.id,
      name: p.name,
      createdAt: p.created_at,
      totalUnits: s.total_units,
      completeUnits: s.complete_units,
      totalItems: s.total_items,
      doneItems: s.done_items,
    };
  });

  res.json({ projects });
});

app.post('/api/projects', async (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'Project name is required' });
  const result = await pool.query('INSERT INTO projects (name) VALUES ($1) RETURNING id, name, created_at', [name]);
  res.json({ project: result.rows[0] });
});

app.get('/api/projects/:id', async (req, res) => {
  const result = await pool.query('SELECT id, name, created_at FROM projects WHERE id = $1', [req.params.id]);
  if (!result.rows.length) return res.status(404).json({ error: 'Project not found' });
  res.json({ project: result.rows[0] });
});

app.delete('/api/projects/:id', async (req, res) => {
  const result = await pool.query('DELETE FROM projects WHERE id = $1 RETURNING id', [req.params.id]);
  if (!result.rows.length) return res.status(404).json({ error: 'Project not found' });
  res.json({ ok: true });
});

// ---------- Import ----------
// Expects an .xlsx/.csv with the unit number in column A. The remaining
// columns are handled two ways:
//
//  1. Fixed-checklist template (what most turnover lists look like): row 1
//     is a header whose first cell reads like a label ("Unit", "Unit #",
//     "Unit Number") and the other header cells name the appliance types
//     (e.g. "Fridge", "Range", "Water Heater") that apply to EVERY unit.
//     A unit's cell under a given column only needs to be filled in when
//     that appliance should be EXCLUDED for that unit — write "N/A", "NA",
//     "N/a", or "-" there and that item is skipped for that unit.
//  2. No recognizable header: each row simply lists, in the columns after
//     the unit number, the appliances present in THAT unit (free-form,
//     can differ per row).
app.post('/api/import', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const projectId = req.body && req.body.projectId ? parseInt(req.body.projectId, 10) : null;
  const projectName = req.body && req.body.projectName ? String(req.body.projectName).trim() : '';

  if (!projectId && !projectName) {
    return res.status(400).json({ error: 'Provide a projectId to replace an existing project, or a projectName to create a new one.' });
  }

  let workbook;
  try {
    workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
  } catch (e) {
    return res.status(400).json({ error: 'Could not read file. Please upload a valid .xlsx or .csv.' });
  }

  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });

  if (!rows.length) return res.status(400).json({ error: 'The file appears to be empty.' });

  const NOT_APPLICABLE = new Set(['n/a', 'na', '-', 'none', 'x']);

  let dataRows = rows;
  let checklistColumns = null; // when set, these column headers apply to every unit
  const firstCell = String(rows[0][0] || '').trim().toLowerCase();
  if (['unit', 'unit #', 'unit number', 'unit no', 'unit no.'].includes(firstCell)) {
    checklistColumns = rows[0].slice(1).map((c) => String(c || '').trim()).filter(Boolean);
    dataRows = rows.slice(1);
  }

  const parsedUnits = dataRows
    .map((row) => {
      const unitNumber = String(row[0] || '').trim();
      let items;
      if (checklistColumns && checklistColumns.length) {
        // Fixed checklist: include every header column unless this unit's
        // cell explicitly marks it not-applicable.
        items = checklistColumns.filter((name, idx) => {
          const cell = String(row[idx + 1] || '').trim().toLowerCase();
          return !NOT_APPLICABLE.has(cell);
        });
      } else {
        // Free-form: whatever's written in each cell is an item name.
        items = row
          .slice(1)
          .map((c) => String(c || '').trim())
          .filter(Boolean);
      }
      return { unitNumber, items };
    })
    .filter((u) => u.unitNumber);

  if (!parsedUnits.length) {
    return res.status(400).json({ error: 'No unit rows found. Column A should contain the unit number.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let finalProjectId = projectId;
    if (finalProjectId) {
      const existing = await client.query('SELECT id FROM projects WHERE id = $1', [finalProjectId]);
      if (!existing.rows.length) throw Object.assign(new Error('Project not found'), { httpStatus: 404 });
      // Replacing this project's unit list.
      await client.query('DELETE FROM units WHERE project_id = $1', [finalProjectId]);
    } else {
      const inserted = await client.query('INSERT INTO projects (name) VALUES ($1) RETURNING id', [projectName]);
      finalProjectId = inserted.rows[0].id;
    }

    for (let i = 0; i < parsedUnits.length; i++) {
      const { unitNumber, items } = parsedUnits[i];
      const unitResult = await client.query(
        'INSERT INTO units (project_id, unit_number, sort_order) VALUES ($1, $2, $3) RETURNING id',
        [finalProjectId, unitNumber, i]
      );
      const unitId = unitResult.rows[0].id;
      for (let j = 0; j < items.length; j++) {
        await client.query(
          'INSERT INTO items (unit_id, name, sort_order) VALUES ($1, $2, $3)',
          [unitId, items[j], j]
        );
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true, projectId: finalProjectId, unitsImported: parsedUnits.length });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.httpStatus === 404) return res.status(404).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: 'Import failed while saving to the database.' });
  } finally {
    client.release();
  }
});

// ---------- Units / dashboard (scoped to a project) ----------
app.get('/api/units', async (req, res) => {
  const projectId = req.query.projectId ? parseInt(req.query.projectId, 10) : null;
  if (!projectId) return res.status(400).json({ error: 'projectId query param is required' });

  const unitsResult = await pool.query(
    'SELECT id, unit_number FROM units WHERE project_id = $1 ORDER BY sort_order ASC',
    [projectId]
  );
  const itemsResult = await pool.query(
    `SELECT i.id, i.unit_id, i.name, i.model, i.serial, i.status, i.scanned_by, i.scanned_at
     FROM items i JOIN units u ON u.id = i.unit_id
     WHERE u.project_id = $1
     ORDER BY i.unit_id, i.sort_order`,
    [projectId]
  );

  const itemsByUnit = new Map();
  for (const item of itemsResult.rows) {
    if (!itemsByUnit.has(item.unit_id)) itemsByUnit.set(item.unit_id, []);
    itemsByUnit.get(item.unit_id).push(item);
  }

  const units = unitsResult.rows.map((u) => {
    const items = itemsByUnit.get(u.id) || [];
    const done = items.length > 0 && items.every((i) => i.status === 'done');
    const inProgress = items.some((i) => i.status === 'done');
    return {
      id: u.id,
      unitNumber: u.unit_number,
      items,
      totalItems: items.length,
      doneItems: items.filter((i) => i.status === 'done').length,
      complete: done,
      inProgress: inProgress && !done,
    };
  });

  res.json({ units });
});

app.get('/api/units/:id', async (req, res) => {
  const unitResult = await pool.query('SELECT id, project_id, unit_number FROM units WHERE id = $1', [req.params.id]);
  if (!unitResult.rows.length) return res.status(404).json({ error: 'Unit not found' });
  const itemsResult = await pool.query(
    'SELECT id, name, model, serial, status, scanned_by, scanned_at FROM items WHERE unit_id = $1 ORDER BY sort_order',
    [req.params.id]
  );
  res.json({ unit: unitResult.rows[0], items: itemsResult.rows });
});

// ---------- Item updates (manual entry or confirmed OCR result) ----------
app.patch('/api/items/:id', async (req, res) => {
  const { model, serial, status, scannedBy } = req.body || {};
  const fields = [];
  const values = [];
  let idx = 1;

  if (model !== undefined) { fields.push(`model = $${idx++}`); values.push(model); }
  if (serial !== undefined) { fields.push(`serial = $${idx++}`); values.push(serial); }
  if (status !== undefined) { fields.push(`status = $${idx++}`); values.push(status); }
  if (scannedBy !== undefined) { fields.push(`scanned_by = $${idx++}`); values.push(scannedBy); }
  if (status === 'done') { fields.push(`scanned_at = now()`); }

  if (!fields.length) return res.status(400).json({ error: 'No fields to update' });

  values.push(req.params.id);
  const result = await pool.query(
    `UPDATE items SET ${fields.join(', ')} WHERE id = $${idx} RETURNING id, name, model, serial, status, scanned_by, scanned_at`,
    values
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Item not found' });
  res.json({ item: result.rows[0] });
});

// Note: OCR happens entirely on-device in the browser (Tesseract.js). The
// server never receives camera images — only the confirmed model/serial
// text, via the PATCH /api/items/:id route above.

// ---------- Export (scoped to a project) ----------
async function fetchExportRows(projectId) {
  const result = await pool.query(
    `
    SELECT u.unit_number, i.name, i.model, i.serial, i.status, i.scanned_by, i.scanned_at
    FROM units u
    JOIN items i ON i.unit_id = u.id
    WHERE u.project_id = $1
    ORDER BY u.sort_order, i.sort_order
  `,
    [projectId]
  );
  return result.rows;
}

app.get('/api/export.csv', async (req, res) => {
  const projectId = req.query.projectId ? parseInt(req.query.projectId, 10) : null;
  if (!projectId) return res.status(400).json({ error: 'projectId query param is required' });
  const rows = await fetchExportRows(projectId);
  const header = ['Unit', 'Item', 'Model', 'Serial', 'Status', 'Scanned By', 'Scanned At'];
  const csvEscape = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.map(csvEscape).join(',')];
  for (const r of rows) {
    lines.push(
      [r.unit_number, r.name, r.model, r.serial, r.status, r.scanned_by, r.scanned_at ? new Date(r.scanned_at).toISOString() : '']
        .map(csvEscape)
        .join(',')
    );
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="appliance-scan-export.csv"');
  res.send(lines.join('\n'));
});

app.get('/api/export.xlsx', async (req, res) => {
  const projectId = req.query.projectId ? parseInt(req.query.projectId, 10) : null;
  if (!projectId) return res.status(400).json({ error: 'projectId query param is required' });
  const rows = await fetchExportRows(projectId);
  const data = rows.map((r) => ({
    Unit: r.unit_number,
    Item: r.name,
    Model: r.model || '',
    Serial: r.serial || '',
    Status: r.status,
    'Scanned By': r.scanned_by || '',
    'Scanned At': r.scanned_at ? new Date(r.scanned_at).toISOString() : '',
  }));
  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Export');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="appliance-scan-export.xlsx"');
  res.send(buffer);
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;

initSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`Appliance scanner listening on :${PORT}`));
  })
  .catch((e) => {
    console.error('Failed to initialize schema', e);
    process.exit(1);
  });

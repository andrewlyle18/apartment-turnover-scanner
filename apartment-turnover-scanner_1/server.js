const express = require('express');
const multer = require('multer');
const path = require('path');
const XLSX = require('xlsx');
const { pool, initSchema } = require('./db');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

app.use(express.json({ limit: '4mb' })); // frames are small (resized client-side) but leave headroom
// Serve the app shell with revalidation rather than plain caching: phones in
// the field kept running a stale app.js after a deploy, which made fixes look
// like they hadn't shipped. etag is on by default, so a revalidated file that
// hasn't changed still costs only a 304.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (/\.(html|js|css)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// ---------- Projects ----------
async function loadProjectsWithStats(whereClause) {
  const projectsResult = await pool.query(
    `SELECT id, name, created_at, trashed_at FROM projects WHERE ${whereClause} ORDER BY COALESCE(trashed_at, created_at) DESC`
  );
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

  return projectsResult.rows.map((p) => {
    const s = statsByProject.get(p.id) || { total_units: 0, complete_units: 0, total_items: 0, done_items: 0 };
    return {
      id: p.id,
      name: p.name,
      createdAt: p.created_at,
      trashedAt: p.trashed_at,
      totalUnits: s.total_units,
      completeUnits: s.complete_units,
      totalItems: s.total_items,
      doneItems: s.done_items,
    };
  });
}

app.get('/api/projects', async (req, res) => {
  const projects = await loadProjectsWithStats('trashed_at IS NULL');
  res.json({ projects });
});

// Trashed projects — "moved to trash" but not permanently deleted, so they
// can be restored later. Must be declared before /api/projects/:id so
// "trash" isn't matched as an :id.
app.get('/api/projects/trash', async (req, res) => {
  const projects = await loadProjectsWithStats('trashed_at IS NOT NULL');
  res.json({ projects });
});

app.post('/api/projects', async (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'Project name is required' });
  const result = await pool.query('INSERT INTO projects (name) VALUES ($1) RETURNING id, name, created_at', [name]);
  res.json({ project: result.rows[0] });
});

app.get('/api/projects/:id', async (req, res) => {
  const result = await pool.query('SELECT id, name, created_at, trashed_at FROM projects WHERE id = $1', [req.params.id]);
  if (!result.rows.length) return res.status(404).json({ error: 'Project not found' });
  res.json({ project: result.rows[0] });
});

app.patch('/api/projects/:id', async (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'Project name is required' });
  const result = await pool.query(
    'UPDATE projects SET name = $1 WHERE id = $2 RETURNING id, name, created_at',
    [name, req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Project not found' });
  res.json({ project: result.rows[0] });
});

// Moves a project to the trash (soft delete) rather than deleting it —
// it stays fully intact and can be restored from /api/projects/trash.
app.delete('/api/projects/:id', async (req, res) => {
  const result = await pool.query(
    'UPDATE projects SET trashed_at = now() WHERE id = $1 AND trashed_at IS NULL RETURNING id',
    [req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Project not found' });
  res.json({ ok: true });
});

app.post('/api/projects/:id/restore', async (req, res) => {
  const result = await pool.query(
    'UPDATE projects SET trashed_at = NULL WHERE id = $1 AND trashed_at IS NOT NULL RETURNING id, name, created_at',
    [req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Project not found in trash' });
  res.json({ project: result.rows[0] });
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
    SELECT u.unit_number, u.sort_order AS unit_sort, i.name, i.sort_order AS item_sort,
           i.model, i.serial, i.status, i.scanned_by, i.scanned_at
    FROM units u
    JOIN items i ON i.unit_id = u.id
    WHERE u.project_id = $1
    ORDER BY u.sort_order, i.sort_order
  `,
    [projectId]
  );
  return result.rows;
}

// A unit number encodes its location: the first digit is the building and
// the second is the floor, so 1202 is building 1, floor 2. Units that don't
// follow the pattern are kept rather than dropped — they group under a
// separate heading so nothing silently vanishes from an export.
function buildingOf(unitNumber) {
  const m = String(unitNumber || '').trim().match(/^(\d)(\d)?/);
  return m ? m[1] : null;
}

// Shapes scan results into the Appliance List layout: one column per
// appliance, and two rows per unit — model numbers on the first, serials on
// the second, exactly as the crew's existing sheets are laid out.
function applianceTable(rows) {
  // Column order follows the imported checklist order, not first-seen order,
  // so every building's sheet has the same columns in the same places.
  const columnOrder = new Map();
  for (const r of rows) {
    const seen = columnOrder.get(r.name);
    if (seen === undefined || r.item_sort < seen) columnOrder.set(r.name, r.item_sort);
  }
  const columns = [...columnOrder.entries()].sort((a, b) => a[1] - b[1]).map((e) => e[0]);

  const units = new Map();
  for (const r of rows) {
    if (!units.has(r.unit_number)) units.set(r.unit_number, { sort: r.unit_sort, items: new Map() });
    units.get(r.unit_number).items.set(r.name, { model: r.model || '', serial: r.serial || '' });
  }

  const ordered = [...units.entries()].sort((a, b) => a[1].sort - b[1].sort);
  const aoa = [['UNIT', '', ...columns]];
  for (const [unitNumber, unit] of ordered) {
    const cell = (name, field) => (unit.items.get(name) || {})[field] || '';
    aoa.push([unitNumber, 'Model #', ...columns.map((c) => cell(c, 'model'))]);
    aoa.push(['', 'Serial #', ...columns.map((c) => cell(c, 'serial'))]);
  }
  return aoa;
}

function groupByBuilding(rows) {
  const buildings = new Map();
  for (const r of rows) {
    const key = buildingOf(r.unit_number) || 'Other';
    if (!buildings.has(key)) buildings.set(key, []);
    buildings.get(key).push(r);
  }
  return [...buildings.entries()].sort((a, b) => {
    if (a[0] === 'Other') return 1;
    if (b[0] === 'Other') return -1;
    return Number(a[0]) - Number(b[0]);
  });
}

app.get('/api/export.csv', async (req, res) => {
  const projectId = req.query.projectId ? parseInt(req.query.projectId, 10) : null;
  if (!projectId) return res.status(400).json({ error: 'projectId query param is required' });
  const rows = await fetchExportRows(projectId);

  const csvEscape = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [];
  for (const [building, buildingRows] of groupByBuilding(rows)) {
    lines.push(csvEscape(building === 'Other' ? 'OTHER UNITS' : `BLDG. ${building}`));
    for (const row of applianceTable(buildingRows)) lines.push(row.map(csvEscape).join(','));
    lines.push('');
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="appliance-list.csv"');
  res.send(lines.join('\n'));
});

app.get('/api/export.xlsx', async (req, res) => {
  const projectId = req.query.projectId ? parseInt(req.query.projectId, 10) : null;
  if (!projectId) return res.status(400).json({ error: 'projectId query param is required' });
  const rows = await fetchExportRows(projectId);

  const workbook = XLSX.utils.book_new();
  const grouped = groupByBuilding(rows);

  if (!grouped.length) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['No scans yet']]), 'Appliance List');
  }

  for (const [building, buildingRows] of grouped) {
    const aoa = applianceTable(buildingRows);
    const sheet = XLSX.utils.aoa_to_sheet(aoa);

    // Column widths: the unit and label columns are narrow, the appliance
    // columns hold model and serial strings and need the room.
    sheet['!cols'] = aoa[0].map((_, i) => (i === 0 ? { wch: 9 } : i === 1 ? { wch: 9 } : { wch: 18 }));

    // Merge each unit's number across its model and serial rows, so the unit
    // reads as one block the way it does on the printed list.
    sheet['!merges'] = [];
    for (let r = 1; r < aoa.length; r += 2) {
      sheet['!merges'].push({ s: { r, c: 0 }, e: { r: r + 1, c: 0 } });
    }

    const title = building === 'Other' ? 'Other units' : `BLDG. ${building}`;
    XLSX.utils.book_append_sheet(workbook, sheet, title.replace(/[\\\/?*\[\]:]/g, '').slice(0, 31));
  }

  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="appliance-list.xlsx"');
  res.send(buffer);
});

// ---------------- Learned label patterns ----------------
//
// Nameplate layouts repeat: every A. O. Smith water heater in a complex
// prints its model the same way. Three things are learned from what the crew
// confirms, and all of them generalise across units:
//
//   shape    — "ENL-50 120" becomes "AAA-99 999"
//   context  — the label word the value followed ("modelnumber")
//   rejected — the shape of a value someone overwrote, never to be picked again
//
// Position on screen is deliberately NOT learned: it changes with how the
// phone is held. Position within the label's own text does not.
app.get('/api/patterns', async (req, res) => {
  const itemName = String(req.query.itemName || '').trim();
  const empty = () => ({
    model: { prefer: [], avoid: [], contexts: [] },
    serial: { prefer: [], avoid: [], contexts: [] },
  });
  if (!itemName) return res.json({ patterns: empty() });

  const result = await pool.query(
    `SELECT field, shape, rejected, context_label, weight
       FROM label_patterns
      WHERE lower(item_name) = lower($1)
      ORDER BY weight DESC, updated_at DESC
      LIMIT 60`,
    [itemName]
  );

  const patterns = empty();
  for (const row of result.rows) {
    const bucket = patterns[row.field];
    if (!bucket) continue;
    if (row.rejected) {
      if (!bucket.avoid.includes(row.shape)) bucket.avoid.push(row.shape);
    } else {
      if (!bucket.prefer.includes(row.shape)) bucket.prefer.push(row.shape);
      if (row.context_label && !bucket.contexts.includes(row.context_label)) bucket.contexts.push(row.context_label);
    }
  }
  // A shape both confirmed and rejected is ambiguous. Trust the confirmation,
  // otherwise the field could end up permanently unfillable.
  for (const field of ['model', 'serial']) {
    patterns[field].avoid = patterns[field].avoid.filter((sh) => !patterns[field].prefer.includes(sh));
  }
  res.json({ patterns });
});

app.post('/api/patterns', async (req, res) => {
  const { itemName, field, shape, sample, contextLabel, rejected, weight } = req.body || {};
  if (!itemName || !['model', 'serial'].includes(field) || !shape) {
    return res.status(400).json({ error: 'itemName, field (model|serial) and shape are required' });
  }
  await pool.query(
    `INSERT INTO label_patterns (item_name, field, shape, sample, context_label, rejected, weight)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (item_name, field, shape, rejected)
     DO UPDATE SET times_seen = label_patterns.times_seen + 1,
                   weight = label_patterns.weight + EXCLUDED.weight,
                   context_label = COALESCE(EXCLUDED.context_label, label_patterns.context_label),
                   sample = COALESCE(EXCLUDED.sample, label_patterns.sample),
                   updated_at = now()`,
    [String(itemName).trim(), field, String(shape), sample ? String(sample) : null,
     contextLabel ? String(contextLabel).slice(0, 40) : null, !!rejected, Number(weight) || 1]
  );
  res.json({ ok: true });
});

// What has been learned so far, so it can be reviewed and cleared rather than
// being an opaque process that quietly gets things wrong.
app.get('/api/patterns/summary', async (req, res) => {
  const result = await pool.query(
    `SELECT item_name, field, shape, sample, context_label, rejected, weight, times_seen
       FROM label_patterns ORDER BY item_name, field, rejected, weight DESC`
  );
  res.json({ patterns: result.rows });
});

app.delete('/api/patterns', async (req, res) => {
  const itemName = String(req.query.itemName || '').trim();
  if (itemName) await pool.query('DELETE FROM label_patterns WHERE lower(item_name) = lower($1)', [itemName]);
  else await pool.query('DELETE FROM label_patterns');
  res.json({ ok: true });
});

// ---------------- Cloud OCR (optional) ----------------
//
// Reading appliance nameplates with in-browser OCR tops out at a few seconds
// per scan and still misses plates that are plainly legible to a person. A
// cloud vision service reads them in a fraction of that, so the app uses one
// when a key is configured and silently falls back to on-device OCR when it
// isn't — no key, no behaviour change, nothing to break on site.
//
// Set exactly one of these in the Render dashboard:
//   GOOGLE_VISION_API_KEY  — best accuracy; 1,000 scans/month free
//   OCR_SPACE_API_KEY      — 25,000 scans/month free, no card required
const GOOGLE_VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY;
const OCR_SPACE_API_KEY = process.env.OCR_SPACE_API_KEY;

function ocrProvider() {
  if (GOOGLE_VISION_API_KEY) return 'google';
  if (OCR_SPACE_API_KEY) return 'ocrspace';
  return null;
}

app.get('/api/ocr/status', (req, res) => {
  res.json({ available: !!ocrProvider(), provider: ocrProvider() });
});

app.post('/api/ocr', upload.single('image'), async (req, res) => {
  const provider = ocrProvider();
  if (!provider) return res.status(503).json({ error: 'Cloud OCR is not configured' });
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

  const started = Date.now();
  try {
    const result = provider === 'google'
      ? await readWithGoogleVision(req.file.buffer)
      : await readWithOcrSpace(req.file.buffer);
    // `words` carries each recognised word's position, so the app can show
    // the user exactly where a value was read from.
    res.json({ text: result.text, words: result.words, provider, ms: Date.now() - started });
  } catch (e) {
    // The client falls back to on-device OCR on any failure, so a flaky
    // network or an exhausted quota degrades rather than blocks.
    res.status(502).json({ error: e.message, provider });
  }
});

async function readWithGoogleVision(buffer) {
  const resp = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${GOOGLE_VISION_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [{
        image: { content: buffer.toString('base64') },
        features: [{ type: 'TEXT_DETECTION' }],
      }],
    }),
  });
  const json = await resp.json();
  if (json.error) throw new Error(json.error.message || 'Vision API error');
  const result = (json.responses && json.responses[0]) || {};
  if (result.error) throw new Error(result.error.message || 'Vision API error');

  // The first annotation is the whole block; the rest are individual words.
  const words = (result.textAnnotations || []).slice(1).map((a) => {
    const xs = (a.boundingPoly.vertices || []).map((v) => v.x || 0);
    const ys = (a.boundingPoly.vertices || []).map((v) => v.y || 0);
    return {
      text: a.description,
      left: Math.min(...xs),
      top: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
  });
  return { text: (result.fullTextAnnotation && result.fullTextAnnotation.text) || '', words };
}

async function readWithOcrSpace(buffer) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'image/jpeg' }), 'label.jpg');
  form.append('apikey', OCR_SPACE_API_KEY);
  form.append('OCREngine', '2');
  form.append('scale', 'true');
  form.append('isOverlayRequired', 'true'); // per-word coordinates
  form.append('detectOrientation', 'true'); // sideways plates are common

  const resp = await fetch('https://api.ocr.space/parse/image', { method: 'POST', body: form });
  const json = await resp.json();
  if (json.IsErroredOnProcessing) {
    throw new Error([].concat(json.ErrorMessage || 'OCR service error').join(' '));
  }
  const parsed = (json.ParsedResults || [])[0] || {};
  const words = [];
  for (const line of (parsed.TextOverlay && parsed.TextOverlay.Lines) || []) {
    for (const w of line.Words || []) {
      words.push({ text: w.WordText, left: w.Left, top: w.Top, width: w.Width, height: w.Height });
    }
  }
  return { text: parsed.ParsedText || '', words };
}

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

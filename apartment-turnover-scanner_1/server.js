const express = require('express');
const multer = require('multer');
const path = require('path');
const XLSX = require('xlsx');
const { pool, initSchema } = require('./db');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

app.use(express.json({ limit: '4mb' })); // frames are small (resized client-side) but leave headroom
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Import ----------
// Expects an .xlsx/.csv where column A is the unit number and the remaining
// columns in that row list the appliances present in that unit (any number
// of columns, blanks allowed). No fixed header required, but a first row
// whose first cell reads like a label ("Unit", "Unit #", "Unit Number") is
// skipped automatically.
app.post('/api/import', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

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

  let dataRows = rows;
  const firstCell = String(rows[0][0] || '').trim().toLowerCase();
  if (['unit', 'unit #', 'unit number', 'unit no', 'unit no.'].includes(firstCell)) {
    dataRows = rows.slice(1);
  }

  const parsedUnits = dataRows
    .map((row) => {
      const unitNumber = String(row[0] || '').trim();
      const items = row
        .slice(1)
        .map((c) => String(c || '').trim())
        .filter(Boolean);
      return { unitNumber, items };
    })
    .filter((u) => u.unitNumber);

  if (!parsedUnits.length) {
    return res.status(400).json({ error: 'No unit rows found. Column A should contain the unit number.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Clear previous project data before loading the new one.
    await client.query('DELETE FROM units');

    for (let i = 0; i < parsedUnits.length; i++) {
      const { unitNumber, items } = parsedUnits[i];
      const unitResult = await client.query(
        'INSERT INTO units (unit_number, sort_order) VALUES ($1, $2) RETURNING id',
        [unitNumber, i]
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
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    return res.status(500).json({ error: 'Import failed while saving to the database.' });
  } finally {
    client.release();
  }

  res.json({ ok: true, unitsImported: parsedUnits.length });
});

// ---------- Units / dashboard ----------
app.get('/api/units', async (req, res) => {
  const unitsResult = await pool.query('SELECT id, unit_number FROM units ORDER BY sort_order ASC');
  const itemsResult = await pool.query(
    'SELECT id, unit_id, name, model, serial, status, scanned_by, scanned_at FROM items ORDER BY unit_id, sort_order'
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

  res.json({ units, hasProject: units.length > 0 });
});

app.get('/api/units/:id', async (req, res) => {
  const unitResult = await pool.query('SELECT id, unit_number FROM units WHERE id = $1', [req.params.id]);
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

// ---------- Export ----------
async function fetchExportRows() {
  const result = await pool.query(`
    SELECT u.unit_number, i.name, i.model, i.serial, i.status, i.scanned_by, i.scanned_at
    FROM units u
    JOIN items i ON i.unit_id = u.id
    ORDER BY u.sort_order, i.sort_order
  `);
  return result.rows;
}

app.get('/api/export.csv', async (req, res) => {
  const rows = await fetchExportRows();
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
  const rows = await fetchExportRows();
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

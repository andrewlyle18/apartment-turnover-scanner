const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

const pool = new Pool(
  connectionString
    ? {
        connectionString,
        ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
      }
    : {
        // Local fallback (no Postgres configured) — app will error clearly on first query.
        connectionString: 'postgres://localhost:5432/appliance_scanner',
      }
);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS units (
  id SERIAL PRIMARY KEY,
  unit_number TEXT UNIQUE NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS items (
  id SERIAL PRIMARY KEY,
  unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  serial TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  scanned_by TEXT,
  scanned_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_items_unit_id ON items(unit_id);
`;

async function initSchema() {
  await pool.query(SCHEMA);
}

module.exports = { pool, initSchema };

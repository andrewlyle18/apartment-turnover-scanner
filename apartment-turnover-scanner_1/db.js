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

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  trashed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS units (
  id SERIAL PRIMARY KEY,
  unit_number TEXT NOT NULL,
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

-- Shapes learned from corrections the crew makes. When someone fixes a
-- misread value, the SHAPE of the correct value is recorded against that
-- appliance type ("Water Heater" model looks like AAA-99 999). On a job of
-- 300 near-identical units the same plates recur constantly, so one
-- correction improves every remaining unit.
CREATE TABLE IF NOT EXISTS label_patterns (
  id SERIAL PRIMARY KEY,
  item_name TEXT NOT NULL,
  field TEXT NOT NULL,
  shape TEXT NOT NULL,
  sample TEXT,
  times_seen INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (item_name, field, shape)
);
`;

// Migrates a units table created before multi-project support existed:
// adds project_id, backfills a default project for any orphaned units,
// and swaps the old globally-unique unit_number for a per-project unique
// constraint. Safe to run repeatedly.
async function migrateToProjects(client) {
  await client.query(`ALTER TABLE units ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE;`);

  const orphaned = await client.query('SELECT COUNT(*)::int AS n FROM units WHERE project_id IS NULL');
  if (orphaned.rows[0].n > 0) {
    const existing = await client.query('SELECT id FROM projects ORDER BY id LIMIT 1');
    let defaultProjectId;
    if (existing.rows.length) {
      defaultProjectId = existing.rows[0].id;
    } else {
      const inserted = await client.query("INSERT INTO projects (name) VALUES ('Imported Project') RETURNING id");
      defaultProjectId = inserted.rows[0].id;
    }
    await client.query('UPDATE units SET project_id = $1 WHERE project_id IS NULL', [defaultProjectId]);
  }

  await client.query(`ALTER TABLE units ALTER COLUMN project_id SET NOT NULL;`);

  // Drop the old single-column unique constraint on unit_number, if present,
  // and replace it with a per-project uniqueness rule.
  await client.query(`
    DO $$
    DECLARE
      c RECORD;
    BEGIN
      FOR c IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'units'::regclass AND contype = 'u'
      LOOP
        EXECUTE 'ALTER TABLE units DROP CONSTRAINT ' || quote_ident(c.conname);
      END LOOP;
    END $$;
  `);
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'units_project_id_unit_number_key'
      ) THEN
        ALTER TABLE units ADD CONSTRAINT units_project_id_unit_number_key UNIQUE (project_id, unit_number);
      END IF;
    END $$;
  `);

  await client.query('CREATE INDEX IF NOT EXISTS idx_units_project_id ON units(project_id);');
}

// Adds soft-delete support to projects created before the trash feature
// existed. Safe to run repeatedly.
async function migrateTrash(client) {
  await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS trashed_at TIMESTAMPTZ;`);
}

// Adds the learned-shape table to databases created before it existed.
async function migrateLabelPatterns(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS label_patterns (
      id SERIAL PRIMARY KEY,
      item_name TEXT NOT NULL,
      field TEXT NOT NULL,
      shape TEXT NOT NULL,
      sample TEXT,
      times_seen INTEGER NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (item_name, field, shape)
    );
  `);
}

async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query(BASE_SCHEMA);
    await migrateToProjects(client);
    await migrateTrash(client);
    await migrateLabelPatterns(client);
  } finally {
    client.release();
  }
}

module.exports = { pool, initSchema };

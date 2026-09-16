const crypto = require('crypto');
const { pool } = require('./db');

// Subcontractor billing: commitments, schedules of values, change orders and
// pay applications.
//
// Money is held as NUMERIC(14,2) in Postgres and as integer cents in here.
// Nothing in this file adds or multiplies a floating-point dollar figure,
// because that is how a pay app ends up a penny out and nobody can say why.

const CONTRACTOR = {
  name: 'Precision Builders, LLC',
  address1: '730 N Dean Rd, Suite 200',
  address2: 'Auburn, Alabama 36830',
  surety: 'Liberty Mutual Insurance Company',
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS commitments (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number TEXT,
  title TEXT NOT NULL,
  sub_company TEXT NOT NULL,
  sub_address1 TEXT,
  sub_address2 TEXT,
  sub_email TEXT,
  contract_date DATE,
  retainage_pct NUMERIC(6,4) NOT NULL DEFAULT 0.10,
  materials_retainage_pct NUMERIC(6,4) NOT NULL DEFAULT 0,
  contractor_name TEXT NOT NULL DEFAULT '${CONTRACTOR.name}',
  contractor_address1 TEXT NOT NULL DEFAULT '${CONTRACTOR.address1}',
  contractor_address2 TEXT NOT NULL DEFAULT '${CONTRACTOR.address2}',
  surety TEXT NOT NULL DEFAULT '${CONTRACTOR.surety}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_commitments_project ON commitments(project_id);

CREATE TABLE IF NOT EXISTS change_orders (
  id SERIAL PRIMARY KEY,
  commitment_id INTEGER NOT NULL REFERENCES commitments(id) ON DELETE CASCADE,
  number TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  reason TEXT,
  location TEXT,
  amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  -- A change order only reaches the billing once it is approved.
  status TEXT NOT NULL DEFAULT 'pending',
  retainage_pct NUMERIC(6,4),
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ,
  approved_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_change_orders_commitment ON change_orders(commitment_id);

CREATE TABLE IF NOT EXISTS sov_lines (
  id SERIAL PRIMARY KEY,
  commitment_id INTEGER NOT NULL REFERENCES commitments(id) ON DELETE CASCADE,
  item_no TEXT,
  description TEXT NOT NULL,
  scheduled_value NUMERIC(14,2) NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  -- 'base' lines come from the subcontract; 'co' lines are created when a
  -- change order is approved, and print in their own block.
  source TEXT NOT NULL DEFAULT 'base',
  change_order_id INTEGER REFERENCES change_orders(id) ON DELETE CASCADE,
  -- Null means "use the commitment's rate". A zero here is a decision
  -- somebody made, not a cell they blanked.
  retainage_pct NUMERIC(6,4)
);

CREATE INDEX IF NOT EXISTS idx_sov_lines_commitment ON sov_lines(commitment_id);

CREATE TABLE IF NOT EXISTS pay_apps (
  id SERIAL PRIMARY KEY,
  commitment_id INTEGER NOT NULL REFERENCES commitments(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  invoice_no TEXT,
  period_start DATE,
  period_end DATE,
  application_date DATE,
  -- open -> submitted -> approved (or back to open when reopened)
  status TEXT NOT NULL DEFAULT 'open',
  token TEXT UNIQUE,
  token_expires TIMESTAMPTZ,
  signer_name TEXT,
  signer_title TEXT,
  submitted_at TIMESTAMPTZ,
  submitted_ip TEXT,
  approved_at TIMESTAMPTZ,
  approved_by TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (commitment_id, number)
);

CREATE INDEX IF NOT EXISTS idx_pay_apps_commitment ON pay_apps(commitment_id);

CREATE TABLE IF NOT EXISTS pay_app_lines (
  id SERIAL PRIMARY KEY,
  pay_app_id INTEGER NOT NULL REFERENCES pay_apps(id) ON DELETE CASCADE,
  sov_line_id INTEGER NOT NULL REFERENCES sov_lines(id) ON DELETE CASCADE,
  -- Snapshotted when the period opens, from the last approved application.
  -- Never typed by anyone.
  previous_completed NUMERIC(14,2) NOT NULL DEFAULT 0,
  this_period NUMERIC(14,2) NOT NULL DEFAULT 0,
  materials_stored NUMERIC(14,2) NOT NULL DEFAULT 0,
  -- What the sub actually sent, kept even after an admin adjusts the line, so
  -- there is never a question of whose number is on the page.
  submitted_this_period NUMERIC(14,2),
  submitted_materials_stored NUMERIC(14,2),
  edited_by TEXT,
  edited_at TIMESTAMPTZ,
  UNIQUE (pay_app_id, sov_line_id)
);

CREATE INDEX IF NOT EXISTS idx_pay_app_lines_app ON pay_app_lines(pay_app_id);
`;

async function initBilling() {
  await pool.query(SCHEMA);
}

// ---------- Money ----------
// Everything internal is integer cents.

const toCents = (value) => {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : parseFloat(String(value).replace(/[$,\s]/g, ''));
  if (!isFinite(n)) return 0;
  return Math.round(n * 100);
};

const toDollars = (cents) => Math.round(cents) / 100;

// Retainage is a rate times a dollar figure, so it rounds once, here, to the
// cent — the same way the spreadsheet's =G13*10% does.
const applyRate = (cents, rate) => Math.round(cents * Number(rate || 0));

/**
 * The whole arithmetic of one application, in one place. Both the screens and
 * the PDFs read this, so they can never disagree.
 */
function computePayApp({ commitment, lines, previousCertificatesCents }) {
  const defaultRate = Number(commitment.retainage_pct || 0);
  const materialsRate = Number(commitment.materials_retainage_pct || 0);

  const priced = lines.map((line) => {
    const scheduled = toCents(line.scheduled_value);
    const previous = toCents(line.previous_completed);
    const thisPeriod = toCents(line.this_period);
    const stored = toCents(line.materials_stored);
    const total = previous + thisPeriod + stored;
    const rate = line.retainage_pct === null || line.retainage_pct === undefined
      ? defaultRate
      : Number(line.retainage_pct);

    return {
      id: line.id,
      sovLineId: line.sov_line_id,
      itemNo: line.item_no,
      description: line.description,
      source: line.source,
      changeOrderId: line.change_order_id,
      scheduledValue: toDollars(scheduled),
      previousCompleted: toDollars(previous),
      thisPeriod: toDollars(thisPeriod),
      materialsStored: toDollars(stored),
      totalCompleted: toDollars(total),
      percent: scheduled === 0 ? 0 : total / scheduled,
      balanceToFinish: toDollars(scheduled - total),
      retainage: toDollars(applyRate(total, rate)),
      retainagePct: rate,
      submittedThisPeriod: line.submitted_this_period === null || line.submitted_this_period === undefined
        ? null : toDollars(toCents(line.submitted_this_period)),
      edited: line.submitted_this_period !== null && line.submitted_this_period !== undefined
        && toCents(line.submitted_this_period) !== thisPeriod,
      _cents: { scheduled, previous, thisPeriod, stored, total, retainage: applyRate(total, rate) },
    };
  });

  const sum = (rows, pick) => rows.reduce((acc, r) => acc + pick(r._cents), 0);

  // Retainage is worked out on the TOTAL at each rate and rounded once, not
  // rounded per line and added up. A pay app with 67 lines differs by a cent
  // or two between those two methods, and the total is the figure the cheque
  // is written from — so the total is what has to be right.
  const retainageOf = (rows, pick, rateOf) => {
    const byRate = new Map();
    for (const row of rows) {
      const rate = rateOf(row);
      byRate.set(rate, (byRate.get(rate) || 0) + pick(row._cents));
    }
    let total = 0;
    for (const [rate, cents] of byRate) total += applyRate(cents, rate);
    return total;
  };
  const blockOf = (rows) => ({
    scheduledValue: toDollars(sum(rows, (c) => c.scheduled)),
    previousCompleted: toDollars(sum(rows, (c) => c.previous)),
    thisPeriod: toDollars(sum(rows, (c) => c.thisPeriod)),
    materialsStored: toDollars(sum(rows, (c) => c.stored)),
    totalCompleted: toDollars(sum(rows, (c) => c.total)),
    percent: sum(rows, (c) => c.scheduled) === 0 ? 0 : sum(rows, (c) => c.total) / sum(rows, (c) => c.scheduled),
    balanceToFinish: toDollars(sum(rows, (c) => c.scheduled) - sum(rows, (c) => c.total)),
    retainage: toDollars(
      retainageOf(rows, (c) => c.previous + c.thisPeriod, (r) => r.retainagePct)
      + retainageOf(rows, (c) => c.stored, () => materialsRate)
    ),
  });

  const baseRows = priced.filter((r) => r.source !== 'co');
  const coRows = priced.filter((r) => r.source === 'co');

  const originalContract = sum(baseRows, (c) => c.scheduled);
  const netChanges = sum(coRows, (c) => c.scheduled);
  const contractToDate = originalContract + netChanges;
  const completedAndStored = sum(priced, (c) => c.total);
  const retainageOnWork = retainageOf(priced, (c) => c.previous + c.thisPeriod, (r) => r.retainagePct);
  const retainageOnStored = retainageOf(priced, (c) => c.stored, () => materialsRate);
  const totalRetainage = retainageOnWork + retainageOnStored;
  const earnedLessRetainage = completedAndStored - totalRetainage;
  const currentDue = earnedLessRetainage - previousCertificatesCents;

  return {
    lines: priced.map(({ _cents, ...rest }) => rest),
    base: blockOf(baseRows),
    changeOrders: blockOf(coRows),
    grand: blockOf(priced),
    summary: {
      originalContractSum: toDollars(originalContract),
      netChangeByChangeOrders: toDollars(netChanges),
      contractSumToDate: toDollars(contractToDate),
      totalCompletedAndStored: toDollars(completedAndStored),
      retainageOnCompletedWork: toDollars(retainageOnWork),
      retainageOnStoredMaterial: toDollars(retainageOnStored),
      totalRetainage: toDollars(totalRetainage),
      totalEarnedLessRetainage: toDollars(earnedLessRetainage),
      previousCertificates: toDollars(previousCertificatesCents),
      currentPaymentDue: toDollars(currentDue),
      balanceToFinishIncludingRetainage: toDollars(contractToDate - earnedLessRetainage),
    },
  };
}

// "Less previous certificates" is line 6 of the last APPROVED application on
// this commitment — looked up, never typed.
async function previousCertificatesFor(commitmentId, beforeNumber) {
  const prior = await pool.query(
    `SELECT id, number FROM pay_apps
     WHERE commitment_id = $1 AND number < $2 AND status = 'approved'
     ORDER BY number DESC LIMIT 1`,
    [commitmentId, beforeNumber]
  );
  if (!prior.rows.length) return 0;
  const { commitment, lines } = await loadApplication(prior.rows[0].id);
  const earlier = await previousCertificatesFor(commitmentId, prior.rows[0].number);
  const computed = computePayApp({ commitment, lines, previousCertificatesCents: earlier });
  return toCents(computed.summary.totalEarnedLessRetainage);
}

async function loadApplication(payAppId) {
  const appRow = await pool.query('SELECT * FROM pay_apps WHERE id = $1', [payAppId]);
  if (!appRow.rows.length) return null;
  const payApp = appRow.rows[0];
  const commitmentRow = await pool.query('SELECT * FROM commitments WHERE id = $1', [payApp.commitment_id]);
  const lines = await pool.query(
    `SELECT l.*, s.item_no, s.description, s.scheduled_value, s.source, s.change_order_id,
            s.sort_order, s.retainage_pct
     FROM pay_app_lines l
     JOIN sov_lines s ON s.id = l.sov_line_id
     WHERE l.pay_app_id = $1
     ORDER BY s.source, s.sort_order, s.id`,
    [payAppId]
  );
  return { payApp, commitment: commitmentRow.rows[0], lines: lines.rows };
}

/** Everything a screen or a PDF needs about one application. */
async function applicationView(payAppId) {
  const loaded = await loadApplication(payAppId);
  if (!loaded) return null;
  const { payApp, commitment, lines } = loaded;
  const previous = await previousCertificatesFor(commitment.id, payApp.number);
  const computed = computePayApp({ commitment, lines, previousCertificatesCents: previous });
  return { payApp, commitment, ...computed };
}

const newToken = () => crypto.randomBytes(24).toString('hex');

module.exports = {
  initBilling,
  computePayApp,
  applicationView,
  loadApplication,
  previousCertificatesFor,
  newToken,
  toCents,
  toDollars,
  CONTRACTOR,
};

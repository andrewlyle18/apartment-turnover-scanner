const { pool } = require('./db');
const { buildChangeOrderPdf } = require('./change-order-pdf');
const { buildApplicationPdf, buildWaiverPdf } = require('./payapp-pdf');
const {
  applicationView,
  changeOrderContext,
  previousCertificatesFor,
  computePayApp,
  loadApplication,
  newToken,
  toCents,
} = require('./billing');

// Admin-only, except the token routes at the bottom, which are what a
// subcontractor opens from a link with no account at all.

const trim = (v) => String(v === undefined || v === null ? '' : v).trim();
const numberOrNull = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

function mountBillingRoutes(app, { adminOnly, upload }) {
  // ---------- Commitments ----------

  app.get('/api/commitments', adminOnly, async (req, res) => {
    const projectId = parseInt(req.query.projectId, 10);
    if (!projectId) return res.status(400).json({ error: 'projectId is required' });

    const commitments = await pool.query(
      `SELECT c.*,
              COALESCE(base.total, 0) AS base_total,
              COALESCE(co.total, 0) AS co_total,
              COALESCE(apps.n, 0) AS pay_app_count
       FROM commitments c
       LEFT JOIN (
         SELECT commitment_id, SUM(scheduled_value) AS total
         FROM sov_lines WHERE source = 'base' GROUP BY commitment_id
       ) base ON base.commitment_id = c.id
       LEFT JOIN (
         SELECT commitment_id, SUM(scheduled_value) AS total
         FROM sov_lines WHERE source = 'co' GROUP BY commitment_id
       ) co ON co.commitment_id = c.id
       LEFT JOIN (
         SELECT commitment_id, COUNT(*)::int AS n FROM pay_apps GROUP BY commitment_id
       ) apps ON apps.commitment_id = c.id
       WHERE c.project_id = $1 AND c.archived_at IS NULL
       ORDER BY c.sub_company, c.id`,
      [projectId]
    );
    res.json({ commitments: commitments.rows });
  });

  app.post('/api/commitments', adminOnly, async (req, res) => {
    const b = req.body || {};
    const projectId = parseInt(b.projectId, 10);
    if (!projectId) return res.status(400).json({ error: 'projectId is required' });
    if (!trim(b.subCompany)) return res.status(400).json({ error: "The subcontractor's company name is required" });

    const result = await pool.query(
      `INSERT INTO commitments
        (project_id, number, title, sub_company, sub_address1, sub_address2, sub_email,
         contract_date, retainage_pct, materials_retainage_pct)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        projectId,
        trim(b.number) || null,
        trim(b.title) || 'Subcontract',
        trim(b.subCompany),
        trim(b.subAddress1) || null,
        trim(b.subAddress2) || null,
        trim(b.subEmail) || null,
        b.contractDate || null,
        b.retainagePct === undefined ? 0.10 : Number(b.retainagePct),
        b.materialsRetainagePct === undefined ? 0 : Number(b.materialsRetainagePct),
      ]
    );
    res.json({ commitment: result.rows[0] });
  });

  app.get('/api/commitments/:id', adminOnly, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const commitment = await pool.query('SELECT * FROM commitments WHERE id = $1', [id]);
    if (!commitment.rows.length) return res.status(404).json({ error: 'Commitment not found' });

    const sov = await pool.query(
      `SELECT * FROM sov_lines WHERE commitment_id = $1 ORDER BY source, sort_order, id`, [id]
    );
    const changeOrders = await pool.query(
      `SELECT * FROM change_orders WHERE commitment_id = $1 ORDER BY id`, [id]
    );
    const payApps = await pool.query(
      `SELECT id, number, invoice_no, period_start, period_end, status, submitted_at,
              approved_at, (token IS NOT NULL) AS has_link, token_expires
       FROM pay_apps WHERE commitment_id = $1 ORDER BY number DESC`, [id]
    );
    res.json({
      commitment: commitment.rows[0],
      sovLines: sov.rows,
      changeOrders: changeOrders.rows,
      payApps: payApps.rows,
    });
  });

  app.patch('/api/commitments/:id', adminOnly, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const fields = [];
    const values = [];
    let i = 1;
    const set = (column, value) => { fields.push(`${column} = $${i++}`); values.push(value); };

    if (b.number !== undefined) set('number', trim(b.number) || null);
    if (b.title !== undefined) set('title', trim(b.title));
    if (b.subCompany !== undefined) set('sub_company', trim(b.subCompany));
    if (b.subAddress1 !== undefined) set('sub_address1', trim(b.subAddress1) || null);
    if (b.subAddress2 !== undefined) set('sub_address2', trim(b.subAddress2) || null);
    if (b.subEmail !== undefined) set('sub_email', trim(b.subEmail) || null);
    if (b.contractDate !== undefined) set('contract_date', b.contractDate || null);
    if (b.retainagePct !== undefined) set('retainage_pct', Number(b.retainagePct));
    if (b.materialsRetainagePct !== undefined) set('materials_retainage_pct', Number(b.materialsRetainagePct));
    if (b.archived !== undefined) set('archived_at', b.archived ? new Date() : null);
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });

    values.push(id);
    const result = await pool.query(
      `UPDATE commitments SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`, values
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Commitment not found' });
    res.json({ commitment: result.rows[0] });
  });

  // Deleting a commitment takes its schedule of values, change orders and
  // applications with it. Refused once an application has been approved:
  // that is a payment certified, and it stays on the record.
  app.delete('/api/commitments/:id', adminOnly, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const existing = await pool.query('SELECT sub_company FROM commitments WHERE id = $1', [id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Commitment not found' });

    // The name has to be typed out, so this can't happen by accident.
    const confirmName = trim(req.body && req.body.confirmName);
    if (confirmName.toLowerCase() !== trim(existing.rows[0].sub_company).toLowerCase()) {
      return res.status(400).json({ error: "That name doesn't match the subcontractor on this commitment." });
    }

    const approved = await pool.query(
      `SELECT COUNT(*)::int AS n FROM pay_apps WHERE commitment_id = $1 AND status = 'approved'`, [id]
    );
    if (approved.rows[0].n > 0) {
      return res.status(409).json({
        error: `This commitment has ${approved.rows[0].n} approved pay application${approved.rows[0].n === 1 ? '' : 's'} and can't be deleted. Archive it instead — it disappears from the list and keeps the record.`,
        canArchive: true,
      });
    }

    await pool.query('DELETE FROM commitments WHERE id = $1', [id]);
    res.json({ ok: true, deleted: existing.rows[0].sub_company });
  });

  // ---------- Schedule of values ----------
  // Replaces the base schedule wholesale. Change-order lines are left alone,
  // and a line that is already billed on an open or approved application
  // cannot be pulled out from under it.

  app.put('/api/commitments/:id/sov', adminOnly, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const rows = Array.isArray(req.body && req.body.lines) ? req.body.lines : null;
    if (!rows) return res.status(400).json({ error: 'lines are required' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const billed = await client.query(
        `SELECT COUNT(*)::int AS n
         FROM pay_app_lines l
         JOIN sov_lines s ON s.id = l.sov_line_id
         WHERE s.commitment_id = $1 AND s.source = 'base'`,
        [id]
      );
      if (billed.rows[0].n > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'This schedule of values is already being billed. Add a change order instead of replacing it.',
        });
      }

      await client.query(`DELETE FROM sov_lines WHERE commitment_id = $1 AND source = 'base'`, [id]);
      let order = 0;
      for (const row of rows) {
        const description = trim(row.description);
        if (!description) continue;
        await client.query(
          `INSERT INTO sov_lines (commitment_id, item_no, description, scheduled_value, sort_order, source, retainage_pct)
           VALUES ($1,$2,$3,$4,$5,'base',$6)`,
          [id, trim(row.itemNo) || null, description, Number(row.scheduledValue || 0), order++, numberOrNull(row.retainagePct)]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const sov = await pool.query(
      `SELECT * FROM sov_lines WHERE commitment_id = $1 ORDER BY source, sort_order, id`, [id]
    );
    res.json({ sovLines: sov.rows });
  });

  // ---------- Change orders ----------

  // A change order bills against the same budget code as the contract it
  // changes, so take it from the schedule of values rather than asking again.
  async function commitmentBudgetCode(commitmentId) {
    const row = await pool.query(
      `SELECT item_no, COUNT(*)::int AS n
       FROM sov_lines
       WHERE commitment_id = $1 AND source = 'base' AND item_no IS NOT NULL AND item_no <> ''
       GROUP BY item_no ORDER BY n DESC LIMIT 1`,
      [commitmentId]
    );
    return row.rows.length ? row.rows[0].item_no : null;
  }

  // Keeps the single line item in step with the change order's own amount and
  // title. Only while there is one line (or none) — once someone has broken
  // the change order into several lines, those lines are the truth and the
  // amount follows them instead.
  async function syncSingleLineItem(changeOrderId) {
    const co = await pool.query(
      'SELECT commitment_id, title, amount FROM change_orders WHERE id = $1', [changeOrderId]
    );
    if (!co.rows.length) return;
    const existing = await pool.query(
      'SELECT id, budget_code FROM co_line_items WHERE change_order_id = $1 ORDER BY sort_order, id', [changeOrderId]
    );
    if (existing.rows.length > 1) return;

    const amount = Number(co.rows[0].amount || 0);
    if (!existing.rows.length && !amount) return;

    const code = existing.rows.length && existing.rows[0].budget_code
      ? existing.rows[0].budget_code
      : await commitmentBudgetCode(co.rows[0].commitment_id);

    if (existing.rows.length) {
      await pool.query(
        'UPDATE co_line_items SET budget_code = $1, description = $2, amount = $3 WHERE id = $4',
        [code, co.rows[0].title, amount, existing.rows[0].id]
      );
    } else {
      await pool.query(
        `INSERT INTO co_line_items (change_order_id, budget_code, description, amount, sort_order)
         VALUES ($1,$2,$3,$4,0)`,
        [changeOrderId, code, co.rows[0].title, amount]
      );
    }
  }

  // Retainage on ONE line. Everything else about a billed schedule of values is
  // frozen, but the rate is not a quantity — waiving it on a change order that
  // was already paid out in full doesn't rewrite what anyone billed, it records
  // what was actually held. Every application recomputes from it.
  app.patch('/api/sov-lines/:id/retainage', adminOnly, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const row = await pool.query('SELECT id, description FROM sov_lines WHERE id = $1', [id]);
    if (!row.rows.length) return res.status(404).json({ error: 'Line not found' });

    if (b.retainagePct === null || b.retainagePct === '') {
      await pool.query('UPDATE sov_lines SET retainage_pct = NULL WHERE id = $1', [id]);
      return res.json({ ok: true, retainagePct: null });
    }
    const rate = Number(b.retainagePct);
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
      return res.status(400).json({ error: 'Retainage has to be between 0 and 100%.' });
    }
    await pool.query('UPDATE sov_lines SET retainage_pct = $1 WHERE id = $2', [rate.toFixed(4), id]);
    res.json({ ok: true, retainagePct: rate });
  });

  app.post('/api/commitments/:id/change-orders', adminOnly, async (req, res) => {
    const commitmentId = parseInt(req.params.id, 10);
    const b = req.body || {};
    if (!trim(b.title)) return res.status(400).json({ error: 'A title is required' });

    const next = await pool.query(
      `SELECT COALESCE(MAX(NULLIF(regexp_replace(number, '\\D', '', 'g'), '')::int), 0) + 1 AS n
       FROM change_orders WHERE commitment_id = $1`,
      [commitmentId]
    );
    const number = trim(b.number) || `CO #${String(next.rows[0].n).padStart(2, '0')}`;

    const result = await pool.query(
      `INSERT INTO change_orders
        (commitment_id, number, title, description, reason, location, amount, retainage_pct, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        commitmentId, number, trim(b.title), trim(b.description) || null, trim(b.reason) || null,
        trim(b.location) || null, Number(b.amount || 0), numberOrNull(b.retainagePct),
        req.user ? (req.user.name || req.user.email) : null,
      ]
    );
    // The amount you just typed becomes the first line item, coded to the
    // contract's own budget code — the usual case is one line, and retyping
    // it is how the two figures end up disagreeing.
    await syncSingleLineItem(result.rows[0].id);
    res.json({ changeOrder: result.rows[0] });
  });

  app.patch('/api/change-orders/:id', adminOnly, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const existing = await pool.query('SELECT * FROM change_orders WHERE id = $1', [id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Change order not found' });
    const co = existing.rows[0];

    if (b.status && !['pending', 'approved', 'rejected'].includes(b.status)) {
      return res.status(400).json({ error: 'Unknown status' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const fields = [];
      const values = [];
      let i = 1;
      const set = (column, value) => { fields.push(`${column} = $${i++}`); values.push(value); };
      if (b.title !== undefined) set('title', trim(b.title));
      if (b.description !== undefined) set('description', trim(b.description) || null);
      if (b.reason !== undefined) set('reason', trim(b.reason) || null);
      if (b.location !== undefined) set('location', trim(b.location) || null);
      if (b.amount !== undefined) set('amount', Number(b.amount));
      if (b.revision !== undefined) set('revision', parseInt(b.revision, 10) || 0);
      if (b.accountingMethod !== undefined) set('accounting_method', trim(b.accountingMethod) || 'Amount Based');
      if (b.scheduleImpactDays !== undefined) set('schedule_impact_days', parseInt(b.scheduleImpactDays, 10) || 0);
      if (b.dueDate !== undefined) set('due_date', b.dueDate || null);
      if (b.requestedFrom !== undefined) set('requested_from', trim(b.requestedFrom) || null);
      if (b.reviewedBy !== undefined) set('reviewed_by', trim(b.reviewedBy) || null);
      if (b.finalReviewer !== undefined) set('final_reviewer', trim(b.finalReviewer) || null);
      if (b.retainagePct !== undefined) set('retainage_pct', numberOrNull(b.retainagePct));
      if (b.status !== undefined) {
        set('status', b.status);
        set('approved_at', b.status === 'approved' ? new Date() : null);
        set('approved_by', b.status === 'approved' && req.user ? (req.user.name || req.user.email) : null);
      }
      if (fields.length) {
        values.push(id);
        await client.query(`UPDATE change_orders SET ${fields.join(', ')} WHERE id = $${i}`, values);
      }

      const after = await client.query('SELECT * FROM change_orders WHERE id = $1', [id]);
      const updated = after.rows[0];
      const amountOrTitleChanged = b.amount !== undefined || b.title !== undefined;

      // An approved change order is a line in the schedule of values. That is
      // the whole point — it bills like everything else.
      if (updated.status === 'approved') {
        const line = await client.query('SELECT id FROM sov_lines WHERE change_order_id = $1', [id]);
        const label = `${updated.number} - ${updated.title}`;
        if (line.rows.length) {
          await client.query(
            `UPDATE sov_lines SET description = $1, scheduled_value = $2, retainage_pct = $3 WHERE id = $4`,
            [label, updated.amount, updated.retainage_pct, line.rows[0].id]
          );
        } else {
          const order = await client.query(
            `SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM sov_lines WHERE commitment_id = $1 AND source = 'co'`,
            [co.commitment_id]
          );
          const inserted = await client.query(
            `INSERT INTO sov_lines (commitment_id, item_no, description, scheduled_value, sort_order, source, change_order_id, retainage_pct)
             VALUES ($1,$2,$3,$4,$5,'co',$6,$7) RETURNING id`,
            [co.commitment_id, null, label, updated.amount, order.rows[0].n, id, updated.retainage_pct]
          );
          // Any application still open picks the new line up straight away,
          // so an approved CO can be billed in the current period.
          await client.query(
            `INSERT INTO pay_app_lines (pay_app_id, sov_line_id, previous_completed)
             SELECT p.id, $1, 0 FROM pay_apps p
             WHERE p.commitment_id = $2 AND p.status = 'open'
             ON CONFLICT DO NOTHING`,
            [inserted.rows[0].id, co.commitment_id]
          );
        }
      } else {
        // Un-approving only works while nothing has billed against it.
        const billed = await client.query(
          `SELECT COUNT(*)::int AS n FROM pay_app_lines l
           JOIN sov_lines s ON s.id = l.sov_line_id
           WHERE s.change_order_id = $1 AND (l.this_period <> 0 OR l.previous_completed <> 0)`,
          [id]
        );
        if (billed.rows[0].n > 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'This change order has already been billed and cannot be un-approved.' });
        }
        await client.query('DELETE FROM sov_lines WHERE change_order_id = $1', [id]);
      }

      await client.query('COMMIT');
      if (amountOrTitleChanged) await syncSingleLineItem(id);
      res.json({ changeOrder: updated });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  // ---------- One change order, in full ----------

  app.get('/api/change-orders/:id', adminOnly, async (req, res) => {
    const context = await changeOrderContext(parseInt(req.params.id, 10));
    if (!context) return res.status(404).json({ error: 'Change order not found' });
    res.json(context);
  });

  // The change order's own lines. Its amount is their total — there is no
  // separate figure to fall out of step.
  app.put('/api/change-orders/:id/lines', adminOnly, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const rows = Array.isArray(req.body && req.body.lines) ? req.body.lines : [];

    const existing = await pool.query('SELECT status FROM change_orders WHERE id = $1', [id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Change order not found' });
    if (existing.rows[0].status === 'approved') {
      return res.status(409).json({ error: 'This change order is approved. Un-approve it before changing the lines.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM co_line_items WHERE change_order_id = $1', [id]);
      let order = 0;
      let totalCents = 0;
      for (const row of rows) {
        const description = trim(row.description);
        if (!description) continue;
        const amount = Number(row.amount || 0);
        totalCents += Math.round(amount * 100);
        await client.query(
          `INSERT INTO co_line_items (change_order_id, budget_code, description, amount, sort_order)
           VALUES ($1,$2,$3,$4,$5)`,
          [id, trim(row.budgetCode) || null, description, amount, order++]
        );
      }
      await client.query('UPDATE change_orders SET amount = $1 WHERE id = $2', [totalCents / 100, id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    res.json(await changeOrderContext(id));
  });

  // Deleting a change order. Allowed while nothing has been billed against
  // it — after that the money has moved and the record has to stand.
  app.delete('/api/change-orders/:id', adminOnly, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const existing = await pool.query('SELECT number, title FROM change_orders WHERE id = $1', [id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Change order not found' });

    const billed = await pool.query(
      `SELECT COALESCE(SUM(l.previous_completed + l.this_period + l.materials_stored), 0) AS billed
       FROM pay_app_lines l
       JOIN sov_lines s ON s.id = l.sov_line_id
       WHERE s.change_order_id = $1`,
      [id]
    );
    if (toCents(billed.rows[0].billed) > 0) {
      return res.status(409).json({
        error: 'This change order has been billed. Reverse the billing on the affected application first, or leave it in place.',
      });
    }

    // Its schedule-of-values line and any zero lines on open applications go
    // with it, by the foreign keys.
    await pool.query('DELETE FROM change_orders WHERE id = $1', [id]);
    res.json({ ok: true, deleted: existing.rows[0] });
  });

  // ---------- Attachments ----------

  app.post('/api/change-orders/:id/attachments', adminOnly, upload.array('files', 10), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No files received' });

    const start = await pool.query(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM co_attachments WHERE change_order_id = $1', [id]
    );
    let order = start.rows[0].n;
    for (const file of files) {
      await pool.query(
        `INSERT INTO co_attachments (change_order_id, filename, content_type, bytes, size_bytes, uploaded_by, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          id, file.originalname, file.mimetype, file.buffer, file.size,
          req.user ? (req.user.name || req.user.email) : null, order++,
        ]
      );
    }
    res.json(await changeOrderContext(id));
  });

  app.get('/api/attachments/:id', adminOnly, async (req, res) => {
    const row = await pool.query(
      'SELECT filename, content_type, bytes FROM co_attachments WHERE id = $1', [parseInt(req.params.id, 10)]
    );
    if (!row.rows.length) return res.status(404).json({ error: 'Attachment not found' });
    const file = row.rows[0];
    res.setHeader('Content-Type', file.content_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${file.filename.replace(/"/g, '')}"`);
    res.send(file.bytes);
  });

  app.delete('/api/attachments/:id', adminOnly, async (req, res) => {
    const row = await pool.query(
      'DELETE FROM co_attachments WHERE id = $1 RETURNING change_order_id', [parseInt(req.params.id, 10)]
    );
    if (!row.rows.length) return res.status(404).json({ error: 'Attachment not found' });
    res.json(await changeOrderContext(row.rows[0].change_order_id));
  });

  // ---------- The change order document ----------

  app.get('/api/change-orders/:id/pdf', adminOnly, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const context = await changeOrderContext(id);
    if (!context) return res.status(404).json({ error: 'Change order not found' });

    const pdf = await buildChangeOrderPdf(context);
    const number = String(context.changeOrder.number || id).replace(/[^0-9]/g, '').padStart(2, '0');
    const name = `CO ${number} - ${context.changeOrder.title}`.replace(/[^A-Za-z0-9 \-_.]/g, '').slice(0, 80);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.pdf"`);
    res.send(pdf);
  });

  // ---------- Pay applications ----------

  app.post('/api/commitments/:id/pay-apps', adminOnly, async (req, res) => {
    const commitmentId = parseInt(req.params.id, 10);
    const b = req.body || {};

    const commitment = await pool.query('SELECT * FROM commitments WHERE id = $1', [commitmentId]);
    if (!commitment.rows.length) return res.status(404).json({ error: 'Commitment not found' });

    // Backfilling records an application that was billed before this job was on
    // the system — a subcontractor part-way through when we onboarded them. It
    // takes its own number and slots in behind the ones already here, so the
    // "still open" rule (which is about not billing twice for the same period)
    // doesn't apply to it.
    const backfill = b.backfill === true;
    const wantedNumber = backfill ? parseInt(b.number, 10) : null;
    if (backfill && (!Number.isInteger(wantedNumber) || wantedNumber < 1)) {
      return res.status(400).json({ error: 'A backfilled application needs its number.' });
    }
    if (backfill) {
      const clash = await pool.query(
        'SELECT id FROM pay_apps WHERE commitment_id = $1 AND number = $2', [commitmentId, wantedNumber]
      );
      if (clash.rows.length) {
        return res.status(409).json({ error: `There is already an application #${wantedNumber} here.` });
      }
    }

    const open = await pool.query(
      `SELECT id, number FROM pay_apps WHERE commitment_id = $1 AND status <> 'approved' ORDER BY number DESC LIMIT 1`,
      [commitmentId]
    );
    if (!backfill && open.rows.length) {
      return res.status(409).json({
        error: `Application #${open.rows[0].number} is still open. Approve or delete it before starting another.`,
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const next = await client.query(
        'SELECT COALESCE(MAX(number), 0) + 1 AS n FROM pay_apps WHERE commitment_id = $1', [commitmentId]
      );
      const number = backfill ? wantedNumber : next.rows[0].n;
      const token = newToken();

      const created = await client.query(
        `INSERT INTO pay_apps (commitment_id, number, invoice_no, period_start, period_end, application_date, token, token_expires)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now() + interval '60 days') RETURNING *`,
        [
          commitmentId, number, trim(b.invoiceNo) || null,
          b.periodStart || null, b.periodEnd || null, b.applicationDate || null, token,
        ]
      );
      const payApp = created.rows[0];

      // Previous completed comes from the last approved application, per line.
      // Nobody types it, so it cannot disagree with last month.
      await client.query(
        `INSERT INTO pay_app_lines (pay_app_id, sov_line_id, previous_completed)
         SELECT $1, s.id, COALESCE(prior.total, 0)
         FROM sov_lines s
         LEFT JOIN (
           SELECT l.sov_line_id,
                  l.previous_completed + l.this_period + l.materials_stored AS total
           FROM pay_app_lines l
           JOIN pay_apps p ON p.id = l.pay_app_id
           WHERE p.commitment_id = $2 AND p.status = 'approved'
             AND p.number = (
               SELECT MAX(number) FROM pay_apps
               WHERE commitment_id = $2 AND status = 'approved' AND number < $3
             )
         ) prior ON prior.sov_line_id = s.id
         WHERE s.commitment_id = $2`,
        [payApp.id, commitmentId, number]
      );

      await client.query('COMMIT');
      res.json({ payApp, link: `/bill.html?t=${token}` });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  app.get('/api/pay-apps/:id', adminOnly, async (req, res) => {
    const view = await applicationView(parseInt(req.params.id, 10));
    if (!view) return res.status(404).json({ error: 'Application not found' });
    res.json({
      ...view,
      link: view.payApp.token ? `/bill.html?t=${view.payApp.token}` : null,
    });
  });

  // Adjusting a line from the admin side. The sub's own figure is kept.
  app.patch('/api/pay-apps/:id/lines/:lineId', adminOnly, async (req, res) => {
    const payAppId = parseInt(req.params.id, 10);
    const lineId = parseInt(req.params.lineId, 10);
    const b = req.body || {};

    const app_ = await pool.query('SELECT status FROM pay_apps WHERE id = $1', [payAppId]);
    if (!app_.rows.length) return res.status(404).json({ error: 'Application not found' });
    if (app_.rows[0].status === 'approved') {
      return res.status(409).json({ error: 'This application is approved. Reopen it before changing any figures.' });
    }

    const fields = [];
    const values = [];
    let i = 1;
    if (b.thisPeriod !== undefined) { fields.push(`this_period = $${i++}`); values.push(Number(b.thisPeriod)); }
    if (b.materialsStored !== undefined) { fields.push(`materials_stored = $${i++}`); values.push(Number(b.materialsStored)); }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    fields.push(`edited_by = $${i++}`); values.push(req.user ? (req.user.name || req.user.email) : 'admin');
    fields.push(`edited_at = now()`);

    values.push(lineId, payAppId);
    await pool.query(
      `UPDATE pay_app_lines SET ${fields.join(', ')} WHERE id = $${i++} AND pay_app_id = $${i}`, values
    );
    res.json(await applicationView(payAppId));
  });

  /**
   * Re-read "previous completed" from whatever now sits in front of this
   * application. Needed when an earlier application is recorded after the fact:
   * work that this one called "this period" was, it turns out, already billed.
   *
   * Total completed to date per line does not move — only the split between
   * previous and this period — so nothing about what the sub has earned
   * changes, and neither does the contract sum. It just stops the same work
   * being claimed as new twice in the paperwork.
   */
  app.post('/api/pay-apps/:id/resync-previous', adminOnly, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const row = await pool.query('SELECT commitment_id, number, status FROM pay_apps WHERE id = $1', [id]);
    if (!row.rows.length) return res.status(404).json({ error: 'Application not found' });
    if (row.rows[0].status === 'approved') {
      return res.status(409).json({ error: 'This application is approved. Reopen it first.' });
    }
    const { commitment_id: commitmentId, number } = row.rows[0];

    const moved = await pool.query(
      `WITH prior AS (
         SELECT l.sov_line_id,
                l.previous_completed + l.this_period + l.materials_stored AS total
         FROM pay_app_lines l
         JOIN pay_apps p ON p.id = l.pay_app_id
         WHERE p.commitment_id = $2 AND p.status = 'approved'
           AND p.number = (
             SELECT MAX(number) FROM pay_apps
             WHERE commitment_id = $2 AND status = 'approved' AND number < $3
           )
       )
       UPDATE pay_app_lines l
       SET previous_completed = COALESCE(prior.total, 0),
           this_period = GREATEST(
             0,
             l.previous_completed + l.this_period - COALESCE(prior.total, 0)
           )
       FROM (SELECT sov_line_id, total FROM prior) prior
       WHERE l.pay_app_id = $1 AND l.sov_line_id = prior.sov_line_id
         AND l.previous_completed IS DISTINCT FROM prior.total
       RETURNING l.sov_line_id`,
      [id, commitmentId, number]
    );

    res.json({ ok: true, linesChanged: moved.rowCount, ...(await applicationView(id)) });
  });

  /**
   * Take a line off ONE application. The schedule of values keeps it — this
   * only says the line wasn't part of what was billed in this period, which is
   * what a backfilled application needs: a change order approved in September
   * was not in the contract sum on a July document, and printing it there
   * overstates lines 2, 3 and 9.
   *
   * Only ever a line with nothing billed against it, so no money can vanish.
   */
  app.delete('/api/pay-apps/:id/lines/:lineId', adminOnly, async (req, res) => {
    const payAppId = parseInt(req.params.id, 10);
    const lineId = parseInt(req.params.lineId, 10);

    const app_ = await pool.query('SELECT status FROM pay_apps WHERE id = $1', [payAppId]);
    if (!app_.rows.length) return res.status(404).json({ error: 'Application not found' });
    if (app_.rows[0].status === 'approved') {
      return res.status(409).json({ error: 'This application is approved. Reopen it first.' });
    }

    const line = await pool.query(
      `SELECT l.previous_completed, l.this_period, l.materials_stored, s.description
       FROM pay_app_lines l JOIN sov_lines s ON s.id = l.sov_line_id
       WHERE l.id = $1 AND l.pay_app_id = $2`,
      [lineId, payAppId]
    );
    if (!line.rows.length) return res.status(404).json({ error: 'Line not found on this application' });
    const { previous_completed: prev, this_period: now_, materials_stored: stored, description } = line.rows[0];
    if (Number(prev) || Number(now_) || Number(stored)) {
      return res.status(409).json({
        error: `"${description}" has money billed against it. Zero it first if it really doesn't belong here.`,
      });
    }

    await pool.query('DELETE FROM pay_app_lines WHERE id = $1 AND pay_app_id = $2', [lineId, payAppId]);
    res.json(await applicationView(payAppId));
  });

  app.patch('/api/pay-apps/:id', adminOnly, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const existing = await pool.query('SELECT * FROM pay_apps WHERE id = $1', [id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Application not found' });

    const fields = [];
    const values = [];
    let i = 1;
    const set = (column, value) => { fields.push(`${column} = $${i++}`); values.push(value); };

    if (b.number !== undefined) {
      const wanted = parseInt(b.number, 10);
      if (!Number.isInteger(wanted) || wanted < 1) {
        return res.status(400).json({ error: 'An application number has to be a whole number.' });
      }
      const clash = await pool.query(
        'SELECT id FROM pay_apps WHERE commitment_id = $1 AND number = $2 AND id <> $3',
        [existing.rows[0].commitment_id, wanted, id]
      );
      if (clash.rows.length) {
        return res.status(409).json({ error: `There is already an application #${wanted} here.` });
      }
      set('number', wanted);
    }
    if (b.invoiceNo !== undefined) set('invoice_no', trim(b.invoiceNo) || null);
    if (b.periodStart !== undefined) set('period_start', b.periodStart || null);
    if (b.periodEnd !== undefined) set('period_end', b.periodEnd || null);
    if (b.applicationDate !== undefined) set('application_date', b.applicationDate || null);
    if (b.note !== undefined) set('note', trim(b.note) || null);
    if (b.priorPaymentAdjustment !== undefined) {
      const amount = Number(b.priorPaymentAdjustment);
      if (!Number.isFinite(amount) || amount < 0) {
        return res.status(400).json({ error: 'A prior payment has to be a positive amount.' });
      }
      set('prior_payment_adjustment', amount.toFixed(2));
    }
    if (b.priorPaymentNote !== undefined) set('prior_payment_note', trim(b.priorPaymentNote) || null);

    if (b.status !== undefined) {
      if (!['open', 'submitted', 'approved'].includes(b.status)) {
        return res.status(400).json({ error: 'Unknown status' });
      }
      set('status', b.status);
      if (b.status === 'approved') {
        set('approved_at', new Date());
        set('approved_by', req.user ? (req.user.name || req.user.email) : 'admin');
      } else {
        set('approved_at', null);
        set('approved_by', null);
      }
    }
    if (b.reissueLink === true) {
      set('token', newToken());
      fields.push(`token_expires = now() + interval '60 days'`);
    }
    if (b.revokeLink === true) set('token', null);
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });

    values.push(id);
    await pool.query(`UPDATE pay_apps SET ${fields.join(', ')} WHERE id = $${i}`, values);
    res.json(await applicationView(id));
  });

  app.delete('/api/pay-apps/:id', adminOnly, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const row = await pool.query(
      'SELECT commitment_id, number, status FROM pay_apps WHERE id = $1',
      [id]
    );
    if (!row.rows.length) return res.status(404).json({ error: 'Application not found' });
    const { commitment_id: commitmentId, number, status } = row.rows[0];

    // A later application reads this one's line 6 as its "less previous
    // certificates". Pull one out of the middle and every application after it
    // silently changes what it says the sub is owed — so the newest goes first.
    const later = await pool.query(
      'SELECT number FROM pay_apps WHERE commitment_id = $1 AND number > $2 ORDER BY number LIMIT 1',
      [commitmentId, number]
    );
    if (later.rows.length) {
      return res.status(409).json({
        error: `Application ${number} is what application ${later.rows[0].number} bills on top of. `
          + `Delete ${later.rows[0].number} first, or this one's figures would move without anyone seeing it.`,
      });
    }

    // Approved means it has been certified — deleting it needs to be a decision,
    // not a mis-click, so the number has to be typed back.
    if (status === 'approved' && String((req.body || {}).confirmNumber || '').trim() !== String(number)) {
      return res.status(409).json({
        error: 'This application was approved. Type its number to confirm.',
        needsConfirmation: true,
        number,
      });
    }

    await pool.query('DELETE FROM pay_apps WHERE id = $1', [id]);
    res.json({ ok: true });
  });

  // ---------- The two documents ----------

  async function projectFor(commitmentId) {
    const row = await pool.query(
      `SELECT p.id, p.name, p.address1, p.address2, p.owner_name
       FROM projects p JOIN commitments c ON c.project_id = p.id WHERE c.id = $1`,
      [commitmentId]
    );
    return row.rows[0] || { name: '' };
  }

  function documentName(view, kind) {
    const base = `${view.commitment.sub_company} - ${kind} ${view.payApp.number}`;
    return base.replace(/[^A-Za-z0-9 \-_.']/g, '').slice(0, 80);
  }

  async function sendApplication(res, view) {
    const project = await projectFor(view.commitment.id);
    const pdf = await buildApplicationPdf(view, project);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${documentName(view, 'Pay App')}.pdf"`);
    res.send(pdf);
  }

  async function sendWaiver(res, view) {
    const project = await projectFor(view.commitment.id);
    const pdf = await buildWaiverPdf(view, project);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${documentName(view, 'Conditional Waiver')}.pdf"`);
    res.send(pdf);
  }

  app.get('/api/pay-apps/:id/pdf/application', adminOnly, async (req, res) => {
    const view = await applicationView(parseInt(req.params.id, 10));
    if (!view) return res.status(404).json({ error: 'Application not found' });
    await sendApplication(res, view);
  });

  app.get('/api/pay-apps/:id/pdf/waiver', adminOnly, async (req, res) => {
    const view = await applicationView(parseInt(req.params.id, 10));
    if (!view) return res.status(404).json({ error: 'Application not found' });
    await sendWaiver(res, view);
  });

  // ---------- The subcontractor's page ----------
  // No account, no sign-in. The token in the link is the only thing that
  // grants access, and it grants access to exactly one application.

  async function byToken(token) {
    const row = await pool.query(
      `SELECT id FROM pay_apps WHERE token = $1 AND (token_expires IS NULL OR token_expires > now())`,
      [String(token || '')]
    );
    return row.rows.length ? row.rows[0].id : null;
  }

  function subView(view) {
    // Deliberately narrow: the sub sees their own application and nothing
    // else about the job.
    return {
      commitment: {
        number: view.commitment.number,
        title: view.commitment.title,
        subCompany: view.commitment.sub_company,
        subAddress1: view.commitment.sub_address1,
        subAddress2: view.commitment.sub_address2,
        contractorName: view.commitment.contractor_name,
        contractorAddress1: view.commitment.contractor_address1,
        contractorAddress2: view.commitment.contractor_address2,
        retainagePct: Number(view.commitment.retainage_pct),
      },
      payApp: {
        id: view.payApp.id,
        number: view.payApp.number,
        invoiceNo: view.payApp.invoice_no,
        periodStart: view.payApp.period_start,
        periodEnd: view.payApp.period_end,
        applicationDate: view.payApp.application_date,
        status: view.payApp.status,
        signerName: view.payApp.signer_name,
        signerTitle: view.payApp.signer_title,
        submittedAt: view.payApp.submitted_at,
        note: view.payApp.note,
      },
      lines: view.lines,
      base: view.base,
      changeOrders: view.changeOrders,
      grand: view.grand,
      summary: view.summary,
    };
  }

  app.get('/api/bill/:token', async (req, res) => {
    const id = await byToken(req.params.token);
    if (!id) return res.status(404).json({ error: 'This link is no longer valid. Ask for a new one.' });
    res.json(subView(await applicationView(id)));
  });

  app.patch('/api/bill/:token', async (req, res) => {
    const id = await byToken(req.params.token);
    if (!id) return res.status(404).json({ error: 'This link is no longer valid. Ask for a new one.' });

    const current = await pool.query('SELECT status FROM pay_apps WHERE id = $1', [id]);
    if (current.rows[0].status !== 'open') {
      return res.status(409).json({ error: 'This application has been submitted. Ask for it to be reopened if something needs changing.' });
    }

    const lines = Array.isArray(req.body && req.body.lines) ? req.body.lines : [];
    for (const line of lines) {
      const lineId = parseInt(line.id, 10);
      if (!lineId) continue;
      // A line can never bill more than its scheduled value, and never a
      // negative amount. Caught here rather than three documents later.
      const row = await pool.query(
        `SELECT l.previous_completed, s.scheduled_value
         FROM pay_app_lines l JOIN sov_lines s ON s.id = l.sov_line_id
         WHERE l.id = $1 AND l.pay_app_id = $2`,
        [lineId, id]
      );
      if (!row.rows.length) continue;
      const scheduled = toCents(row.rows[0].scheduled_value);
      const previous = toCents(row.rows[0].previous_completed);
      let thisPeriod = Math.max(0, toCents(line.thisPeriod));
      let stored = Math.max(0, toCents(line.materialsStored));
      if (previous + thisPeriod + stored > scheduled) {
        thisPeriod = Math.max(0, scheduled - previous - stored);
      }
      await pool.query(
        `UPDATE pay_app_lines SET this_period = $1, materials_stored = $2 WHERE id = $3 AND pay_app_id = $4`,
        [thisPeriod / 100, stored / 100, lineId, id]
      );
    }
    res.json(subView(await applicationView(id)));
  });

  // The sub downloads their own copies from the same link.
  app.get('/api/bill/:token/pdf/application', async (req, res) => {
    const id = await byToken(req.params.token);
    if (!id) return res.status(404).json({ error: 'This link is no longer valid. Ask for a new one.' });
    await sendApplication(res, await applicationView(id));
  });

  app.get('/api/bill/:token/pdf/waiver', async (req, res) => {
    const id = await byToken(req.params.token);
    if (!id) return res.status(404).json({ error: 'This link is no longer valid. Ask for a new one.' });
    await sendWaiver(res, await applicationView(id));
  });

  app.post('/api/bill/:token/submit', async (req, res) => {
    const id = await byToken(req.params.token);
    if (!id) return res.status(404).json({ error: 'This link is no longer valid. Ask for a new one.' });

    const b = req.body || {};
    if (!trim(b.signerName)) return res.status(400).json({ error: 'Please type your name to sign this application.' });

    const current = await pool.query('SELECT status FROM pay_apps WHERE id = $1', [id]);
    if (current.rows[0].status !== 'open') {
      return res.status(409).json({ error: 'This application has already been submitted.' });
    }

    // Keep what the sub sent, so an admin adjustment later is visible as one.
    await pool.query(
      `UPDATE pay_app_lines
       SET submitted_this_period = this_period, submitted_materials_stored = materials_stored
       WHERE pay_app_id = $1`,
      [id]
    );
    await pool.query(
      `UPDATE pay_apps
       SET status = 'submitted', signer_name = $1, signer_title = $2,
           submitted_at = now(), submitted_ip = $3,
           application_date = COALESCE(application_date, CURRENT_DATE)
       WHERE id = $4`,
      [trim(b.signerName), trim(b.signerTitle) || null, req.ip || null, id]
    );
    res.json(subView(await applicationView(id)));
  });
}

module.exports = { mountBillingRoutes };

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

// The subcontractor's progress payment pack: AIA-style G702 application,
// G703 continuation sheets, and the conditional waiver, in one file.
//
// Every figure comes from the same stored calculation the screens read, so the
// period dates, the company name and the amount cannot disagree between the
// three documents — which is exactly what went wrong on the pack we started
// from, where the waiver covered a different period than the application.
//
// Landscape letter throughout, matching the workbook this replaces: nine money
// columns do not fit across a portrait page without lying about the spacing.

const SHEET = { width: 792, height: 612 };   // letter, landscape
const MARGIN = 28;
const RIGHT = SHEET.width - MARGIN;
const INK = rgb(0.05, 0.08, 0.1);
const GREY = rgb(0.42, 0.46, 0.5);
const RULE = rgb(0.72, 0.76, 0.79);
const HAIR = rgb(0.85, 0.88, 0.9);
const BAND = rgb(0.94, 0.95, 0.96);

const logoPath = path.join(__dirname, 'assets', 'precision-logo.png');

const money = (value) =>
  `$${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const pct1 = (value) => `${(Number(value || 0) * 100).toFixed(0)}%`;

const asDate = (value) => {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d)) return String(value);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function wrap(text, font, size, maxWidth) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ');
  if (!words[0]) return [];
  const lines = [];
  let line = words[0];
  for (let i = 1; i < words.length; i++) {
    const candidate = `${line} ${words[i]}`;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth) {
      lines.push(line);
      line = words[i];
    } else {
      line = candidate;
    }
  }
  lines.push(line);
  return lines;
}

/** Trim a description to fit its column rather than letting it run into the money. */
function clip(text, font, size, maxWidth) {
  let s = String(text || '');
  if (font.widthOfTextAtSize(s, size) <= maxWidth) return s;
  while (s.length > 1 && font.widthOfTextAtSize(`${s}…`, size) > maxWidth) s = s.slice(0, -1);
  return `${s}…`;
}

async function newDocument() {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);
  let logo = null;
  try {
    if (fs.existsSync(logoPath)) logo = await pdf.embedPng(fs.readFileSync(logoPath));
  } catch (err) {
    logo = null;
  }

  const page = () => {
    const p = pdf.addPage([SHEET.width, SHEET.height]);
    const text = (value, x, y, { size = 8, font = regular, color = INK, align = 'left' } = {}) => {
      const str = String(value === null || value === undefined ? '' : value);
      if (!str) return;
      const width = font.widthOfTextAtSize(str, size);
      const left = align === 'right' ? x - width : align === 'center' ? x - width / 2 : x;
      p.drawText(str, { x: left, y, size, font, color });
    };
    const line = (x1, y, x2, thickness = 0.6, color = RULE) =>
      p.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
    const vline = (x, y1, y2, thickness = 0.6, color = RULE) =>
      p.drawLine({ start: { x, y: y1 }, end: { x, y: y2 }, thickness, color });
    const box = (x, y, w, h, { fill = null, border = RULE, width = 0.6 } = {}) =>
      p.drawRectangle({ x, y, width: w, height: h, color: fill || undefined, borderColor: border, borderWidth: width });
    return { p, text, line, vline, box };
  };

  return { pdf, regular, bold, italic, logo, page };
}

// ---------------------------------------------------------------------------
// G703 continuation sheet geometry
// ---------------------------------------------------------------------------

// Right edge of each money column, and the left edge of the two text columns.
// The lettering is the standard one: A item, B description, C scheduled value,
// D previously completed, E this period, F stored, G total, then the unlettered
// per-cent column, H balance to finish, I retainage.// The form is a ruled grid, not a list of figures with tidy spacing. Every
// cell on a G703 is boxed, the column letters sit in their own band, and
// "WORK COMPLETED" spans D and E above them. Getting that wrong is what made
// our first attempt read as "a table of the right numbers" rather than as the
// document a project manager expects to receive.

const TABLE_L = 18;
const TABLE_R = SHEET.width - 18;

// Column boundaries, left to right. Ten columns; the gaps are sized for the
// widest figure each one has to hold, not evenly.
const EDGES = [18, 74, 250, 334, 406, 474, 546, 620, 658, 716, 774];
const CELL = {
  item: 0, description: 1, scheduled: 2, previous: 3, thisPeriod: 4,
  stored: 5, total: 6, percent: 7, balance: 8, retainage: 9,
};
const cellLeft = (i) => EDGES[i];
const cellRight = (i) => EDGES[i + 1];
const cellMid = (i) => (EDGES[i] + EDGES[i + 1]) / 2;

const ROW_H = 11.6;
const LETTER_H = 11;
const HEAD_H = 52;

/** Text centred in a column, wrapped onto as many lines as it needs. */
function centreStack(ctx, col, linesOfText, bottom, height, size = 5.8, font = null) {
  const f = font || ctx.bold;
  const total = linesOfText.length * (size + 1.4);
  let y = bottom + (height + total) / 2 - size - 1;
  for (const l of linesOfText) {
    ctx.text(l, cellMid(col), y, { size, font: f, align: 'center' });
    y -= size + 1.4;
  }
}

function sheetHeader(ctx, { pageNumber, pageCount, payApp, project, sectionLabel }) {
  const { text } = ctx;
  let y = SHEET.height - 26;

  text('CONTINUATION SHEET', TABLE_L, y, { size: 9.5, font: ctx.bold });
  text('DOCUMENT G703', SHEET.width / 2, y, { size: 9, font: ctx.italic, align: 'center' });
  text(`Page ${pageNumber} of ${pageCount}`, TABLE_R, y, { size: 8, align: 'right' });
  y -= 12;

  const LAB = 640;
  text('Document G702, APPLICATION AND CERTIFICATE FOR PAYMENT, containing', TABLE_L, y, { size: 7 });
  text('APPLICATION NUMBER:', LAB, y, { size: 7, align: 'right' });
  text(String(payApp.number), LAB + 6, y, { size: 7 });
  y -= 9;
  text("Contractor's signed Certification is attached.", TABLE_L, y, { size: 7 });
  text('APPLICATION DATE:', LAB, y, { size: 7, align: 'right' });
  text(asDate(payApp.application_date) || asDate(payApp.submitted_at), LAB + 6, y, { size: 7 });
  y -= 9;
  text('Use Column I on Contracts where variable retainage for line items may apply.', TABLE_L, y, { size: 7 });
  text('PERIOD:', LAB, y, { size: 7, align: 'right' });
  text([asDate(payApp.period_start), asDate(payApp.period_end)].filter(Boolean).join('-'), LAB + 6, y, { size: 7 });
  y -= 9;
  text('ARCHITECTS PROJECT NO:', LAB, y, { size: 7, align: 'right' });
  text(project.name || '', LAB + 6, y, { size: 7 });

  y -= 14;
  // The section name sits above the table, as a caption — not as a band inside
  // it, which is not how the form is laid out.
  if (sectionLabel) {
    text(sectionLabel, TABLE_L, y, { size: 7.5, font: ctx.bold });
    y -= 9;
  }
  return y;
}

/** The lettered band and the two-tier column titles. Returns the body top. */
function columnHeader(ctx, top) {
  const { text, box, line, vline } = ctx;
  const letterBottom = top - LETTER_H;
  const headBottom = letterBottom - HEAD_H;

  // Outer frame for both bands.
  box(TABLE_L, headBottom, TABLE_R - TABLE_L, LETTER_H + HEAD_H, { border: INK, width: 0.9 });
  line(TABLE_L, letterBottom, TABLE_R, 0.9, INK);

  const letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', '', 'H', 'I'];
  letters.forEach((letter, i) => {
    if (letter) text(letter, cellMid(i), letterBottom + 3, { size: 6.5, align: 'center' });
  });

  // "WORK COMPLETED" spans D and E, with its own rule under it.
  const splitY = headBottom + HEAD_H - 11;
  text('WORK COMPLETED', (cellLeft(CELL.previous) + cellRight(CELL.thisPeriod)) / 2,
    splitY + 3, { size: 6, font: ctx.bold, align: 'center' });
  line(cellLeft(CELL.previous), splitY, cellRight(CELL.thisPeriod), 0.9, INK);

  centreStack(ctx, CELL.item, ['ITEM NO.'], headBottom, HEAD_H, 6);
  centreStack(ctx, CELL.description, ['DESCRIPTION OF WORK'], headBottom, HEAD_H, 6);
  centreStack(ctx, CELL.scheduled, ['SCHEDULED VALUE'], headBottom, HEAD_H, 6);
  centreStack(ctx, CELL.previous, ['FROM', 'PREVIOUS', 'APPLICATION', '(D+E)'], headBottom, HEAD_H - 11, 5.8);
  centreStack(ctx, CELL.thisPeriod, ['THIS PERIOD'], headBottom, HEAD_H - 11, 5.8);
  centreStack(ctx, CELL.stored, ['MATERIALS', 'PRESENTLY', 'STORED (NOT IN', 'D OR E)'], headBottom, HEAD_H, 5.8);
  centreStack(ctx, CELL.total, ['TOTAL', 'COMPLETED AND', 'STORED TO DATE', '(D+E+F)'], headBottom, HEAD_H, 5.8);
  centreStack(ctx, CELL.percent, ['% (G/C)'], headBottom, HEAD_H, 5.8);
  centreStack(ctx, CELL.balance, ['BALANCE TO', 'FINISH (C-G)'], headBottom, HEAD_H, 5.8);
  centreStack(ctx, CELL.retainage, ['RETAINAGE'], headBottom, HEAD_H, 5.8);

  // Verticals run the whole header, except the one inside "WORK COMPLETED",
  // which starts below that spanning title.
  for (let i = 1; i < EDGES.length - 1; i++) {
    const topY = i === CELL.thisPeriod ? splitY : letterBottom;
    vline(EDGES[i], headBottom, topY, 0.9, INK);
    vline(EDGES[i], letterBottom, top, 0.9, INK);
  }
  return headBottom;
}

function drawBodyRow(ctx, y, row) {
  const { text, box, vline } = ctx;
  const bold = row.kind === 'total' || row.kind === 'grand';
  const font = bold ? ctx.bold : ctx.regular;
  const size = 7;

  box(TABLE_L, y, TABLE_R - TABLE_L, ROW_H, { border: INK, width: bold ? 0.9 : 0.5 });
  for (let i = 1; i < EDGES.length - 1; i++) vline(EDGES[i], y, y + ROW_H, 0.5, INK);

  const baseline = y + 3.4;
  const left = (col, value) => text(value, cellLeft(col) + 3, baseline, { size, font });
  const right = (col, value) => text(value, cellRight(col) - 3, baseline, { size, font, align: 'right' });

  if (row.kind === 'blank') return y - ROW_H;

  left(CELL.item, row.itemNo || '');
  left(CELL.description, clip(row.description, font, size, cellRight(CELL.description) - cellLeft(CELL.description) - 6));
  right(CELL.scheduled, money(row.scheduledValue));
  right(CELL.previous, money(row.previousCompleted));
  right(CELL.thisPeriod, money(row.thisPeriod));
  right(CELL.stored, money(row.materialsStored));
  right(CELL.total, money(row.totalCompleted));
  right(CELL.percent, pct1(row.percent));
  right(CELL.balance, money(row.balanceToFinish));
  right(CELL.retainage, money(row.retainage));
  return y - ROW_H;
}

/**
 * The continuation sheets, in order: the contract lines with their total, then
 * the change order packages with theirs, then the grand total. Each section
 * starts its own sheet, which is how the workbook prints it.
 */
function continuationSections(view) {
  const sections = [];
  const baseLines = view.lines.filter((l) => l.source !== 'co');
  const coLines = view.lines.filter((l) => l.source === 'co');

  sections.push({
    label: 'Contract Lines',
    rows: [
      ...baseLines.map((l) => ({ ...l, kind: 'line' })),
      { ...view.base, kind: 'total', description: 'TOTALS:', itemNo: '' },
    ],
  });

  if (coLines.length) {
    sections.push({
      label: 'Whole Change Order Packages',
      rows: [
        ...coLines.map((l) => ({ ...l, kind: 'line' })),
        { ...view.changeOrders, kind: 'total', description: 'TOTALS:', itemNo: '' },
      ],
    });
  }

  // Grand totals close the last section rather than opening a sheet of their
  // own: a page containing one row reads as a mistake, and the workbook does
  // not print one.
  const last = sections[sections.length - 1];
  last.rows.push({ kind: 'blank' });
  last.rows.push({ ...view.grand, kind: 'grand', description: 'GRAND TOTALS', itemNo: '' });
  return sections;
}

// ---------------------------------------------------------------------------
// G702
// ---------------------------------------------------------------------------

function drawG702(ctx, { view, project, pageCount }) {
  const { payApp, commitment, summary } = view;
  const { text, line, box } = ctx;
  const L = TABLE_L;
  const R = TABLE_R;

  let y = SHEET.height - 26;
  text('APPLICATION AND CERTIFICATE FOR PAYMENT', L, y, { size: 10.5, font: ctx.bold });
  text('DOCUMENT G702', SHEET.width / 2 + 60, y, { size: 9, font: ctx.italic, align: 'center' });
  text(`Page 1 of ${pageCount}`, R, y, { size: 8, align: 'right' });
  y -= 7;
  line(L, y, R, 1.1, INK);
  y -= 15;

  const C1 = L;
  const C2 = 276;
  const LABX = 594;          // right-aligned label column
  const VALX = LABX + 6;
  const C4 = 700;

  const lab = (t, x, yy, align = 'left') => text(t, x, yy, { size: 7.5, font: ctx.bold, align });
  const val = (t, x, yy) => text(t, x, yy, { size: 7.5 });

  let ly = y;
  lab('TO CONTRACTOR:', C1, ly);
  lab('PROJECT:', C2, ly);
  lab('APPLICATION NO:', LABX, ly, 'right');
  val(String(payApp.number), VALX, ly);
  lab('DISTRIBUTION TO:', C4, ly);
  ly -= 11;
  val(commitment.contractor_name || '', C1, ly);
  val(project.name || '', C2, ly);
  lab('INVOICE NO:', LABX, ly, 'right');
  val(payApp.invoice_no || '', VALX, ly);
  ly -= 11;
  val(commitment.contractor_address1 || '', C1, ly);
  val(project.address1 || '', C2, ly);
  lab('PERIOD:', LABX, ly, 'right');
  val([asDate(payApp.period_start), asDate(payApp.period_end)].filter(Boolean).join('-'), VALX, ly);
  ly -= 11;
  val(commitment.contractor_address2 || '', C1, ly);
  val(project.address2 || '', C2, ly);
  lab('SUBCONTRACT NO:', LABX, ly, 'right');
  val(commitment.number || '', VALX, ly);
  ly -= 11;
  lab('PROJECT NO:', LABX, ly, 'right');
  val(project.name || '', VALX, ly);

  ly -= 14;
  lab('FROM SUBCONTRACTOR:', C1, ly);
  lab('SUBCONTRACT DATE:', C2, ly);
  val(asDate(commitment.contract_date), C2 + 92, ly);
  ly -= 11;
  val(commitment.sub_company || '', C1, ly);
  ly -= 11;
  val(commitment.sub_address1 || '', C1, ly);
  ly -= 11;
  val(commitment.sub_address2 || '', C1, ly);
  ly -= 12;
  text(`SUBCONTRACT FOR: ${commitment.title || ''}`, C1, ly, { size: 7.5 });

  ly -= 13;
  text("SUBCONTRACTOR'S DRAW REQUEST", C1, ly, { size: 10, font: ctx.bold });
  const certTop = ly;
  ly -= 11;
  text('Application is made for payment, as shown below, in connection with the Subcontract.', C1, ly, { size: 7.5 });
  ly -= 9;
  text('Continuation Sheet is attached.', C1, ly, { size: 7.5 });

  // Certification, right column.
  const RCOL = 462;
  let ry = certTop + 2;
  for (const row of [
    "The undersigned Subcontractor certifies that to the best of the Subcontractor's knowledge,",
    'information and belief the Work covered by this Application for Payment has been',
    'completed in accordance with the Subcontract Documents, that all amounts have been paid by',
    'the Contractor for Work for which previous Certificates for Payment were issued and',
    'payments received from the Owner, and that current payment shown herein is now due.',
  ]) {
    text(row, RCOL, ry, { size: 6.8 });
    ry -= 9.5;
  }

  // ----- the nine numbered lines -----
  // Each amount sits on a rule, which is what makes the form read as a form.
  y = ly - 22;
  const NUMX = C1 + 4;
  const TXTX = C1 + 26;
  // Both amount columns stop short of RCOL: the certification paragraph and
  // the signature block own everything to the right of it.
  const AMT_R = 438;          // right edge of the main amount column
  const SUB_R = 366;          // right edge of the indented 5a / 5b column
  const ruleUnder = (right, width = 96) => line(right - width, y - 2.5, right, 0.6, INK);

  const row = (num, labelText, amount, note, { indent = false, rightEdge = AMT_R } = {}) => {
    if (num) text(num, NUMX, y, { size: 7.5 });
    text(labelText, indent ? TXTX + 22 : TXTX, y, { size: 7.5 });
    if (amount !== null && amount !== undefined) {
      text(money(amount), rightEdge - 3, y, { size: 7.5, align: 'right' });
      ruleUnder(rightEdge);
    }
    y -= 11;
    if (note) {
      text(note, TXTX, y, { size: 7 });
      y -= 10;
    }
  };

  row('1.', 'Original Contract Sum', summary.originalContractSum);
  row('2.', 'Net change by change orders', summary.netChangeByChangeOrders);
  row('3.', 'Contract sum to date (Line 1 ± 2)', summary.contractSumToDate);
  row('4.', 'Total completed and stored to date', summary.totalCompletedAndStored, '(Column G on G703)');
  row('5.', 'Retainage:', null, null);
  row('a.', `${(Number(summary.effectiveRetainageRate || 0) * 100).toFixed(2)}% of Completed Work:`,
    summary.retainageOnCompletedWork, null, { indent: true, rightEdge: SUB_R });
  row('b.', `${(Number(commitment.materials_retainage_pct || 0) * 100).toFixed(2)}% of Stored Material:`,
    summary.retainageOnStoredMaterial, null, { indent: true, rightEdge: SUB_R });
  row('', 'Total Retainage (Lines 5a + 5b or Total in Column I of G703)', summary.totalRetainage);
  row('6.', 'Total earned less retainage', summary.totalEarnedLessRetainage, '(Line 4 Less Line 5 Total)');
  row('7.', 'Less previous certificates for payment', summary.previousCertificates, '(Line 6 from prior certificate)');
  if (Number(summary.priorPaymentAdjustment) > 0) {
    text(`includes ${money(summary.priorPaymentAdjustment)} ${payApp.prior_payment_note || 'paid outside the applications'}`,
      TXTX, y + 1, { size: 6.4, color: GREY });
    y -= 9;
  }
  row('8.', 'Current payment due:', summary.currentPaymentDue);
  row('9.', 'Balance to finish, including retainage', summary.balanceToFinishIncludingRetainage, '(Line 3 less Line 6)');

  // ----- signature and notary, right column -----
  let sy = ry - 12;
  text('SUBCONTRACTOR:', RCOL, sy, { size: 7.5, font: ctx.bold });
  text(commitment.sub_company || '', RCOL + 92, sy, { size: 7.5 });
  sy -= 22;
  text('By:', RCOL, sy, { size: 7.5 });
  line(RCOL + 18, sy - 2.5, RCOL + 200, 0.6, INK);
  if (payApp.signer_name) text(payApp.signer_name, RCOL + 22, sy, { size: 7.5 });
  text('Date:', RCOL + 212, sy, { size: 7.5 });
  line(RCOL + 240, sy - 2.5, R, 0.6, INK);
  text(asDate(payApp.submitted_at) || asDate(payApp.application_date), RCOL + 244, sy, { size: 7.5 });
  sy -= 15;
  text('State of:', RCOL, sy, { size: 7.5 });
  line(RCOL + 36, sy - 2.5, RCOL + 200, 0.6, INK);
  sy -= 13;
  text('County of:', RCOL, sy, { size: 7.5 });
  line(RCOL + 44, sy - 2.5, RCOL + 200, 0.6, INK);
  sy -= 13;
  text('Subscribed and sworn to before', RCOL, sy, { size: 7.5 });
  sy -= 12;
  text('me this', RCOL, sy, { size: 7.5 });
  line(RCOL + 30, sy - 2.5, RCOL + 120, 0.6, INK);
  text('day of', RCOL + 126, sy, { size: 7.5 });
  line(RCOL + 156, sy - 2.5, R, 0.6, INK);
  sy -= 18;
  text('Notary Public:', RCOL, sy, { size: 7.5 });
  line(RCOL + 54, sy - 2.5, R, 0.6, INK);
  sy -= 15;
  text('My Commission expires:', RCOL, sy, { size: 7.5 });
  line(RCOL + 92, sy - 2.5, R, 0.6, INK);

  // ----- change order summary, a bordered table -----
  const co = view.changeOrderSummary || {};
  const boxTop = Math.min(y, sy) - 24;
  const X0 = C1 + 22;
  const X1 = X0 + 250;
  const X2 = X1 + 108;
  const X3 = X2 + 108;
  const rows = [
    ['Total changes approved', money(co.approvedPreviousAdditions || 0), money(co.approvedPreviousDeductions || 0), 'in previous months by Owner:'],
    ['Total approved this Month:', money(co.approvedThisMonthAdditions || 0), money(co.approvedThisMonthDeductions || 0), null],
  ];
  const H_HEAD = 13;
  const H_TALL = 20;
  const H_ONE = 13;
  const totalH = H_HEAD + H_TALL + H_ONE + H_ONE + H_ONE;
  let by = boxTop;

  const bandRow = (height, cells, { bold = false, secondLine = null } = {}) => {
    const top = by;
    const bottom = by - height;
    box(X0, bottom, X3 - X0, height, { border: INK, width: 0.7 });
    ctx.vline(X1, bottom, top, 0.7, INK);
    ctx.vline(X2, bottom, top, 0.7, INK);
    const f = bold ? ctx.bold : ctx.regular;
    if (cells[0]) text(cells[0], X0 + 4, bottom + height - 9, { size: 7, font: f });
    if (secondLine) text(secondLine, X0 + 4, bottom + 3.5, { size: 7, font: f });
    if (cells[1]) text(cells[1], X2 - 4, bottom + height - 9, { size: 7, font: f, align: 'right' });
    if (cells[2]) text(cells[2], X3 - 4, bottom + height - 9, { size: 7, font: f, align: 'right' });
    by = bottom;
  };

  // Header row, centred.
  box(X0, by - H_HEAD, X3 - X0, H_HEAD, { border: INK, width: 0.7 });
  ctx.vline(X1, by - H_HEAD, by, 0.7, INK);
  ctx.vline(X2, by - H_HEAD, by, 0.7, INK);
  text('CHANGE ORDER SUMMARY', (X0 + X1) / 2, by - 9, { size: 7, font: ctx.bold, align: 'center' });
  text('ADDITIONS', (X1 + X2) / 2, by - 9, { size: 7, font: ctx.bold, align: 'center' });
  text('DEDUCTIONS', (X2 + X3) / 2, by - 9, { size: 7, font: ctx.bold, align: 'center' });
  by -= H_HEAD;

  bandRow(H_TALL, rows[0].slice(0, 3), { secondLine: rows[0][3] });
  bandRow(H_ONE, rows[1].slice(0, 3));
  bandRow(H_ONE, ['', money((co.approvedPreviousAdditions || 0) + (co.approvedThisMonthAdditions || 0)),
    money((co.approvedPreviousDeductions || 0) + (co.approvedThisMonthDeductions || 0))], { bold: true });
  text('Totals:', X1 - 4, by + H_ONE - 9, { size: 7, font: ctx.bold, align: 'right' });
  bandRow(H_ONE, ['Net change by change orders:', money(summary.netChangeByChangeOrders), ''], { bold: true });
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

function drawApplication(doc, view, project) {
  const { regular, bold, italic, page } = doc;
  const sections = continuationSections(view);

  // How many body rows fit under the sheet header and the column band.
  const probeTop = SHEET.height - 26 - 12 - 27 - 14 - 9;
  const bodyTop = probeTop - LETTER_H - HEAD_H;
  const capacity = Math.max(6, Math.floor((bodyTop - 26) / ROW_H));

  // Sections do not share a sheet; each starts a new one, as the workbook
  // prints them, so a TOTALS line is never orphaned from its block.
  const sheets = [];
  for (const section of sections) {
    for (let i = 0; i < section.rows.length; i += capacity) {
      sheets.push({ label: section.label, rows: section.rows.slice(i, i + capacity) });
    }
  }
  const pageCount = 1 + sheets.length;

  const ctxOf = (p) => Object.assign(p, { regular, bold, italic });
  drawG702(ctxOf(page()), { view, project, pageCount });

  sheets.forEach((sheet, i) => {
    const ctx = ctxOf(page());
    const top = sheetHeader(ctx, {
      pageNumber: i + 2,
      pageCount,
      payApp: view.payApp,
      project,
      sectionLabel: sheet.label,
    });
    let y = columnHeader(ctx, top) - ROW_H;
    for (const row of sheet.rows) y = drawBodyRow(ctx, y, row);
  });

  return pageCount;
}

function drawWaiver(doc, view, project) {
  const { regular, bold, italic, logo, page } = doc;
  const { payApp, commitment, summary } = view;
  const w = Object.assign(page(), { regular, bold, italic });
  const TEXT_W = 700;
  const LEFT = (SHEET.width - TEXT_W) / 2;
  let y = SHEET.height - MARGIN - 8;

  if (logo) {
    const width = 100;
    const height = (logo.height / logo.width) * width;
    w.p.drawImage(logo, { x: LEFT, y: y - height + 4, width, height });
    y -= height + 10;
  }

  w.text('CONDITIONAL WAIVER AND RELEASE ON PROGRESS PAYMENT', SHEET.width / 2, y, {
    size: 12, font: bold, align: 'center',
  });
  y -= 15;
  w.text(`${project.name || ''} · Pay Application #${payApp.number}`, SHEET.width / 2, y,
    { size: 9, align: 'center', color: GREY });
  y -= 18;

  const owner = project.owner_name || '[owner]';
  const location = [project.address1, project.address2].filter(Boolean).join(', ');
  const period = [asDate(payApp.period_start), asDate(payApp.period_end)].filter(Boolean).join(' – ');

  const paragraphs = [
    `On receipt by the signer of this document of a check from ${commitment.contractor_name} (maker of check) in the sum of ${money(summary.currentPaymentDue)} payable to ${commitment.sub_company} (payee or payees of check) and when the check has been properly endorsed and has been paid by the bank on which it is drawn, this document becomes effective to hereby release and discharge ${commitment.contractor_name}, its surety, ${commitment.surety}, Carter & Carter Construction, ${owner}, from any and all claims, demands, liens, and/or causes of action of any kind whatsoever, which Supplier has or may have been entitled to assert on account of materials, equipment, services, and/or labor furnished to or in connection with the project through ${period} (billing period) that the signer has on the property of ${owner} (owner) located at ${location} (location) to the following extent: ${commitment.title} (job description).`,

    `This release covers a progress payment for all labor, services, equipment, or materials furnished to the property or to ${commitment.contractor_name} (person with whom signer contracted) as indicated in the attached statement(s) or progress payment request(s), except for unpaid retention, pending modifications and changes, or other items furnished.`,

    `The signer warrants that the signer has already paid or will use the funds received from this progress payment to promptly pay in full all of the signer's laborers, subcontractors, materialmen, and suppliers for all work, materials, equipment, or services provided for or to the above referenced project in regard to the attached statement(s) or progress payment request(s).`,

    `Supplier warrants and represents that all of its subcontractors, suppliers, laborers, and lessors of construction equipment that have supplied labor, equipment, services, and/or materials to the undersigned in connection with the Project have been paid in full and that all labor, material and other things of value furnished to the Project, by or through Supplier, meet all requirements of the plans and specifications and/or the agreement between ${commitment.sub_company} and/or ${commitment.contractor_name} as may be applicable. Further, Supplier agrees to indemnify and hold harmless ${commitment.contractor_name}, its surety, ${commitment.surety}, Carter & Carter Construction, ${owner}, from any and all claims, costs, liability, demands, and/or causes of action which any of them may incur by virtue of Supplier's failure to pay any such suppliers, laborers, and/or lessors.`,
  ];

  for (const paragraph of paragraphs) {
    for (const row of wrap(paragraph, regular, 8.4, TEXT_W)) {
      w.text(row, LEFT, y, { size: 8.4 });
      y -= 10.6;
    }
    y -= 7;
  }

  const executed = payApp.submitted_at ? new Date(payApp.submitted_at) : new Date();
  y -= 2;
  w.text(`Executed this the ${executed.getUTCDate()} day of ${MONTHS[executed.getUTCMonth()]}, ${executed.getUTCFullYear()}.`,
    LEFT, y, { size: 8.4 });

  // Signature on the left, notary on the right — it fits side by side in
  // landscape, which keeps the waiver to a single page.
  const RCOL = LEFT + 380;
  let sy = y - 24;
  w.text(commitment.sub_company, LEFT, sy, { size: 9.5, font: bold });
  w.text('(Company name)', LEFT + 200, sy, { size: 7, color: GREY });
  sy -= 28;
  w.line(LEFT, sy, LEFT + 300, 0.9, INK);
  if (payApp.signer_name) w.text(payApp.signer_name, LEFT + 2, sy + 5, { size: 9.5, font: bold });
  w.text('By (Signature)', LEFT, sy - 10, { size: 7, color: GREY });
  sy -= 30;
  w.line(LEFT, sy, LEFT + 300, 0.9, INK);
  if (payApp.signer_title) w.text(payApp.signer_title, LEFT + 2, sy + 5, { size: 9 });
  w.text('Title', LEFT, sy - 10, { size: 7, color: GREY });

  let ny = y - 24;
  w.text('STATE OF ______________________', RCOL, ny, { size: 8.4 });
  ny -= 15;
  w.text('COUNTY OF ____________________', RCOL, ny, { size: 8.4 });
  ny -= 20;
  w.text('This instrument was acknowledged before me', RCOL, ny, { size: 8.4 });
  ny -= 12;
  w.text('the ______ day of ____________, 20____.', RCOL, ny, { size: 8.4 });
  ny -= 32;
  w.line(RCOL, ny, RCOL + 260, 0.9, INK);
  w.text('Notary Public', RCOL, ny - 10, { size: 7, color: GREY });
  ny -= 28;
  w.text('My commission expires: ____________________', RCOL, ny, { size: 8.4 });
}

/**
 * The application, its continuation sheets AND the conditional waiver, in one
 * file — so the subcontractor prints, signs and returns one thing rather than
 * chasing two downloads and stapling them in the right order.
 */
async function buildApplicationPdf(view, project) {
  const doc = await newDocument();
  drawApplication(doc, view, project);
  drawWaiver(doc, view, project);
  return Buffer.from(await doc.pdf.save());
}

/** The waiver on its own, for when only that is being reissued. */
async function buildWaiverPdf(view, project) {
  const doc = await newDocument();
  drawWaiver(doc, view, project);
  return Buffer.from(await doc.pdf.save());
}

module.exports = { buildApplicationPdf, buildWaiverPdf };

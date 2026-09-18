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

  return { pdf, regular, bold, logo, page };
}

// ---------------------------------------------------------------------------
// G703 continuation sheet geometry
// ---------------------------------------------------------------------------

// Right edge of each money column, and the left edge of the two text columns.
// The lettering is the standard one: A item, B description, C scheduled value,
// D previously completed, E this period, F stored, G total, then the unlettered
// per-cent column, H balance to finish, I retainage.
const COL = {
  item: { x: MARGIN + 4, align: 'left', width: 62 },
  description: { x: MARGIN + 74, align: 'left', width: 198 },
  scheduled: { x: 352, align: 'right' },
  previous: { x: 422, align: 'right' },
  thisPeriod: { x: 488, align: 'right' },
  stored: { x: 548, align: 'right' },
  total: { x: 620, align: 'right' },
  percent: { x: 656, align: 'right' },
  // These last two need real daylight between them: right-aligned headers
  // ("BALANCE TO FINISH", "RETAINAGE") ran together when they shared an edge.
  balance: { x: 706, align: 'right' },
  retainage: { x: RIGHT - 2, align: 'right' },
};
// Vertical rules sit between columns, not through them.
const DIVIDERS = [MARGIN + 70, 278, 358, 428, 494, 554, 626, 662, 712];

const ROW_H = 12.4;
const HEADER_H = 54;

function sheetHeader(ctx, { pageNumber, pageCount, payApp, project, retainageRate }) {
  const { text, line } = ctx;
  let y = SHEET.height - MARGIN - 8;

  text('CONTINUATION SHEET', MARGIN, y, { size: 10, font: ctx.bold });
  text('DOCUMENT G703', SHEET.width / 2, y, { size: 9, font: ctx.bold, align: 'center' });
  text(`Page ${pageNumber} of ${pageCount}`, RIGHT, y, { size: 9, align: 'right' });
  y -= 11;
  text('Document G702, APPLICATION AND CERTIFICATE FOR PAYMENT, containing', MARGIN, y, { size: 7, color: GREY });
  text(`APPLICATION NUMBER: ${payApp.number}`, 470, y, { size: 8 });
  y -= 9.5;
  text("Contractor's signed Certification is attached.", MARGIN, y, { size: 7, color: GREY });
  text(`APPLICATION DATE: ${asDate(payApp.application_date) || asDate(payApp.submitted_at)}`, 470, y, { size: 8 });
  y -= 9.5;
  text('Use Column I on Contracts where variable retainage for line items may apply.', MARGIN, y, { size: 7, color: GREY });
  text(`PERIOD: ${[asDate(payApp.period_start), asDate(payApp.period_end)].filter(Boolean).join(' – ')}`,
    470, y, { size: 8 });
  y -= 9.5;
  text(`ARCHITECT'S PROJECT NO: ${project.name || ''}`, 470, y, { size: 8 });
  text(`Retainage: ${(Number(retainageRate || 0) * 100).toFixed(2)}%`, MARGIN, y, { size: 7, color: GREY });

  return y - 8;
}

/** The lettered column band plus the stacked column titles. */
function columnHeader(ctx, top) {
  const { text, line, box, vline } = ctx;
  const letterRow = top - 9;
  const headTop = letterRow - 3;
  const headBottom = headTop - HEADER_H;

  box(MARGIN, headBottom, RIGHT - MARGIN, HEADER_H + 13, { fill: BAND, border: RULE });

  const letters = [
    ['A', COL.item.x + 20], ['B', 170], ['C', COL.scheduled.x - 30], ['D', COL.previous.x - 28],
    ['E', COL.thisPeriod.x - 26], ['F', COL.stored.x - 24], ['G', COL.total.x - 30],
    ['H', COL.balance.x - 20], ['I', COL.retainage.x - 22],
  ];
  for (const [letter, x] of letters) text(letter, x, letterRow, { size: 6.5, color: GREY, align: 'center' });

  const stack = (lines, col, size = 5.8) => {
    let yy = headTop - 9;
    for (const l of lines) {
      text(l, col.x, yy, { size, font: ctx.bold, align: col.align === 'right' ? 'right' : 'left' });
      yy -= 6.6;
    }
  };

  stack(['ITEM NO.'], COL.item, 6.2);
  stack(['DESCRIPTION OF WORK'], COL.description, 6.2);
  stack(['SCHEDULED', 'VALUE'], COL.scheduled, 6.2);
  stack(['WORK COMPLETED', 'FROM PREVIOUS', 'APPLICATION (D + E)'], COL.previous, 5.5);
  // Short header lines only: a long right-aligned title runs into its
  // neighbour's column long before the numbers underneath ever would.
  stack(['WORK', 'COMPLETED', 'THIS PERIOD'], COL.thisPeriod);
  stack(['MATERIALS', 'PRESENTLY', 'STORED', '(NOT IN D OR E)'], COL.stored, 5.4);
  stack(['TOTAL COMPLETED', 'AND STORED', 'TO DATE (D+E+F)'], COL.total, 5.5);
  stack(['%', '(G / C)'], COL.percent);
  stack(['BALANCE TO', 'FINISH', '(C - G)'], COL.balance, 5.6);
  stack(['RETAINAGE'], COL.retainage, 5.8);

  for (const x of DIVIDERS) vline(x, headBottom, headTop + 13, 0.6, RULE);
  line(MARGIN, headBottom, RIGHT, 0.9, RULE);
  return headBottom;
}

function drawRow(ctx, y, row) {
  const { text, line, vline, box } = ctx;
  const font = row.kind === 'total' || row.kind === 'grand' ? ctx.bold : ctx.regular;
  const size = row.kind === 'grand' ? 8 : 7.6;

  if (row.kind === 'section') {
    box(MARGIN, y - 3, RIGHT - MARGIN, ROW_H, { fill: BAND, border: HAIR });
    text(row.label, COL.item.x, y + 1, { size: 7.4, font: ctx.bold });
    return y - ROW_H;
  }
  if (row.kind === 'spacer') return y - ROW_H / 2;

  if (row.kind === 'total' || row.kind === 'grand') line(MARGIN, y + ROW_H - 4, RIGHT, 0.8, RULE);

  text(row.itemNo || '', COL.item.x, y + 1, { size, font });
  text(clip(row.description, font, size, COL.description.width), COL.description.x, y + 1, { size, font });
  const cell = (key, value) => text(value, COL[key].x, y + 1, { size, font, align: 'right' });
  cell('scheduled', money(row.scheduledValue));
  cell('previous', money(row.previousCompleted));
  cell('thisPeriod', money(row.thisPeriod));
  cell('stored', money(row.materialsStored));
  cell('total', money(row.totalCompleted));
  cell('percent', pct1(row.percent));
  cell('balance', money(row.balanceToFinish));
  cell('retainage', money(row.retainage));

  if (row.kind !== 'total' && row.kind !== 'grand') line(MARGIN, y - 3, RIGHT, 0.4, HAIR);
  for (const x of DIVIDERS) vline(x, y - 3, y + ROW_H - 3, 0.4, HAIR);
  return y - ROW_H;
}

/** Everything the continuation sheets have to print, in order. */
function continuationRows(view) {
  const rows = [];
  const baseLines = view.lines.filter((l) => l.source !== 'co');
  const coLines = view.lines.filter((l) => l.source === 'co');

  rows.push({ kind: 'section', label: 'CONTRACT LINES' });
  for (const l of baseLines) rows.push({ ...l, kind: 'line' });
  rows.push({ ...view.base, kind: 'total', description: 'TOTALS:', itemNo: '' });

  if (coLines.length) {
    rows.push({ kind: 'spacer' });
    rows.push({ kind: 'section', label: 'WHOLE CHANGE ORDER PACKAGES' });
    for (const l of coLines) rows.push({ ...l, kind: 'line' });
    rows.push({ ...view.changeOrders, kind: 'total', description: 'TOTALS:', itemNo: '' });
  }

  rows.push({ kind: 'spacer' });
  rows.push({ ...view.grand, kind: 'grand', description: 'GRAND TOTALS', itemNo: '' });
  return rows;
}

// ---------------------------------------------------------------------------
// G702
// ---------------------------------------------------------------------------

function drawG702(ctx, { view, project, pageCount }) {
  const { payApp, commitment, summary } = view;
  const { text, line, box, vline } = ctx;
  let y = SHEET.height - MARGIN - 6;

  text('APPLICATION AND CERTIFICATE FOR PAYMENT', MARGIN, y, { size: 11, font: ctx.bold });
  text('DOCUMENT G702', SHEET.width / 2 + 60, y, { size: 9, font: ctx.bold, align: 'center' });
  text(`Page 1 of ${pageCount}`, RIGHT, y, { size: 9, align: 'right' });
  y -= 6;
  line(MARGIN, y, RIGHT, 0.9, RULE);
  y -= 14;

  const C1 = MARGIN;
  const C2 = 280;
  const C3 = 496;
  const C4 = 668;
  const label = (t, x, yy) => text(t, x, yy, { size: 7, color: GREY });
  const value = (t, x, yy, size = 8.5) => text(t, x, yy, { size, font: ctx.bold });

  let ly = y;
  label('TO CONTRACTOR:', C1, ly);
  label('PROJECT:', C2, ly);
  label('APPLICATION NO:', C3, ly);
  value(payApp.number, C3 + 90, ly);
  label('DISTRIBUTION TO:', C4, ly);
  ly -= 11;
  value(commitment.contractor_name || '', C1, ly);
  value(project.name || '', C2, ly);
  label('INVOICE NO:', C3, ly);
  value(payApp.invoice_no || '', C3 + 90, ly);
  ly -= 11;
  text(commitment.contractor_address1 || '', C1, ly, { size: 8 });
  text(project.address1 || '', C2, ly, { size: 8 });
  label('PERIOD:', C3, ly);
  value([asDate(payApp.period_start), asDate(payApp.period_end)].filter(Boolean).join(' – '), C3 + 90, ly, 8);
  ly -= 11;
  text(commitment.contractor_address2 || '', C1, ly, { size: 8 });
  text(project.address2 || '', C2, ly, { size: 8 });
  label('SUBCONTRACT NO:', C3, ly);
  value(commitment.number || '', C3 + 90, ly);
  ly -= 11;
  label('PROJECT NO:', C3, ly);
  value(project.name || '', C3 + 90, ly, 8);

  ly -= 16;
  label('FROM SUBCONTRACTOR:', C1, ly);
  label('SUBCONTRACT DATE:', C2, ly);
  value(asDate(commitment.contract_date), C2 + 88, ly, 8);
  ly -= 11;
  value(commitment.sub_company || '', C1, ly);
  ly -= 11;
  text(commitment.sub_address1 || '', C1, ly, { size: 8 });
  ly -= 11;
  text(commitment.sub_address2 || '', C1, ly, { size: 8 });
  ly -= 15;
  text(`SUBCONTRACT FOR: ${commitment.title || ''}`, C1, ly, { size: 8.5, font: ctx.bold });

  y = ly - 16;
  line(MARGIN, y, RIGHT, 0.9, RULE);
  y -= 14;

  // Left half: the draw request and the nine numbered lines.
  const LEFT_W = 396;
  text("SUBCONTRACTOR'S DRAW REQUEST", C1, y, { size: 9, font: ctx.bold });
  let ry = y;
  const certification = [
    "The undersigned Subcontractor certifies that to the best of the Subcontractor's knowledge,",
    'information and belief the Work covered by this Application for Payment has been',
    'completed in accordance with the Subcontract Documents, that all amounts have been paid by',
    'the Contractor for Work for which previous Certificates for Payment were issued and',
    'payments received from the Owner, and that current payment shown herein is now due.',
  ];
  for (const row of certification) {
    text(row, C3 - 26, ry, { size: 7 });
    ry -= 9;
  }

  y -= 11;
  text('Application is made for payment, as shown below, in connection with the Subcontract.', C1, y, { size: 7.4, color: GREY });
  y -= 9;
  text('Continuation Sheet is attached.', C1, y, { size: 7.4, color: GREY });
  y -= 18;

  const amountX = C1 + LEFT_W;
  const numbered = [
    ['1.', 'Original Contract Sum', summary.originalContractSum, null],
    ['2.', 'Net change by change orders', summary.netChangeByChangeOrders, null],
    ['3.', 'Contract sum to date (Line 1 ± 2)', summary.contractSumToDate, null],
    ['4.', 'Total completed and stored to date', summary.totalCompletedAndStored, '(Column G on G703)'],
    ['5.', 'Retainage:', null, null],
    ['5a', `${(Number(summary.effectiveRetainageRate || 0) * 100).toFixed(2)}% of Completed Work:`,
      summary.retainageOnCompletedWork, null],
    ['5b', `${(Number(commitment.materials_retainage_pct || 0) * 100).toFixed(2)}% of Stored Material:`,
      summary.retainageOnStoredMaterial, null],
    ['', 'Total Retainage (Lines 5a + 5b or Total in Column I of G703)', summary.totalRetainage, null],
    ['6.', 'Total earned less retainage', summary.totalEarnedLessRetainage, '(Line 4 Less Line 5 Total)'],
    ['7.', 'Less previous certificates for payment', summary.previousCertificates, '(Line 6 from prior certificate)'],
    ['8.', 'Current payment due:', summary.currentPaymentDue, null],
    ['9.', 'Balance to finish, including retainage', summary.balanceToFinishIncludingRetainage, '(Line 3 less Line 6)'],
  ];

  for (const [num, labelText, amount, note] of numbered) {
    const isDue = num === '8.';
    const isSub = num === '5a' || num === '5b';
    // The highlighted line 8 band is taller than a normal row; without this it
    // sat on top of the "(Line 6 from prior certificate)" note above it.
    if (isDue) y -= 5;
    if (isDue) box(C1 - 4, y - 4, LEFT_W + 12, 15, { fill: BAND, border: RULE });
    text(num === '5a' || num === '5b' ? '' : num, C1, y, { size: isDue ? 9 : 8, font: isDue ? ctx.bold : ctx.regular });
    text(isSub ? `${num === '5a' ? 'a.' : 'b.'}  ${labelText}` : labelText,
      C1 + (isSub ? 26 : 16), y, { size: isDue ? 9 : 8, font: isDue ? ctx.bold : ctx.regular });
    if (amount !== null && amount !== undefined) {
      text(money(amount), isSub ? amountX - 80 : amountX, y,
        { size: isDue ? 9 : 8, font: isDue ? ctx.bold : ctx.regular, align: 'right' });
    }
    y -= isDue ? 17 : 11;
    if (note) {
      text(note, C1 + 16, y + 1, { size: 6.6, color: GREY });
      y -= 9;
    }
    // A payment made outside the applications is the one figure on this page
    // that cannot be derived from the others. Say what it was.
    if (num === '7.' && Number(summary.priorPaymentAdjustment) > 0) {
      text(`includes ${money(summary.priorPaymentAdjustment)} ${payApp.prior_payment_note || 'paid outside the applications'}`,
        C1 + 16, y + 1, { size: 6.6, color: GREY });
      y -= 9;
    }
  }

  // Right half: signature and notary, as on the workbook.
  let sy = ry - 14;
  text('SUBCONTRACTOR:', C3 - 26, sy, { size: 7, color: GREY });
  text(commitment.sub_company || '', C3 + 60, sy, { size: 8.5, font: ctx.bold });
  sy -= 26;
  ctx.line(C3 - 26, sy, C3 + 150, 0.8, INK);
  if (payApp.signer_name) text(payApp.signer_name, C3 - 24, sy + 4, { size: 8.5, font: ctx.bold });
  text('By:', C3 - 26, sy - 9, { size: 7, color: GREY });
  ctx.line(C3 + 170, sy, RIGHT, 0.8, INK);
  text(asDate(payApp.submitted_at) || asDate(payApp.application_date), C3 + 172, sy + 4, { size: 8.5 });
  text('Date:', C3 + 170, sy - 9, { size: 7, color: GREY });
  sy -= 26;
  text('State of:', C3 - 26, sy, { size: 7.6 });
  ctx.line(C3 + 10, sy - 2, C3 + 150, 0.6, RULE);
  sy -= 13;
  text('County of:', C3 - 26, sy, { size: 7.6 });
  ctx.line(C3 + 10, sy - 2, C3 + 150, 0.6, RULE);
  sy -= 15;
  text('Subscribed and sworn to before', C3 - 26, sy, { size: 7.6 });
  sy -= 11;
  text('me this', C3 - 26, sy, { size: 7.6 });
  ctx.line(C3 + 8, sy - 2, C3 + 90, 0.6, RULE);
  text('day of', C3 + 96, sy, { size: 7.6 });
  ctx.line(C3 + 124, sy - 2, RIGHT, 0.6, RULE);
  sy -= 22;
  text('Notary Public:', C3 - 26, sy, { size: 7.6 });
  ctx.line(C3 + 30, sy - 2, RIGHT, 0.6, RULE);
  sy -= 15;
  text('My Commission expires:', C3 - 26, sy, { size: 7.6 });
  ctx.line(C3 + 70, sy - 2, RIGHT, 0.6, RULE);

  // Change order summary, bottom left.
  const co = view.changeOrderSummary || {};
  let cy = Math.min(y, sy) - 18;
  if (cy < 96) cy = 96;
  const COLA = C1 + 210;
  const COLB = C1 + 320;
  text('CHANGE ORDER SUMMARY', C1 + 16, cy, { size: 8, font: ctx.bold });
  text('ADDITIONS', COLA, cy, { size: 7.4, font: ctx.bold, align: 'right' });
  text('DEDUCTIONS', COLB, cy, { size: 7.4, font: ctx.bold, align: 'right' });
  cy -= 4;
  line(C1, cy, COLB + 10, 0.7, RULE);
  cy -= 11;
  text('Total changes approved', C1 + 16, cy, { size: 7.4 });
  text(money(co.approvedPreviousAdditions || 0), COLA, cy, { size: 7.4, align: 'right' });
  text(money(co.approvedPreviousDeductions || 0), COLB, cy, { size: 7.4, align: 'right' });
  cy -= 9;
  text('in previous months by Owner:', C1 + 16, cy, { size: 7.4 });
  cy -= 12;
  text('Total approved this Month:', C1 + 16, cy, { size: 7.4 });
  text(money(co.approvedThisMonthAdditions || 0), COLA, cy, { size: 7.4, align: 'right' });
  text(money(co.approvedThisMonthDeductions || 0), COLB, cy, { size: 7.4, align: 'right' });
  cy -= 4;
  line(C1 + 140, cy, COLB + 10, 0.7, RULE);
  cy -= 11;
  text('Totals:', COLA - 80, cy, { size: 7.4, font: ctx.bold });
  text(money((co.approvedPreviousAdditions || 0) + (co.approvedThisMonthAdditions || 0)), COLA, cy,
    { size: 7.4, font: ctx.bold, align: 'right' });
  text(money((co.approvedPreviousDeductions || 0) + (co.approvedThisMonthDeductions || 0)), COLB, cy,
    { size: 7.4, font: ctx.bold, align: 'right' });
  cy -= 12;
  text('Net change by change orders:', C1 + 16, cy, { size: 7.4, font: ctx.bold });
  text(money(view.summary.netChangeByChangeOrders), COLA, cy, { size: 7.4, font: ctx.bold, align: 'right' });
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

function paginate(rows, capacity) {
  const pages = [];
  let current = [];
  for (const row of rows) {
    if (current.length >= capacity) {
      pages.push(current);
      current = [];
    }
    current.push(row);
  }
  if (current.length) pages.push(current);
  return pages;
}

function drawApplication(doc, view, project) {
  const { pdf, regular, bold, logo, page } = doc;
  const rows = continuationRows(view);

  // Body height available under the sheet header and the column band.
  const bodyTop = SHEET.height - MARGIN - 8 - 38 - 8 - HEADER_H - 13;
  const capacity = Math.floor((bodyTop - MARGIN - 18) / ROW_H);
  const sheets = paginate(rows, capacity);
  const pageCount = 1 + sheets.length;

  const ctxOf = (p) => Object.assign(p, { regular, bold });

  drawG702(ctxOf(page()), { view, project, pageCount });

  sheets.forEach((sheetRows, i) => {
    const ctx = ctxOf(page());
    const afterHeader = sheetHeader(ctx, {
      pageNumber: i + 2,
      pageCount,
      payApp: view.payApp,
      project,
      retainageRate: view.summary.effectiveRetainageRate,
    });
    let y = columnHeader(ctx, afterHeader) - ROW_H;
    for (const row of sheetRows) y = drawRow(ctx, y, row);
  });

  return pageCount;
}

function drawWaiver(doc, view, project) {
  const { regular, bold, logo, page } = doc;
  const { payApp, commitment, summary } = view;
  const w = Object.assign(page(), { regular, bold });
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

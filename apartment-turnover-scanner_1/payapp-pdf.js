const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

// The two documents a subcontractor's progress payment needs: the application
// for payment with its continuation sheet, and the conditional waiver.
//
// Both are drawn from the same stored figures as the screens, so the period
// dates, the company name and the amount can never disagree between them —
// which is exactly what went wrong on the pack we started from.

const PAGE = { width: 612, height: 792 };
const MARGIN = 40;
const RIGHT = PAGE.width - MARGIN;
const INK = rgb(0.05, 0.08, 0.1);
const GREY = rgb(0.42, 0.46, 0.5);
const RULE = rgb(0.72, 0.76, 0.79);
const BAND = rgb(0.94, 0.95, 0.96);

const logoPath = path.join(__dirname, 'assets', 'precision-logo.png');

const money = (value) =>
  `$${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const percent = (value) => `${(Number(value || 0) * 100).toFixed(1)}%`;

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

  const page = (landscape = false) => {
    const p = pdf.addPage(landscape ? [PAGE.height, PAGE.width] : [PAGE.width, PAGE.height]);
    const text = (value, x, y, { size = 9, font = regular, color = INK, align = 'left' } = {}) => {
      const width = font.widthOfTextAtSize(String(value), size);
      const left = align === 'right' ? x - width : align === 'center' ? x - width / 2 : x;
      p.drawText(String(value), { x: left, y, size, font, color });
    };
    const line = (x1, y, x2, thickness = 0.7, color = RULE) =>
      p.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
    const box = (x, y, w, h, { fill = null, border = RULE, width = 0.7 } = {}) =>
      p.drawRectangle({ x, y, width: w, height: h, color: fill || undefined, borderColor: border, borderWidth: width });
    return { p, text, line, box };
  };

  return { pdf, regular, bold, logo, page };
}

/** The application for payment, with its continuation sheet. */
async function buildApplicationPdf(view, project) {
  const { payApp, commitment, lines, base, changeOrders, grand, summary } = view;
  const { pdf, regular, bold, logo, page } = await newDocument();

  const period = [asDate(payApp.period_start), asDate(payApp.period_end)].filter(Boolean).join(' – ');

  // ---------- Page 1: the application ----------
  const a = page();
  let y = PAGE.height - MARGIN;

  if (logo) {
    const w = 120;
    const h = (logo.height / logo.width) * w;
    a.p.drawImage(logo, { x: MARGIN, y: y - h + 4, width: w, height: h });
  }
  a.text('APPLICATION AND CERTIFICATE FOR PAYMENT', RIGHT, y - 8, { size: 13, font: bold, align: 'right' });
  a.text(`Application No. ${payApp.number}`, RIGHT, y - 24, { size: 10, align: 'right' });
  if (payApp.invoice_no) a.text(`Invoice No. ${payApp.invoice_no}`, RIGHT, y - 37, { size: 9, align: 'right' });

  y -= 62;
  a.line(MARGIN, y, RIGHT, 1.2, INK);
  y -= 16;

  // Parties
  const col2 = MARGIN + 270;
  const pair = (label, value, x, yy) => {
    a.text(label, x, yy, { size: 7.5, color: GREY });
    a.text(value || '', x, yy - 11, { size: 9.5 });
  };
  pair('TO CONTRACTOR:', commitment.contractor_name, MARGIN, y);
  pair('PROJECT:', project.name, col2, y);
  a.text(commitment.contractor_address1 || '', MARGIN, y - 22, { size: 9 });
  a.text(project.address1 || '', col2, y - 22, { size: 9 });
  a.text(commitment.contractor_address2 || '', MARGIN, y - 33, { size: 9 });
  a.text(project.address2 || '', col2, y - 33, { size: 9 });

  y -= 54;
  pair('FROM SUBCONTRACTOR:', commitment.sub_company, MARGIN, y);
  pair('PERIOD:', period, col2, y);
  a.text(commitment.sub_address1 || '', MARGIN, y - 22, { size: 9 });
  a.text(`SUBCONTRACT NO: ${commitment.number || ''}`, col2, y - 22, { size: 9 });
  a.text(commitment.sub_address2 || '', MARGIN, y - 33, { size: 9 });
  a.text(`SUBCONTRACT FOR: ${commitment.title || ''}`, col2, y - 33, { size: 9 });

  y -= 52;
  a.line(MARGIN, y, RIGHT, 1.2, INK);
  y -= 18;

  a.text("SUBCONTRACTOR'S DRAW REQUEST", MARGIN, y, { size: 9.5, font: bold });
  y -= 12;
  a.text('Application is made for payment, as shown below, in connection with the Subcontract. Continuation sheet is attached.',
    MARGIN, y, { size: 8, color: GREY });
  y -= 20;

  // The nine lines, as they are on every application for payment.
  const rows = [
    ['1.', 'Original contract sum', summary.originalContractSum],
    ['2.', 'Net change by change orders', summary.netChangeByChangeOrders],
    ['3.', 'Contract sum to date (line 1 ± 2)', summary.contractSumToDate],
    ['4.', 'Total completed and stored to date', summary.totalCompletedAndStored],
    // The rate printed here is what retainage ACTUALLY came to across every
    // line billed, not the contract rate. Where retainage was waived on a
    // change order the two differ, and the document should say the true one.
    ['5.', `Retainage (${percent(summary.effectiveRetainageRate)} of completed work)`, summary.totalRetainage],
    ['6.', 'Total earned less retainage (line 4 less line 5)', summary.totalEarnedLessRetainage],
    ['7.', 'Less previous certificates for payment', summary.previousCertificates],
    ['8.', 'CURRENT PAYMENT DUE', summary.currentPaymentDue],
    ['9.', 'Balance to finish, including retainage', summary.balanceToFinishIncludingRetainage],
  ];

  for (const [number, label, value] of rows) {
    const isDue = number === '8.';
    if (isDue) a.box(MARGIN, y - 6, RIGHT - MARGIN, 20, { fill: BAND, border: RULE });
    a.text(number, MARGIN + 6, y, { size: isDue ? 10 : 9, font: isDue ? bold : regular });
    a.text(label, MARGIN + 26, y, { size: isDue ? 10 : 9, font: isDue ? bold : regular });
    a.text(money(value), RIGHT - 6, y, { size: isDue ? 10 : 9, font: isDue ? bold : regular, align: 'right' });
    y -= isDue ? 24 : 17;
    if (!isDue) a.line(MARGIN, y + 5, RIGHT);

    // A payment made outside the application chain is the one figure on this
    // page nobody can derive from the others. Say what it was, under line 7,
    // rather than leaving a reader to wonder why line 7 beats the last line 6.
    if (number === '7.' && Number(summary.priorPaymentAdjustment) > 0) {
      const note = payApp.prior_payment_note
        || 'paid outside the application chain';
      a.text(
        `includes ${money(summary.priorPaymentAdjustment)} ${note}`,
        MARGIN + 26, y + 9, { size: 7.5, color: GREY }
      );
      y -= 10;
    }
  }

  y -= 14;
  a.line(MARGIN, y, RIGHT, 1.2, INK);
  y -= 16;

  const certification = "The undersigned Subcontractor certifies that to the best of the Subcontractor's knowledge, information and belief the Work covered by this Application for Payment has been completed in accordance with the Subcontract Documents, that all amounts have been paid by the Subcontractor for Work for which previous Certificates for Payment were issued and payments received, and that current payment shown herein is now due.";
  for (const row of wrap(certification, regular, 8.5, RIGHT - MARGIN)) {
    a.text(row, MARGIN, y, { size: 8.5 });
    y -= 11;
  }

  y -= 26;
  a.text('SUBCONTRACTOR:', MARGIN, y, { size: 8, color: GREY });
  a.text(commitment.sub_company, MARGIN + 100, y, { size: 9.5, font: bold });
  y -= 30;
  a.line(MARGIN, y, MARGIN + 240, 0.9, INK);
  a.line(MARGIN + 280, y, MARGIN + 420, 0.9, INK);
  a.text('SIGNATURE', MARGIN, y - 11, { size: 7.5, color: GREY });
  a.text('DATE', MARGIN + 280, y - 11, { size: 7.5, color: GREY });
  if (payApp.signer_name) {
    a.text(payApp.signer_name, MARGIN + 2, y + 5, { size: 10, font: bold });
    a.text(payApp.signer_title || '', MARGIN + 2, y - 22, { size: 8, color: GREY });
    a.text(asDate(payApp.submitted_at), MARGIN + 282, y + 5, { size: 10 });
    a.text('Submitted electronically', MARGIN + 282, y - 22, { size: 7.5, color: GREY });
  }

  // ---------- Continuation sheet ----------
  // Landscape, with every money column right-aligned to its own edge.
  const WIDE_RIGHT = PAGE.height - MARGIN; // 752pt on a sideways letter page
  const cols = {
    item: MARGIN, description: MARGIN + 64,
    scheduled: 405, previous: 478, thisPeriod: 550, stored: 608,
    total: 660, percent: 698, retainage: WIDE_RIGHT,
  };

  let sheet = null;
  let sy = 0;

  const header = () => {
    sheet = page(true);
    sy = PAGE.width - MARGIN;
    sheet.text('CONTINUATION SHEET', MARGIN, sy - 8, { size: 11, font: bold });
    sheet.text(`${commitment.sub_company} · Application No. ${payApp.number}${period ? ` · ${period}` : ''}`,
      WIDE_RIGHT, sy - 8, { size: 8.5, align: 'right' });
    sy -= 26;

    sheet.box(MARGIN, sy - 22, WIDE_RIGHT - MARGIN, 22, { fill: BAND, border: INK, width: 0.8 });
    const head = (label, x, align = 'left') => sheet.text(label, x, sy - 15, { size: 7, font: bold, align });
    head('ITEM NO.', cols.item + 3);
    head('DESCRIPTION OF WORK', cols.description + 3);
    head('SCHEDULED', cols.scheduled, 'right');
    head('PREVIOUS', cols.previous, 'right');
    head('THIS PERIOD', cols.thisPeriod, 'right');
    head('STORED', cols.stored, 'right');
    head('TOTAL', cols.total, 'right');
    head('%', cols.percent, 'right');
    head('RETAINAGE', cols.retainage, 'right');
    sy -= 36;
  };

  const row = (line, { isTotal = false, label = null } = {}) => {
    if (sy < 70) header();
    if (isTotal) sheet.box(MARGIN, sy - 5, WIDE_RIGHT - MARGIN, 18, { fill: BAND, border: RULE });
    const font = isTotal ? bold : regular;
    const size = 8;
    if (!isTotal) sheet.text(line.itemNo || '', cols.item + 3, sy, { size, font });
    sheet.text(label || (line.description || '').slice(0, 52), cols.description + 3, sy, { size, font });
    sheet.text(money(line.scheduledValue), cols.scheduled, sy, { size, font, align: 'right' });
    sheet.text(money(line.previousCompleted), cols.previous, sy, { size, font, align: 'right' });
    sheet.text(money(line.thisPeriod), cols.thisPeriod, sy, { size, font, align: 'right' });
    sheet.text(money(line.materialsStored), cols.stored, sy, { size, font, align: 'right' });
    sheet.text(money(line.totalCompleted), cols.total, sy, { size, font, align: 'right' });
    sheet.text(percent(line.percent), cols.percent, sy, { size, font, align: 'right' });
    sheet.text(money(line.retainage), cols.retainage, sy, { size, font, align: 'right' });
    sy -= isTotal ? 22 : 14;
    if (!isTotal) sheet.line(MARGIN, sy + 4, WIDE_RIGHT, 0.4);
  };

  const section = (title) => {
    if (sy < 96) header();
    sy -= 6;
    sheet.text(title, MARGIN + 3, sy, { size: 7.5, font: bold, color: GREY });
    sy -= 14;
  };

  header();
  section('CONTRACT LINES');
  for (const l of lines.filter((l) => l.source !== 'co')) row(l);
  row(base, { isTotal: true, label: 'TOTAL — CONTRACT LINES' });

  const coLines = lines.filter((l) => l.source === 'co');
  if (coLines.length) {
    section('CHANGE ORDERS');
    for (const l of coLines) row(l);
    row(changeOrders, { isTotal: true, label: 'TOTAL — CHANGE ORDERS' });
  }

  sy -= 4;
  row(grand, { isTotal: true, label: 'GRAND TOTAL' });

  // Footer on every page
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    const edge = p.getWidth() - MARGIN;
    p.drawText(`${commitment.sub_company} · Application ${payApp.number}`,
      { x: MARGIN, y: 26, size: 7.5, font: regular, color: GREY });
    const label = `Page ${i + 1} of ${pages.length}`;
    p.drawText(label, { x: edge - regular.widthOfTextAtSize(label, 7.5), y: 26, size: 7.5, font: regular, color: GREY });
  });

  return Buffer.from(await pdf.save());
}

/**
 * Florida's conditional waiver on progress payment. The wording follows the
 * form Precision already issues; the figures and dates come from the
 * application, so the period on the waiver is the period on the pay app.
 */
async function buildWaiverPdf(view, project) {
  const { payApp, commitment, summary } = view;
  const { pdf, regular, bold, logo, page } = await newDocument();
  const w = page();
  let y = PAGE.height - MARGIN - 10;

  if (logo) {
    const width = 110;
    const height = (logo.height / logo.width) * width;
    w.p.drawImage(logo, { x: MARGIN, y: y - height + 4, width, height });
    y -= height + 22;
  }

  w.text('CONDITIONAL WAIVER AND RELEASE ON PROGRESS PAYMENT', PAGE.width / 2, y, {
    size: 12.5, font: bold, align: 'center',
  });
  y -= 20;
  w.text(`Project: ${project.name}`, PAGE.width / 2, y, { size: 10, align: 'center' });
  y -= 14;
  w.text(`Pay Application #${payApp.number}`, PAGE.width / 2, y, { size: 10, align: 'center' });
  y -= 24;

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
    for (const row of wrap(paragraph, regular, 9, RIGHT - MARGIN)) {
      w.text(row, MARGIN, y, { size: 9 });
      y -= 12.5;
    }
    y -= 10;
  }

  const executed = payApp.submitted_at ? new Date(payApp.submitted_at) : new Date();
  y -= 6;
  w.text(`Executed this the ${executed.getUTCDate()} day of ${MONTHS[executed.getUTCMonth()]}, ${executed.getUTCFullYear()}.`,
    MARGIN, y, { size: 9 });

  y -= 34;
  w.text(commitment.sub_company, MARGIN, y, { size: 10, font: bold });
  w.text('(Company name)', MARGIN + 260, y, { size: 8, color: GREY });

  y -= 34;
  w.line(MARGIN, y, MARGIN + 240, 0.9, INK);
  w.text('By (Signature)', MARGIN, y - 11, { size: 8, color: GREY });
  if (payApp.signer_name) w.text(payApp.signer_name, MARGIN + 2, y + 5, { size: 10, font: bold });

  y -= 34;
  w.line(MARGIN, y, MARGIN + 240, 0.9, INK);
  w.text('Title', MARGIN, y - 11, { size: 8, color: GREY });
  if (payApp.signer_title) w.text(payApp.signer_title, MARGIN + 2, y + 5, { size: 10 });

  // Notary block
  y -= 46;
  w.text('STATE OF ______________________', MARGIN, y, { size: 9 });
  y -= 16;
  w.text('COUNTY OF ____________________', MARGIN, y, { size: 9 });
  y -= 24;
  w.text('This instrument was acknowledged before me the ______ day of ____________, 20____.', MARGIN, y, { size: 9 });
  y -= 40;
  w.line(MARGIN, y, MARGIN + 240, 0.9, INK);
  w.text('Notary Public', MARGIN, y - 11, { size: 8, color: GREY });
  y -= 30;
  w.text('My commission expires: ____________________', MARGIN, y, { size: 9 });

  return Buffer.from(await pdf.save());
}

module.exports = { buildApplicationPdf, buildWaiverPdf };

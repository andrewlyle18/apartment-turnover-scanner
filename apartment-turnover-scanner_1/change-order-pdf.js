const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

// The subcontract change order, laid out to match the document Precision
// already issues, with the backup appended behind it — because a change order
// and its quote getting separated is how a change order stops being agreed.

const PAGE = { width: 612, height: 792 }; // US Letter
const MARGIN = 54;
const RIGHT = PAGE.width - MARGIN;
const INK = rgb(0.05, 0.08, 0.1);
const GREY = rgb(0.42, 0.46, 0.5);
const RULE = rgb(0.75, 0.78, 0.81);

const logoPath = path.join(__dirname, 'assets', 'precision-logo.png');

const money = (value) =>
  `$${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const asDate = (value) => {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d)) return String(value);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
};

const STATUS_LABEL = {
  pending: 'Pending – In Review',
  approved: 'Approved',
  rejected: 'Rejected',
};

/** Wraps text to a width, so a long description doesn't run off the page. */
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

async function buildChangeOrderPdf(context) {
  const { changeOrder: co, lines, attachments, sums } = context;

  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let logo = null;
  try {
    if (fs.existsSync(logoPath)) logo = await pdf.embedPng(fs.readFileSync(logoPath));
  } catch (err) {
    logo = null; // the document reads fine without it
  }

  const number = String(co.number || '').replace(/[^0-9]/g, '').padStart(3, '0');
  const title = `CCO #${number}`;

  const newPage = () => {
    const page = pdf.addPage([PAGE.width, PAGE.height]);
    const text = (value, x, y, { size = 9, font = regular, color = INK, align = 'left' } = {}) => {
      const width = font.widthOfTextAtSize(String(value), size);
      const left = align === 'right' ? x - width : align === 'center' ? x - width / 2 : x;
      page.drawText(String(value), { x: left, y, size, font, color });
      return width;
    };
    const line = (x1, y, x2, thickness = 0.75, color = RULE) =>
      page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
    return { page, text, line };
  };

  // ---------- Page 1 ----------
  const p1 = newPage();
  let y = PAGE.height - MARGIN;

  if (logo) {
    const w = 132;
    const h = (logo.height / logo.width) * w;
    p1.page.drawImage(logo, { x: MARGIN, y: y - h + 6, width: w, height: h });
    y -= h;
  } else {
    p1.text(co.contractor_name || 'Precision Builders, LLC', MARGIN, y - 10, { size: 15, font: bold });
    y -= 22;
  }

  p1.text(co.contractor_name || 'Precision Builders, LLC', MARGIN, y - 6, { size: 7.5 });
  p1.text(co.contractor_address1 || '', MARGIN, y - 17, { size: 7.5 });
  p1.text(co.contractor_address2 || '', MARGIN, y - 28, { size: 7.5 });

  let rightY = PAGE.height - MARGIN - 14;
  p1.text(title, RIGHT, rightY, { size: 18, font: bold, align: 'right' });
  rightY -= 16;
  p1.text(`Project: ${co.project_name || ''}`, RIGHT, rightY, { size: 8, align: 'right' });
  if (co.project_address1) {
    rightY -= 11;
    p1.text(co.project_address1, RIGHT, rightY, { size: 8, align: 'right' });
  }
  if (co.project_address2) {
    rightY -= 11;
    p1.text(co.project_address2, RIGHT, rightY, { size: 8, align: 'right' });
  }

  y -= 56;

  // Status banner
  const bannerHeight = 26;
  p1.page.drawRectangle({
    x: MARGIN, y: y - bannerHeight, width: RIGHT - MARGIN, height: bannerHeight,
    borderColor: INK, borderWidth: 1,
  });
  p1.text(STATUS_LABEL[co.status] || co.status, PAGE.width / 2, y - 17, { size: 12, font: bold, align: 'center' });
  y -= bannerHeight + 22;

  p1.line(MARGIN, y + 12, RIGHT, 1.4, INK);
  p1.text(`Subcontract Change Order #${number}: ${co.title}`, PAGE.width / 2, y - 6, {
    size: 13, font: bold, align: 'center',
  });
  y -= 20;
  p1.line(MARGIN, y, RIGHT, 1.4, INK);
  y -= 6;

  // Two columns of label / value, as on the original.
  const colX = [MARGIN + 2, MARGIN + 118, MARGIN + 292, MARGIN + 404];
  const pairs = [
    ['CONTRACT COMPANY:', co.sub_company, 'CONTRACT FOR:',
      [co.commitment_number, co.commitment_title].filter(Boolean).join(': ')],
    ['DATE CREATED:', asDate(co.created_at), 'CREATED BY:', co.created_by || ''],
    ['CONTRACT STATUS:', STATUS_LABEL[co.status] || co.status, 'REVISION:', String(co.revision || 0)],
    ['REQUEST RECEIVED FROM:', co.requested_from || '', 'LOCATION:', co.location || ''],
    ['FINAL REVIEWER:', co.final_reviewer || '', 'REVIEWED BY:', co.reviewed_by || ''],
    ['DUE DATE:', asDate(co.due_date), 'CHANGE REASON:', co.reason || ''],
    ['ACCOUNTING METHOD:', co.accounting_method || 'Amount Based', 'SCHEDULE IMPACT:',
      `${co.schedule_impact_days || 0} days`],
  ];

  for (const [labelA, valueA, labelB, valueB] of pairs) {
    p1.text(labelA, colX[0], y - 12, { size: 7.5, color: GREY });
    p1.text(valueA || '', colX[1], y - 12, { size: 9 });
    p1.text(labelB, colX[2], y - 12, { size: 7.5, color: GREY });
    p1.text(valueB || '', colX[3], y - 12, { size: 9 });
    y -= 26;
    p1.line(MARGIN, y, RIGHT);
  }

  y -= 18;
  p1.text('TOTAL AMOUNT:', RIGHT - 120, y, { size: 9, font: bold, align: 'right' });
  p1.text(money(sums.thisChangeOrder), RIGHT, y, { size: 10, font: bold, align: 'right' });
  y -= 14;
  p1.line(MARGIN, y, RIGHT);

  y -= 18;
  p1.text('DESCRIPTION:', MARGIN, y, { size: 7.5, color: GREY });
  y -= 12;
  for (const row of wrap(co.description || '', regular, 9, RIGHT - MARGIN)) {
    p1.text(row, MARGIN, y, { size: 9 });
    y -= 12;
  }

  y -= 8;
  p1.line(MARGIN, y, RIGHT);
  y -= 16;
  p1.text('ATTACHMENTS:', MARGIN, y, { size: 7.5, color: GREY });
  y -= 12;
  if (attachments.length) {
    for (const a of attachments) {
      p1.text(a.filename, MARGIN, y, { size: 9, color: rgb(0.12, 0.33, 0.6) });
      y -= 12;
    }
  } else {
    p1.text('None', MARGIN, y, { size: 9, color: GREY });
    y -= 12;
  }
  y -= 6;
  p1.line(MARGIN, y, RIGHT, 1.6, INK);

  // ---------- Page 2 ----------
  const p2 = newPage();
  let y2 = PAGE.height - MARGIN;

  if (logo) {
    const w = 132;
    const h = (logo.height / logo.width) * w;
    p2.page.drawImage(logo, { x: MARGIN, y: y2 - h + 6, width: w, height: h });
    y2 -= h + 18;
  } else {
    y2 -= 40;
  }
  p2.text(title, RIGHT, PAGE.height - MARGIN - 14, { size: 18, font: bold, align: 'right' });

  p2.text('CHANGE ORDER LINE ITEMS:', MARGIN, y2, { size: 8, font: bold });
  y2 -= 14;

  // Line items table
  const cols = { num: MARGIN, code: MARGIN + 26, description: MARGIN + 230, amount: RIGHT };
  const headerHeight = 18;
  p2.page.drawRectangle({
    x: MARGIN, y: y2 - headerHeight, width: RIGHT - MARGIN, height: headerHeight,
    borderColor: INK, borderWidth: 0.75,
  });
  p2.text('#', cols.num + 8, y2 - 13, { size: 8 });
  p2.text('Budget Code', cols.code + 80, y2 - 13, { size: 8, align: 'center' });
  p2.text('Description', cols.description + 110, y2 - 13, { size: 8, align: 'center' });
  p2.text('Amount', cols.amount - 6, y2 - 13, { size: 8, align: 'right' });
  y2 -= headerHeight;

  const rows = lines.length
    ? lines
    : [{ budget_code: '', description: co.title, amount: co.amount }];

  rows.forEach((row, i) => {
    const height = 20;
    p2.page.drawRectangle({
      x: MARGIN, y: y2 - height, width: RIGHT - MARGIN, height,
      borderColor: RULE, borderWidth: 0.6,
    });
    p2.text(String(i + 1), cols.num + 8, y2 - 14, { size: 8.5 });
    p2.text(row.budget_code || '', cols.code + 6, y2 - 14, { size: 8.5 });
    p2.text(row.description || '', cols.description + 6, y2 - 14, { size: 8.5 });
    p2.text(money(row.amount), cols.amount - 6, y2 - 14, { size: 8.5, align: 'right' });
    y2 -= height;
  });

  const totalHeight = 20;
  p2.page.drawRectangle({
    x: MARGIN, y: y2 - totalHeight, width: RIGHT - MARGIN, height: totalHeight,
    borderColor: RULE, borderWidth: 0.6,
  });
  p2.text('Grand Total:', cols.amount - 90, y2 - 14, { size: 8.5, align: 'right' });
  p2.text(money(sums.thisChangeOrder), cols.amount - 6, y2 - 14, { size: 8.5, align: 'right' });
  y2 -= totalHeight + 40;

  // Contract sums. Every figure here is derived, never entered.
  p2.line(MARGIN, y2, RIGHT, 1.6, INK);
  y2 -= 16;
  const sumRows = [
    ['The original (Contract Sum)', sums.originalContractSum],
    ['Net change by previously authorized Change Orders', sums.netChangeByPrevious],
    ['The contract sum prior to this Change Order was', sums.contractSumPrior],
    [`The contract sum will ${co.status === 'approved' ? '' : 'not '}be changed by this Change Order in the amount of`, sums.thisChangeOrder],
    ['The new contract sum including this Change Order will be', sums.newContractSum],
  ];
  for (const [label, value] of sumRows) {
    p2.text(label, MARGIN, y2, { size: 8.5 });
    p2.text(money(value), RIGHT, y2, { size: 8.5, align: 'right' });
    y2 -= 17;
  }

  // Signatures
  let sigY = 190;
  const rightCol = MARGIN + 300;
  p2.text(co.contractor_name || '', MARGIN, sigY, { size: 8.5, font: bold });
  p2.text(co.contractor_address1 || '', MARGIN, sigY - 11, { size: 8.5 });
  p2.text(co.contractor_address2 || '', MARGIN, sigY - 22, { size: 8.5 });
  p2.text(co.sub_company || '', rightCol, sigY, { size: 8.5, font: bold });
  p2.text(co.sub_address1 || '', rightCol, sigY - 11, { size: 8.5 });
  p2.text(co.sub_address2 || '', rightCol, sigY - 22, { size: 8.5 });

  sigY -= 82;
  p2.line(MARGIN, sigY, MARGIN + 230, 0.9, INK);
  p2.line(rightCol, sigY, rightCol + 230, 0.9, INK);
  p2.text('SIGNATURE', MARGIN, sigY - 11, { size: 7.5, color: GREY });
  p2.text('DATE', MARGIN + 230, sigY - 11, { size: 7.5, color: GREY, align: 'right' });
  p2.text('SIGNATURE', rightCol, sigY - 11, { size: 7.5, color: GREY });
  p2.text('DATE', rightCol + 230, sigY - 11, { size: 7.5, color: GREY, align: 'right' });

  // Footers on the two generated pages, numbered the way the original is —
  // the attachments that follow are backup, not part of the document.
  const generated = pdf.getPages();
  generated.forEach((page, i) => {
    page.drawText(co.contractor_name || '', { x: MARGIN, y: 48, size: 8, font: regular, color: INK });
    const label = `Page ${i + 1} of ${generated.length}`;
    const width = regular.widthOfTextAtSize(label, 8);
    page.drawText(label, { x: PAGE.width / 2 - width / 2, y: 48, size: 8, font: regular, color: INK });
  });

  // ---------- The backup ----------
  for (const attachment of attachments) {
    const type = String(attachment.content_type || '').toLowerCase();
    try {
      if (type.includes('pdf')) {
        const source = await PDFDocument.load(attachment.bytes, { ignoreEncryption: true });
        const copied = await pdf.copyPages(source, source.getPageIndices());
        copied.forEach((page) => pdf.addPage(page));
      } else if (type.includes('png') || type.includes('jpeg') || type.includes('jpg')) {
        const image = type.includes('png')
          ? await pdf.embedPng(attachment.bytes)
          : await pdf.embedJpg(attachment.bytes);
        const page = pdf.addPage([PAGE.width, PAGE.height]);
        // Fit inside the margins, whichever way round the picture is.
        const maxW = PAGE.width - MARGIN * 2;
        const maxH = PAGE.height - MARGIN * 2 - 20;
        const scale = Math.min(maxW / image.width, maxH / image.height, 1);
        const w = image.width * scale;
        const h = image.height * scale;
        page.drawImage(image, { x: (PAGE.width - w) / 2, y: (PAGE.height - h) / 2 - 8, width: w, height: h });
        page.drawText(attachment.filename, {
          x: MARGIN, y: PAGE.height - MARGIN + 6, size: 8, font: regular, color: GREY,
        });
      } else {
        // A .docx or .xlsx can't be printed into a PDF here. Say so on the
        // page rather than dropping it silently.
        const page = pdf.addPage([PAGE.width, PAGE.height]);
        page.drawText('ATTACHMENT', { x: MARGIN, y: PAGE.height - MARGIN, size: 8, font: bold, color: GREY });
        page.drawText(attachment.filename, { x: MARGIN, y: PAGE.height - MARGIN - 24, size: 12, font: bold, color: INK });
        page.drawText('This file is attached to the change order in the app but cannot be printed into a PDF.',
          { x: MARGIN, y: PAGE.height - MARGIN - 44, size: 9, font: regular, color: GREY });
        page.drawText('Download it from the change order to open it.',
          { x: MARGIN, y: PAGE.height - MARGIN - 58, size: 9, font: regular, color: GREY });
      }
    } catch (err) {
      const page = pdf.addPage([PAGE.width, PAGE.height]);
      page.drawText(`Could not include ${attachment.filename}`, {
        x: MARGIN, y: PAGE.height - MARGIN, size: 10, font: bold, color: INK,
      });
    }
  }

  return Buffer.from(await pdf.save());
}

module.exports = { buildChangeOrderPdf };

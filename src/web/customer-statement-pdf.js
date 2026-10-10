'use strict';
const PDFDocument = require('pdfkit');

async function sendCustomerStatementPdf(res, report, company = {}, formatDate = value => String(value || '')) {
  const customer = String(report.selected.customer_name || 'customer').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'customer';
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 34, bufferPages: true,
    info: { Title: `Customer Statement - ${report.selected.customer_name}`, Author: company.name || 'Work Master' } });
  const chunks = [];
  const complete = new Promise((resolve, reject) => {
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  renderStatement(doc, report, company || {}, formatDate);
  doc.end();
  const buffer = await complete;
  res.set('Cache-Control', 'private, no-store');
  res.attachment(`${customer}-statement.pdf`);
  res.type('application/pdf');
  return res.send(buffer);
}
function renderStatement(doc, report, company, formatDate) {
  const left = 34;
  const width = doc.page.width - left * 2;
  const bottom = doc.page.height - 54;
  const lineHeight = 11;
  const padding = 6;
  const teal = '#0f766e';
  const weights = [24, 65, 65, 95, 285, 80, 80, 80];
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const widths = weights.map(value => value * width / totalWeight);
  const headers = ['#', 'Date', 'Type', 'Reference', 'Description', 'Debit', 'Credit', 'Balance'];
  const amount = value => Number(value || 0).toLocaleString('en-UG', { maximumFractionDigits: 0 });
  let y;

  function header(first = false) {
    doc.rect(0, 0, doc.page.width, 6).fill(teal);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(teal).text(company.name || 'Work Master', left, 27, { width, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(first ? 26 : 18).fillColor('#1f2937').text('Customer Statement', left, 49, { lineBreak: false });
    y = first ? 89 : 80;
    if (first) {
      const contact = [company.address, company.phone, company.email, company.website].filter(Boolean).join('  |  ');
      if (contact) {
        doc.font('Helvetica').fontSize(8).fillColor('#6b7280').text(contact, left, y, { width });
        y = doc.y + 15;
      }
      doc.font('Helvetica').fontSize(8).fillColor('#6b7280').text('PREPARED FOR', left, y, { lineBreak: false });
      y += 15;
      doc.font('Helvetica-Bold').fontSize(16).fillColor('#1f2937').text(report.selected.customer_name, left, y, { width });
      y = doc.y + 8;
      if (report.selected.customer_id) {
        doc.font('Helvetica').fontSize(9).fillColor('#6b7280').text(`Customer ID: ${report.selected.customer_id}`, left, y, { width });
        y = doc.y + 8;
      }
      const from = report.filters.statement_from;
      const to = report.filters.statement_to;
      const period = from || to ? `${from ? formatDate(from) : 'Beginning'} to ${to ? formatDate(to) : 'Latest'}` : 'All transactions';
      doc.font('Helvetica').fontSize(9).fillColor('#6b7280').text(`Period: ${period}   |   Currency: UGX`, left, y, { width });
      y = doc.y + 18;
      const metrics = [['Total debits', report.statement.reduce((sum, row) => sum + Number(row.debit || 0), 0)],
        ['Total credits', report.statement.reduce((sum, row) => sum + Number(row.credit || 0), 0)], ['Closing balance', report.statementBalance]];
      metrics.forEach(([label, value], index) => {
        const x = left + index * (width / 3);
        const featured = index === 2;
        doc.roundedRect(x, y, width / 3 - 10, 54, 5).fill(featured ? teal : '#eef6f5');
        doc.font('Helvetica').fontSize(8).fillColor(featured ? '#ffffff' : '#6b7280').text(label.toUpperCase(), x + 12, y + 10, { lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(16).fillColor(featured ? '#ffffff' : '#115e59').text(amount(value), x + 12, y + 27, { width: width / 3 - 34, lineBreak: false });
      });
      y += 72;
    } else {
      doc.font('Helvetica').fontSize(9).fillColor('#6b7280').text(report.selected.customer_name, left, y, { width });
      y = doc.y + 12;
    }
    doc.rect(left, y, width, 26).fill(teal);
    let x = left;
    headers.forEach((label, index) => {
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#FFFFFF').text(label, x + padding, y + 9, { width: widths[index] - padding * 2, align: index >= 5 ? 'right' : 'left', lineBreak: false });
      x += widths[index];
    });
    y += 26;
  }
  function newPage() { doc.addPage(); header(); }
  function wrap(value, column) {
    doc.font('Helvetica').fontSize(8);
    const max = widths[column] - padding * 2;
    const lines = [];
    for (const paragraph of String(value ?? '').split(/\r?\n/)) {
      let line = '';
      for (const character of paragraph) {
        if (line && doc.widthOfString(line + character) > max) {
          const space = line.lastIndexOf(' ');
          if (space > 0) { lines.push(line.slice(0, space)); line = line.slice(space + 1); }
          else { lines.push(line); line = ''; }
        }
        line += character;
      }
      lines.push(line);
    }
    return lines;
  }
  function drawRow(cells, index, total = false) {
    const lines = cells.map(wrap);
    const count = Math.max(...lines.map(cell => cell.length));
    let offset = 0;
    while (offset < count) {
      if (bottom - y < lineHeight + padding * 2) newPage();
      const length = Math.min(count - offset, Math.floor((bottom - y - padding * 2) / lineHeight));
      const height = length * lineHeight + padding * 2;
      doc.rect(left, y, width, height).fill(total ? '#e8f3f1' : index % 2 === 0 ? '#F8FAFC' : '#FFFFFF');
      let x = left;
      lines.forEach((cell, column) => {
        doc.font(total ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor(column >= 5 ? teal : '#334155');
        cell.slice(offset, offset + length).forEach((line, number) => {
          doc.text(line, x + padding, y + padding + number * lineHeight, { width: widths[column] - padding * 2, align: column >= 5 ? 'right' : 'left', lineBreak: false });
        });
        x += widths[column];
      });
      y += height;
      doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.4).strokeColor('#E2E8F0').stroke();
      offset += length;
      if (offset < count) newPage();
    }
  }
  header(true);
  report.statement.forEach((row, index) => drawRow([
    index + 1, formatDate(row.date), row.type, row.reference, row.description,
    row.debit ? amount(row.debit) : '', row.credit ? amount(row.credit) : '', amount(row.balance),
  ], index));
  if (!report.statement.length) drawRow(['', '', '', '', 'No statement entries found.', '', '', ''], 0);
  drawRow(['', '', '', '', 'CLOSING BALANCE', '', '', amount(report.statementBalance)], report.statement.length, true);
  const range = doc.bufferedPageRange();
  for (let page = range.start; page < range.start + range.count; page++) {
    doc.switchToPage(page);
    const originalBottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.moveTo(left, doc.page.height - 37).lineTo(left + width, doc.page.height - 37).strokeColor('#CBD5E1').stroke();
    doc.font('Helvetica').fontSize(8).fillColor('#64748B').text('Balances include transactions before the selected period.', left, doc.page.height - 27, { lineBreak: false });
    doc.text(`Page ${page + 1} of ${range.count}`, left + width - 110, doc.page.height - 27, { width: 110, align: 'right', lineBreak: false });
    doc.page.margins.bottom = originalBottomMargin;
  }
}

module.exports = { sendCustomerStatementPdf };

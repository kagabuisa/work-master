'use strict';
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const columns = ['Date', 'Account Code', 'Account Name', 'Debit', 'Credit', 'Balance', 'Voucher Type', 'Voucher No.', 'Party', 'Remarks'];
const values = row => [row.posting_date, row.account_code, row.account_name, Number(row.debit || 0), Number(row.credit || 0), Number(row.running_balance || 0), row.voucher_type, row.voucher_no || row.voucher_id || '', row.party_name || row.party_id || '', row.remarks || ''];
const csvCell = value => {
  let text = String(value ?? '');
  if (typeof value !== 'number' && /^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};
const filterDescription = report => Object.entries(report.filters).filter(([,value]) => value).map(([key,value]) => `${key}: ${value}`).join(' | ') || 'All transactions';

async function sendGeneralLedgerExport(res, report, format) {
  const filename = `general-ledger${report.filters.from ? '-' + report.filters.from : ''}${report.filters.to ? '-to-' + report.filters.to : ''}.${format}`;
  res.set('Cache-Control', 'private, no-store');
  res.attachment(filename);
  if (format === 'csv') {
    res.type('text/csv');
    const rows = [columns, ...report.rows.map(values), ['', '', 'Total', report.summary.debit, report.summary.credit, report.summary.balance, '', '', '', '']];
    return res.send('\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n');
  }
  if (format === 'xlsx') {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('General Ledger', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = columns.map((header, index) => ({ header, width: [15,18,30,18,18,18,22,24,28,50][index] }));
    sheet.addRows(report.rows.map(values));
    sheet.autoFilter = { from: 'A1', to: 'J1' };
    const total = sheet.addRow(['', '', 'Total', report.summary.debit, report.summary.credit, report.summary.balance]);
    total.font = { bold: true };
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF16324F' } };
    for (const column of [4,5,6]) sheet.getColumn(column).numFmt = '#,##0.00;[Red]-#,##0.00';
    sheet.getColumn(10).alignment = { wrapText: true, vertical: 'top' };
    const info = workbook.addWorksheet('Report Details');
    info.addRows([['Report', 'General Ledger'], ['Filters', filterDescription(report)], ['Entries', report.rows.length], ['Balance', 'Running balance per account within the selected filters']]);
    info.getColumn(1).width = 20; info.getColumn(2).width = 100;
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.send(Buffer.from(await workbook.xlsx.writeBuffer()));
  }
  res.type('application/pdf');
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 34, bufferPages: true, info: { Title: 'General Ledger' } });
  const chunks = [];
  const complete = new Promise((resolve, reject) => { doc.on('data', chunk => chunks.push(chunk)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  renderLedgerTable(doc, report);
  doc.end();
  res.send(await complete);
}
function renderLedgerTable(doc, report) {
  const left = 34;
  const width = doc.page.width - left * 2;
  const bottom = doc.page.height - 54;
  const lineHeight = 11;
  const padding = 6;
  const navy = '#16324F';
  const widths = [24, 60, 120, 68, 68, 76, 106, 92, 160].map(value => value * width / 774);
  const headers = ['#', 'Date', 'Account', 'Debit', 'Credit', 'Balance', 'Voucher', 'Party', 'Remarks'];
  const amount = value => Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let y;

  function header(first = false) {
    doc.font('Helvetica-Bold').fontSize(first ? 23 : 16).fillColor(navy).text('General Ledger', left, 30, { lineBreak: false });
    doc.font('Helvetica').fontSize(9).fillColor('#64748B').text(`${report.rows.length.toLocaleString('en-US')} transactions`, left + width - 150, 36, { width: 150, align: 'right', lineBreak: false });
    y = first ? 65 : 58;
    if (first) {
      const labels = { search: 'Search', account: 'Account', party: 'Party', voucher_type: 'Voucher', from: 'From', to: 'To' };
      const description = Object.entries(report.filters).filter(([,value]) => value).map(([key,value]) => `${labels[key] || key}: ${value}`).join('   |   ') || 'All transactions';
      doc.font('Helvetica').fontSize(9).fillColor('#475569').text(description, left, y, { width });
      y = doc.y + 14;
      const metrics = [['Total debits', report.summary.debit], ['Total credits', report.summary.credit], ['Net balance', report.summary.balance]];
      metrics.forEach(([label, value], index) => {
        const x = left + index * (width / 3);
        doc.roundedRect(x, y, width / 3 - 10, 47, 5).fill('#F1F5F9');
        doc.font('Helvetica').fontSize(8).fillColor('#64748B').text(label.toUpperCase(), x + 12, y + 8, { lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(14).fillColor(navy).text(amount(value), x + 12, y + 23, { lineBreak: false });
      });
      y += 61;
    }
    doc.rect(left, y, width, 26).fill(navy);
    let x = left;
    headers.forEach((label, index) => {
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#FFFFFF').text(label, x + padding, y + 9, { width: widths[index] - padding * 2, align: index >= 3 && index <= 5 ? 'right' : 'left', lineBreak: false });
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
      doc.rect(left, y, width, height).fill(total ? '#E8EFF6' : index % 2 === 0 ? '#F8FAFC' : '#FFFFFF');
      let x = left;
      lines.forEach((cell, column) => {
        doc.font(total ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor(column >= 3 && column <= 5 ? navy : '#334155');
        cell.slice(offset, offset + length).forEach((line, number) => {
          doc.text(line, x + padding, y + padding + number * lineHeight, { width: widths[column] - padding * 2, align: column >= 3 && column <= 5 ? 'right' : 'left', lineBreak: false });
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
  report.rows.forEach((row, index) => drawRow([
    index + 1, row.posting_date, `${row.account_code || ''}\n${row.account_name || ''}`,
    amount(row.debit), amount(row.credit), amount(row.running_balance),
    `${String(row.voucher_type || '').replaceAll('_', ' ')}\n${row.voucher_no || row.voucher_id || ''}`,
    row.party_name || row.party_id || '', row.remarks || '',
  ], index));
  if (!report.rows.length) drawRow(['', '', 'No entries found', '', '', '', '', '', ''], 0);
  drawRow(['', '', 'TOTAL / NET', amount(report.summary.debit), amount(report.summary.credit), amount(report.summary.balance), '', '', ''], report.rows.length, true);
  const range = doc.bufferedPageRange();
  for (let page = range.start; page < range.start + range.count; page++) {
    doc.switchToPage(page);
    const originalBottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.moveTo(left, doc.page.height - 37).lineTo(left + width, doc.page.height - 37).strokeColor('#CBD5E1').stroke();
    doc.font('Helvetica').fontSize(8).fillColor('#64748B').text('Balances run per account within the selected filters. Net = debit minus credit.', left, doc.page.height - 27, { lineBreak: false });
    doc.text(`Page ${page + 1} of ${range.count}`, left + width - 110, doc.page.height - 27, { width: 110, align: 'right', lineBreak: false });
    doc.page.margins.bottom = originalBottomMargin;
  }
}

module.exports = { sendGeneralLedgerExport };

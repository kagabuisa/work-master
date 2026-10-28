'use strict';

const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

const HEADERS = ['Item', 'Qty', 'Cost', 'Valuation rate', 'Stock value'];
const number = (value, digits = 6) => value == null ? '—' : Number(value).toLocaleString('en-UG', { maximumFractionDigits: digits });

async function stockBalanceExcel(report) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Work Master';
  const sheet = workbook.addWorksheet('Stock Balance', { views: [{ state: 'frozen', ySplit: 4 }] });
  sheet.columns = [42, 18, 22, 22, 24].map(width => ({ width }));
  sheet.addRow(['ERPNext Stock Balance']);
  sheet.mergeCells('A1:E1');
  sheet.getCell('A1').font = { bold: true, size: 16 };
  sheet.getRow(1).height = 24;
  sheet.addRow(['Grouped by item · Currency: UGX']);
  sheet.mergeCells('A2:E2');
  sheet.addRow([]);
  sheet.addRow(HEADERS);
  sheet.getRow(4).height = 22;
  sheet.getRow(4).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF176B66' } };
  for (const row of report.rows) {
    const added = sheet.addRow([String(row.item_code), row.quantity, row.cost, row.valuation_rate, row.stock_value]);
    added.getCell(1).alignment = { wrapText: true, vertical: 'top' };
  }
  sheet.autoFilter = { from: 'A4', to: `E${Math.max(4, sheet.rowCount)}` };
  sheet.addRow(['Total', report.summary.quantity, null, null, report.summary.stock_value]).font = { bold: true };
  [2, 3, 4].forEach(index => { sheet.getColumn(index).numFmt = '#,##0.######'; });
  sheet.getColumn(5).numFmt = '#,##0';
  sheet.pageSetup = { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:4' };
  const filters = workbook.addWorksheet('Filters');
  filters.columns = [{ width: 24 }, { width: 100 }];
  filters.addRow(['Source', 'ERPNext current stock balances']);
  filters.addRow(['Generated at (UTC)', new Date().toISOString()]);
  filters.addRow(['Item search', report.filters.search || 'All items']);
  filters.addRow(['Matching items', report.summary.total]);
  filters.addRow(['Currency', 'UGX']);
  filters.addRow(['Valuation rate', 'Combined stock value divided by Qty; blank when Qty is zero.']);
  filters.addRow(['Cost', 'ERPNext item cost, with last purchase rate used when unset; blank if unavailable.']);
  report.filters.warehouses.forEach(name => filters.addRow(['Warehouse', name]));
  filters.getColumn(2).alignment = { wrapText: true, vertical: 'top' };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function stockBalancePdf(report) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 34, bufferPages: true,
    info: { Title: 'ERPNext Stock Balance', Author: 'Work Master' } });
  const chunks = [];
  const complete = new Promise((resolve, reject) => {
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const left = 34, width = doc.page.width - 68, bottom = doc.page.height - 48;
  const widths = [0.38, 0.12, 0.16, 0.17, 0.17].map(weight => weight * width);
  let y;
  function header() {
    doc.rect(0, 0, doc.page.width, 5).fill('#176b66');
    doc.font('Helvetica-Bold').fontSize(19).fillColor('#172b3a').text('ERPNext Stock Balance', left, 28);
    doc.font('Helvetica').fontSize(9).fillColor('#637381').text('Grouped by item · Currency: UGX', left, 55);
    y = 78;
  }
  function tableRow(values, { heading = false, total = false, stripe = false } = {}) {
    doc.font(heading || total ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
    const height = Math.max(15, ...values.map((value, i) => doc.heightOfString(String(value), { width: widths[i] - 12 }))) + 12;
    if (y + height > bottom) {
      doc.addPage(); header();
      if (!heading) tableRow(HEADERS, { heading: true });
    }
    if (heading || total || stripe) doc.rect(left, y, width, height).fill(heading ? '#176b66' : '#f2f6f8');
    doc.font(heading || total ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(heading ? '#ffffff' : '#172b3a');
    let x = left;
    values.forEach((value, i) => {
      doc.text(String(value), x + 6, y + 6, { width: widths[i] - 12, align: i ? 'right' : 'left' });
      x += widths[i];
    });
    doc.moveTo(left, y + height).lineTo(left + width, y + height).strokeColor('#dce4e8').lineWidth(0.5).stroke();
    y += height;
  }
  function metadata(text) {
    doc.font('Helvetica').fontSize(9);
    const height = doc.heightOfString(text, { width }) + 5;
    if (y + height > bottom) { doc.addPage(); header(); }
    doc.font('Helvetica').fontSize(9).fillColor('#637381').text(text, left, y, { width });
    y += height;
  }
  header();
  metadata(`Generated at (UTC): ${new Date().toISOString()}`);
  metadata(`Warehouses (${report.filters.warehouses.length}):`);
  report.filters.warehouses.forEach(name => metadata(name));
  metadata(`Item search: ${report.filters.search || 'All items'} | Matching items: ${report.summary.total}`);
  metadata('Cost: ERPNext item cost (last purchase rate when unset). Valuation rate: Stock value / Qty; dash when Qty is zero.');
  y += 5;
  tableRow(HEADERS, { heading: true });
  if (!report.rows.length) metadata('No matching stock balances.');
  report.rows.forEach((row, i) => tableRow([row.item_code, number(row.quantity), number(row.cost),
    number(row.valuation_rate), number(row.stock_value, 0)], { stripe: i % 2 === 1 }));
  tableRow(['Total', number(report.summary.quantity), '', '', number(report.summary.stock_value, 0)], { total: true });
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(8).fillColor('#637381').text(`Page ${i + 1} of ${range.count}`, left, doc.page.height - 30,
      { width, align: 'right', lineBreak: false });
    doc.page.margins.bottom = bottomMargin;
  }
  doc.end();
  return complete;
}

async function sendStockBalanceDownload(res, report, format) {
  const buffer = format === 'xlsx' ? await stockBalanceExcel(report) : await stockBalancePdf(report);
  res.set('Cache-Control', 'private, no-store');
  res.attachment(`erpnext-stock-balance.${format}`);
  res.type(format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf');
  return res.send(buffer);
}

module.exports = { stockBalanceExcel, stockBalancePdf, sendStockBalanceDownload };

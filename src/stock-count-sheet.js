'use strict';
const ExcelJS = require('exceljs');
const MAX_COUNT_ROWS = 5000;
const MAX_COUNT_FILE_BYTES = 5 * 1024 * 1024;
const HEADERS = ['Warehouse', 'Item Code', 'Item Name', 'Book Qty', 'Counted Qty'];

function countSheetFilename(reconciliationNumber, warehouse) {
  const clean = (value, fallback) => String(value || '').normalize('NFC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 80) || fallback;
  return `${clean(reconciliationNumber, 'new-reconciliation')}-${clean(warehouse, 'warehouse')}-count-sheet.xlsx`;
}

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

async function createCountSheet(warehouse, items) {
  if (items.length > MAX_COUNT_ROWS) throw invalid(`Count sheets support up to ${MAX_COUNT_ROWS} item rows.`);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Work Master';
  const sheet = workbook.addWorksheet('Count Sheet', {
    views: [{ state: 'frozen', ySplit: 1 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  sheet.columns = HEADERS.map((header, index) => ({ header, width: [28, 24, 45, 16, 18][index] }));
  sheet.getRow(1).height = 26;
  sheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF18342F' } };
  });
  for (const item of items) sheet.addRow([warehouse, String(item.item_code), item.item_name || item.item_code, Number(item.quantity || 0), null]);
  for (let index = 0; index < Math.min(20, MAX_COUNT_ROWS - items.length); index += 1) sheet.addRow([warehouse, '', '', null, null]);
  sheet.getColumn(2).numFmt = '@';
  sheet.getColumn(4).numFmt = '0.###';
  sheet.getColumn(5).numFmt = '0.###';
  for (let index = 2; index <= sheet.rowCount; index += 1) {
    const cell = sheet.getRow(index).getCell(5);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF4D6' } };
    cell.dataValidation = { type: 'decimal', operator: 'greaterThanOrEqual', allowBlank: true,
      formulae: [0], showErrorMessage: true, errorTitle: 'Invalid count', error: 'Enter a nonnegative quantity with up to three decimal places.' };
  }
  sheet.autoFilter = { from: 'A1', to: `E${Math.max(1, items.length + 1)}` };
  const instructions = workbook.addWorksheet('Instructions');
  instructions.getColumn(1).width = 110;
  for (const text of [
    'Work Master stock count sheet', `Warehouse: ${warehouse}`,
    'Enter physical quantities in Counted Qty. Use 0 for an item with no stock. Blank counts are ignored.',
    'Use up to three decimal places. Enter numbers, not formulas. Keep Warehouse and Item Code unchanged.',
    'Add active item codes in the spare rows for items not listed. Keep one row per item and the same warehouse.',
    'Upload the .xlsx file on a new reconciliation or while editing a draft. Upload fills the form; it does not save or submit.',
    'Existing form rows omitted from the upload keep their current counts. Review differences, then Save draft or Submit reconciliation.',
    'Book Qty and Item Name are for reference; current stock and master data are used when importing. Rates are not imported.',
  ]) instructions.addRow([text]);
  instructions.getCell('A1').font = { bold: true, size: 16 };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function cellText(value, row, field) {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (value == null) return '';
  throw invalid(`Row ${row}: ${field} must contain plain text, not a formula.`);
}

async function readCountSheet(buffer, warehouse) {
  if (!buffer?.length) throw invalid('Choose an Excel count sheet (.xlsx).');
  if (buffer.length > MAX_COUNT_FILE_BYTES) throw invalid('Count sheets must be no larger than 5 MB.');
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(buffer); }
  catch { throw invalid('The file is not a valid Excel .xlsx workbook.'); }
  const sheet = workbook.getWorksheet('Count Sheet') || workbook.worksheets[0];
  if (!sheet) throw invalid('The workbook has no count sheet.');
  if (sheet.rowCount > MAX_COUNT_ROWS + 1) throw invalid(`Count sheets support up to ${MAX_COUNT_ROWS} item rows.`);
  const columns = new Map();
  sheet.getRow(1).eachCell((cell, index) => {
    const header = cellText(cell.value, 1, 'Column heading').toLowerCase();
    if (columns.has(header)) throw invalid(`The count sheet repeats the ${header} column.`);
    columns.set(header, index);
  });
  for (const header of ['Warehouse', 'Item Code', 'Counted Qty']) {
    if (!columns.has(header.toLowerCase())) throw invalid(`Missing ${header} column. Download the count sheet template.`);
  }
  const items = [];
  const codes = new Set();
  for (let index = 2; index <= sheet.rowCount; index += 1) {
    const row = sheet.getRow(index);
    const value = row.getCell(columns.get('counted qty')).value;
    if (value == null || typeof value === 'string' && !value.trim()) continue;
    const code = cellText(row.getCell(columns.get('item code')).value, index, 'Item Code');
    const rowWarehouse = cellText(row.getCell(columns.get('warehouse')).value, index, 'Warehouse');
    if (!code) throw invalid(`Row ${index}: enter an Item Code for this count.`);
    if (rowWarehouse !== warehouse) throw invalid(`Row ${index}: warehouse must be ${warehouse}.`);
    if (codes.has(code)) throw invalid(`Row ${index}: item ${code} appears more than once.`);
    if (!['number', 'string'].includes(typeof value) || typeof value === 'string' && !/^\d+(?:\.\d{1,3})?$/.test(value.trim())) {
      throw invalid(`Row ${index}: Counted Qty must be a number with up to three decimal places; formulas are not supported.`);
    }
    const count = Number(value);
    if (!Number.isFinite(count) || count < 0 || count > 99999999999.999 || Math.abs(count * 1000 - Math.round(count * 1000)) > 0.00001) {
      throw invalid(`Row ${index}: enter a nonnegative Counted Qty with up to three decimal places.`);
    }
    items.push({ item_code: code, quantity: count, sheet_row: index });
    codes.add(code);
  }
  if (!items.length) throw invalid('No counts found. Fill Counted Qty for at least one item; use 0 for zero stock.');
  return items;
}

module.exports = { createCountSheet, readCountSheet, countSheetFilename, MAX_COUNT_ROWS, MAX_COUNT_FILE_BYTES };

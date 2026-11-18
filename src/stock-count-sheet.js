'use strict';
const ExcelJS = require('exceljs');
const MAX_COUNT_ROWS = 5000;
const MAX_COUNT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_REPORTED_DUPLICATES = 20;
const MAX_REPORTED_DUPLICATE_ROWS = 12;
const HEADERS = ['Warehouse', 'Item Code', 'Item Name', 'Book Qty', 'Counted Qty', 'Valuation Rate'];

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

function formatCountRows(rows) {
  const shown = rows.slice(0, MAX_REPORTED_DUPLICATE_ROWS);
  const remaining = rows.length - shown.length;
  if (remaining) return `${shown.join(', ')} and ${remaining} more row${remaining === 1 ? '' : 's'}`;
  return `${shown.slice(0, -1).join(', ')}${shown.length > 1 ? ' and ' : ''}${shown[shown.length - 1]}`;
}

function duplicateCountError(duplicates) {
  const shown = duplicates.slice(0, MAX_REPORTED_DUPLICATES);
  const remaining = duplicates.length - shown.length;
  if (duplicates.length === 1) {
    const [[code, rows]] = duplicates;
    return invalid(`Item ${code} appears more than once on rows ${formatCountRows(rows)}. Remove the extra counted rows, then upload the sheet again.`);
  }
  const details = shown.map(([code, rows]) => `item ${code} appears more than once on rows ${formatCountRows(rows)}`);
  if (remaining) details.push(`${remaining} more duplicated item${remaining === 1 ? ' is' : 's are'} not listed`);
  return invalid(`Duplicate items: ${details.join('; ')}. Remove the extra counted rows, then upload the sheet again.`);
}

function unknownCountItemsError(items) {
  const rowsByCode = new Map();
  for (const item of items) {
    if (!rowsByCode.has(item.item_code)) rowsByCode.set(item.item_code, []);
    rowsByCode.get(item.item_code).push(item.sheet_row);
  }
  const groups = [...rowsByCode];
  const shown = groups.slice(0, MAX_REPORTED_DUPLICATES);
  const remaining = groups.length - shown.length;
  if (groups.length === 1) {
    const [[code, rows]] = groups;
    return invalid(`Unknown item: ${code} on ${rows.length === 1 ? 'row' : 'rows'} ${formatCountRows(rows)}. Check the item code, then upload the sheet again.`);
  }
  const details = shown.map(([code, rows]) => `${code} on ${rows.length === 1 ? 'row' : 'rows'} ${formatCountRows(rows)}`);
  if (remaining) details.push(`${remaining} more unknown item${remaining === 1 ? ' is' : 's are'} not listed`);
  return invalid(`Unknown items: ${details.join('; ')}. Check the item codes, then upload the sheet again.`);
}

async function createCountSheet(warehouse, items, session = null) {
  if (items.length > MAX_COUNT_ROWS) throw invalid(`Count sheets support up to ${MAX_COUNT_ROWS} item rows.`);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Work Master';
  const sheet = workbook.addWorksheet('Count Sheet', {
    views: [{ state: 'frozen', ySplit: 1 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  sheet.columns = HEADERS.map((header, index) => ({ header, width: [28, 24, 45, 16, 18, 18][index] }));
  sheet.getRow(1).height = 26;
  sheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF18342F' } };
  });
  for (const item of items) sheet.addRow([warehouse, String(item.item_code), item.item_name || item.item_code, Number(item.quantity || 0), null, Number(item.valuation_rate || 0)]);
  for (let index = 0; index < Math.min(20, MAX_COUNT_ROWS - items.length); index += 1) sheet.addRow([warehouse, '', '', null, null, null]);
  sheet.getColumn(2).numFmt = '@';
  sheet.getColumn(4).numFmt = '0.###';
  sheet.getColumn(5).numFmt = '0.###';
  sheet.getColumn(6).numFmt = '0.###';
  for (let index = 2; index <= sheet.rowCount; index += 1) {
    const cell = sheet.getRow(index).getCell(5);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF4D6' } };
    cell.dataValidation = { type: 'decimal', operator: 'greaterThanOrEqual', allowBlank: true,
      formulae: [0], showErrorMessage: true, errorTitle: 'Invalid count', error: 'Enter a nonnegative quantity with up to three decimal places.' };
  }
  sheet.autoFilter = { from: 'A1', to: `${sheet.getColumn(HEADERS.length).letter}${Math.max(1, items.length + 1)}` };
  const instructions = workbook.addWorksheet('Instructions');
  instructions.getColumn(1).width = 110;
  const legacyInstructions = [
    'Work Master stock count sheet', `Warehouse: ${warehouse}`,
    'Enter physical quantities in Counted Qty. Use 0 for an item with no stock. Blank counts are ignored.',
    'Use up to three decimal places. Enter numbers, not formulas. Keep Warehouse and Item Code unchanged.',
    'Add active item codes in the spare rows for items not listed. Keep one row per item and the same warehouse.',
    'Upload the .xlsx file on a new reconciliation or while editing a draft. Upload fills the form; it does not save or submit.',
    'Existing form rows omitted from the upload keep their current counts. Review differences, then Save draft or Submit reconciliation.',
    'Book Qty, Valuation Rate and Item Name are for reference; current stock and master data are used when importing. Workbook rates are not imported.',
  ];
  const texts=session?[
    'Controlled warehouse count sheet',`Warehouse: ${warehouse}`,`Count: ${session.id}; revision: ${session.revision}; fixed cut-off: ${session.cutoff}`,
    'Physical movement and ordinary inventory posting are frozen. Book quantities are the frozen snapshot.',
    'Enter explicit quantities including zero. Blank cells remain incomplete. Keep warehouse and item codes unchanged.',
    'Import on this count session. Import saves a new count revision but never approves or submits.',
    'Valuation Rate is the rate held for the count. It is for reference; edit gain rates in the app.',
    'After importing, explain discrepancies and review gain rates in the app. The app ignores edited book quantities and valuation rates.',
    'A different authorized reviewer must approve the completed count. Stale sheets are rejected.'
  ]:legacyInstructions;
  for (const text of texts) instructions.addRow([text]);
  if(session){const meta=workbook.addWorksheet('_CountSession',{state:'veryHidden'});meta.addRow([String(session.id),String(session.revision),String(session.cutoff)]);}
  instructions.getCell('A1').font = { bold: true, size: 16 };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function cellText(value, row, field) {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (value == null) return '';
  throw invalid(`Row ${row}: ${field} must contain plain text, not a formula.`);
}

async function readCountSheet(buffer, warehouse, session = null) {
  if (!buffer?.length) throw invalid('Choose an Excel count sheet (.xlsx).');
  if (buffer.length > MAX_COUNT_FILE_BYTES) throw invalid('Count sheets must be no larger than 5 MB.');
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(buffer); }
  catch { throw invalid('The file is not a valid Excel .xlsx workbook.'); }
  if(session){const meta=workbook.getWorksheet('_CountSession');const values=meta?.getRow(1);if(!values||String(values.getCell(1).value)!==String(session.id)||String(values.getCell(2).value)!==String(session.revision)||String(values.getCell(3).value)!==String(session.cutoff))throw invalid('This sheet belongs to a different count or stale revision. Download the current sheet.');}
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
  const rowsByCode = new Map();
  for (let index = 2; index <= sheet.rowCount; index += 1) {
    const row = sheet.getRow(index);
    const value = row.getCell(columns.get('counted qty')).value;
    if (value == null || typeof value === 'string' && !value.trim()) continue;
    const code = cellText(row.getCell(columns.get('item code')).value, index, 'Item Code');
    const rowWarehouse = cellText(row.getCell(columns.get('warehouse')).value, index, 'Warehouse');
    if (!code) throw invalid(`Row ${index}: enter an Item Code for this count.`);
    if (rowWarehouse !== warehouse) throw invalid(`Row ${index}: warehouse must be ${warehouse}.`);
    if (rowsByCode.has(code)) {
      rowsByCode.get(code).push(index);
      continue;
    }
    rowsByCode.set(code, [index]);
    if (!['number', 'string'].includes(typeof value) || typeof value === 'string' && !/^\d+(?:\.\d{1,3})?$/.test(value.trim())) {
      throw invalid(`Row ${index}: Counted Qty must be a number with up to three decimal places; formulas are not supported.`);
    }
    const count = Number(value);
    if (!Number.isFinite(count) || count < 0 || count > 99999999999.999 || Math.abs(count * 1000 - Math.round(count * 1000)) > 0.00001) {
      throw invalid(`Row ${index}: enter a nonnegative Counted Qty with up to three decimal places.`);
    }
    items.push({ item_code: code, quantity: count, sheet_row: index });
  }
  const duplicates = [...rowsByCode].filter(([, rows]) => rows.length > 1);
  if (duplicates.length) throw duplicateCountError(duplicates);
  if (!items.length) throw invalid('No counts found. Fill Counted Qty for at least one item; use 0 for zero stock.');
  return items;
}

module.exports = { createCountSheet, readCountSheet, countSheetFilename, unknownCountItemsError, MAX_COUNT_ROWS, MAX_COUNT_FILE_BYTES };

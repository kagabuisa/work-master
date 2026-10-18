const stockEntryForm = document.querySelector('#stock-entry-form');
const stockEntryItemsTable = document.querySelector('#stock-entry-items');
const tableBody = document.querySelector('#stock-entry-items tbody');
const addRowButton = document.querySelector('#add-stock-row');
const entryType = document.querySelector('#entry-type');
const warehouseDatalist = document.querySelector('#stock-warehouses');
const supplierDialog = document.querySelector('#supplier-dialog');
const supplierForm = document.querySelector('#supplier-form');
const adjustSupplierInfo = document.querySelector('#adjust-supplier-info');
const cancelEntrySourceWrapper = document.querySelector('#cancel-entry-source-wrapper');
const cancelEntrySource = document.querySelector('#cancel-entry-source');
const cancelEntrySourceResults = document.querySelector('.stock-entry-source-results');
const cancelEntrySourceStatus = document.querySelector('#cancel-entry-source-status');
const cancelEntryButton = document.querySelector('#cancel-entry-button');
const stockEntryPostingWrapper = document.querySelector('#stock-entry-posting-wrapper');
const stockEntryRemarksWrapper = document.querySelector('#stock-entry-remarks-wrapper');
const stockEntrySubmitButtons = [...document.querySelectorAll('#stock-entry-form button[type="submit"], button[type="submit"][form="stock-entry-form"]')];
const importStockEntryRowsButton = document.querySelector('#import-stock-entry-rows');
const stockEntryImportFile = document.querySelector('#stock-entry-import-file');
const stockEntryImportStatus = document.querySelector('#stock-entry-import-status');
const initialStockEntry = window.STOCK_ENTRY_INITIAL || { entry: null, items: [] };
const stockEntryReadOnly = Boolean(initialStockEntry.readOnly);
const stockTransferTypes = new Set(initialStockEntry.transferTypes || ['transfer']);
const rowTemplate = tableBody.querySelector('tr').cloneNode(true);
const stockEntryItemPicker = document.querySelector('#stock-entry-item-picker');
const stockEntryItemSearch = document.querySelector('#stock-entry-item-search');
const stockEntryItemResults = document.querySelector('#stock-entry-item-results');
const stockEntryItemStatus = document.querySelector('#stock-entry-item-status');
let itemPickerTimer;
let itemPickerRequest;

if (stockEntryItemSearch) {
  stockEntryItemSearch.addEventListener('input', () => {
    clearTimeout(itemPickerTimer);
    itemPickerRequest?.abort();
    stockEntryItemResults.replaceChildren();
    stockEntryItemStatus.textContent = '';
    itemPickerTimer = setTimeout(searchStockEntryItemPicker, 180);
  });
  stockEntryItemResults.addEventListener('click', event => {
    const button = event.target.closest('[data-stock-picker-item]');
    if (button) addStockEntryPickerItem(JSON.parse(button.dataset.stockPickerItem));
  });
  stockEntryItemPicker.addEventListener('keydown', event => {
    const buttons = [...stockEntryItemResults.querySelectorAll('button')];
    const index = buttons.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = event.key === 'ArrowDown' ? index + 1 : index < 0 ? buttons.length - 1 : index - 1;
      buttons[(next + buttons.length) % buttons.length]?.focus();
    } else if (event.key === 'Escape') {
      clearTimeout(itemPickerTimer);
      itemPickerRequest?.abort();
      stockEntryItemResults.replaceChildren();
      stockEntryItemSearch.focus();
    } else if (event.key === 'Enter' && event.target === stockEntryItemSearch) {
      event.preventDefault();
      buttons[0]?.click();
    }
  });
  document.addEventListener('click', event => {
    if (!stockEntryItemPicker.contains(event.target)) {
      clearTimeout(itemPickerTimer);
      itemPickerRequest?.abort();
      stockEntryItemResults.replaceChildren();
    }
  });
}

async function searchStockEntryItemPicker() {
  const query = stockEntryItemSearch.value.trim();
  if (!query || entryType.value === 'cancel') return;
  const request = new AbortController();
  itemPickerRequest = request;
  try {
    const response = await fetch(`/api/master-items?q=${encodeURIComponent(query)}`, { signal: request.signal });
    if (!response.ok) throw new Error('Item lookup failed.');
    const items = await response.json();
    if (request.signal.aborted || stockEntryItemSearch.value.trim() !== query) return;
    stockEntryItemResults.innerHTML = items.map(item => `<button type="button" data-stock-picker-item="${escapeAttr(JSON.stringify(item))}">${escapeHtml(item.item_code)}</button>`).join('');
    stockEntryItemStatus.textContent = items.length ? '' : 'No matching items.';
  } catch (error) {
    if (!request.signal.aborted) stockEntryItemStatus.textContent = 'Could not load items. Type again to retry.';
  }
}

function addStockEntryPickerItem(item) {
  if (stockEntryReadOnly || entryType.value === 'cancel') return;
  let row = [...tableBody.querySelectorAll('tr')].find(row => !row.querySelector('[name="item_code"]').value.trim());
  if (!row) {
    addRowButton.click();
    row = tableBody.lastElementChild;
  }
  row.querySelector('[name="item_code"]').value = item.item_code;
  applyItemToRow(row, item);
  updateRowBalances(row);
  stockEntryItemSearch.value = '';
  itemPickerRequest?.abort();
  stockEntryItemResults.replaceChildren();
  stockEntryItemStatus.textContent = `${item.item_code} added to row ${[...tableBody.children].indexOf(row) + 1}. Enter its quantity in the table.`;
  row.querySelector('[name="quantity"]').focus();
}

let itemCacheByQuery = new Map();
let itemTimer;
let cancelTemplateTimer;
let cancelSearchTimer;
let lockedWarehouse = '';
let lockedTargetWarehouse = '';
let supplierPromptShown = false;
let selectedCancelEntry = null;

stockEntryForm.addEventListener('submit', (event) => {
  if (entryType.value === 'cancel') {
    event.preventDefault();
  }
});
const balanceRequests = new WeakMap();
window.addEventListener('focus', updateRowsBalances);
document.addEventListener('inventory-control-ready',updateRowsBalances);
stockEntryForm.addEventListener('change', event => {
  if (event.target.matches('[name="posting_date"], [name="posting_time"], [name="quantity"]')) updateRowsBalances();
});
stockEntryForm.addEventListener('input', event => {
  if (event.target.matches('[name="quantity"], [name="valuation_rate"]')) updateStockEntryValues();
  if (event.target.matches('[name="posting_date"], [name="posting_time"]')) updateRowsBalances();
});

addRowButton.addEventListener('click', () => {
  const firstRow = tableBody.querySelector('tr');
  const row = firstRow.cloneNode(true);
  row.querySelectorAll('input').forEach((input) => {
    input.value = defaultInputValue(input);
  });
  resetBalanceDisplays(row);
  tableBody.appendChild(row);
  updateStockEntryRowNumbers();
  applyLockedWarehouse(row);
  applyLockedTargetWarehouse(row);
  updateEntryTypeControls();
  updateRowBalances(row);
});

tableBody.addEventListener('click', (event) => {
  const itemButton = event.target.closest('[data-stock-item]');
  if (itemButton) {
    selectItem(itemButton);
    return;
  }
  if (!event.target.matches('[data-remove-row]')) {
    return;
  }
  if (tableBody.querySelectorAll('tr').length === 1) {
    clearRow(event.target.closest('tr'));
    return;
  }
  event.target.closest('tr').remove();
  updateStockEntryRowNumbers();
  updateLockedWarehouse();
});

tableBody.addEventListener('input', (event) => {
  if (event.target.matches('[name="item_code"]')) {
    updateRowBalances(event.target.closest('tr'));
    clearTimeout(itemTimer);
    itemTimer = setTimeout(() => searchItems(event.target), 180);
    return;
  }
  if (event.target.matches('[name="warehouse"]')) {
    updateLockedWarehouse();
    updateRowsBalances();
    return;
  }
  if (event.target.matches('[name="target_warehouse"]')) {
    updateLockedTargetWarehouse();
    updateRowBalances(event.target.closest('tr'));
  }
});

tableBody.addEventListener('change', (event) => {
  if (event.target.matches('[name="item_code"]')) {
    fillItemFromCode(event.target);
    updateRowBalances(event.target.closest('tr'));
    return;
  }
  if (event.target.matches('[name="warehouse"]')) {
    updateLockedWarehouse();
    updateRowsBalances();
    return;
  }
  if (event.target.matches('[name="target_warehouse"]')) {
    updateLockedTargetWarehouse();
    updateRowBalances(event.target.closest('tr'));
  }
});

entryType.addEventListener('change', () => {
  updateEntryTypeControls();
  updateSupplierControls(true);
  updateCancelEntrySourceControls();
});
if (cancelEntrySource) {
  cancelEntrySource.addEventListener('input', () => {
    clearTimeout(cancelTemplateTimer);
    clearTimeout(cancelSearchTimer);
    clearCancelEntrySelection();
    populateRows([], { readOnly: true });
    cancelSearchTimer = setTimeout(() => searchCancelEntrySources(cancelEntrySource.value), 180);
  });
  cancelEntrySource.addEventListener('change', loadCancelEntrySource);
}
if (cancelEntryButton) {
  cancelEntryButton.addEventListener('click', cancelSelectedStockEntry);
}
if (importStockEntryRowsButton && stockEntryImportFile) {
  importStockEntryRowsButton.addEventListener('click', () => {
    stockEntryImportFile.value = '';
    stockEntryImportFile.click();
  });
  stockEntryImportFile.addEventListener('change', importStockEntryRowsFromFile);
}
document.addEventListener('click', (event) => {
  const sourceButton = event.target.closest('[data-cancel-entry-source]');
  if (sourceButton) {
    cancelEntrySource.value = sourceButton.dataset.cancelEntrySource;
    clearCancelEntrySourceResults();
    loadCancelEntrySource();
    return;
  }
  if (
    cancelEntrySource
    && cancelEntrySourceResults
    && event.target !== cancelEntrySource
    && !cancelEntrySourceResults.contains(event.target)
  ) {
    clearCancelEntrySourceResults();
  }
});
if (adjustSupplierInfo) {
  adjustSupplierInfo.addEventListener('click', () => openSupplierDialog());
}
if (supplierForm) {
  supplierForm.addEventListener('submit', (event) => {
    event.preventDefault();
    saveSupplierDialog();
  });
}
document.querySelectorAll('[data-supplier-cancel]').forEach((button) => {
  button.addEventListener('click', () => closeSupplierDialog());
});
populateInitialStockEntry();
loadWarehouses();
if (stockEntryReadOnly) {
  applyStockEntryReadOnlyView();
} else {
  updateEntryTypeControls();
  updateSupplierControls(false);
  updateCancelEntrySourceControls();
}

async function searchItems(input) {
  const query = input.value.trim();
  const row = input.closest('tr');
  const results = row.querySelector('.stock-item-results');
  if (!query) {
    results.innerHTML = '';
    return;
  }
  try {
    const response = await fetch(`/api/master-items?q=${encodeURIComponent(query || '')}`);
    if (!response.ok) {
      throw new Error('Item lookup failed.');
    }
    const items = await response.json();
    itemCacheByQuery.set(query, items);
    results.innerHTML = items.map((item) => (
      `<button type="button" data-stock-item="${escapeAttr(JSON.stringify(item))}">
        <strong>${escapeHtml(item.item_code)}</strong>

      </button>`
    )).join('') || '<p>No matching items.</p>';
  } catch {
    results.innerHTML = '<p>Could not load items.</p>';
  }
}

async function importStockEntryRowsFromFile() {
  const file = stockEntryImportFile?.files?.[0];
  if (!file) {
    return;
  }
  setStockEntryImportStatus('Reading file');
  try {
    const text = await readTextFile(file);
    const importedRows = parseStockEntryImport(text);
    if (!importedRows.length) {
      throw new Error('No valid stock entry rows found in the file.');
    }
    populateRows(importedRows);
    setStockEntryImportStatus(`Imported ${importedRows.length} row${importedRows.length === 1 ? '' : 's'}.`);
  } catch (err) {
    setStockEntryImportStatus(err.message || 'Could not import stock entry rows.');
  }
}

function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result || '')));
    reader.addEventListener('error', () => reject(new Error('Could not read the selected file.')));
    reader.readAsText(file);
  });
}

function parseStockEntryImport(text) {
  const rows = parseDelimitedRows(text);
  if (!rows.length) {
    return [];
  }
  const headers = rows[0].map(normalizeImportHeader);
  const hasHeaders = headers.some((header) => [
    'item_code',
    'item_name',
    'warehouse',
    'target_warehouse',
    'quantity',
    'valuation_rate',
  ].includes(header));
  const dataRows = hasHeaders ? rows.slice(1) : rows;
  return dataRows.map((row) => {
    const value = (name, fallbackIndex) => {
      if (hasHeaders) {
        const index = headers.indexOf(name);
        return index >= 0 ? String(row[index] || '').trim() : '';
      }
      return String(row[fallbackIndex] || '').trim();
    };
    const itemCode = value('item_code', 0);
    return {
      item_code: itemCode,
      item_name: value('item_name', 5) || itemCode,
      warehouse: value('warehouse', 1),
      target_warehouse: value('target_warehouse', 2),
      quantity: value('quantity', 3),
      valuation_rate: value('valuation_rate', 4) || '0',
    };
  }).filter((row) => (
    row.item_code
    && row.warehouse
    && (entryType.value === 'reconciliation' ? row.quantity !== '' : Number(row.quantity || 0) !== 0)
  ));
}

function parseDelimitedRows(text) {
  const normalizedText = String(text || '').replace(/^\uFEFF/, '');
  const delimiter = normalizedText.split(/\r?\n/, 1)[0].includes('\t') ? '\t' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < normalizedText.length; index += 1) {
    const char = normalizedText[index];
    const nextChar = normalizedText[index + 1];
    if (char === '"') {
      if (quoted && nextChar === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === delimiter && !quoted) {
      row.push(field);
      field = '';
      continue;
    }
    if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && nextChar === '\n') {
        index += 1;
      }
      row.push(field);
      if (row.some((value) => String(value || '').trim())) {
        rows.push(row);
      }
      row = [];
      field = '';
      continue;
    }
    field += char;
  }
  row.push(field);
  if (row.some((value) => String(value || '').trim())) {
    rows.push(row);
  }
  return rows;
}

function normalizeImportHeader(value) {
  const header = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (['item', 'item_code', 'code'].includes(header)) {
    return 'item_code';
  }
  if (['item_name', 'name', 'description'].includes(header)) {
    return 'item_name';
  }
  if (['qty', 'quantity'].includes(header)) {
    return 'quantity';
  }
  if (['rate', 'valuation_rate', 'valuation', 'cost'].includes(header)) {
    return 'valuation_rate';
  }
  if (['target', 'target_warehouse', 'to_warehouse'].includes(header)) {
    return 'target_warehouse';
  }
  if (['source_warehouse', 'from_warehouse'].includes(header)) {
    return 'warehouse';
  }
  return header;
}

function setStockEntryImportStatus(message) {
  if (stockEntryImportStatus) {
    stockEntryImportStatus.textContent = message || '';
  }
}

async function loadWarehouses() {
  try {
    const response = await fetch('/api/warehouses');
    if (!response.ok) {
      throw new Error('Warehouse lookup failed.');
    }
    const warehouses = await response.json();
    warehouseDatalist.innerHTML = warehouses.map((warehouse) => (
      `<option value="${escapeAttr(warehouse)}"></option>`
    )).join('');
  } catch {
    warehouseDatalist.innerHTML = '';
  }
}

function fillItemFromCode(input) {
  const row = input.closest('tr');
  const selected = [...itemCacheByQuery.values()]
    .flat()
    .find((item) => item.item_code === input.value);
  if (!selected) {
    return;
  }
  applyItemToRow(row, selected);
}

function selectItem(button) {
  const row = button.closest('tr');
  const item = JSON.parse(button.dataset.stockItem);
  row.querySelector('[name="item_code"]').value = item.item_code;
  applyItemToRow(row, item);
  row.querySelector('.stock-item-results').innerHTML = '';
  updateRowBalances(row);
}

function applyItemToRow(row, item) {
  row.querySelector('[name="item_name"]').value = item.item_name || item.item_code;
  const rateInput = row.querySelector('[name="valuation_rate"]');
  if ((stockTransferTypes.has(entryType.value) || entryType.value === 'cancel')) {
    updateRowBalances(row);
    return;
  }
  if (!Number(rateInput.value || 0) && Number(item.default_rate || 0)) {
    rateInput.value = Math.round(Number(item.default_rate || 0));
  }
}

function clearRow(row) {
  row.querySelectorAll('input').forEach((input) => {
    input.value = defaultInputValue(input);
  });
  resetBalanceDisplays(row);
  row.querySelector('.stock-item-results').innerHTML = '';
  applyLockedWarehouse(row);
  applyLockedTargetWarehouse(row);
  updateRowBalances(row);
}

async function loadCancelEntrySource() {
  if (!cancelEntrySource || entryType.value !== 'cancel') {
    return;
  }
  const source = cancelEntrySource.value.trim();
  if (!source) {
    setCancelEntrySourceStatus('');
    return;
  }
  setCancelEntrySourceStatus('Loading');
  try {
    const response = await fetch(`/api/stock-entry-cancel-template?entry=${encodeURIComponent(source)}`);
    const template = await response.json();
    if (!response.ok) {
      throw new Error(template.error || 'Could not load stock entry.');
    }
    selectedCancelEntry = template.entry || null;
    populateRows(template.items || [], { readOnly: true });
    if (cancelEntryButton) {
      cancelEntryButton.disabled = !selectedCancelEntry;
    }
    setCancelEntrySourceStatus(`Loaded ${template.entry.entry_no}`);
  } catch (err) {
    clearCancelEntrySelection();
    setCancelEntrySourceStatus(err.message || 'Could not load stock entry.');
  }
}

async function cancelSelectedStockEntry() {
  if (!selectedCancelEntry || !selectedCancelEntry.id || !cancelEntryButton) {
    setCancelEntrySourceStatus('Choose a stock entry to cancel.');
    return;
  }
  const postingDate = document.querySelector('[name="posting_date"]')?.value || '';
  const reason = document.querySelector('[name="remarks"]')?.value.trim() || `Cancelled from ${selectedCancelEntry.entry_no}`;
  cancelEntryButton.disabled = true;
  setCancelEntrySourceStatus('Cancelling');
  try {
    const response = await fetch(`/stock/entries/${encodeURIComponent(selectedCancelEntry.id)}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason, posting_date: postingDate }),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'Could not cancel stock entry.');
    }
    window.location.href = '/stock/entries/new';
  } catch (err) {
    cancelEntryButton.disabled = false;
    setCancelEntrySourceStatus(err.message || 'Could not cancel stock entry.');
  }
}

async function searchCancelEntrySources(query) {
  if (!cancelEntrySourceResults || entryType.value !== 'cancel') {
    return;
  }
  const search = String(query || '').trim();
  if (!search) {
    clearCancelEntrySourceResults();
    return;
  }
  try {
    const response = await fetch(`/api/stock-entries?q=${encodeURIComponent(search)}`);
    if (!response.ok) {
      throw new Error('Stock entry lookup failed.');
    }
    const entries = await response.json();
    cancelEntrySourceResults.innerHTML = entries.map((entry) => (
      `<button type="button" data-cancel-entry-source="${escapeAttr(entry.entry_no)}">
        <strong>${escapeHtml(entry.entry_no)}</strong>
        <span>${escapeHtml([
          entry.entry_type,
          entry.posting_date,
          `${entry.item_count || 0} item${Number(entry.item_count || 0) === 1 ? '' : 's'}`,
        ].filter(Boolean).join(' | '))}</span>
        ${entry.remarks ? `<span>${escapeHtml(entry.remarks)}</span>` : ''}
      </button>`
    )).join('') || '<p>No matching stock entries.</p>';
  } catch {
    cancelEntrySourceResults.innerHTML = '<p>Could not load stock entries.</p>';
  }
}

function clearCancelEntrySourceResults() {
  if (cancelEntrySourceResults) {
    cancelEntrySourceResults.innerHTML = '';
  }
}

function clearCancelEntrySelection() {
  selectedCancelEntry = null;
  if (cancelEntryButton) {
    cancelEntryButton.disabled = true;
  }
}

function populateRows(items, options = {}) {
  const sourceItems = Array.isArray(items) && items.length ? items : [{}];
  tableBody.innerHTML = '';
  sourceItems.forEach((item) => {
    const row = rowTemplate.cloneNode(true);
    row.querySelectorAll('input').forEach((input) => {
      input.value = defaultInputValue(input);
      input.readOnly = false;
      input.disabled = false;
    });
    resetBalanceDisplays(row);
    row.querySelector('.stock-item-results').innerHTML = '';
    const idInput = row.querySelector('[name="id"]');
    if (idInput) {
      idInput.value = item.id || '';
    }
    if (stockEntryReadOnly) {
      fillStockEntryAuditCells(row, item);
    }
    row.querySelector('[name="item_code"]').value = item.item_code || '';
    row.querySelector('[name="item_name"]').value = item.item_name || item.item_code || '';
    row.querySelector('[name="warehouse"]').value = item.warehouse || '';
    row.querySelector('[name="target_warehouse"]').value = item.target_warehouse || '';
    row.querySelector('[name="quantity"]').value = item.quantity ?? '';
    row.querySelector('[name="valuation_rate"]').value = item.valuation_rate || '0';
    tableBody.appendChild(row);
  });
  updateStockEntryRowNumbers();
  lockedWarehouse = '';
  lockedTargetWarehouse = '';
  if (options.readOnly) {
    setStockEntryRowsReadOnly(true);
    updateRowsBalances();
  } else {
    updateEntryTypeControls();
    updateRowsBalances();
  }
}

function setStockEntryRowsReadOnly(readOnly) {
  tableBody.querySelectorAll('input').forEach((input) => {
    input.readOnly = readOnly;
    input.disabled = false;
  });
  tableBody.querySelectorAll('[data-remove-row]').forEach((button) => {
    button.hidden = readOnly;
    button.disabled = readOnly;
  });
  tableBody.querySelectorAll('.stock-item-results').forEach((results) => {
    results.innerHTML = '';
  });
}

function applyStockEntryReadOnlyView() {
  setStockEntryRowsReadOnly(true);
  if (entryType) {
    entryType.disabled = true;
  }
  stockEntryForm.querySelectorAll('input:not([type="hidden"])').forEach((input) => {
    input.readOnly = true;
  });
  if (addRowButton) {
    addRowButton.hidden = true;
    addRowButton.disabled = true;
  }
  if (importStockEntryRowsButton) {
    importStockEntryRowsButton.hidden = true;
    importStockEntryRowsButton.disabled = true;
  }
  stockEntrySubmitButtons.forEach((button) => {
    button.hidden = true;
    button.disabled = true;
  });
  if (cancelEntryButton) {
    cancelEntryButton.hidden = true;
    cancelEntryButton.disabled = true;
  }
  if (adjustSupplierInfo) {
    adjustSupplierInfo.hidden = true;
  }
  updateRowsBalances();
}

function updateLockedWarehouse() {
  const rows = [...tableBody.querySelectorAll('tr')];
  const firstWarehouse = rows[0]?.querySelector('[name="warehouse"]');
  lockedWarehouse = firstWarehouse ? firstWarehouse.value : '';
  rows.forEach((row, index) => {
    const warehouseInput = row.querySelector('[name="warehouse"]');
    warehouseInput.readOnly = index > 0 && Boolean(lockedWarehouse);
    if (index > 0) {
      warehouseInput.value = lockedWarehouse;
    }
  });
  updateRowsBalances();
}

function updateLockedTargetWarehouse() {
  const rows = [...tableBody.querySelectorAll('tr')];
  const firstTargetWarehouse = rows[0]?.querySelector('[name="target_warehouse"]');
  lockedTargetWarehouse = firstTargetWarehouse ? firstTargetWarehouse.value : '';
  rows.forEach((row, index) => {
    const targetWarehouseInput = row.querySelector('[name="target_warehouse"]');
    targetWarehouseInput.readOnly = index > 0 && Boolean(lockedTargetWarehouse);
    if (index > 0) {
      targetWarehouseInput.value = lockedTargetWarehouse;
    }
  });
  updateRowsBalances();
}

function applyLockedWarehouse(row) {
  const rowIndex = [...tableBody.querySelectorAll('tr')].indexOf(row);
  const warehouseInput = row.querySelector('[name="warehouse"]');
  if (rowIndex > 0 && lockedWarehouse) {
    warehouseInput.value = lockedWarehouse;
    warehouseInput.readOnly = true;
  } else {
    warehouseInput.readOnly = false;
  }
}

function applyLockedTargetWarehouse(row) {
  const rowIndex = [...tableBody.querySelectorAll('tr')].indexOf(row);
  const targetWarehouseInput = row.querySelector('[name="target_warehouse"]');
  if (rowIndex > 0 && lockedTargetWarehouse) {
    targetWarehouseInput.value = lockedTargetWarehouse;
    targetWarehouseInput.readOnly = true;
  } else {
    targetWarehouseInput.readOnly = false;
  }
}

function updateEntryTypeControls() {
  const transfer = stockTransferTypes.has(entryType.value);
  const reconciliation = entryType.value === 'reconciliation';
  document.querySelector('#stock-entry-quantity-heading').textContent = reconciliation ? 'Counted Qty' : 'Qty';
  document.querySelector('#stock-reconciliation-hint').hidden = !reconciliation;
  tableBody.querySelectorAll('[name="quantity"]').forEach((input) => {
    input.min = reconciliation ? '0' : '';
  });
  tableBody.querySelectorAll('[name="target_warehouse"]').forEach((input) => {
    input.required = transfer;
    input.disabled = !transfer;
    if (!transfer) {
      input.value = '';
    }
  });
  tableBody.querySelectorAll('[data-balance-field="target_warehouse_balance"]').forEach((input) => {
    input.hidden = !transfer;
    if (!transfer) {
      input.textContent = 'Balance: 0';
    }
  });
  tableBody.querySelectorAll('[name="valuation_rate"]').forEach((input) => {
    input.readOnly = transfer || entryType.value === 'cancel';
  });
  updateRowsBalances();
}

function updateCancelEntrySourceControls() {
  if (!cancelEntrySourceWrapper) {
    return;
  }
  const isCancelEntry = entryType.value === 'cancel';
  if (stockEntryItemPicker) {
    stockEntryItemPicker.hidden = isCancelEntry;
    stockEntryItemSearch.disabled = isCancelEntry;
    clearTimeout(itemPickerTimer);
    itemPickerRequest?.abort();
    stockEntryItemResults.replaceChildren();
    stockEntryItemStatus.textContent = '';
  }
  cancelEntrySourceWrapper.hidden = !isCancelEntry;
  if (isCancelEntry && !selectedCancelEntry) {
    populateRows([], { readOnly: true });
  }
  if (stockEntryItemsTable) {
    stockEntryItemsTable.hidden = false;
  }
  if (addRowButton) {
    addRowButton.hidden = isCancelEntry;
    addRowButton.disabled = isCancelEntry;
  }
  if (importStockEntryRowsButton) {
    importStockEntryRowsButton.hidden = isCancelEntry;
    importStockEntryRowsButton.disabled = isCancelEntry;
  }
  setStockEntryImportStatus('');
  stockEntrySubmitButtons.forEach((button) => {
    button.hidden = isCancelEntry;
    button.disabled = isCancelEntry;
  });
  if (cancelEntryButton) {
    cancelEntryButton.hidden = !isCancelEntry;
    cancelEntryButton.disabled = true;
  }
  if (stockEntryPostingWrapper) {
    stockEntryPostingWrapper.hidden = false;
  }
  if (stockEntryRemarksWrapper) {
    stockEntryRemarksWrapper.hidden = false;
  }
  setStockEntryRowsReadOnly(isCancelEntry);
  if (!isCancelEntry) {
    clearCancelEntrySourceResults();
    clearCancelEntrySelection();
    setCancelEntrySourceStatus('');
    updateEntryTypeControls();
  }
}

function setCancelEntrySourceStatus(message) {
  if (cancelEntrySourceStatus) {
    cancelEntrySourceStatus.textContent = message || '';
  }
}

function populateInitialStockEntry() {
  const items = Array.isArray(initialStockEntry.items) ? initialStockEntry.items : [];
  if (!items.length) {
    return;
  }
  const firstRow = tableBody.querySelector('tr');
  items.forEach((item, index) => {
    const row = index === 0 ? firstRow : firstRow.cloneNode(true);
    if (index > 0) {
      row.querySelectorAll('input').forEach((input) => {
        input.value = defaultInputValue(input);
      });
      resetBalanceDisplays(row);
      tableBody.appendChild(row);
    }
    const idInput = row.querySelector('[name="id"]');
    if (idInput) {
      idInput.value = item.id || '';
    }
    if (stockEntryReadOnly) {
      fillStockEntryAuditCells(row, item);
    }
    row.querySelector('[name="item_code"]').value = item.item_code || '';
    row.querySelector('[name="item_name"]').value = item.item_name || item.item_code || '';
    row.querySelector('[name="warehouse"]').value = item.warehouse || '';
    row.querySelector('[name="target_warehouse"]').value = item.target_warehouse || '';
    row.querySelector('[name="quantity"]').value = item.quantity || '';
    row.querySelector('[name="valuation_rate"]').value = item.valuation_rate || '0';
  });
  updateStockEntryRowNumbers();
  updateLockedWarehouse();
  updateLockedTargetWarehouse();
}

function updateStockEntryRowNumbers() {
  updateStockEntryValues();
  tableBody.querySelectorAll('tr').forEach((row, index) => {
    const numberCell = row.querySelector('.row-number');
    if (numberCell) {
      numberCell.textContent = index + 1;
    }
  });
}

function defaultInputValue(input) {
  if (input.name === 'valuation_rate') {
    return '0';
  }
  return '';
}

function resetBalanceDisplays(row) {
  row.querySelectorAll('[data-balance-field]').forEach((field) => {
    field.textContent = 'As of: —';
  });
}

function updateStockEntryValues() {
  let total = 0;
  tableBody.querySelectorAll('tr').forEach(row => {
    const quantity = Number(row.querySelector('[name="quantity"]').value || 0);
    const rate = Math.max(0, Math.round(Number(row.querySelector('[name="valuation_rate"]').value || 0)));
    const value = Number.isFinite(quantity * rate) ? Math.round(quantity * rate) : 0;
    total += value;
    const output = row.querySelector('[data-item-value]');
    if (output) output.textContent = value.toLocaleString('en-UG');
  });
  const totalOutput = document.querySelector('#stock-entry-total-value');
  if (totalOutput) totalOutput.textContent = total.toLocaleString('en-UG');
}

function updateRowsBalances() {
  updateStockEntryValues();
  tableBody.querySelectorAll('tr').forEach((row) => updateRowBalances(row));
}

async function updateRowBalances(row) {
  if (!row) {
    return;
  }
  updateStockEntryValues();
  const itemCode = row.querySelector('[name="item_code"]').value.trim();
  await Promise.all([
    updateBalanceField(row, 'warehouse', 'warehouse_balance', itemCode),
    updateBalanceField(row, 'target_warehouse', 'target_warehouse_balance', itemCode),
  ]);
}

async function updateBalanceField(row, warehouseFieldName, balanceFieldName, itemCode) {
  const warehouseInput = row.querySelector(`[name="${warehouseFieldName}"]`);
  const balanceInput = row.querySelector(`[data-balance-field="${balanceFieldName}"]`);
  if (!warehouseInput || !balanceInput) return;
  balanceRequests.get(balanceInput)?.abort();
  const controller = new AbortController();
  balanceRequests.set(balanceInput, controller);
  if (balanceInput.hidden) return;
  const warehouse = warehouseInput.value.trim();
  const date = stockEntryForm.querySelector('[name="posting_date"]').value;
  const time = stockEntryForm.querySelector('[name="posting_time"]').value;
  const current = () => !controller.signal.aborted && row.isConnected
    && row.querySelector('[name="item_code"]').value.trim() === itemCode
    && warehouseInput.value.trim() === warehouse
    && stockEntryForm.querySelector('[name="posting_date"]').value === date
    && stockEntryForm.querySelector('[name="posting_time"]').value === time;
  if (!itemCode || !warehouse) {
    balanceInput.textContent = 'As of: —';
    return;
  }
  balanceInput.textContent = 'As of: checking';
  try {
    const params = new URLSearchParams({ item_code: itemCode, warehouse });
    if (!window.inventoryControlState?.enabled) { params.set('posting_date',date);params.set('posting_time',time); }
    const response = await fetch(`/api/stock-balance?${params}`, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error('Balance lookup failed.');
    const balance = await response.json();
    if (!current()) return;
    balanceInput.textContent = `As of: ${formatQuantity(balance.quantity)}${balance.available_quantity < balance.quantity ? `; available: ${formatQuantity(balance.available_quantity)}` : ''}`;
    if (warehouseFieldName === 'warehouse' && (stockTransferTypes.has(entryType.value) || ['cancel', 'reconciliation'].includes(entryType.value))) {
      const rateInput = row.querySelector('[name="valuation_rate"]');
      if (entryType.value !== 'reconciliation' || !Number(rateInput.value)) {
        rateInput.value = formatRate(balance.valuation_rate);
        updateStockEntryValues();
      }
    }
  } catch {
    if (current()) balanceInput.textContent = 'As of: unavailable — change item or warehouse to retry';
  }
}

function formatRate(value) {
  const rate = Math.round(Number(value || 0));
  return rate ? String(rate) : '0';
}

function formatQuantity(value) {
  return Number(value || 0).toLocaleString(undefined, {
    maximumFractionDigits: 3,
    minimumFractionDigits: 0,
  });
}

function fillStockEntryAuditCells(row, item) {
  const cells = row.querySelectorAll('td');
  const createdCell = cells[cells.length - 3];
  const updatedCell = cells[cells.length - 2];
  if (createdCell && updatedCell) {
    createdCell.textContent = auditLineLabel(item.created_by, item.created_at);
    updatedCell.textContent = auditLineLabel(item.updated_by, item.updated_at);
  }
}

function auditLineLabel(user, value) {
  const time = value && !Number.isNaN(new Date(value).getTime())
    ? new Date(value).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
    : '';
  return `${user || 'Unknown'}${time ? ` · ${time}` : ''}`;
}

function updateSupplierControls(promptWhenSelected) {
  const isPurchaseReceipt = entryType.value === 'purchase';
  if (adjustSupplierInfo) {
    adjustSupplierInfo.hidden = !isPurchaseReceipt;
  }
  if (isPurchaseReceipt && promptWhenSelected && !supplierPromptShown && !hasSupplierInfo()) {
    supplierPromptShown = true;
    openSupplierDialog();
  }
}

function openSupplierDialog() {
  if (!supplierDialog || !supplierForm) {
    return;
  }
  supplierForm.elements.supplier_name.value = document.querySelector('#supplier-name').value;
  supplierForm.elements.supplier_contact.value = document.querySelector('#supplier-contact').value;
  supplierForm.elements.supplier_phone.value = document.querySelector('#supplier-phone').value;
  supplierForm.elements.supplier_reference.value = document.querySelector('#supplier-reference').value;
  if (typeof supplierDialog.showModal === 'function') {
    supplierDialog.showModal();
  } else {
    supplierDialog.setAttribute('open', '');
  }
  supplierForm.elements.supplier_name.focus();
}

function closeSupplierDialog() {
  if (!supplierDialog) {
    return;
  }
  if (typeof supplierDialog.close === 'function') {
    supplierDialog.close();
  } else {
    supplierDialog.removeAttribute('open');
  }
}

function saveSupplierDialog() {
  document.querySelector('#supplier-name').value = supplierForm.elements.supplier_name.value.trim();
  document.querySelector('#supplier-contact').value = supplierForm.elements.supplier_contact.value.trim();
  document.querySelector('#supplier-phone').value = supplierForm.elements.supplier_phone.value.trim();
  document.querySelector('#supplier-reference').value = supplierForm.elements.supplier_reference.value.trim();
  closeSupplierDialog();
}

function hasSupplierInfo() {
  return ['#supplier-name', '#supplier-contact', '#supplier-phone', '#supplier-reference']
    .some((selector) => document.querySelector(selector).value.trim());
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#096;');
}

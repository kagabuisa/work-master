const initial = window.RECONCILIATION_INITIAL || {};
const form = document.querySelector('#reconciliation-form');
const warehouseInput = document.querySelector('#reconciliation-warehouse');
const warehouseList = document.querySelector('#reconciliation-warehouses');
const loadButton = document.querySelector('#reconciliation-load');
const rowsBody = document.querySelector('#reconciliation-rows');
const emptyMessage = document.querySelector('#reconciliation-empty');
const statusMessage = document.querySelector('#reconciliation-status');
const searchInput = document.querySelector('#reconciliation-item-search');
const searchResults = document.querySelector('#reconciliation-item-results');
const varianceSummary = document.querySelector('#reconciliation-variance-summary');
const downloadSheet = document.querySelector('#reconciliation-download-sheet');
const uploadSheet = document.querySelector('#reconciliation-upload-sheet');
const countFile = document.querySelector('#reconciliation-count-file');
const sheetStatus = document.querySelector('#reconciliation-sheet-status');
let countSheetBusy = false;
const readOnly = Boolean(initial.readOnly);
const canEditRate = Boolean(initial.canEditRate) && !readOnly;
let rows = [];
let loadToken = 0;
let searchTimer;
let warehouseTimer;
let loadedWarehouse = '';
if (searchInput) searchInput.disabled = true;

function number(value) { return Number(value || 0); }
function qty(value) { return number(value).toLocaleString(undefined, { maximumFractionDigits: 3 }); }
function signedQty(value) { return value > 0 ? `+${qty(value)}` : qty(value); }
function money(value) { return `Ugx ${Math.round(number(value)).toLocaleString('en-UG')}`; }
function rateMoney(value) { return `Ugx ${number(value).toLocaleString('en-UG', { maximumFractionDigits: 2 })}`; }
function rounded(value, places = 3) { return Number(number(value).toFixed(places)); }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  }[char]));
}

function setStatus(message, error = false) {
  if (!statusMessage) return;
  statusMessage.textContent = message;
  statusMessage.classList.toggle('warning-text', error);
}

function setSheetStatus(message, error = false) {
  sheetStatus.textContent = message;
  sheetStatus.hidden = !message;
  sheetStatus.classList.toggle('warning-text', error);
}

function sheetWarehouse() { return warehouseInput?.value.trim() || initial.warehouse || ''; }

downloadSheet?.addEventListener('click', async () => {
  const warehouse = sheetWarehouse();
  if (!warehouse) { setSheetStatus('Choose a warehouse before downloading the template.', true); warehouseInput?.focus(); return; }
  downloadSheet.disabled = true;
  setSheetStatus('Preparing Excel count sheet…');
  try {
    const params = new URLSearchParams({ warehouse });
    if (initial.entry?.id) params.set('voucher_id', initial.entry.id);
    const response = await fetch(`/stock/reconciliations/count-sheet-template?${params}`);
    if (!response.ok) throw new Error('Could not download the template. Check your warehouse and permissions.');
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    const disposition = response.headers.get('Content-Disposition') || '';
    const encodedName = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
    const plainName = /filename="([^"]+)"/i.exec(disposition);
    link.download = encodedName ? decodeURIComponent(encodedName[1]) : plainName?.[1] || 'stock-count-sheet.xlsx';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setSheetStatus('Template downloaded. Fill Counted Qty, then upload the completed sheet.');
  } catch (error) { setSheetStatus(error.message, true); }
  finally { downloadSheet.disabled = false; }
});

uploadSheet?.addEventListener('click', () => {
  if (!sheetWarehouse()) { setSheetStatus('Choose a warehouse before uploading a count sheet.', true); warehouseInput?.focus(); return; }
  countFile.click();
});

countFile?.addEventListener('change', async () => {
  const file = countFile.files[0];
  if (!file || countSheetBusy || readOnly) return;
  const warehouse = sheetWarehouse();
  if (!warehouse) { setSheetStatus('Choose a warehouse first.', true); countFile.value = ''; return; }
  if (!/\.xlsx$/i.test(file.name) || file.size > 5 * 1024 * 1024) {
    setSheetStatus('Upload an Excel .xlsx count sheet no larger than 5 MB.', true); countFile.value = ''; return;
  }
  if (rows.length && loadedWarehouse && warehouse !== loadedWarehouse) {
    setSheetStatus('Load the selected warehouse stock before uploading its count sheet.', true); countFile.value = ''; return;
  }
  const wasReadOnly = warehouseInput.readOnly;
  const saveButtons = [...form.querySelectorAll('button[type="submit"]')].map((button) => [button, button.disabled]);
  countSheetBusy = true;
  ++loadToken;
  uploadSheet.disabled = true;
  if (loadButton) loadButton.disabled = true;
  warehouseInput.readOnly = true;
  saveButtons.forEach(([button]) => { button.disabled = true; });
  setSheetStatus('Reading and validating count sheet…');
  try {
    const body = new FormData();
    body.append('count_sheet', file);
    body.append('warehouse', warehouse);
    if (initial.entry?.id) body.append('voucher_id', initial.entry.id);
    const response = await fetch('/stock/reconciliations/count-sheet-upload', { method: 'POST', headers: { Accept: 'application/json' }, body });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not import the count sheet.');
    if (result.warehouse !== sheetWarehouse() || !Array.isArray(result.items)) throw new Error('Warehouse changed. Upload the sheet again.');
    const existing = new Map(rows.map((item) => [item.code, item]));
    for (const item of result.items) {
      const previous = existing.get(item.code);
      if (previous) Object.assign(previous, item, { id: previous.id, rate: previous.rate });
      else rows.push({ ...item, id: '' });
    }
    loadedWarehouse = warehouse;
    if (searchInput) searchInput.disabled = false;
    renderRows();
    setSheetStatus(`${result.items.length.toLocaleString()} count${result.items.length === 1 ? '' : 's'} imported. Review the differences, then save or submit the voucher.`);
  } catch (error) { setSheetStatus(error.message || 'Could not import the count sheet.', true); }
  finally {
    countSheetBusy = false;
    uploadSheet.disabled = false;
    if (loadButton) loadButton.disabled = false;
    warehouseInput.readOnly = wasReadOnly;
    saveButtons.forEach(([button, disabled]) => { button.disabled = disabled; });
    countFile.value = '';
  }
});

function difference(item) { return rounded(item.counted - item.book); }
function valueDifference(item) {
  if (item.postedValue != null) return item.postedValue;
  const change = difference(item);
  return Math.round(change * number(change > 0 ? item.rate : item.bookRate));
}

function updateSummary() {
  let gain = 0;
  let loss = 0;
  let gainValue = 0;
  let lossValue = 0;
  let value = 0;
  let variances = 0;
  for (const item of rows) {
    const change = difference(item);
    if (change !== 0) variances += 1;
    const lineValue = valueDifference(item);
    if (change > 0) { gain += change; gainValue += lineValue; }
    if (change < 0) { loss += -change; lossValue += Math.abs(lineValue); }
    value += lineValue;
  }
  document.querySelector('#reconciliation-lines').textContent = rows.length.toLocaleString();
  document.querySelector('#reconciliation-gain').textContent = qty(gain);
  document.querySelector('#reconciliation-loss').textContent = qty(loss);
  document.querySelector('#reconciliation-gain-value').textContent = money(gainValue);
  document.querySelector('#reconciliation-loss-value').textContent = money(lossValue);
  document.querySelector('#reconciliation-value').textContent = money(value);
  varianceSummary.textContent = variances === 0 ? 'No differences yet'
    : `${variances.toLocaleString()} ${variances === 1 ? 'difference' : 'differences'} found`;
  varianceSummary.classList.toggle('has-differences', variances > 0);
}

function updateRow(tr, item) {
  const change = difference(item);
  const differenceCell = tr.querySelector('[data-difference]');
  const valueCell = tr.querySelector('[data-value-difference]');
  differenceCell.innerHTML = `<span class="reconciliation-difference-pill">${change > 0 ? 'Gain ' : change < 0 ? 'Loss ' : 'Match '}${signedQty(change)}</span>`;
  valueCell.textContent = change > 0 && item.rate <= 0 ? 'Rate needed' : money(valueDifference(item));
  differenceCell.className = change > 0 ? 'reconciliation-positive' : change < 0 ? 'reconciliation-negative' : 'reconciliation-zero';
  valueCell.className = differenceCell.className;
  tr.classList.toggle('reconciliation-gain-row', change > 0);
  tr.classList.toggle('reconciliation-loss-row', change < 0);
}

function renderRows() {
  rowsBody.replaceChildren();
  rows.forEach((item, index) => {
    const tr = document.createElement('tr');
    tr._item = item;
    tr.innerHTML = `
      <td class="row-number" data-label="Line">${index + 1}</td>
      <td class="reconciliation-item-cell" data-label="Item">
        <input type="hidden" name="id" value="${escapeHtml(item.id || '')}">
        <input type="hidden" name="item_code" value="${escapeHtml(item.code)}">
        <input type="hidden" name="item_name" value="${escapeHtml(item.name)}">
        <strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.code)}</small>
      </td>
      <td class="reconciliation-book-qty" data-label="Book Qty">${qty(item.book)}</td>
      <td data-label="Counted Qty"><input name="quantity" type="number" min="0" step="0.001" value="${item.counted}" aria-label="Counted quantity for ${escapeHtml(item.name)}" ${readOnly ? 'readonly' : ''} required></td>
      <td data-label="Difference" data-difference></td>
      <td class="reconciliation-rate-cell" data-label="Rate">
        <span class="reconciliation-rate-value">${rateMoney(item.rate)}</span>
        <input name="valuation_rate" type="number" min="0" step="0.01" value="${item.rate}" aria-label="Valuation rate for ${escapeHtml(item.name)}" hidden>
        ${canEditRate ? `<button type="button" class="reconciliation-rate-edit" data-edit-rate aria-label="Edit valuation rate for ${escapeHtml(item.name)}" title="Edit rate">✎</button>` : ''}
      </td>
      <td data-label="Value difference" data-value-difference></td>
      <td class="entry-row-actions">${readOnly ? '' : '<button type="button" class="button-light" data-remove>Remove</button>'}</td>`;
    rowsBody.appendChild(tr);
    updateRow(tr, item);
  });
  emptyMessage.hidden = rows.length > 0;
  emptyMessage.textContent = (warehouseInput?.value.trim() || initial.warehouse)
    ? 'No stock loaded for this warehouse. Search for an item below to add it to the count.'
    : 'Choose a warehouse to load its stock.';
  updateSummary();
}

function itemFromSaved(item, balance, posted) {
  const counted = number(item.quantity);
  const book = posted ? rounded(counted - number(item.quantity_change)) : number(balance?.quantity);
  return { id: item.id || '', code: item.item_code, name: item.item_name || balance?.item_name || item.item_code,
    book, counted, rate: number(item.valuation_rate || balance?.valuation_rate),
    bookRate: number(balance?.valuation_rate || item.valuation_rate),
    postedValue: posted ? item.value_change : null };
}

async function loadWarehouseStock(event) {
  if (countSheetBusy) return;
  const warehouse = warehouseInput.value.trim();
  if (!warehouse) { setStatus('Choose a warehouse first.', true); warehouseInput.focus(); return; }
  if (loadedWarehouse && rows.length && (warehouse !== loadedWarehouse || event?.type === 'click')
      && !window.confirm('Load warehouse stock again? This will replace unsaved counts.')) {
    warehouseInput.value = loadedWarehouse;
    return;
  }
  if (warehouse !== loadedWarehouse && !initial.entry?.id) {
    rows = [];
    renderRows();
  }
  if (searchInput) searchInput.disabled = true;
  const token = ++loadToken;
  setStatus('Loading warehouse stock…');
  try {
    const response = await fetch(`/stock/reconciliations/warehouse-stock?warehouse=${encodeURIComponent(warehouse)}`);
    const stock = await response.json();
    if (!response.ok || !Array.isArray(stock)) throw new Error(stock.error || 'Could not load warehouse stock.');
    if (token !== loadToken) return;
    const saved = Array.isArray(initial.items) ? initial.items : [];
    const savedByCode = new Map(saved.map((item) => [item.item_code, item]));
    rows = stock.map((balance) => {
      const item = savedByCode.get(balance.item_code);
      return item ? itemFromSaved(item, balance, false)
        : { id: '', code: balance.item_code, name: balance.item_name,
          book: number(balance.quantity), counted: number(balance.quantity),
          rate: number(balance.valuation_rate), bookRate: number(balance.valuation_rate) };
    });
    const loadedCodes = new Set(rows.map((item) => item.code));
    for (const item of saved) {
      if (!loadedCodes.has(item.item_code)) rows.push(itemFromSaved(item, null, false));
    }
    loadedWarehouse = warehouse;
    if (searchInput) searchInput.disabled = false;
    renderRows();
    setStatus(`${stock.length.toLocaleString()} stocked item${stock.length === 1 ? '' : 's'} loaded. Add other counted items below.`);
  } catch (err) {
    if (token !== loadToken) return;
    if (searchInput) searchInput.disabled = true;
    setStatus(err.message || 'Could not load warehouse stock.', true);
  }
}

async function loadWarehouses(query = '') {
  try {
    const response = await fetch(`/api/warehouses?q=${encodeURIComponent(query)}`);
    if (!response.ok) throw new Error('Warehouse lookup failed');
    const warehouses = await response.json();
    warehouseList.replaceChildren(...warehouses.map((warehouse) => {
      const option = document.createElement('option');
      option.value = warehouse;
      return option;
    }));
  } catch { warehouseList.replaceChildren(); }
}

async function searchItems(query) {
  if (!searchResults) return;
  if (!query.trim()) { searchResults.replaceChildren(); return; }
  try {
    const response = await fetch(`/api/master-items?q=${encodeURIComponent(query.trim())}`);
    if (!response.ok) throw new Error('Item lookup failed');
    const items = await response.json();
    searchResults.replaceChildren();
    for (const item of items) {
      if (rows.some((row) => row.code === item.item_code) || item.disabled === '1') continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.itemCode = item.item_code;
      button.dataset.itemName = item.item_name || item.item_code;
      button.innerHTML = `<strong>${escapeHtml(item.item_name || item.item_code)}</strong><small>${escapeHtml(item.item_code)}</small>`;
      searchResults.appendChild(button);
    }
    if (!searchResults.children.length) searchResults.textContent = 'No other matching items.';
  } catch { searchResults.textContent = 'Could not search items.'; }
}

rowsBody.addEventListener('input', (event) => {
  const tr = event.target.closest('tr');
  if (!tr) return;
  if (event.target.name === 'quantity') tr._item.counted = number(event.target.value);
  if (event.target.name === 'valuation_rate') tr._item.rate = number(event.target.value);
  if (event.target.name === 'valuation_rate') tr.querySelector('.reconciliation-rate-value').textContent = rateMoney(tr._item.rate);
  updateRow(tr, tr._item);
  updateSummary();
});
rowsBody.addEventListener('click', (event) => {
  const editRate = event.target.closest('[data-edit-rate]');
  if (editRate && canEditRate) {
    const tr = editRate.closest('tr');
    const input = tr.querySelector('[name="valuation_rate"]');
    input.hidden = false;
    tr.querySelector('.reconciliation-rate-value').hidden = true;
    editRate.hidden = true;
    input.focus();
    input.select();
    return;
  }
  if (!event.target.closest('[data-remove]')) return;
  rows = rows.filter((item) => item !== event.target.closest('tr')._item);
  renderRows();
});
if (loadButton) loadButton.addEventListener('click', loadWarehouseStock);
if (!readOnly && !initial.entry?.id) {
  warehouseInput.addEventListener('change', loadWarehouseStock);
  warehouseInput.addEventListener('input', () => {
    clearTimeout(warehouseTimer);
    warehouseTimer = setTimeout(() => loadWarehouses(warehouseInput.value), 180);
  });
}
if (searchInput) {
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => searchItems(searchInput.value), 180);
  });
  searchResults.addEventListener('click', (event) => {
    const button = event.target.closest('[data-item-code]');
    if (!button) return;
    if (!warehouseInput.value.trim()) { setStatus('Choose a warehouse first.', true); warehouseInput.focus(); return; }
    rows.push({ id: '', code: button.dataset.itemCode, name: button.dataset.itemName,
      book: 0, counted: 0, rate: 0, bookRate: 0 });
    searchInput.value = '';
    searchResults.replaceChildren();
    renderRows();
    rowsBody.lastElementChild?.querySelector('[name="quantity"]')?.focus();
  });
}
form.addEventListener('submit', (event) => {
  if (countSheetBusy) { event.preventDefault(); setStatus('Wait for the count sheet upload to finish.', true); return; }
  if (!rows.length) { event.preventDefault(); setStatus('Add at least one item to count.', true); return; }
  for (const input of rowsBody.querySelectorAll('[name="quantity"]')) {
    if (input.value === '' || !Number.isFinite(Number(input.value)) || Number(input.value) < 0) {
      event.preventDefault(); setStatus('Complete every counted quantity.', true); input.focus(); return;
    }
  }
  for (const tr of rowsBody.rows) {
    if (difference(tr._item) > 0 && tr._item.rate <= 0) {
      event.preventDefault();
      setStatus(canEditRate ? `Enter a valuation rate for ${tr._item.name}.`
        : `An admin must set a valuation rate for ${tr._item.name} before submission.`, true);
      if (canEditRate) {
        tr.querySelector('[data-edit-rate]')?.click();
        tr.querySelector('[name="valuation_rate"]').focus();
      }
      return;
    }
  }
});

if (warehouseList) loadWarehouses();
if (readOnly) {
  const balances = new Map((initial.balances || []).map((balance) => [balance.item_code, balance]));
  rows = (initial.items || []).map((item) => itemFromSaved(item, balances.get(item.item_code), initial.entry?.docstatus !== 'draft'));
  renderRows();
} else if (warehouseInput.value.trim()) {
  loadWarehouseStock();
} else {
  renderRows();
}

const purchaseForm = document.querySelector('#purchase-form');
const fromPurchaseOrder = Boolean(purchaseForm.dataset.purchaseOrderId);
const purchaseRows = document.querySelector('#purchase-items tbody');
const supplierInput = document.querySelector('#purchase-supplier');
const supplierName = document.querySelector('#purchase-supplier-name');
const supplierList = document.querySelector('#purchase-suppliers');
const itemList = document.querySelector('#purchase-items-list');
const warehouseList = document.querySelector('#purchase-warehouses');
const priceListSelect = document.querySelector('#purchase-price-list');
const totalLabel = document.querySelector('#purchase-total');
let suppliers = [];
let items = [];
const searchTimers = new WeakMap();

function scheduleSearch(input, callback) {
  clearTimeout(searchTimers.get(input));
  searchTimers.set(input, setTimeout(callback, 180));
}

function formatMoney(value) {
  return `Ugx ${Number(value || 0).toLocaleString('en-UG', { maximumFractionDigits: 0 })}`;
}

function setOptions(list, rows, valueKey, labelKey) {
  list.replaceChildren();
  for (const row of rows) {
    const option = document.createElement('option');
    option.value = typeof row === 'string' ? row : row[valueKey];
    if (labelKey && typeof row !== 'string') option.label = row[labelKey] || option.value;
    list.appendChild(option);
  }
}

const lookupStatus = document.querySelector('#purchase-lookup-status');
const lookupMessage = lookupStatus.querySelector('[data-lookup-message]');
const retryLookup = lookupStatus.querySelector('[data-lookup-retry]');
const failures = new Map();
const requests = new WeakMap();

function showLookupStatus(message = '') {
  const errors = [...failures.values()];
  lookupMessage.textContent = errors.length
    ? `Could not load ${errors.map((error) => error.label).join(', ')}. Check your connection and retry.`
    : message;
  lookupStatus.hidden = !lookupMessage.textContent;
  lookupStatus.classList.toggle('warning', Boolean(errors.length));
  retryLookup.hidden = !errors.length;
}

async function lookup(list, input, endpoint, label, apply, filter = (rows) => rows) {
  const query = input ? input.value.trim() : '';
  const request = {};
  requests.set(list, request);
  failures.delete(list);
  setOptions(list, [], '');
  showLookupStatus(`Loading ${label}…`);
  const current = () => requests.get(list) === request && (!input || input.isConnected && input.value.trim() === query)
    && (!endpoint.startsWith('/api/master-items?') || endpoint.includes(`price_list=${encodeURIComponent(priceListSelect.value)}`));
  try {
    const response = await fetch(`${endpoint}${endpoint.includes('?') ? '&' : '?'}q=${encodeURIComponent(query)}`);
    if (!response.ok) throw new Error('Lookup failed');
    const result = await response.json();
    if (!Array.isArray(result)) throw new Error('Invalid lookup result');
    if (!current()) return;
    const rows = filter(result);
    apply(rows);
    showLookupStatus(rows.length ? '' : `No matching ${label}. Try a different search.`);
  } catch {
    if (!current()) return;
    failures.set(list, { label, retry: () => lookup(list, input, endpoint, label, apply, filter) });
    showLookupStatus();
  }
}

retryLookup.addEventListener('click', () => {
  [...failures.values()].forEach((failure) => failure.retry());
});

function loadSuppliers() {
  return lookup(supplierList, supplierInput, '/api/suppliers', 'suppliers', (rows) => {
    suppliers = rows;
    setOptions(supplierList, rows, 'supplier_id', 'supplier_name');
    updateSupplierName();
  });
}

function loadItems(input) {
  if (!priceListSelect.value) { showLookupStatus('Choose a price list first.'); return; }
  return lookup(itemList, input, `/api/master-items?price_list=${encodeURIComponent(priceListSelect.value)}`, 'items', (rows) => {
    items = rows;
    setOptions(itemList, rows, 'item_code', 'item_name');
    updateItemName(input);
  }, (rows) => rows.filter((item) => item.is_purchase_item && item.disabled !== '1'));
}

function loadWarehouses(input = null) {
  return lookup(warehouseList, input, '/api/warehouses', 'warehouses', (rows) => setOptions(warehouseList, rows));
}

function updateTotals() {
  let total = 0;
  [...purchaseRows.rows].forEach((row, index) => {
    row.querySelector('.row-number').textContent = index + 1;
    const qty = Number(row.querySelector('[name="quantity"]').value || 0);
    const rate = Number(row.querySelector('[name="unit_price"]').value || 0);
    const lineTotal = Math.round(qty * rate * 100) / 100;
    row.querySelector('.purchase-line-total').textContent = formatMoney(lineTotal);
    total += lineTotal;
  });
  totalLabel.textContent = formatMoney(total);
}

function updateSupplierName() {
  if (!supplierName) return;
  const selected = suppliers.find((row) => row.supplier_id === supplierInput.value.trim());
  supplierName.value = selected ? selected.supplier_name : '';
}

function updateItemName(input, applyRate = false) {
  const row = input.closest('tr');
  const selected = items.find((item) => item.item_code === input.value.trim());
  if (selected) {
    row.querySelector('[name="item_name"]').value = selected.item_name;
    const rate = row.querySelector('[name="unit_price"]');
    if (applyRate) rate.value = selected.unit_cost || 0;
  } else {
    row.querySelector('[name="item_name"]').value = '';
  }
  updateTotals();
}

supplierInput.addEventListener('input', () => {
  updateSupplierName();
  scheduleSearch(supplierInput, loadSuppliers);
});
supplierInput.addEventListener('change', updateSupplierName);
supplierInput.addEventListener('focus', loadSuppliers);

purchaseRows.addEventListener('input', (event) => {
  const input = event.target;
  if (input.matches('[name="item_code"]')) scheduleSearch(input, () => loadItems(input));
  if (input.matches('[name="warehouse"]')) scheduleSearch(input, () => loadWarehouses(input));
  updateTotals();
});
purchaseRows.addEventListener('focusin', (event) => {
  const input = event.target;
  if (input.matches('[name="item_code"]')) loadItems(input);
  if (input.matches('[name="warehouse"]')) loadWarehouses(input);
});
purchaseRows.addEventListener('change', (event) => {
  if (event.target.matches('[name="item_code"]')) updateItemName(event.target, true);
});
purchaseRows.addEventListener('click', (event) => {
  const remove = event.target.closest('[data-remove-purchase-row]');
  if (!remove) return;
  if (purchaseRows.rows.length === 1) {
    if (fromPurchaseOrder) return;
    purchaseRows.querySelectorAll('input').forEach((input) => { input.value = ''; });
  } else {
    remove.closest('tr').remove();
  }
  updateTotals();
});
document.querySelector('#add-purchase-row').addEventListener('click', () => {
  if (fromPurchaseOrder) return;
  const row = purchaseRows.rows[0].cloneNode(true);
  row.querySelectorAll('input').forEach((input) => { input.value = ''; });
  purchaseRows.appendChild(row);
  updateTotals();
  row.querySelector('[name="item_code"]').focus();
});

purchaseForm.addEventListener('submit', (event) => {
  if (!purchaseRows.rows.length) {
    event.preventDefault();
    return;
  }
  updateTotals();
});

loadWarehouses();
async function loadPriceLists() {
  const selected = priceListSelect.value;
  try {
    const response = await fetch('/api/price-lists?type=buying');
    if (!response.ok) throw new Error('Price lists unavailable');
    const rows = await response.json();
    priceListSelect.replaceChildren(new Option('Choose price list', ''));
    for (const row of rows) priceListSelect.add(new Option(`${row.value} · ${row.label}`, row.value));
    if (selected && !rows.some((row) => row.value === selected)) priceListSelect.add(new Option(selected, selected));
    priceListSelect.value = selected;
  } catch { showLookupStatus('Could not load price lists. Retry the page.'); }
}
priceListSelect.addEventListener('change', () => {
  if (fromPurchaseOrder) return;
  items = [];
  for (const row of purchaseRows.rows) {
    row.querySelector('[name="item_code"]').value = '';
    row.querySelector('[name="item_name"]').value = '';
    row.querySelector('[name="unit_price"]').value = '';
  }
  updateTotals();
});
loadPriceLists();
updateTotals();

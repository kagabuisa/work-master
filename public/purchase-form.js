const purchaseForm = document.querySelector('#purchase-form');
const purchaseRows = document.querySelector('#purchase-items tbody');
const supplierInput = document.querySelector('#purchase-supplier');
const supplierName = document.querySelector('#purchase-supplier-name');
const supplierList = document.querySelector('#purchase-suppliers');
const itemList = document.querySelector('#purchase-items-list');
const warehouseList = document.querySelector('#purchase-warehouses');
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

async function search(url) {
  const response = await fetch(url);
  if (!response.ok) return [];
  return response.json();
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
  const selected = suppliers.find((row) => row.supplier_id === supplierInput.value.trim());
  supplierName.value = selected ? selected.supplier_name : '';
}

function updateItemName(input) {
  const row = input.closest('tr');
  const selected = items.find((item) => item.item_code === input.value.trim());
  if (selected) {
    row.querySelector('[name="item_name"]').value = selected.item_name;
    const rate = row.querySelector('[name="unit_price"]');
    if (!rate.value) rate.value = selected.unit_cost || 0;
  } else {
    row.querySelector('[name="item_name"]').value = '';
  }
  updateTotals();
}

supplierInput.addEventListener('input', () => {
  updateSupplierName();
  scheduleSearch(supplierInput, async () => {
    suppliers = await search(`/api/suppliers?q=${encodeURIComponent(supplierInput.value.trim())}`);
    setOptions(supplierList, suppliers, 'supplier_id', 'supplier_name');
    updateSupplierName();
  });
});
supplierInput.addEventListener('change', updateSupplierName);

purchaseRows.addEventListener('input', (event) => {
  if (event.target.matches('[name="item_code"]')) {
    const input = event.target;
    scheduleSearch(input, async () => {
      items = (await search(`/api/master-items?q=${encodeURIComponent(input.value.trim())}`))
        .filter((item) => item.is_purchase_item && item.disabled !== '1');
      setOptions(itemList, items, 'item_code', 'item_name');
      updateItemName(input);
    });
  }
  if (event.target.matches('[name="warehouse"]')) {
    const input = event.target;
    scheduleSearch(input, async () => {
      const warehouses = await search(`/api/warehouses?q=${encodeURIComponent(input.value.trim())}`);
      setOptions(warehouseList, warehouses);
    });
  }
  updateTotals();
});
purchaseRows.addEventListener('change', (event) => {
  if (event.target.matches('[name="item_code"]')) updateItemName(event.target);
});
purchaseRows.addEventListener('click', (event) => {
  const remove = event.target.closest('[data-remove-purchase-row]');
  if (!remove) return;
  if (purchaseRows.rows.length === 1) {
    purchaseRows.querySelectorAll('input').forEach((input) => { input.value = ''; });
  } else {
    remove.closest('tr').remove();
  }
  updateTotals();
});
document.querySelector('#add-purchase-row').addEventListener('click', () => {
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

search('/api/warehouses').then((rows) => setOptions(warehouseList, rows));
updateTotals();

const items = [];
const itemSearch = document.querySelector('#item-search');
const itemResults = document.querySelector('#item-results');
const warehouseSelect = document.querySelector('#warehouse-select');
const priceListSelect = document.querySelector('#invoice-price-list');
const costCenterInput = document.querySelector('#invoice-cost-center');
const costCenterOptions = document.querySelector('#invoice-cost-centers');
const refreshPricesButton = document.querySelector('#refresh-invoice-prices');
const priceUpdateStatus = document.querySelector('#invoice-price-update-status');
const customerSearch = document.querySelector('#customer-search');
const customerResults = document.querySelector('#customer-results');
const customerId = document.querySelector('#customer-id');
const invoicerSearch = document.querySelector('#invoice-invoicer');
const invoicerId = document.querySelector('#invoice-invoicer-id');
const invoicerResults = document.querySelector('#invoice-invoicer-results');
const tbody = document.querySelector('#invoice-items tbody');
const payments = [];
const paymentsTbody = document.querySelector('#invoice-payments tbody');
const form = document.querySelector('#invoice-form');
const itemsJson = document.querySelector('#items-json');
const paymentsJson = document.querySelector('#payments-json');
const grandTotal = document.querySelector('#grand-total');
const paidTotal = document.querySelector('#paid-total');
const balanceTotal = document.querySelector('#balance-total');
const paymentStatus = document.querySelector('#payment-status');
const paymentDate = document.querySelector('#payment-date');
const paymentAmount = document.querySelector('#payment-amount');
const paymentAccount = document.querySelector('#payment-account');
const paymentReference = document.querySelector('#payment-reference');
const paymentNotes = document.querySelector('#payment-notes');
const addPaymentButton = document.querySelector('#add-payment');
const formError = document.querySelector('#invoice-form-error');
const initialData = window.invoiceInitial || {};
const editSaveButton = document.querySelector('[data-edit-save]');
const editSubmitActions = [...document.querySelectorAll('[data-edit-submit-action]')];
let activeWarehouse = initialData.warehouse || '';
let activePriceList = initialData.invoice?.price_list || '';
let repricing = false;
let dirty = Boolean(initialData.recovered);
let saving = false;
let savedInvoiceState = null;
form.addEventListener('input', () => { dirty = true; updateEditActions(); });
form.addEventListener('change', () => { dirty = true; updateEditActions(); });
window.addEventListener('beforeunload', (event) => {
  if (saving || (initialData.invoice?.id ? !isInvoiceChanged() : !dirty)) return;
  event.preventDefault();
  event.returnValue = '';
});
window.addEventListener('pageshow', () => { saving = false; });

const money = new Intl.NumberFormat('en-UG', {
  style: 'currency',
  currency: 'UGX',
  currencyDisplay: 'code',
  maximumFractionDigits: 0,
});

const formatMoney = (value) => money.format(value).replace('UGX', 'Ugx');

let preloadedCustomers = [];
let itemRequestId = 0;
let customersLoading = false;
let costCenterTimer;
let costCenterRequestId = 0;

async function loadCostCenters() {
  const requestId = ++costCenterRequestId;
  const query = costCenterInput.value.trim();
  try {
    const response = await fetch(`/api/cost-centers?q=${encodeURIComponent(query)}`);
    if (!response.ok) return;
    const rows = await response.json();
    if (requestId !== costCenterRequestId || query !== costCenterInput.value.trim()) return;
    costCenterOptions.replaceChildren(...rows.map((row) => {
      const option = document.createElement('option');
      option.value = row.cost_center;
      option.label = row.cost_center_name;
      return option;
    }));
  } catch {
    // The saved value remains available if suggestions cannot be loaded.
  }
}

costCenterInput.addEventListener('focus', loadCostCenters);
costCenterInput.addEventListener('input', () => {
  clearTimeout(costCenterTimer);
  costCenterTimer = setTimeout(loadCostCenters, 220);
});
let editingPaymentIndex = null;

let itemTimer;
itemSearch.addEventListener('input', () => {
  clearTimeout(itemTimer);
  itemRequestId += 1;
  itemResults.innerHTML = '';
  itemTimer = setTimeout(searchItems, 220);
});

itemSearch.addEventListener('focus', searchItems);
itemSearch.addEventListener('click', () => {
  searchItems();
});

itemSearch.addEventListener('blur', () => {
  setTimeout(() => {
    if (!itemResults.contains(document.activeElement)) {
      itemSearch.value = '';
      itemResults.innerHTML = '';
    }
  }, 150);
});

warehouseSelect.addEventListener('change', async () => {
  const nextWarehouse = warehouseSelect.value;
  if (nextWarehouse === activeWarehouse) return;
  if (items.length) {
    const confirmed = await confirmWithDialog(`Changing the warehouse will remove ${items.length} line item${items.length === 1 ? '' : 's'}. Continue?`);
    if (!confirmed) {
      warehouseSelect.value = activeWarehouse;
      syncWarehouseFields();
      updateEditActions();
      return;
    }
  }

  activeWarehouse = nextWarehouse;
  syncWarehouseFields();
  items.length = 0;
  renderItems();
});

let customerTimer;
let invoicerTimer;
let invoicerRequestId = 0;

async function searchInvoicers() {
  const requestId = ++invoicerRequestId;
  const query = invoicerSearch.value.trim();
  invoicerResults.innerHTML = '<p>Loading employees...</p>';
  try {
    const response = await fetch(`/api/employees?q=${encodeURIComponent(query)}`);
    if (!response.ok) throw new Error('Employee request failed.');
    const rows = await response.json();
    if (requestId !== invoicerRequestId || query !== invoicerSearch.value.trim()) return;
    invoicerResults.innerHTML = rows.map((employee) => `
      <button type="button" data-id="${escapeAttr(employee.employee_id)}" data-name="${escapeAttr(employee.employee_name)}">
        <strong>${escapeHtml(employee.employee_name)}</strong>
        <span>${escapeHtml([employee.employee_id, employee.department].filter(Boolean).join(' · '))}</span>
      </button>
    `).join('') || '<p>No matching employees.</p>';
    invoicerResults.querySelectorAll('[data-id]').forEach((button) => {
      button.addEventListener('mousedown', (event) => { event.preventDefault(); selectInvoicer(button); });
      button.addEventListener('click', () => selectInvoicer(button));
    });
  } catch {
    if (requestId === invoicerRequestId) invoicerResults.innerHTML = '<p>Could not load employees.</p>';
  }
}

function selectInvoicer(button) {
  clearTimeout(invoicerTimer);
  invoicerRequestId += 1;
  invoicerId.value = button.dataset.id;
  invoicerSearch.value = button.dataset.name;
  invoicerResults.innerHTML = '';
  dirty = true;
  updateEditActions();
}

function clearUnselectedInvoicer() {
  if (!invoicerId.value) invoicerSearch.value = '';
  invoicerResults.innerHTML = '';
  updateEditActions();
}

invoicerSearch.addEventListener('input', () => {
  invoicerId.value = '';
  clearTimeout(invoicerTimer);
  invoicerTimer = setTimeout(searchInvoicers, 220);
});
invoicerSearch.addEventListener('focus', searchInvoicers);
invoicerSearch.addEventListener('click', searchInvoicers);
invoicerSearch.addEventListener('blur', () => setTimeout(clearUnselectedInvoicer, 150));

customerSearch.addEventListener('input', () => {
  customerId.value = '';
  clearTimeout(customerTimer);
  customerTimer = setTimeout(searchCustomers, 220);
});

customerSearch.addEventListener('focus', () => {
  showPreloadedCustomers();
});

customerSearch.addEventListener('click', () => {
  showPreloadedCustomers();
});

customerSearch.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    customerResults.innerHTML = '';
    return;
  }
  if (event.key !== 'Enter' || event.ctrlKey) {
    return;
  }
  const firstResult = customerResults.querySelector('[data-id]');
  if (!firstResult) {
    return;
  }
  event.preventDefault();
  selectCustomer(firstResult);
});

customerSearch.addEventListener('blur', () => {
  setTimeout(clearUnselectedCustomer, 150);
});

document.addEventListener('click', (event) => {
  closeResultsOnOutsideClick(event, itemSearch, itemResults, () => {
    itemSearch.value = '';
  });
  closeResultsOnOutsideClick(event, customerSearch, customerResults, clearUnselectedCustomer);
  closeResultsOnOutsideClick(event, invoicerSearch, invoicerResults, clearUnselectedInvoicer);
});

document.querySelectorAll('[name="discount_amount"], [name="tax_amount"]').forEach((input) => {
  input.addEventListener('input', renderTotals);
});

form.addEventListener('input', clearFormError);

initializeInvoiceForm();
initializePayments();
savedInvoiceState = JSON.stringify(invoiceState());
updateEditActions();
loadWarehouses();
loadPriceLists();
preloadCustomers();

addPaymentButton.addEventListener('click', addPaymentFromForm);

form.addEventListener('submit', (event) => {
  if (repricing) {
    event.preventDefault();
    showFormError('Wait for the item prices to update before saving.');
    return;
  }
  if (hasPendingPaymentInput()) {
    if (!addPaymentFromForm()) {
      event.preventDefault();
      return;
    }
  }
  if (!customerId.value) {
    event.preventDefault();
    showFormError('Select a customer from the database.', customerSearch);
    return;
  }
  if (!invoicerId.value) {
    event.preventDefault();
    showFormError('Select an invoicer from the employee list.', invoicerSearch);
    return;
  }
  if (!priceListSelect.value) {
    event.preventDefault();
    showFormError('Select a price list.', priceListSelect);
    return;
  }
  if (!items.length) {
    event.preventDefault();
    showFormError('Add at least one item.', itemSearch);
    return;
  }
  if (calculatePaidTotal() > calculateGrandTotal()) {
    event.preventDefault();
    showFormError('Total payments cannot exceed the invoice total.', paymentAmount);
    return;
  }
  itemsJson.value = JSON.stringify(items);
  paymentsJson.value = JSON.stringify(payments);
  saving = true;
});

form.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.ctrlKey) {
    return;
  }
  if (event.target.matches('textarea')) {
    return;
  }
  if (event.target.closest('#invoice-items')) {
    return;
  }
  event.preventDefault();
  if (event.target === itemSearch) {
    const firstItem = itemResults.querySelector('[data-item]');
    if (firstItem) {
      firstItem.click();
      return;
    }
  }
  if (event.target === customerSearch) {
    const firstCustomer = customerResults.querySelector('[data-id]');
    if (firstCustomer) {
      selectCustomer(firstCustomer);
      return;
    }
  }
  if (event.target === invoicerSearch) {
    const firstInvoicer = invoicerResults.querySelector('[data-id]');
    if (firstInvoicer) {
      selectInvoicer(firstInvoicer);
      return;
    }
  }
  focusNextField(event.target);
});

form.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    clearTimeout(itemTimer);
    itemRequestId += 1;
    itemResults.innerHTML = '';
    customerResults.innerHTML = '';
    invoicerResults.innerHTML = '';
  }
});

async function searchItems() {
  clearTimeout(itemTimer);
  const requestId = ++itemRequestId;
  const q = itemSearch.value.trim();
  const warehouse = warehouseSelect.value;
  const priceList = priceListSelect.value;
  if (!warehouse || !priceListSelect.value) {
    itemResults.innerHTML = '<p>Choose a price list and warehouse before searching items.</p>';
    return;
  }
  const isCurrentSearch = () => requestId === itemRequestId
    && warehouse === warehouseSelect.value
    && priceList === priceListSelect.value
    && q === itemSearch.value.trim()
    && (document.activeElement === itemSearch || itemResults.contains(document.activeElement));
  itemResults.innerHTML = '<p>Loading items...</p>';
  try {
    const response = await fetch(`/api/items?q=${encodeURIComponent(q)}&warehouse=${encodeURIComponent(warehouse)}&price_list=${encodeURIComponent(priceList)}`);
    if (!response.ok) {
      throw new Error('Item request failed.');
    }
    const rows = await response.json();
    if (isCurrentSearch()) renderItemResults(rows);
  } catch {
    if (isCurrentSearch()) {
      itemResults.innerHTML = '<p>Could not load items for this warehouse. Click the search field to retry.</p>';
    }
  }
}

function renderItemResults(rows) {
  itemResults.innerHTML = rows.map((item) => `
    <div class="result-row">
      <div class="item-result-details">
        <strong class="item-result-name">${escapeHtml(item.item_name || item.item_code)}</strong>
        <span class="item-result-meta">${[
          item.item_code !== item.item_name ? item.item_code : '',
          item.category,
        ].filter(Boolean).map(escapeHtml).join(' · ')}</span>
      </div>
      <div class="item-result-stock">
        <span class="item-result-label">In stock</span>
        <strong>${formatQuantity(item.stock_balance)}${item.stock_uom ? ` <small>${escapeHtml(item.stock_uom)}</small>` : ''}</strong>
      </div>
      <div class="item-result-price">
        <span class="item-result-label">Unit price</span>
        <strong>${formatMoney(item.unit_price || 0)}</strong>
      </div>
      <label class="item-result-quantity">
        <span class="item-result-label">Qty</span>
        <input type="text" inputmode="decimal" value="1" data-qty>
      </label>
      <button type="button" data-item='${escapeAttr(JSON.stringify(item))}'>Add</button>
    </div>
  `).join('') || '<p>No matching items.</p>';

  itemResults.querySelectorAll('[data-item]').forEach((button) => {
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      selectItemResult(button);
    });
    button.addEventListener('click', () => {
      if (!button.isConnected) {
        return;
      }
      selectItemResult(button);
    });
  });

  itemResults.querySelectorAll('.result-row').forEach((row) => {
    row.addEventListener('mousedown', (event) => {
      if (event.target.closest('input, button')) {
        return;
      }
      const button = row.querySelector('[data-item]');
      if (!button) {
        return;
      }
      event.preventDefault();
      selectItemResult(button);
    });
  });

  itemResults.querySelectorAll('[data-qty]').forEach((input) => {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.closest('.result-row').querySelector('[data-item]').click();
      }
    });
  });
}

function selectItemResult(button) {
  const row = button.closest('.result-row');
  if (!row || !button.dataset.item) {
    return;
  }
  const quantity = Number(row.querySelector('[data-qty]').value || 0);
  addItem(JSON.parse(button.dataset.item), quantity);
  itemSearch.value = '';
  itemResults.innerHTML = '';
  requestAnimationFrame(() => {
    itemSearch.focus();
    itemSearch.select();
  });
}

async function loadWarehouses() {
  try {
    const response = await fetch('/api/warehouses');
    if (!response.ok) {
      throw new Error('Warehouse request failed.');
    }
    const warehouses = await response.json();
    warehouseSelect.innerHTML = [
      '<option value="">Choose warehouse</option>',
      ...warehouses.map((warehouse) => `<option value="${escapeAttr(warehouse)}">${escapeHtml(warehouse)}</option>`),
    ].join('');
    if (initialData.warehouse) {
      warehouseSelect.value = initialData.warehouse;
      activeWarehouse = initialData.warehouse;
    }
    syncWarehouseFields();
  } catch {
    warehouseSelect.innerHTML = initialData.warehouse
      ? `<option value="${escapeAttr(initialData.warehouse)}">${escapeHtml(initialData.warehouse)}</option>`
      : '<option value="">Could not load warehouses</option>';
  } finally {
    syncWarehouseFields();
    updateEditActions();
  }
}

function syncWarehouseFields() {
  itemSearch.disabled = repricing || !warehouseSelect.value || !priceListSelect.value;
  itemSearch.placeholder = !priceListSelect.value ? 'Choose a price list first' : warehouseSelect.value ? 'Search item name, code, category' : 'Choose a warehouse first';
}

async function loadPriceLists() {
  try {
    const response = await fetch('/api/price-lists?type=selling&invoice=1');
    if (!response.ok) throw new Error('Price lists unavailable');
    const rows = await response.json();
    const selected = initialData.invoice?.price_list || priceListSelect.value;
    priceListSelect.replaceChildren(new Option('Choose price list', ''));
    for (const row of rows) priceListSelect.add(new Option(`${row.value} · ${row.label}`, row.value));
    if (selected && !rows.some((row) => row.value === selected)) {
      const unavailable = new Option(`${selected} · No longer available to this role`, selected);
      unavailable.disabled = true;
      priceListSelect.add(unavailable);
    }
    priceListSelect.value = selected || '';
    activePriceList = priceListSelect.value;
  } catch {
    priceListSelect.replaceChildren(new Option(activePriceList || 'Could not load price lists', activePriceList));
  }
  syncWarehouseFields();
  updateEditActions();
}

priceListSelect.addEventListener('change', () => updateInvoiceItemPrices());
refreshPricesButton?.addEventListener('click', () => updateInvoiceItemPrices(true));

async function updateInvoiceItemPrices(force = false) {
  const nextPriceList = priceListSelect.value;
  if (repricing || !force && nextPriceList === activePriceList) return;
  clearTimeout(itemTimer);
  itemRequestId += 1;
  itemResults.innerHTML = '';
  if (!items.length) {
    activePriceList = nextPriceList;
    if (force) showFormError('Add an item before refreshing prices.', itemSearch);
    syncWarehouseFields();
    updateEditActions();
    return;
  }
  if (!nextPriceList) {
    priceListSelect.value = activePriceList;
    showFormError('Select a price list to update the item prices.', priceListSelect);
    return;
  }
  repricing = true;
  updateEditActions();
  priceListSelect.disabled = true;
  if (refreshPricesButton) refreshPricesButton.disabled = true;
  if (priceUpdateStatus) {
    priceUpdateStatus.textContent = 'Updating item prices…';
    priceUpdateStatus.hidden = false;
  }
  syncWarehouseFields();
  try {
    const response = await fetch('/api/invoice-item-prices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ price_list: nextPriceList, item_codes: items.map((item) => item.item_code) }),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || `Price lookup failed (${response.status}).`);
    }
    const prices = await response.json();
    const byCode = new Map(prices.map((row) => [row.item_code, row]));
    if (items.some((item) => !byCode.has(item.item_code))) throw new Error('An item price is missing.');
    const changed = items.filter((item) => item.unit_price !== roundMoney(byCode.get(item.item_code).unit_price)).length;
    const missing = items.filter((item) => !byCode.get(item.item_code).has_list_price).map((item) => item.item_code);
    for (const item of items) item.unit_price = roundMoney(byCode.get(item.item_code).unit_price);
    activePriceList = nextPriceList;
    renderItems();
    clearFormError();
    if (priceUpdateStatus) {
      const summary = changed ? `Updated ${changed} item rate${changed === 1 ? '' : 's'}.` : 'Item rates already match this price list.';
      priceUpdateStatus.textContent = missing.length
        ? `${summary} No price in ${nextPriceList} for ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` and ${missing.length - 3} more` : ''}; item default rates were used.`
        : summary;
    }
  } catch (error) {
    priceListSelect.value = activePriceList;
    priceListSelect.disabled = false;
    if (priceUpdateStatus) priceUpdateStatus.hidden = true;
    showFormError(`Could not update item prices: ${error.message}`, priceListSelect);
  } finally {
    repricing = false;
    priceListSelect.disabled = false;
    if (refreshPricesButton) refreshPricesButton.disabled = false;
    syncWarehouseFields();
    updateEditActions();
  }
}

function confirmWithDialog(message) {
  if (window.WorkMasterConfirm) {
    return window.WorkMasterConfirm(message);
  }

  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => resolve(window.confirm(message)), 1500);
    window.addEventListener('WorkMasterConfirmReady', () => {
      window.clearTimeout(timeout);
      if (window.WorkMasterConfirm) {
        resolve(window.WorkMasterConfirm(message));
      } else {
        resolve(window.confirm(message));
      }
    }, { once: true });
  });
}

async function searchCustomers() {
  const q = customerSearch.value.trim();
  if (!q) {
    showPreloadedCustomers();
    return;
  }
  try {
    const rows = await fetchCustomers(q);
    renderCustomerResults(rows);
  } catch {
    customerResults.innerHTML = '<p>Could not load customers.</p>';
  }
}

async function fetchCustomers(q = '') {
  const response = await fetch(`/api/customers?q=${encodeURIComponent(q)}`);
  if (!response.ok) {
    throw new Error('Customer request failed.');
  }
  return response.json();
}

async function preloadCustomers() {
  customersLoading = true;
  try {
    preloadedCustomers = await fetchCustomers();
  } catch {
    preloadedCustomers = [];
  } finally {
    customersLoading = false;
    if (document.activeElement === customerSearch && !customerSearch.value.trim()) {
      showPreloadedCustomers();
    }
  }
}

function showPreloadedCustomers() {
  if (customersLoading) {
    customerResults.innerHTML = '<p>Loading customers...</p>';
    return;
  }
  renderCustomerResults(preloadedCustomers);
}

function renderCustomerResults(rows) {
  customerResults.innerHTML = rows.map((customer) => `
    <button type="button" data-id="${escapeAttr(customer.customer_id)}" data-name="${escapeAttr(customer.customer_name)}">
      <strong>${escapeHtml(customer.customer_name)}</strong>
      <span>${escapeHtml([customer.territory, customer.customer_group].filter(Boolean).join(' · '))}</span>
    </button>
  `).join('') || '<p>No matching customers.</p>';

  customerResults.querySelectorAll('[data-id]').forEach((button) => {
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      selectCustomer(button);
    });
    button.addEventListener('click', () => {
      selectCustomer(button);
    });
  });
}

function addItem(source, quantity = 1) {
  dirty = true;
  quantity = normalizeQuantity(quantity);
  if (quantity <= 0) {
    return;
  }
  const existing = items.find((item) => item.item_code === source.item_code);
  if (existing) {
    existing.quantity = normalizeQuantity(existing.quantity + quantity);
  } else {
    items.push({
      id: 0,
      item_code: source.item_code,
      item_name: source.item_name || source.item_code,
      warehouse: source.warehouse || '',
      quantity,
      unit_price: roundMoney(source.unit_price),
      stock_at_sale: normalizeQuantity(source.stock_balance),
    });
  }
  renderItems();
}

function initializeInvoiceForm() {
  if (!Array.isArray(initialData.items) || !initialData.items.length) {
    renderTotals();
    return;
  }

  initialData.items.forEach((item) => {
    items.push({
      id: Number(item.id || 0),
      line_no: Number(item.line_no || item.id || 0),
      item_code: item.item_code,
      item_name: item.item_name,
      warehouse: item.warehouse || '',
      quantity: normalizeQuantity(item.quantity),
      unit_price: roundMoney(item.unit_price),
      stock_at_sale: item.stock_at_sale == null ? null : normalizeQuantity(item.stock_at_sale),
    });
  });
  renderItems();
}

function initializePayments() {
  const existingPayments = initialData.invoice && Array.isArray(initialData.invoice.payments)
    ? initialData.invoice.payments
    : [];

  existingPayments.forEach((payment) => {
    payments.push({
      id: payment.id || 0,
      payment_date: payment.payment_date || payment.date || initialData.invoice.invoice_date,
      amount: roundMoney(payment.amount),
      method: payment.method || 'cash',
      account_id: payment.account_id || '',
      account_name: payment.account_name || '',
      reference: payment.reference || '',
      notes: payment.notes || '',
      created_at: payment.created_at || '',
    });
  });

  if (!payments.length && initialData.invoice && Number(initialData.invoice.amount_paid || 0) > 0) {
    payments.push({
      id: 1,
      payment_date: initialData.invoice.invoice_date,
      amount: roundMoney(initialData.invoice.amount_paid),
      method: 'legacy',
      account_id: '',
      account_name: '',
      reference: '',
      notes: 'Recorded before payment history was added',
      created_at: initialData.invoice.created_at || '',
    });
  }

  renderPayments();
}

function renderItems() {
  if (!items.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="7" class="empty">Search and add items to begin.</td></tr>';
    renderTotals();
    return;
  }

  tbody.innerHTML = items.map((item, index) => {
    const quantity = normalizeQuantity(item.quantity);
    const total = quantity * item.unit_price;
    return `
      <tr>
        <td class="row-number" data-label="Item">${index + 1}</td>
        <td class="item-code-col" data-label="Item Name"><strong>${escapeHtml(item.item_code)}</strong></td>
        <td data-label="Stock">${item.stock_at_sale == null ? '—' : formatQuantity(item.stock_at_sale)}</td>
        <td data-label="Qty"><input aria-label="Quantity" type="text" inputmode="decimal" value="${formatQuantity(quantity)}" data-index="${index}" data-field="quantity"></td>
        <td data-label="Unit Price"><input aria-label="Unit price" type="number" min="0" step="1" value="${roundMoney(item.unit_price)}" data-index="${index}" data-field="unit_price"></td>
        <td data-label="Total" data-line-total="${index}">${formatMoney(total || 0)}</td>
        <td class="entry-row-actions"><button type="button" class="icon" data-remove="${index}">Remove</button></td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('input').forEach((input) => {
    input.addEventListener('input', () => {
      const index = Number(input.dataset.index);
      if (input.dataset.field === 'unit_price') {
        items[index].unit_price = roundMoney(input.value);
        input.value = items[index].unit_price;
      } else {
        items[index][input.dataset.field] = normalizeQuantity(input.value);
      }
      input.dataset.enterReady = '';
      updateLineTotal(index);
      renderTotals();
    });
    input.addEventListener('blur', () => {
      if (input.dataset.field === 'unit_price') {
        input.value = roundMoney(input.value);
      }
      if (input.dataset.field === 'quantity') {
        input.value = formatQuantity(input.value);
      }
    });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.ctrlKey) {
        return;
      }
      event.preventDefault();
      if (input.dataset.enterReady === '1') {
        focusNextItemInput(input);
        return;
      }
      input.dataset.enterReady = '1';
    });
  });

  tbody.querySelectorAll('[data-remove]').forEach((button) => {
    button.addEventListener('click', () => {
      dirty = true;
      items.splice(Number(button.dataset.remove), 1);
      renderItems();
    });
  });

  renderTotals();
}

function addPaymentFromForm() {
  const total = calculateGrandTotal();
  const paid = calculatePaidTotal();
  const amount = roundMoney(paymentAmount.value);
  const currentPaymentAmount = editingPaymentIndex == null ? 0 : Number(payments[editingPaymentIndex].amount || 0);
  const balance = Math.max(0, total - paid + currentPaymentAmount);

  if (!paymentDate.value) {
    showFormError('Enter a payment date.', paymentDate);
    return false;
  }
  if (amount <= 0) {
    showFormError('Enter a payment amount greater than zero.', paymentAmount);
    return false;
  }
  if (amount > balance) {
    showFormError(`Payment cannot exceed the current balance of ${formatMoney(balance)}.`, paymentAmount);
    return false;
  }
  if (!paymentAccount.value) {
    showFormError('Choose a cash or bank account.', paymentAccount);
    return false;
  }

  const payment = {
    id: editingPaymentIndex == null ? 0 : payments[editingPaymentIndex].id,
    payment_date: paymentDate.value,
    amount,
    account_id: paymentAccount.value,
    account_name: paymentAccount.selectedOptions[0].textContent.trim(),
    reference: paymentReference.value.trim(),
    notes: paymentNotes.value.trim(),
    created_at: editingPaymentIndex == null ? '' : payments[editingPaymentIndex].created_at,
  };

  if (editingPaymentIndex == null) {
    payments.push(payment);
  } else {
    payments[editingPaymentIndex] = payment;
  }

  paymentAmount.value = '';
  paymentReference.value = '';
  paymentNotes.value = '';
  editingPaymentIndex = null;
  addPaymentButton.textContent = 'Add Payment';
  renderPayments();
  return true;
}

function hasPendingPaymentInput() {
  return Boolean(
    paymentAmount.value
    || paymentReference.value.trim()
    || paymentNotes.value.trim()
    || editingPaymentIndex != null,
  );
}

function renderPayments() {
  if (!payments.length) {
    paymentsTbody.innerHTML = '<tr class="empty-row"><td colspan="7" class="empty">No payments added.</td></tr>';
    renderTotals();
    return;
  }

  paymentsTbody.innerHTML = payments.map((payment, index) => `
    <tr>
      <td class="row-number">${index + 1}</td>
      <td>${escapeHtml(payment.payment_date)}</td>
      <td>${escapeHtml(payment.account_name || payment.method || '')}</td>
      <td>${escapeHtml(payment.reference || '')}</td>
      <td>${escapeHtml(payment.notes || '')}</td>
      <td>${formatMoney(payment.amount || 0)}</td>
      <td class="row-actions">
        <button type="button" class="button-light" data-edit-payment="${index}">Edit</button>
        <button type="button" class="icon" data-remove-payment="${index}">Remove</button>
      </td>
    </tr>
  `).join('');

  paymentsTbody.querySelectorAll('[data-edit-payment]').forEach((button) => {
    button.addEventListener('click', () => {
      editPayment(Number(button.dataset.editPayment));
    });
  });

  paymentsTbody.querySelectorAll('[data-remove-payment]').forEach((button) => {
    button.addEventListener('click', () => {
      const removedIndex = Number(button.dataset.removePayment);
      payments.splice(removedIndex, 1);
      if (editingPaymentIndex === removedIndex) {
        editingPaymentIndex = null;
        addPaymentButton.textContent = 'Add Payment';
      } else if (editingPaymentIndex > removedIndex) {
        editingPaymentIndex -= 1;
      }
      renderPayments();
    });
  });

  renderTotals();
}

function editPayment(index) {
  const payment = payments[index];
  if (!payment) {
    return;
  }

  editingPaymentIndex = index;
  paymentDate.value = payment.payment_date;
  paymentAmount.value = payment.amount;
  paymentAccount.value = payment.account_id || '';
  paymentReference.value = payment.reference || '';
  paymentNotes.value = payment.notes || '';
  addPaymentButton.textContent = 'Update Payment';
  paymentAmount.focus();
}

function updateLineTotal(index) {
  const totalCell = tbody.querySelector(`[data-line-total="${index}"]`);
  if (!totalCell) {
    return;
  }
  const item = items[index];
  totalCell.textContent = formatMoney((item.quantity * item.unit_price) || 0);
}

function renderTotals() {
  const total = calculateGrandTotal();
  const paid = calculatePaidTotal();
  grandTotal.textContent = formatMoney(total);
  paidTotal.textContent = formatMoney(paid);
  balanceTotal.textContent = formatMoney(Math.max(0, total - paid));
  if (paymentStatus) {
    paymentStatus.textContent = formatPaymentStatus(total, paid);
  }
  updateEditActions();
}

function invoiceState() {
  return {
    invoice_date: document.querySelector('#invoice-date').value,
    posting_time: document.querySelector('#invoice-posting-time').value,
    due_date: document.querySelector('#due-date').value,
    non_system_invoice: document.querySelector('#non-system-invoice').value.trim(),
    customer_id: customerId.value,
    customer_name: customerSearch.value.trim(),
    price_list: priceListSelect.value,
    cost_center: costCenterInput.value.trim(),
    invoicer_id: invoicerId.value,
    invoicer: document.querySelector('#invoice-invoicer').value.trim(),
    warehouse: warehouseSelect.value,
    discount_amount: Number(form.elements.discount_amount.value || 0),
    tax_amount: Number(form.elements.tax_amount.value || 0),
    notes: form.elements.notes.value.trim(),
    items: items.map((item) => ({
      id: item.id || 0,
      item_code: item.item_code,
      warehouse: item.warehouse,
      quantity: normalizeQuantity(item.quantity),
      unit_price: roundMoney(item.unit_price),
    })),
    payments: payments.map((payment) => ({
      id: payment.id || 0,
      payment_date: payment.payment_date,
      amount: roundMoney(payment.amount),
      account_id: payment.account_id,
      reference: payment.reference,
      notes: payment.notes,
    })),
  };
}

function isInvoiceChanged() {
  return Boolean(initialData.recovered) || savedInvoiceState !== JSON.stringify(invoiceState());
}

function updateEditActions() {
  if (!initialData.invoice?.id || savedInvoiceState === null || !editSubmitActions.length) return;
  const showSave = repricing || isInvoiceChanged();
  editSaveButton.hidden = !showSave;
  editSubmitActions.forEach((action) => { action.hidden = showSave; });
}

function calculateGrandTotal() {
  const discount = Number(document.querySelector('[name="discount_amount"]').value || 0);
  const tax = Number(document.querySelector('[name="tax_amount"]').value || 0);
  return InvoiceMath.grandTotal(items, discount, tax);
}

function calculatePaidTotal() {
  return InvoiceMath.paidTotal(payments);
}

function formatPaymentStatus(total, paid) {
  const status = InvoiceMath.paymentStatus(total, paid);
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function roundMoney(value) {
  return InvoiceMath.roundMoney(value);
}

function normalizeQuantity(value) {
  const cleaned = String(value || '')
    .replace(/,/g, '')
    .replace(/[^\d.]/g, '')
    .replace(/(\..*)\./g, '$1');
  const quantity = Number(cleaned || 0);
  return Math.max(0, Number(quantity.toFixed(3)));
}

function formatQuantity(value) {
  const quantity = String(normalizeQuantity(value));
  return quantity.includes('.')
    ? quantity.replace(/0+$/, '').replace(/\.$/, '')
    : quantity;
}

function focusNextItemInput(currentInput) {
  const inputs = [...tbody.querySelectorAll('input')];
  const currentIndex = inputs.indexOf(currentInput);
  const nextInput = inputs[currentIndex + 1];
  if (!nextInput) {
    return;
  }
  currentInput.dataset.enterReady = '';
  nextInput.focus();
  nextInput.select();
}

function showFormError(message, field) {
  if (formError) {
    const target = formError.querySelector('strong') || formError;
    target.textContent = message;
    formError.hidden = false;
    formError.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  if (field && typeof field.focus === 'function') {
    field.focus();
  }
}

function clearFormError() {
  if (formError) {
    formError.hidden = true;
  }
}

function focusNextField(current) {
  const fields = [...form.querySelectorAll('input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])')]
    .filter((field) => field.offsetParent !== null);
  const index = fields.indexOf(current);
  const next = fields[index + 1];
  if (next && typeof next.focus === 'function') {
    next.focus();
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('`', '&#096;');
}

function closeResultsOnOutsideClick(event, searchInput, resultsPanel, onClose) {
  if (event.target === searchInput || resultsPanel.contains(event.target)) {
    return;
  }
  resultsPanel.innerHTML = '';
  if (onClose) {
    onClose();
  }
}

function clearUnselectedCustomer() {
  if (customerId.value) {
    return;
  }
  customerSearch.value = '';
  customerResults.innerHTML = '';
  updateEditActions();
}

function selectCustomer(button) {
  dirty = true;
  customerId.value = button.dataset.id;
  customerSearch.value = button.dataset.name;
  customerResults.innerHTML = '';
  updateEditActions();
}

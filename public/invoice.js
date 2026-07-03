const items = [];
const itemSearch = document.querySelector('#item-search');
const itemResults = document.querySelector('#item-results');
const warehouseSelect = document.querySelector('#warehouse-select');
const customerSearch = document.querySelector('#customer-search');
const customerResults = document.querySelector('#customer-results');
const customerId = document.querySelector('#customer-id');
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
const paymentMethod = document.querySelector('#payment-method');
const paymentReference = document.querySelector('#payment-reference');
const paymentNotes = document.querySelector('#payment-notes');
const addPaymentButton = document.querySelector('#add-payment');
const initialData = window.invoiceInitial || {};

const money = new Intl.NumberFormat('en-UG', {
  style: 'currency',
  currency: 'UGX',
  maximumFractionDigits: 0,
});

let preloadedItems = [];
let preloadedCustomers = [];
let itemsLoading = false;
let customersLoading = false;
let editingPaymentIndex = null;

let itemTimer;
itemSearch.addEventListener('input', () => {
  clearTimeout(itemTimer);
  itemTimer = setTimeout(searchItems, 220);
});

itemSearch.addEventListener('focus', () => {
  showPreloadedItems();
});

itemSearch.addEventListener('click', () => {
  showPreloadedItems();
});

itemSearch.addEventListener('blur', () => {
  setTimeout(() => {
    if (!itemResults.contains(document.activeElement)) {
      itemSearch.value = '';
      itemResults.innerHTML = '';
    }
  }, 150);
});

warehouseSelect.addEventListener('change', () => {
  itemSearch.disabled = !warehouseSelect.value;
  itemSearch.placeholder = warehouseSelect.value ? 'Search item name, code, category' : 'Choose a warehouse first';
  itemSearch.value = '';
  itemResults.innerHTML = '';
  preloadedItems = [];
  items.length = 0;
  renderItems();
  preloadItems();
});

let customerTimer;
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
});

document.querySelectorAll('[name="discount_amount"], [name="tax_amount"]').forEach((input) => {
  input.addEventListener('input', renderTotals);
});

document.addEventListener('wheel', (event) => {
  if (event.target.matches('input[type="number"]')) {
    event.preventDefault();
  }
}, { passive: false });

initializeInvoiceForm();
initializePayments();
loadWarehouses();
preloadCustomers();

addPaymentButton.addEventListener('click', addPaymentFromForm);

form.addEventListener('submit', (event) => {
  if (hasPendingPaymentInput()) {
    if (!addPaymentFromForm()) {
      event.preventDefault();
      return;
    }
  }
  if (!customerId.value) {
    event.preventDefault();
    alert('Select a customer from the database.');
    customerSearch.focus();
    return;
  }
  if (!items.length) {
    event.preventDefault();
    alert('Add at least one item.');
    return;
  }
  if (calculatePaidTotal() > calculateGrandTotal()) {
    event.preventDefault();
    alert('Total payments cannot exceed the invoice total.');
    return;
  }
  itemsJson.value = JSON.stringify(items);
  paymentsJson.value = JSON.stringify(payments);
});

form.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.ctrlKey) {
    return;
  }
  if (event.target.matches('textarea')) {
    return;
  }
  event.preventDefault();
});

form.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.ctrlKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

async function searchItems() {
  const q = itemSearch.value.trim();
  const warehouse = warehouseSelect.value;
  if (!warehouse) {
    itemResults.innerHTML = '<p>Choose a warehouse before searching items.</p>';
    return;
  }
  if (!q) {
    showPreloadedItems();
    return;
  }
  try {
    const rows = await fetchItems(q);
    renderItemResults(rows);
  } catch {
    itemResults.innerHTML = '<p>Could not load items for this warehouse.</p>';
  }
}

async function fetchItems(q = '') {
  const warehouse = warehouseSelect.value;
  const response = await fetch(`/api/items?q=${encodeURIComponent(q)}&warehouse=${encodeURIComponent(warehouse)}`);
  if (!response.ok) {
    throw new Error('Item request failed.');
  }
  return response.json();
}

async function preloadItems() {
  if (!warehouseSelect.value) {
    return;
  }
  itemsLoading = true;
  try {
    preloadedItems = await fetchItems();
  } catch {
    preloadedItems = [];
  } finally {
    itemsLoading = false;
    if (document.activeElement === itemSearch && !itemSearch.value.trim()) {
      showPreloadedItems();
    }
  }
}

function showPreloadedItems() {
  if (!warehouseSelect.value) {
    itemResults.innerHTML = '<p>Choose a warehouse before searching items.</p>';
    return;
  }
  if (itemsLoading) {
    itemResults.innerHTML = '<p>Loading items...</p>';
    return;
  }
  renderItemResults(preloadedItems);
}

function renderItemResults(rows) {
  itemResults.innerHTML = rows.map((item) => `
    <div class="result-row">
      <div>
        <strong>${escapeHtml(item.item_name || item.item_code)}</strong>
        <span>${escapeHtml(item.category || '')} · Stock ${formatQuantity(item.stock_balance)} · ${money.format(item.unit_price || 0)}</span>
      </div>
      <label>
        Qty
        <input type="text" inputmode="decimal" value="1" data-qty>
      </label>
      <button type="button" data-item='${escapeAttr(JSON.stringify(item))}'>Add</button>
    </div>
  `).join('') || '<p>No matching items.</p>';

  itemResults.querySelectorAll('[data-item]').forEach((button) => {
    button.addEventListener('click', () => {
      const row = button.closest('.result-row');
      const quantity = Number(row.querySelector('[data-qty]').value || 0);
      addItem(JSON.parse(button.dataset.item), quantity);
      itemSearch.value = '';
      itemResults.innerHTML = '';
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
    }
    itemSearch.disabled = !warehouseSelect.value;
    itemSearch.placeholder = warehouseSelect.value ? 'Search item name, code, category' : 'Choose a warehouse first';
    preloadItems();
  } catch {
    warehouseSelect.innerHTML = '<option value="">Could not load warehouses</option>';
  } finally {
    itemSearch.disabled = !warehouseSelect.value;
  }
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
  quantity = normalizeQuantity(quantity);
  if (quantity <= 0) {
    return;
  }
  const existing = items.find((item) => item.item_code === source.item_code);
  if (existing) {
    existing.quantity = normalizeQuantity(existing.quantity + quantity);
  } else {
    items.push({
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
      item_code: item.item_code,
      item_name: item.item_name,
      warehouse: item.warehouse || '',
      quantity: normalizeQuantity(item.quantity),
      unit_price: roundMoney(item.unit_price),
      stock_at_sale: normalizeQuantity(item.stock_at_sale),
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
      reference: '',
      notes: 'Recorded before payment history was added',
      created_at: initialData.invoice.created_at || '',
    });
  }

  renderPayments();
}

function renderItems() {
  if (!items.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="6" class="empty">Search and add items to begin.</td></tr>';
    renderTotals();
    return;
  }

  tbody.innerHTML = items.map((item, index) => {
    const quantity = normalizeQuantity(item.quantity);
    const total = quantity * item.unit_price;
    return `
      <tr>
        <td class="item-code-col">
          <strong>${escapeHtml(item.item_name)}</strong>
          <small>${escapeHtml(item.item_code)}${item.warehouse ? ` · ${escapeHtml(item.warehouse)}` : ''}</small>
        </td>
        <td>${formatQuantity(item.stock_at_sale)}</td>
        <td><input type="text" inputmode="decimal" value="${formatQuantity(quantity)}" data-index="${index}" data-field="quantity"></td>
        <td><input type="number" min="0" step="1" value="${roundMoney(item.unit_price)}" data-index="${index}" data-field="unit_price"></td>
        <td data-line-total="${index}">${money.format(total || 0)}</td>
        <td><button type="button" class="icon" data-remove="${index}">Remove</button></td>
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
    alert('Enter a payment date.');
    paymentDate.focus();
    return false;
  }
  if (amount <= 0) {
    alert('Enter a payment amount greater than zero.');
    paymentAmount.focus();
    return false;
  }
  if (amount > balance) {
    alert(`Payment cannot exceed the current balance of ${money.format(balance)}.`);
    paymentAmount.focus();
    return false;
  }

  const payment = {
    id: editingPaymentIndex == null ? 0 : payments[editingPaymentIndex].id,
    payment_date: paymentDate.value,
    amount,
    method: paymentMethod.value,
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
    paymentsTbody.innerHTML = '<tr class="empty-row"><td colspan="6" class="empty">No payments added.</td></tr>';
    renderTotals();
    return;
  }

  paymentsTbody.innerHTML = payments.map((payment, index) => `
    <tr>
      <td>${escapeHtml(payment.payment_date)}</td>
      <td>${escapeHtml(payment.method)}</td>
      <td>${escapeHtml(payment.reference || '')}</td>
      <td>${escapeHtml(payment.notes || '')}</td>
      <td>${money.format(payment.amount || 0)}</td>
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
  paymentMethod.value = payment.method;
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
  totalCell.textContent = money.format((item.quantity * item.unit_price) || 0);
}

function renderTotals() {
  const total = calculateGrandTotal();
  const paid = calculatePaidTotal();
  grandTotal.textContent = money.format(total);
  paidTotal.textContent = money.format(paid);
  balanceTotal.textContent = money.format(Math.max(0, total - paid));
  if (paymentStatus) {
    paymentStatus.textContent = formatPaymentStatus(total, paid);
  }
}

function calculateGrandTotal() {
  const subtotal = items.reduce((sum, item) => sum + (item.quantity * item.unit_price), 0);
  const discount = Number(document.querySelector('[name="discount_amount"]').value || 0);
  const tax = Number(document.querySelector('[name="tax_amount"]').value || 0);
  return roundMoney(Math.max(0, subtotal - discount + tax));
}

function calculatePaidTotal() {
  return roundMoney(payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0));
}

function formatPaymentStatus(total, paid) {
  if (Number(paid || 0) <= 0) {
    return 'Unpaid';
  }
  return Number(paid || 0) >= Number(total || 0) ? 'Paid' : 'Partial';
}

function roundMoney(value) {
  return Math.round(Number(value || 0));
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
}

function selectCustomer(button) {
  customerId.value = button.dataset.id;
  customerSearch.value = button.dataset.name;
  customerResults.innerHTML = '';
}

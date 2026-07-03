const reportItemInput = document.querySelector('[data-stock-report-item]');
const reportItemResults = document.querySelector('.stock-report-item-results');
const reportWarehouseList = document.querySelector('#stock-report-warehouses');

let reportItemTimer;

if (reportItemInput && reportItemResults) {
  if (reportWarehouseList) {
    loadReportWarehouses();
  }
  reportItemInput.addEventListener('input', () => {
    clearTimeout(reportItemTimer);
    reportItemTimer = setTimeout(() => loadReportItems(reportItemInput.value), 180);
  });
  document.addEventListener('click', (event) => {
    const itemButton = event.target.closest('[data-report-item-code]');
    if (itemButton) {
      reportItemInput.value = itemButton.dataset.reportItemCode;
      reportItemResults.innerHTML = '';
      return;
    }
    if (event.target !== reportItemInput && !reportItemResults.contains(event.target)) {
      reportItemResults.innerHTML = '';
    }
  });
}

async function loadReportItems(query) {
  const search = String(query || '').trim();
  if (!search) {
    reportItemResults.innerHTML = '';
    return;
  }
  try {
    const response = await fetch(`/api/master-items?q=${encodeURIComponent(search)}`);
    if (!response.ok) {
      throw new Error('Item lookup failed.');
    }
    const items = await response.json();
    reportItemResults.innerHTML = items.map((item) => (
      `<button type="button" data-report-item-code="${escapeAttr(item.item_code)}">
        <strong>${escapeHtml(item.item_code)}</strong>
        <span>${escapeHtml(item.item_name || '')}</span>
      </button>`
    )).join('') || '<p>No matching items.</p>';
  } catch {
    reportItemResults.innerHTML = '<p>Could not load items.</p>';
  }
}

async function loadReportWarehouses() {
  if (!reportWarehouseList) {
    return;
  }
  try {
    const response = await fetch('/api/warehouses');
    if (!response.ok) {
      throw new Error('Warehouse lookup failed.');
    }
    const warehouses = await response.json();
    reportWarehouseList.innerHTML = warehouses.map((warehouse) => (
      `<option value="${escapeAttr(warehouse)}"></option>`
    )).join('');
  } catch {
    reportWarehouseList.innerHTML = '';
  }
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

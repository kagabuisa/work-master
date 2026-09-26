(function () {
  const money = new Intl.NumberFormat('en-UG', {
    style: 'currency',
    currency: 'UGX',
    currencyDisplay: 'code',
    maximumFractionDigits: 0,
  });

  const formatMoney = (value) => money.format(value).replace('UGX', 'Ugx');

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-movement-toggle]');
    if (!button) {
      return;
    }

    const detailRow = document.getElementById(button.dataset.movementToggle);
    if (!detailRow) {
      return;
    }

    const isOpen = !detailRow.hidden;
    detailRow.hidden = isOpen;
    button.setAttribute('aria-expanded', String(!isOpen));
    if (isOpen) {
      return;
    }

    const body = detailRow.querySelector('[data-movement-detail]');
    if (!body || body.dataset.loaded === '1') {
      return;
    }
    body.innerHTML = '<p>Loading...</p>';
    try {
      const details = await fetchDetails(button);
      body.innerHTML = renderDetails(details, button.dataset.title || 'Movement details');
      body.dataset.loaded = '1';
    } catch {
      body.innerHTML = '<p>Could not load movement details.</p>';
    }
  });

  async function fetchDetails(button) {
    const pageParams = new URLSearchParams(window.location.search);
    const params = new URLSearchParams({
      item_code: button.dataset.itemCode || '',
      warehouse: button.dataset.warehouse || '',
      direction: button.dataset.direction || '',
      from: pageParams.get('from') || '',
      to: pageParams.get('to') || '',
    });
    const response = await fetch(`/reports/stock-movement/details?${params.toString()}`);
    if (!response.ok) {
      throw new Error('Request failed.');
    }
    return response.json();
  }

  function renderDetails(details, title) {
    const rows = details.rows || [];
    return `
      <h2>${escapeHtml(title)}</h2>
      <table>
        <thead>
          <tr>
            <th class="row-number">#</th>
            <th>Date</th>
            <th>Voucher</th>
            <th>Type</th>
            <th>Qty</th>
            <th>Rate</th>
            <th>Value</th>
            <th>Balance Qty</th>
            <th>Balance Value</th>
            <th>Remarks</th>
          </tr>
        </thead>
        <tbody>
          ${rows.length ? rows.map(renderDetailRow).join('') : '<tr><td colspan="10" class="empty">No movement details found.</td></tr>'}
        </tbody>
        ${rows.length ? `
          <tfoot>
            <tr>
              <th colspan="4">Total</th>
              <th>${formatQuantity(details.summary && details.summary.qty)}</th>
              <th></th>
              <th>${formatMoney((details.summary && details.summary.value) || 0)}</th>
              <th colspan="3"></th>
            </tr>
          </tfoot>
        ` : ''}
      </table>
    `;
  }

  function renderDetailRow(row, index) {
    const voucherType = String(row.voucher_type || '');
    const fullUrl = row.voucher_id && voucherType.startsWith('stock_')
      ? `/stock/entries/${encodeURIComponent(row.voucher_id)}`
      : row.voucher_id && voucherType === 'purchase'
        ? `/purchases/${encodeURIComponent(row.voucher_id)}`
        : row.voucher_id && voucherType === 'invoice'
          ? `/invoices/${encodeURIComponent(row.voucher_id)}`
          : '';
    const drawerUrl = row.voucher_id && voucherType.startsWith('stock_')
      ? `/stock/entries/${encodeURIComponent(row.voucher_id)}/drawer`
      : row.voucher_id && voucherType === 'purchase'
        ? `/purchases/${encodeURIComponent(row.voucher_id)}/drawer`
        : row.voucher_id && voucherType === 'invoice'
          ? `/invoices/${encodeURIComponent(row.voucher_id)}/drawer`
          : '';
    const voucher = fullUrl
      ? `<a class="voucher-drawer-link" href="${fullUrl}" data-voucher-drawer="${drawerUrl}">${escapeHtml(row.voucher_no || row.voucher_type)}</a>`
      : escapeHtml(row.voucher_no || row.voucher_type);
    return `
      <tr>
        <td class="row-number">${index + 1}</td>
        <td>${escapeHtml(row.posting_date)}</td>
        <td>${voucher}</td>
        <td>${escapeHtml(row.stock_entry_type || '')}</td>
        <td>${formatQuantity(row.qty)}</td>
        <td>${Number(row.rate || 0) ? formatMoney(row.rate) : ''}</td>
        <td>${formatMoney(row.value || 0)}</td>
        <td>${formatQuantity(row.balance_qty)}</td>
        <td>${formatMoney(row.balance_value || 0)}</td>
        <td>${escapeHtml(row.remarks || '')}</td>
      </tr>
    `;
  }

  function formatQuantity(value) {
    return Number(value || 0).toLocaleString();
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
}());

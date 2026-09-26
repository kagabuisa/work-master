(function () {
  const dialog = document.getElementById('voucher-dialog');
  const body = dialog && dialog.querySelector('[data-voucher-body]');
  const title = dialog && dialog.querySelector('#voucher-dialog-title');
  const closeButton = dialog && dialog.querySelector('[data-voucher-close]');

  if (!dialog || !body || !title) {
    return;
  }

  const money = new Intl.NumberFormat('en-UG', {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  });
  const quantity = new Intl.NumberFormat('en-UG', {
    maximumFractionDigits: 3,
    minimumFractionDigits: 0,
  });

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatMoney(value) {
    return `Ugx ${money.format(Number(value || 0))}`;
  }

  function formatQuantity(value) {
    return quantity.format(Number(value || 0));
  }

  function openDialog() {
    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function closeDialog() {
    if (typeof dialog.close === 'function') {
      dialog.close();
    } else {
      dialog.removeAttribute('open');
    }
  }

  function renderMeta(meta, details) {
    return Object.entries(meta || {})
      .filter(([label, value]) => (
        label === 'Remarks' && details.kind === 'stock_entry'
      ) || (
        value !== null && value !== undefined && String(value).trim() !== ''
      ))
      .map(([label, value]) => `
        <div>
          <span>
            ${escapeHtml(label)}
            ${label === 'Remarks' && isPurchaseStockEntry(details) && details.status === 'draft' ? '<button type="button" class="inline-link" data-supplier-adjust>Adjust</button>' : ''}
          </span>
          <strong>${escapeHtml(value || '')}</strong>
        </div>
      `)
      .join('');
  }

  function renderSupplierInfo(details) {
    if (!isPurchaseStockEntry(details)) {
      return '';
    }
    const supplier = details.supplier || {};
    const rows = [
      ['Supplier', supplier.supplier_name],
      ['Contact', supplier.supplier_contact],
      ['Phone', supplier.supplier_phone],
      ['Reference', supplier.supplier_reference],
    ].filter(([, value]) => String(value || '').trim() !== '');
    if (!rows.length) {
      return '<p class="empty supplier-summary">No supplier information captured.</p>';
    }
    return `
      <div class="voucher-meta supplier-summary">
        ${rows.map(([label, value]) => `
          <div>
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(value)}</strong>
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderSupplierForm(details) {
    if (!isPurchaseStockEntry(details)) {
      return '';
    }
    const supplier = details.supplier || {};
    return `
      <form class="supplier-edit-form" data-supplier-form data-stock-entry-id="${escapeHtml(details.id)}" hidden>
        <label>
          Supplier Name
          <input name="supplier_name" value="${escapeHtml(supplier.supplier_name || '')}">
        </label>
        <label>
          Contact Person
          <input name="supplier_contact" value="${escapeHtml(supplier.supplier_contact || '')}">
        </label>
        <label>
          Phone
          <input name="supplier_phone" value="${escapeHtml(supplier.supplier_phone || '')}">
        </label>
        <label>
          Receipt / Invoice Reference
          <input name="supplier_reference" value="${escapeHtml(supplier.supplier_reference || '')}">
        </label>
        <div class="actions">
          <button type="button" class="button-light" data-supplier-edit-cancel>Cancel</button>
          <button type="submit">Save Supplier Info</button>
        </div>
      </form>
    `;
  }

  function renderItems(details) {
    const items = Array.isArray(details.items) ? details.items : [];
    const hasTarget = items.some((item) => item.target_warehouse);
    if (!items.length) {
      return '<p class="empty">No voucher lines found.</p>';
    }
    return `
      <table>
        <thead>
          <tr>
            <th class="row-number">#</th>
            <th class="item-code-col">Item Name</th>
            <th class="warehouse-col">Warehouse</th>
            ${hasTarget ? '<th class="warehouse-col">Target</th>' : ''}
            <th>Qty</th>
            <th>Rate</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          ${items.map((item, index) => `
            <tr>
              <td class="row-number">${index + 1}</td>
              <td class="item-code-col"><strong>${escapeHtml(item.item_code)}</strong></td>
              <td class="warehouse-col">${escapeHtml(item.warehouse || '')}</td>
              ${hasTarget ? `<td class="warehouse-col">${escapeHtml(item.target_warehouse || '')}</td>` : ''}
              <td>${formatQuantity(item.quantity)}</td>
              <td>${formatMoney(item.rate)}</td>
              <td>${formatMoney(item.amount)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  function renderTotals(totals) {
    const rows = Object.entries(totals || {});
    if (!rows.length) {
      return '';
    }
    return `
      <dl class="voucher-totals">
        ${rows.map(([label, value]) => `
          <div>
            <dt>${escapeHtml(label)}</dt>
            <dd>${formatMoney(value)}</dd>
          </div>
        `).join('')}
      </dl>
    `;
  }

  function renderDetails(details) {
    title.textContent = details.title || 'Voucher Details';
    const linkLabel = details.kind === 'stock_entry' && details.status === 'draft' ? 'Edit' : 'Open Voucher';
    const link = details.href
      ? `<a class="button button-light" href="${escapeHtml(details.href)}">${linkLabel}</a>`
      : '';
    const cancelButton = document.body.dataset.canCancel === 'true' && details.kind === 'stock_entry' && details.status === 'submitted'
      ? `<button type="button" class="button-light" data-cancel-stock-entry data-stock-entry-id="${escapeHtml(details.id)}">Cancel</button>`
      : '';
    body.innerHTML = `
      <div class="voucher-meta">${renderMeta(details.meta, details)}</div>
      ${link || cancelButton ? `<div class="voucher-actions">${link}${cancelButton}</div>` : ''}
      ${renderSupplierInfo(details)}
      ${details.status === 'draft' ? renderSupplierForm(details) : ''}
      ${renderItems(details)}
      ${renderTotals(details.totals)}
    `;
  }

  function openSupplierForm() {
    const form = body.querySelector('[data-supplier-form]');
    if (!form) {
      return;
    }
    form.hidden = false;
    const firstInput = form.querySelector('input');
    if (firstInput) {
      firstInput.focus();
    }
  }

  function closeSupplierForm() {
    const form = body.querySelector('[data-supplier-form]');
    if (form) {
      form.hidden = true;
    }
  }

  async function saveSupplierForm(form) {
    const stockEntryId = form.dataset.stockEntryId;
    const payload = Object.fromEntries(new FormData(form).entries());
    const response = await fetch(`/stock/entries/${encodeURIComponent(stockEntryId)}/supplier`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'Could not save supplier information.');
    }
    const details = {
      kind: 'stock_entry',
      id: stockEntryId,
      entry_type: 'purchase',
      title: title.textContent,
      meta: {},
      supplier: result.supplier,
      items: [],
      totals: {},
    };
    const summary = body.querySelector('.supplier-summary');
    if (summary) {
      summary.outerHTML = renderSupplierInfo(details);
    }
    closeSupplierForm();
  }

  async function cancelStockEntry(button) {
    const stockEntryId = button.dataset.stockEntryId;
    const reason = window.prompt('Cancellation reason', 'Cancelled');
    if (reason === null) {
      return;
    }
    button.disabled = true;
    try {
      const response = await fetch(`/stock/entries/${encodeURIComponent(stockEntryId)}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || 'Could not cancel stock entry.');
      }
      window.location.href = '/reports/stock-ledger?status=cancelled';
    } catch (err) {
      button.disabled = false;
      body.insertAdjacentHTML('afterbegin', `<p class="notice warning">${escapeHtml(err.message || 'Could not cancel stock entry.')}</p>`);
    }
  }

  function isPurchaseStockEntry(details) {
    return details.kind === 'stock_entry' && details.entry_type === 'purchase';
  }

  async function loadVoucher(button) {
    const type = button.dataset.voucherType;
    const id = button.dataset.voucherId;
    title.textContent = button.textContent.trim() || 'Voucher Details';
    body.innerHTML = '<p class="empty">Loading voucher details...</p>';
    openDialog();

    try {
      const response = await fetch(`/reports/stock-ledger/vouchers/${encodeURIComponent(type)}/${encodeURIComponent(id)}`);
      const details = await response.json();
      if (!response.ok) {
        throw new Error(details.error || 'Could not load voucher details.');
      }
      renderDetails(details);
    } catch (err) {
      body.innerHTML = `<p class="empty">${escapeHtml(err.message || 'Could not load voucher details.')}</p>`;
    }
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest('.voucher-link');
    if (button) {
      loadVoucher(button);
      return;
    }
    if (event.target.closest('[data-supplier-adjust]')) {
      openSupplierForm();
      return;
    }
    if (event.target.closest('[data-supplier-edit-cancel]')) {
      closeSupplierForm();
      return;
    }
    const cancelButton = event.target.closest('[data-cancel-stock-entry]');
    if (cancelButton) {
      cancelStockEntry(cancelButton);
    }
  });

  body.addEventListener('submit', async (event) => {
    const form = event.target.closest('[data-supplier-form]');
    if (!form) {
      return;
    }
    event.preventDefault();
    try {
      await saveSupplierForm(form);
    } catch (err) {
      body.insertAdjacentHTML('afterbegin', `<p class="notice warning">${escapeHtml(err.message || 'Could not save supplier information.')}</p>`);
    }
  });

  closeButton.addEventListener('click', closeDialog);
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      closeDialog();
    }
  });
}());

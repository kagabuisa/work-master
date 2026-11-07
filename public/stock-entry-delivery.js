(function () {
  const statusRequirements = {
    'Picked & packed': 'picked',
    Delivered: 'delivered',
    'All Received': 'received',
    'Received + DDR': 'received',
  };
  let active = null;
  let employeeTimer;
  let employeeRequest;
  const previousStatuses = new WeakMap();

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
  }

  function dialogFor(select) {
    return select.closest('form')?.querySelector('[data-delivery-dialog]') || null;
  }

  function field(dialog, name) {
    return [...dialog.querySelectorAll('[data-delivery-dialog-field]')]
      .find(input => input.dataset.deliveryDialogField === name);
  }

  function detailComplete(dialog, kind) {
    if (kind === 'picked') {
      return Boolean(field(dialog, 'picked_employee_id').value
        && field(dialog, 'picked_employee_name').value
        && dialog.querySelector('[name="picked_date"]').value);
    }
    if (kind === 'delivered') {
      const name = dialog.querySelector('[name="transporter_name"]');
      const phone = dialog.querySelector('[name="transporter_phone"]');
      const date = dialog.querySelector('[name="delivered_date"]');
      return Boolean(name.value.trim() && phone.value.trim() && date.value);
    }
    const receivedDate = dialog.querySelector('[name="received_date"]');
    return Boolean(receivedDate.value
      && field(dialog, 'received_by_employee_id').value
      && field(dialog, 'received_by_employee_name').value);
  }

  function clearRequired(dialog) {
    if (!dialog) return;
    for (const input of dialog.querySelectorAll('input')) input.required = false;
  }

  function openDialog(select) {
    const dialog = dialogFor(select);
    const kind = statusRequirements[select.value];
    if (!dialog || !kind) return;
    if (dialog.open) dialog.close();
    if (!previousStatuses.has(select)) previousStatuses.set(select, select.value);
    active = { select, dialog, kind };
    const title = kind === 'picked' ? 'Picked and packed'
      : kind === 'delivered' ? 'Delivered' : select.value;
    dialog.querySelector('[data-delivery-dialog-title]').textContent = title;
    dialog.querySelector('[data-delivery-dialog-help]').textContent = kind === 'picked'
      ? 'Select the employee who picked and packed this stock entry.'
      : kind === 'delivered'
        ? 'Enter the transporter who delivered the stock and their telephone number.'
        : 'Enter the receipt date and select the employee who received and confirmed the stock.';
    for (const section of dialog.querySelectorAll('[data-delivery-section]')) {
      section.hidden = section.dataset.deliverySection !== kind;
    }
    clearRequired(dialog);
    const current = dialog.querySelector(`[data-delivery-section="${kind}"]`);
    for (const name of ['picked_date', 'delivered_date', 'received_date']) {
      const input = dialog.querySelector(`[name="${name}"]`);
      if (input && !input.value && dialog.dataset.today) input.value = dialog.dataset.today;
    }
    if (kind === 'picked') {
      current.querySelector('[name="picked_date"]').required = true;
    } else if (kind === 'delivered') {
      current.querySelector('[name="transporter_name"]').required = true;
      current.querySelector('[name="transporter_phone"]').required = true;
      current.querySelector('[name="delivered_date"]').required = true;
    } else if (kind === 'received') {
      current.querySelector('[name="received_date"]').required = true;
    }
    if (kind === 'picked') current.querySelector('[data-delivery-employee-search]')?.focus();
    else if (kind === 'delivered') current.querySelector('[name="transporter_name"]')?.focus();
    else current.querySelector('[name="received_date"]')?.focus();
    dialog.showModal();
  }

  function closeDialog(revert = false) {
    if (!active) return;
    const { dialog, select } = active;
    if (revert) select.value = previousStatuses.get(select) || '';
    active = null;
    employeeRequest?.abort();
    clearRequired(dialog);
    dialog.close();
  }

  function confirmDialog() {
    if (!active) return;
    const { select, dialog, kind } = active;
    const section = dialog.querySelector(`[data-delivery-section="${kind}"]`);
    if (kind === 'picked' && !field(dialog, 'picked_employee_id').value) {
      dialog.querySelector('[data-delivery-employee-status="picked"]').textContent = 'Choose an employee.';
      return;
    }
    if (kind === 'received' && !field(dialog, 'received_by_employee_id').value) {
      dialog.querySelector('[data-delivery-employee-status="received"]').textContent = 'Choose the receiving employee.';
      return;
    }
    const invalid = [...section.querySelectorAll('input')].find(input => !input.checkValidity());
    if (invalid || !detailComplete(dialog, kind)) {
      invalid?.reportValidity();
      return;
    }
    select.dataset.confirmedStatus = select.value;
    previousStatuses.set(select, select.value);
    active = null;
    clearRequired(dialog);
    dialog.close();
    select.focus();
  }

  async function searchEmployees(input) {
    const dialog = input.closest('[data-delivery-dialog]');
    const kind = input.dataset.deliveryEmployeeSearch;
    const results = dialog.querySelector(`[data-delivery-employee-results="${kind}"]`);
    const status = dialog.querySelector(`[data-delivery-employee-status="${kind}"]`);
    const idField = field(dialog, kind === 'picked' ? 'picked_employee_id' : 'received_by_employee_id');
    const nameField = field(dialog, kind === 'picked' ? 'picked_employee_name' : 'received_by_employee_name');
    idField.value = '';
    nameField.value = '';
    const query = input.value.trim();
    status.textContent = 'Searching employees…';
    employeeRequest?.abort();
    const request = new AbortController();
    employeeRequest = request;
    try {
      const entryId = dialog.dataset.stockEntryId;
      const endpoint = entryId
        ? `/stock/entries/${encodeURIComponent(entryId)}/delivery-employees`
        : '/stock/delivery-employees';
      const response = await fetch(`${endpoint}?q=${encodeURIComponent(query)}`, {
        signal: request.signal,
      });
      if (!response.ok) throw new Error('Employee search failed.');
      const employees = await response.json();
      results.innerHTML = employees.map(employee => `<button type="button" data-delivery-employee-id="${escapeHtml(employee.employee_id)}" data-delivery-employee-name="${escapeHtml(employee.employee_name)}"><strong>${escapeHtml(employee.employee_name)}</strong><span>${escapeHtml(employee.employee_id)}</span></button>`).join('')
        || '<p>No active employees match.</p>';
      status.textContent = '';
    } catch (error) {
      if (!request.signal.aborted) status.textContent = 'Could not search employees. Type again to retry.';
    }
  }

  document.addEventListener('change', event => {
    const select = event.target.closest('[data-delivery-status-select]');
    if (!select) return;
    select.dataset.confirmedStatus = '';
    if (statusRequirements[select.value]) {
      openDialog(select);
    } else {
      clearRequired(dialogFor(select));
      previousStatuses.set(select, select.value);
      select.dataset.confirmedStatus = select.value;
    }
  });

  document.addEventListener('focusin', event => {
    const select = event.target.closest('[data-delivery-status-select]');
    if (select && !previousStatuses.has(select)) previousStatuses.set(select, select.value);
  });

  document.addEventListener('submit', event => {
    const form = event.target;
    const select = form.querySelector?.('[data-delivery-status-select]');
    if (!select || !statusRequirements[select.value]) return;
    const dialog = form.querySelector('[data-delivery-dialog]');
    if (!dialog || select.dataset.confirmedStatus === select.value) return;
    event.preventDefault();
    openDialog(select);
  });

  document.addEventListener('input', event => {
    const input = event.target.closest('[data-delivery-employee-search]');
    if (!input) return;
    clearTimeout(employeeTimer);
    employeeTimer = setTimeout(() => searchEmployees(input), 180);
  });

  document.addEventListener('click', event => {
    const employee = event.target.closest('[data-delivery-employee-id]');
    if (employee) {
      const dialog = employee.closest('[data-delivery-dialog]');
      const section = employee.closest('[data-delivery-section]');
      const kind = section.dataset.deliverySection;
      field(dialog, kind === 'picked' ? 'picked_employee_id' : 'received_by_employee_id').value = employee.dataset.deliveryEmployeeId;
      field(dialog, kind === 'picked' ? 'picked_employee_name' : 'received_by_employee_name').value = employee.dataset.deliveryEmployeeName;
      dialog.querySelector(`[data-delivery-employee-search="${kind}"]`).value = employee.dataset.deliveryEmployeeName;
      dialog.querySelector(`[data-delivery-employee-results="${kind}"]`).replaceChildren();
      dialog.querySelector(`[data-delivery-employee-status="${kind}"]`).textContent = `${employee.dataset.deliveryEmployeeName} selected.`;
      return;
    }
    if (event.target.closest('[data-delivery-confirm]')) {
      confirmDialog();
      return;
    }
    if (event.target.closest('[data-delivery-cancel]')) closeDialog(true);
  });

  document.addEventListener('cancel', event => {
    if (event.target.matches?.('[data-delivery-dialog]')) {
      event.preventDefault();
      closeDialog(true);
    }
  }, true);

  function initializeDeliveryFields() {
    for (const select of document.querySelectorAll('[data-delivery-status-select]')) {
      previousStatuses.set(select, select.value);
      const dialog = dialogFor(select);
      select.dataset.confirmedStatus = !statusRequirements[select.value]
        || (dialog && detailComplete(dialog, statusRequirements[select.value])) ? select.value : '';
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializeDeliveryFields);
  else initializeDeliveryFields();
  document.addEventListener('voucher-drawer-loaded', initializeDeliveryFields);
})();

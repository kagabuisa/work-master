(() => {
  let dialog, active;
  const action = root => root.querySelector('[name="action_request"]');
  const reason = root => root.querySelector('[name="why_cancel"]');
  function paint(root, pending) {
    const selected = pending || action(root).value;
    const backdate = root.querySelector('[data-request-backdate]');
    backdate.disabled = root.dataset.documentState !== 'draft' || selected === 'Cancel';
    backdate.checked = selected === 'Backdate';
    const cancel = root.querySelector('[data-request-cancel]');
    cancel.checked = selected === 'Cancel';
    cancel.disabled = root.dataset.documentState !== 'submitted' || selected === 'Backdate';
    root.querySelector('[data-request-clear]').hidden = !selected;
    root.querySelector('[data-request-summary]').textContent = action(root).value
      ? `${action(root).value}${action(root).value === 'Backdate' ? ' · ' + root.querySelector('[name="requested_posting_date"]').value : ''}${reason(root).value ? ' · ' + reason(root).value : ''}` : 'Choose an action below';
    const save = root.closest('form')?.querySelector('[data-request-save]');
    if (save) save.disabled = !action(root).value;
  }
  function notify(root) {
    paint(root);
    for (const input of [action(root),reason(root)]) {
      input.dispatchEvent(new Event('input',{bubbles:true}));
      input.dispatchEvent(new Event('change',{bubbles:true}));
    }
  }
  function clear(root) {
    action(root).value = ''; reason(root).value = ''; notify(root);
  }
  function ensureDialog() {
    if (dialog) return;
    dialog = document.createElement('dialog');
    dialog.className = 'confirm-dialog';
    dialog.setAttribute('aria-labelledby','invoice-request-dialog-title');
    dialog.innerHTML = `<form data-standard-labels>
      <div class="confirm-dialog-header"><h2 id="invoice-request-dialog-title"></h2><button type="button" class="button-light" data-request-dismiss>Close</button></div>
      <div class="ui-dialog-fields">
        <label data-request-date-label>Posting Date<input type="date" data-request-date></label>
        <label><span data-request-reason-label></span><textarea data-request-reason rows="3" maxlength="4000" required></textarea></label>
      </div>
      <div class="confirm-dialog-actions"><button type="button" class="button-light" data-request-dismiss>Dismiss</button><button type="submit">Apply Request</button></div>
    </form>`;
    document.body.appendChild(dialog);
    for (const button of dialog.querySelectorAll('[data-request-dismiss]')) button.addEventListener('click',close);
    dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
    dialog.querySelector('form').addEventListener('submit',event=>{
      event.preventDefault();
      if (!active || !dialog.querySelector('form').reportValidity()) return;
      const why = dialog.querySelector('[data-request-reason]').value.trim();
      if (!why) { dialog.querySelector('[data-request-reason]').setCustomValidity('Enter a reason.'); dialog.querySelector('form').reportValidity(); return; }
      const {root,kind} = active;
      if (kind === 'Backdate') {
        const value = dialog.querySelector('[data-request-date]').value;
        root.querySelector('[name="requested_posting_date"]').value = value;
        const invoiceDate = root.closest('form').querySelector(`[name="${root.dataset.dateField || 'invoice_date'}"]`);
        if (invoiceDate) {
          invoiceDate.value = value;
          invoiceDate.dispatchEvent(new Event('input',{bubbles:true}));
          invoiceDate.dispatchEvent(new Event('change',{bubbles:true}));
        }
      }
      action(root).value = kind; reason(root).value = why;
      notify(root); close();
    });
    dialog.querySelector('[data-request-reason]').addEventListener('input',event=>event.target.setCustomValidity(''));
  }
  function close() {
    if (!active) return;
    const {root,trigger} = active; active = null;
    dialog.close(); paint(root); trigger.focus();
  }
  function open(root,kind,trigger) {
    ensureDialog(); active = {root,kind,trigger}; paint(root,kind);
    const date = dialog.querySelector('[data-request-date]');
    dialog.querySelector('#invoice-request-dialog-title').textContent = kind === 'Backdate' ? 'Request Backdate' : 'Request Cancellation';
    dialog.querySelector('[data-request-date-label]').hidden = kind !== 'Backdate';
    date.required = kind === 'Backdate'; date.disabled = kind !== 'Backdate';
    const invoiceDate = root.closest('form').querySelector(`[name="${root.dataset.dateField || 'invoice_date'}"]`);
    date.value = invoiceDate?.value || root.querySelector('[name="requested_posting_date"]').value || root.dataset.today;
    date.max = root.dataset.today;
    date.readOnly = !invoiceDate && root.dataset.dateEditable !== '1';
    const why = dialog.querySelector('[data-request-reason]');
    why.value = reason(root).value; why.setCustomValidity('');
    dialog.querySelector('[data-request-reason-label]').textContent = kind === 'Backdate' ? 'Reason for backdating' : 'Reason for cancellation';
    dialog.showModal(); (kind === 'Backdate' ? date : why).focus();
  }
  // Delegation also supports invoice drawers inserted after the page loads.
  document.addEventListener('click',event=>{
    const button = event.target.closest('[data-request-clear]');
    if (!button || button.disabled) return;
    const root = button.closest('[data-invoice-request-controls]');
    if (!root) return;
    clear(root);
  });
  document.addEventListener('change',event=>{
    if (!event.target.matches('[data-request-backdate],[data-request-cancel]') || event.target.disabled) return;
    const root = event.target.closest('[data-invoice-request-controls]');
    if (!event.target.checked) clear(root);
    else open(root,event.target.hasAttribute('data-request-backdate')?'Backdate':'Cancel',event.target);
  });
})();

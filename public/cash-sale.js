(() => {
  const layer = document.createElement('div');
  layer.className = 'statement-drawer-layer cash-sale-layer';
  layer.setAttribute('aria-hidden', 'true');
  layer.inert = true;
  layer.innerHTML = `
    <button type="button" class="statement-drawer-backdrop" aria-label="Close cash sale payment" tabindex="-1" data-cash-close></button>
    <aside class="statement-drawer cash-sale-drawer" role="dialog" aria-modal="true" aria-labelledby="cash-sale-title" tabindex="-1">
      <header class="statement-drawer-header cash-sale-header">
        <div>
          <p class="eyebrow">Sales · Payment</p>
          <h2 id="cash-sale-title">Complete cash sale</h2>
          <small>Record the payment and submit this invoice.</small>
        </div>
        <button type="button" class="statement-drawer-close" aria-label="Close cash sale payment" data-cash-close>&times;</button>
      </header>
      <form method="post" class="cash-sale-form" data-static-labels>
        <div class="statement-drawer-body cash-sale-body">
          <section class="cash-sale-summary" aria-label="Cash sale summary">
            <div class="cash-sale-summary-top">
              <span>Payment to receive</span>
              <span class="cash-sale-summary-status">Full payment</span>
            </div>
            <strong class="cash-sale-amount" data-cash-total></strong>
            <div class="cash-sale-summary-details">
              <span data-cash-invoice></span>
              <span data-cash-customer></span>
            </div>
          </section>
          <div class="cash-sale-section-heading">
            <span class="cash-sale-section-number">01</span>
            <div><h3>Payment details</h3><p>Choose where the payment will be received.</p></div>
          </div>
          <div class="cash-sale-fields">
            <label>Payment date<input type="date" name="payment_date" required></label>
            <label>Receive into<select name="cash_sale_account_id" required>
              <option value="">Choose cash or bank account</option>
            </select></label>
            <label>Payment reference <span class="cash-sale-optional">Optional</span><input name="cash_sale_reference" placeholder="Receipt or transaction number"></label>
            <label>Notes <span class="cash-sale-optional">Optional</span><textarea name="cash_sale_notes" rows="3" placeholder="Add a note for this payment"></textarea></label>
          </div>
          <p class="cash-sale-account-empty" data-cash-account-empty hidden>No cash or bank account is available for your role.</p>
        </div>
        <footer class="cash-sale-footer">
          <p>Submitting records full payment and reduces stock.</p>
          <div class="cash-sale-footer-actions">
            <button type="button" class="button-light" data-cash-close>Cancel</button>
            <button type="submit" data-cash-submit>Submit Cash Sale</button>
          </div>
        </footer>
      </form>
    </aside>`;
  document.body.appendChild(layer);

  const drawer = layer.querySelector('.cash-sale-drawer');
  const form = layer.querySelector('form');
  const accountSelect = form.elements.cash_sale_account_id;
  const submitButton = layer.querySelector('[data-cash-submit]');
  const background = new Map();
  let lastTrigger = null;
  let layerWasInert = true;

  function close() {
    if (!layer.classList.contains('is-open')) return;
    layer.classList.remove('is-open');
    layer.setAttribute('aria-hidden', 'true');
    layer.inert = layerWasInert;
    for (const [element, wasInert] of background) element.inert = wasInert;
    background.clear();
    document.body.classList.toggle('drawer-open', Boolean(document.querySelector('.statement-drawer-layer.is-open')));
    if (lastTrigger?.isConnected) lastTrigger.focus({ preventScroll: true });
    lastTrigger = null;
  }

  function open(trigger) {
    lastTrigger = trigger;
    form.reset();
    form.action = trigger.dataset.cashSaleUrl;
    form.elements.payment_date.value = trigger.dataset.cashSaleDate || '';
    layer.querySelector('[data-cash-total]').textContent = `Ugx ${Number(trigger.dataset.cashSaleTotal || 0).toLocaleString('en-UG')}`;
    layer.querySelector('[data-cash-invoice]').textContent = trigger.dataset.cashSaleInvoice || 'Sales invoice';
    layer.querySelector('[data-cash-customer]').textContent = trigger.dataset.cashSaleCustomer || '';

    accountSelect.replaceChildren(new Option('Choose cash or bank account', ''));
    let accounts = [];
    try { accounts = JSON.parse(trigger.dataset.cashSaleAccounts || '[]'); } catch { accounts = []; }
    for (const account of accounts) {
      accountSelect.add(new Option(`${account.account_code ? `${account.account_code} · ` : ''}${account.account_name}`, String(account.id)));
    }
    layer.querySelector('[data-cash-account-empty]').hidden = accounts.length > 0;
    submitButton.disabled = accounts.length === 0;

    for (const element of document.body.children) {
      if (element === layer || element.matches('script, dialog') || background.has(element)) continue;
      background.set(element, element.inert);
      element.inert = true;
    }
    layerWasInert = layer.inert;
    layer.inert = false;
    layer.removeAttribute('aria-hidden');
    layer.classList.add('is-open');
    document.body.classList.add('drawer-open');
    form.elements.payment_date.focus({ preventScroll: true });
  }

  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-cash-sale-url]');
    if (trigger) {
      event.preventDefault();
      open(trigger);
    }
  });
  layer.querySelectorAll('[data-cash-close]').forEach((button) => button.addEventListener('click', close));
  document.addEventListener('keydown', (event) => {
    if (!layer.classList.contains('is-open')) return;
    if (event.key === 'Escape') {
      event.stopImmediatePropagation();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    event.stopImmediatePropagation();
    const focusable = [...drawer.querySelectorAll('button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])')];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !focusable.includes(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !focusable.includes(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  });
})();

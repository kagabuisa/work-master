(() => {
  let dialog;
  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-cash-sale-url]');
    if (!trigger) return;
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.className = 'confirm-dialog cash-sale-dialog';
      dialog.setAttribute('aria-labelledby', 'cash-sale-title');
      dialog.innerHTML = `
        <h2 id="cash-sale-title">Submit Cash Sale</h2>
        <p>Submitting reduces stock and records full payment of <strong data-cash-total></strong>.</p>
        <form method="post" data-static-labels>
          <label>Payment date<input type="date" name="payment_date" required></label>
          <label>Payment method<select name="cash_sale_method">
            <option value="cash">Cash</option><option value="mobile_money">Mobile Money</option>
            <option value="bank">Bank</option><option value="card">Card</option><option value="other">Other</option>
          </select></label>
          <label>Payment reference<input name="cash_sale_reference" placeholder="Optional"></label>
          <label>Payment notes<input name="cash_sale_notes" placeholder="Optional"></label>
          <div class="confirm-dialog-actions">
            <button type="button" class="button-light" data-cash-cancel>Cancel</button>
            <button type="submit">Submit Cash Sale</button>
          </div>
        </form>`;
      document.body.appendChild(dialog);
      dialog.querySelector('[data-cash-cancel]').addEventListener('click', () => dialog.close());
    }
    const form = dialog.querySelector('form');
    form.reset();
    form.action = trigger.dataset.cashSaleUrl;
    form.elements.payment_date.value = trigger.dataset.cashSaleDate;
    dialog.querySelector('[data-cash-total]').textContent = `Ugx ${Number(trigger.dataset.cashSaleTotal).toLocaleString('en-UG')}`;
    dialog.showModal();
  });
})();

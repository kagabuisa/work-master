document.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() !== 's' || (!event.ctrlKey && !event.metaKey) || event.altKey || event.shiftKey) return;

  const target = event.target;
  if (!(target instanceof Element) || target.closest('[data-voucher-shortcut-ignore]')) return;
  let form = target.closest('form[data-voucher-form]');
  if (!form) {
    const saveButton = document.querySelector('[data-voucher-save][form]');
    form = saveButton ? document.getElementById(saveButton.getAttribute('form')) : null;
  }
  if (!form) form = document.querySelector('form[data-voucher-form]');
  if (!form) return;

  const saveButton = form.querySelector('[data-voucher-save]');
  const externalSaveButton = document.querySelector(`[data-voucher-save][form="${CSS.escape(form.id)}"]`);
  const submitter = saveButton || externalSaveButton;
  if (!submitter || submitter.disabled) return;

  event.preventDefault();
  form.requestSubmit(submitter);
});

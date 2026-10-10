document.addEventListener('keydown', (event) => {
  const enter = event.key === 'Enter';
  const save = event.key.toLowerCase() === 's' && (event.ctrlKey || event.metaKey)
    && !event.altKey && !event.shiftKey && !event.repeat;
  if (!enter && !save) return;

  const target = event.target;
  if (!(target instanceof Element) || target.closest('dialog, [role="dialog"], [data-voucher-shortcut-ignore]')) return;

  const forms = document.querySelectorAll('form[data-voucher-form]');
  const form = target.closest('form[data-voucher-form]') || (forms.length === 1 ? forms[0] : null);
  if (!form || form.closest('[inert]')) return;

  if (enter) {
    if (!event.isComposing && form.hasAttribute('data-prevent-enter-submit') && target.matches('input')) {
      event.preventDefault();
    }
    return;
  }

  const saveButton = [...document.querySelectorAll('[data-voucher-save]')]
    .find((button) => button.form === form && !button.disabled);
  if (!saveButton) return;

  event.preventDefault();
  form.requestSubmit(saveButton);
});

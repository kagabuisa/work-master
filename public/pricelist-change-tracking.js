(function () {
  const form = document.querySelector('form[data-pricelist-change-tracking]');
  if (!form) return;
  const updateButton = form.querySelector('[data-pricelist-update]');
  if (!updateButton) return;

  const fields = [...form.querySelectorAll('input[name], select[name], textarea[name]')]
    .filter((field) => !field.disabled && field.name !== (form.dataset.recordIdField || 'price_list') && field.type !== 'hidden');
  const valueOf = (field) => {
    const value = field.value.trim();
    return field.name === 'currency' ? value.toUpperCase() : value;
  };
  const original = fields.map(valueOf);
  const hasChanges = () => fields.some((field, index) => valueOf(field) !== original[index]);
  const refresh = () => {
    const changed = hasChanges();
    updateButton.hidden = !changed;
  };

  form.addEventListener('input', refresh);
  form.addEventListener('change', refresh);
  form.addEventListener('submit', (event) => {
    if (!hasChanges()) event.preventDefault();
  });
  refresh();
})();

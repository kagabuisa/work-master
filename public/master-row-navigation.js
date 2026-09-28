document.addEventListener('click', (event) => {
  const row = event.target.closest('tr[data-edit-href]');
  if (!row || event.target.closest('a, button, form, input, select, textarea, label')) return;
  if (window.getSelection()?.toString()) return;
  window.location.assign(row.dataset.editHref);
});

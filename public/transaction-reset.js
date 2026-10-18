document.querySelectorAll('[data-maintenance-form]').forEach(form => {
  form.querySelectorAll('button[type="submit"]').forEach(button => { button.dataset.originalLabel = button.textContent; });
  form.addEventListener('submit', () => {
    form.querySelectorAll('button[type="submit"]').forEach(button => {
      button.disabled = true;
      button.textContent = form.dataset.progressLabel;
    });
  });
});
window.addEventListener('pageshow', () => {
  document.querySelectorAll('[data-maintenance-form] button[type="submit"]').forEach(button => {
    button.disabled = false;
    button.textContent = button.dataset.originalLabel;
  });
});

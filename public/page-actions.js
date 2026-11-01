'use strict';

document.addEventListener('click', (event) => {
  const printButton = event.target.closest('[data-print-page]');
  if (printButton) {
    event.preventDefault();
    window.print();
    return;
  }
  const backLink = event.target.closest('[data-history-back]');
  if (backLink && window.history.length > 1) {
    event.preventDefault();
    window.history.back();
  }
});

document.addEventListener('change', (event) => {
  if (!event.target.matches('[data-auto-submit]') || !event.target.form) return;
  event.target.form.requestSubmit();
});

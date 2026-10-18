// Reveal invalid collapsed fields before the browser tries to focus them.
document.addEventListener('invalid', (event) => {
  const disclosure = event.target.closest('[data-voucher-posting]');
  if (disclosure) disclosure.open = true;
}, true);

// Keep edits in place while dismissing the floating editor.
document.addEventListener('click', (event) => {
  document.querySelectorAll('[data-voucher-posting][open]').forEach((disclosure) => {
    if (!event.composedPath().includes(disclosure)) disclosure.open = false;
  });
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  document.querySelectorAll('[data-voucher-posting][open]').forEach((disclosure) => {
    if (disclosure.contains(document.activeElement)) disclosure.querySelector('summary').focus();
    disclosure.open = false;
  });
});

document.addEventListener('click', (event) => {
  document.querySelectorAll('.ui-account-menu[open]').forEach((menu) => {
    if (!menu.contains(event.target)) menu.open = false;
  });
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  document.querySelectorAll('.ui-account-menu[open]').forEach((menu) => {
    const focusedInside = menu.contains(document.activeElement);
    menu.open = false;
    if (focusedInside) menu.querySelector('summary').focus();
  });
});

document.addEventListener('click', (event) => {
  const nav = event.target.closest('[data-module-nav]');
  document.querySelectorAll('.module-nav-group.open').forEach((group) => {
    if (!group.contains(event.target)) {
      group.classList.remove('open');
    }
  });

  if (!nav) {
    return;
  }

  const primaryLink = event.target.closest('.module-nav-primary');
  if (!primaryLink) {
    return;
  }

  const group = primaryLink.closest('.module-nav-group');
  const menu = group && group.querySelector('.module-nav-menu');
  if (!menu) {
    return;
  }

  if (!group.classList.contains('open')) {
    event.preventDefault();
    group.classList.add('open');
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') {
    return;
  }

  document.querySelectorAll('.module-nav-group.open').forEach((group) => {
    group.classList.remove('open');
  });
});

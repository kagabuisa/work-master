const mobileNav = document.querySelector('[data-module-nav]');
const mobileToggle = document.querySelector('.mobile-nav-toggle');

function syncMobileToggle() {
  if (!mobileNav || !mobileToggle) {
    return;
  }
  const collapsed = mobileNav.classList.contains('mobile-collapsed');
  mobileToggle.setAttribute('aria-expanded', String(!collapsed));
  mobileToggle.textContent = collapsed ? 'Menu' : 'Close menu';
}

if (mobileNav && mobileToggle) {
  if (window.matchMedia('(max-width: 820px)').matches) {
    mobileNav.classList.add('mobile-collapsed');
  }
  syncMobileToggle();

  mobileToggle.addEventListener('click', () => {
    mobileNav.classList.toggle('mobile-collapsed');
    syncMobileToggle();
  });

  window.matchMedia('(max-width: 820px)').addEventListener('change', (event) => {
    if (event.matches) {
      mobileNav.classList.add('mobile-collapsed');
    } else {
      mobileNav.classList.remove('mobile-collapsed');
    }
    syncMobileToggle();
  });
}

document.addEventListener('click', (event) => {
  document.querySelectorAll('[data-new-menu]').forEach((newMenu) => {
    const trigger = newMenu.querySelector('[data-new-menu-trigger]');
    const options = newMenu.querySelector('[data-new-menu-options]');
    const clickedTrigger = event.target.closest('[data-new-menu-trigger]') === trigger;

    if (clickedTrigger) {
      const willOpen = options.hidden;
      options.hidden = !willOpen;
      trigger.setAttribute('aria-expanded', String(willOpen));
      if (willOpen) {
        const firstItem = options.querySelector('[role="menuitem"]');
        if (firstItem) firstItem.focus();
      }
      return;
    }

    if (!newMenu.contains(event.target)) {
      options.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    }
  });

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
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const openOptions = document.querySelector('[data-new-menu-options]:not([hidden])');
    if (openOptions) {
      const items = [...openOptions.querySelectorAll('[role="menuitem"]')];
      const currentIndex = items.indexOf(document.activeElement);
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      const nextIndex = currentIndex < 0
        ? (direction === 1 ? 0 : items.length - 1)
        : (currentIndex + direction + items.length) % items.length;
      event.preventDefault();
      items[nextIndex]?.focus();
    }
    return;
  }

  if (event.key !== 'Escape') {
    return;
  }

  document.querySelectorAll('[data-new-menu]').forEach((newMenu) => {
    const trigger = newMenu.querySelector('[data-new-menu-trigger]');
    const options = newMenu.querySelector('[data-new-menu-options]');
    if (!options.hidden) {
      options.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      trigger.focus();
    }
  });

  document.querySelectorAll('.module-nav-group.open').forEach((group) => {
    group.classList.remove('open');
  });
});

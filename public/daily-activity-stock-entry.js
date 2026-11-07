'use strict';

(() => {
  const input = document.querySelector('[data-daily-activity-stock-entry]');
  if (!input) return;
  const form = input.closest('form');
  const warehouse = form?.querySelector('[name="warehouse"]');
  const menu = document.getElementById(input.getAttribute('aria-controls'));
  const status = document.getElementById(input.getAttribute('aria-describedby'));
  if (!form || !warehouse || !menu || !status) return;

  const menuId = menu.id;
  let timer;
  let controller;
  let requestId = 0;
  let entries = [];
  let selectedValue = '';
  let active = -1;

  function setOpen(open) {
    menu.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
    if (!open) {
      input.removeAttribute('aria-activedescendant');
      active = -1;
    }
  }

  function setValidity(message = '') {
    input.setCustomValidity(message);
  }

  function setActive(index) {
    active = index;
    [...menu.querySelectorAll('[role="option"]')].forEach((button, optionIndex) => {
      button.setAttribute('aria-selected', String(optionIndex === active));
    });
    const button = menu.querySelectorAll('[role="option"]')[active];
    if (!button) return;
    input.setAttribute('aria-activedescendant', button.id);
    if (button.offsetTop < menu.scrollTop) menu.scrollTop = button.offsetTop;
    else if (button.offsetTop + button.offsetHeight > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = button.offsetTop + button.offsetHeight - menu.clientHeight;
    }
  }

  function choose(entry) {
    selectedValue = entry.value;
    input.value = entry.value;
    setValidity();
    status.textContent = `Selected ${entry.value}: ${entry.label}`;
    setOpen(false);
    input.focus();
  }

  function render() {
    menu.replaceChildren();
    entries.forEach((entry, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = `${menuId}-${index}`;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', 'false');
      button.tabIndex = -1;
      const number = document.createElement('strong');
      number.textContent = entry.entry_no;
      const detail = document.createElement('span');
      detail.textContent = entry.label;
      button.append(number, detail);
      button.addEventListener('pointerdown', (event) => event.preventDefault());
      button.addEventListener('click', () => choose(entry));
      menu.append(button);
    });
    setOpen(entries.length > 0);
  }

  async function load() {
    clearTimeout(timer);
    controller?.abort();
    const currentRequest = ++requestId;
    const selectedWarehouse = warehouse.value.trim();
    const value = input.value.trim();
    entries = [];
    menu.replaceChildren();
    setOpen(false);
    if (!selectedWarehouse) {
      status.textContent = 'Choose a warehouse, then search for a submitted stock entry.';
      if (value) setValidity('Choose a warehouse before selecting a stock entry.');
      else setValidity();
      return;
    }

    controller = new AbortController();
    status.textContent = 'Loading stock entries…';
    try {
      const url = new URL(input.dataset.lookupUrl, window.location.origin);
      url.searchParams.set('warehouse', selectedWarehouse);
      url.searchParams.set('q', value);
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json().catch(() => ({}));
      if (controller.signal.aborted || currentRequest !== requestId) return;
      if (!response.ok) throw new Error(payload.error || 'Could not load stock entries.');
      entries = Array.isArray(payload) ? payload : [];
      render();
      const exact = value && entries.find((entry) => entry.value === value);
      if (exact) {
        selectedValue = value;
        setValidity();
        status.textContent = `Selected ${exact.value}: ${exact.label}`;
      } else {
        selectedValue = '';
        if (value) {
          setValidity('Choose an existing submitted stock entry from the suggestions.');
          status.textContent = 'No matching submitted stock entries include this warehouse.';
        } else {
          setValidity();
          status.textContent = entries.length
            ? 'Choose a recent submitted stock entry or type to search.'
            : 'No submitted stock entries include this warehouse.';
        }
      }
    } catch (error) {
      if (controller.signal.aborted || currentRequest !== requestId) return;
      selectedValue = '';
      if (value) setValidity('Could not verify this stock entry. Try again before saving.');
      status.textContent = error.message || 'Could not load stock entries. Try again.';
    }
  }

  function scheduleLoad() {
    clearTimeout(timer);
    timer = setTimeout(load, 180);
  }

  input.addEventListener('input', () => {
    selectedValue = '';
    if (input.value.trim()) setValidity('Choose an existing submitted stock entry from the suggestions.');
    else setValidity();
    scheduleLoad();
  });
  warehouse.addEventListener('input', () => {
    selectedValue = '';
    if (input.value.trim()) setValidity('Choose an existing submitted stock entry for this warehouse.');
    else setValidity();
    scheduleLoad();
  });
  warehouse.addEventListener('change', scheduleLoad);
  input.addEventListener('focus', load);
  input.addEventListener('blur', () => setOpen(false));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (menu.hidden) load();
      if (entries.length) {
        setActive(event.key === 'ArrowDown'
          ? (active + 1) % entries.length
          : (active <= 0 ? entries.length - 1 : active - 1));
      }
    } else if (event.key === 'Enter' && !menu.hidden && active >= 0) {
      event.preventDefault();
      choose(entries[active]);
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (!input.parentElement.contains(event.target)) setOpen(false);
  });
  form.addEventListener('submit', (event) => {
    const value = input.value.trim();
    if (!value || selectedValue === value) return;
    event.preventDefault();
    setValidity('Choose an existing submitted stock entry from the suggestions.');
    input.reportValidity();
    load();
  });

  if (warehouse.value.trim()) load();
})();

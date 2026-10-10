'use strict';

function permissionOptionMatches(label, query) {
  const term = String(query || '').trim();
  const pattern = term.split('%').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(pattern, 'i').test(String(label || ''));
}

function enhancePermissionSelect(select) {
  const label = select.closest('label');
  label.dataset.staticLabels = '';
  label.classList.add('permission-autocomplete');
  const input = document.createElement('input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.required = select.required;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-label', label.firstChild.textContent.trim());
  const menu = document.createElement('div');
  menu.className = 'results permission-autocomplete-results';
  menu.id = select.hasAttribute('data-permission-type') ? 'permission-type-options' : 'permission-record-options';
  menu.setAttribute('role', 'listbox');
  input.setAttribute('aria-controls', menu.id);
  menu.hidden = true;
  select.before(input);
  document.body.append(menu);
  select.hidden = true;
  select.style.display = 'none';
  select.required = false;
  let typing = false;
  let matches = [];
  let active = -1;

  function positionMenu() {
    if (menu.hidden) return;
    const rect = input.getBoundingClientRect();
    const gap = 4;
    const margin = 8;
    const below = Math.max(0, window.innerHeight - rect.bottom - gap - margin);
    const above = Math.max(0, rect.top - gap - margin);
    const wanted = Math.min(260, menu.scrollHeight);
    const openAbove = below < wanted && above > below;
    const height = Math.min(wanted, openAbove ? above : below);
    const width = Math.min(rect.width, window.innerWidth - margin * 2);
    menu.style.width = `${width}px`;
    menu.style.maxHeight = `${height}px`;
    menu.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin))}px`;
    menu.style.top = `${openAbove ? rect.top - gap - height : rect.bottom + gap}px`;
  }

  function close() {
    menu.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  }
  function refresh() {
    input.disabled = select.disabled;
    input.value = select.value ? select.selectedOptions[0]?.textContent || '' : '';
    input.placeholder = select.options[0]?.textContent || 'Search';
    input.setCustomValidity('');
    close();
  }
  function choose(option) {
    select.value = option.value;
    refresh();
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function setActive(index) {
    active = index;
    [...menu.querySelectorAll('[role="option"]')].forEach((button, i) => {
      button.setAttribute('aria-selected', String(i === active));
    });
    const button = menu.querySelectorAll('[role="option"]')[active];
    if (button) {
      input.setAttribute('aria-activedescendant', button.id);
      // Scroll only the suggestion list, never the page containing the form.
      const top = button.offsetTop;
      const bottom = top + button.offsetHeight;
      if (top < menu.scrollTop) menu.scrollTop = top;
      else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight;
    }
  }
  function show() {
    if (input.disabled) return;
    matches = [...select.options].filter((option) => !option.disabled && permissionOptionMatches(option.textContent, input.value));
    menu.replaceChildren();
    for (const [index, option] of matches.entries()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = `${menu.id}-${index}`;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', 'false');
      button.tabIndex = -1;
      button.textContent = option.textContent;
      button.addEventListener('pointerdown', (event) => event.preventDefault());
      button.addEventListener('click', () => { choose(option); input.focus(); close(); });
      menu.append(button);
    }
    if (!matches.length) {
      const empty = document.createElement('p');
      empty.textContent = 'No matching options';
      empty.setAttribute('role', 'status');
      menu.append(empty);
    }
    menu.hidden = false;
    menu.style.maxHeight = '260px';
    positionMenu();
    input.setAttribute('aria-expanded', 'true');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  }
  input.addEventListener('input', () => {
    // A query is not a permission selection. Require an explicit result choice.
    typing = true;
    select.value = '';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    typing = false;
    input.setCustomValidity(input.value.trim() ? 'Choose a matching option from the suggestions.' : '');
    show();
  });
  input.addEventListener('focus', show);
  input.addEventListener('blur', close);
  window.addEventListener('resize', positionMenu);
  window.addEventListener('scroll', (event) => {
    if (!menu.contains(event.target)) positionMenu();
  }, true);
  document.addEventListener('pointerdown', (event) => {
    if (!label.contains(event.target) && !menu.contains(event.target)) close();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (menu.hidden) show();
      if (matches.length) setActive(event.key === 'ArrowDown' ? (active + 1) % matches.length : (active <= 0 ? matches.length - 1 : active - 1));
    } else if (event.key === 'Enter' && !menu.hidden && active >= 0) {
      event.preventDefault();
      choose(matches[active]);
    }
  });
  select.addEventListener('change', () => { if (!typing) refresh(); });
  // Saving temporarily disables the original controls; keep the search in sync.
  new MutationObserver(() => {
    input.disabled = select.disabled;
    if (input.disabled) close();
  }).observe(select, { attributes: true, attributeFilter: ['disabled'] });
  refresh();
  return { refresh, input };
}

if (typeof module !== 'undefined') module.exports = { permissionOptionMatches, enhancePermissionSelect };
if (typeof window !== 'undefined') window.enhancePermissionSelect = enhancePermissionSelect;

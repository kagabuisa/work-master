/* Keep autocomplete menus visible above horizontally scrolling filter bars. */
(() => {
  if (!('showPopover' in HTMLElement.prototype)) return;
  document.querySelectorAll('.ui-filter-row .results').forEach((menu) => {
    const field = menu.closest('label');
    const input = field?.querySelector('input');
    const bar = menu.closest('.ui-filter-row');
    if (!input || !bar) return;
    menu.setAttribute('popover', 'manual');
    const close = () => { if (menu.matches(':popover-open')) menu.hidePopover(); };
    const position = () => {
      const anchor = input.getBoundingClientRect();
      const bounds = bar.getBoundingClientRect();
      if (!menu.textContent.trim() || anchor.right <= bounds.left || anchor.left >= bounds.right) {
        close(); return;
      }
      const width = Math.min(Math.max(anchor.width, 240), window.innerWidth - 24);
      menu.style.width = `${width}px`;
      menu.style.minWidth = '0';
      menu.style.left = `${Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12))}px`;
      menu.style.top = `${anchor.bottom + 4}px`;
      if (!menu.matches(':popover-open')) menu.showPopover();
    };
    new MutationObserver(position).observe(menu, { childList: true, subtree: true });
    bar.addEventListener('scroll', position, { passive: true });
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, { passive: true });
    input.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
  });
  document.querySelectorAll('.ui-filter-row .invoice-report-columns').forEach((details) => {
    const panel = details.querySelector('.ui-filter-panel');
    const summary = details.querySelector('summary');
    if (!panel || !summary) return;
    panel.setAttribute('popover', 'manual');
    const position = () => {
      if (!details.open) {
        if (panel.matches(':popover-open')) panel.hidePopover();
        return;
      }
      const anchor = summary.getBoundingClientRect();
      const width = Math.min(640, window.innerWidth - 24);
      panel.style.width = `${width}px`;
      panel.style.left = `${Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12))}px`;
      panel.style.top = `${anchor.bottom + 4}px`;
      panel.style.maxHeight = `${Math.max(100, window.innerHeight - anchor.bottom - 16)}px`;
      if (!panel.matches(':popover-open')) panel.showPopover();
    };
    details.addEventListener('toggle', position);
    details.closest('.ui-filter-row').addEventListener('scroll', position, { passive: true });
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, { passive: true });
    document.addEventListener('click', (event) => { if (!details.contains(event.target)) details.open = false; });
    panel.addEventListener('keydown', (event) => { if (event.key === 'Escape') { details.open = false; summary.focus(); } });
  });
})();

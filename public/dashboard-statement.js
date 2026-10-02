(() => {
  const rows = document.querySelectorAll('[data-dashboard-statement]');
  if (!rows.length) return;

  let layer = null;
  let lastTrigger = null;
  let requestId = 0;
  const background = new Map();

  function setBackgroundInert(open) {
    if (open) {
      for (const element of document.body.children) {
        if (element === layer || element.matches('script, dialog') || background.has(element)) continue;
        background.set(element, element.inert);
        element.inert = true;
      }
    } else {
      for (const [element, wasInert] of background) element.inert = wasInert;
      background.clear();
    }
    document.body.classList.toggle('drawer-open', open);
  }

  function closeStatement() {
    if (!layer) return;
    requestId += 1;
    const closingLayer = layer;
    layer = null;
    closingLayer.classList.remove('is-open');
    setBackgroundInert(false);
    if (lastTrigger?.isConnected) lastTrigger.focus({ preventScroll: true });
    lastTrigger = null;
    window.setTimeout(() => closingLayer.remove(), 180);
  }

  async function openStatement(url, trigger) {
    const currentRequest = ++requestId;
    if (!layer) {
      lastTrigger = trigger;
      layer = document.createElement('div');
      layer.className = 'statement-drawer-layer dashboard-statement-layer';
      layer.setAttribute('data-statement-layer', '');
      layer.innerHTML = `
        <button type="button" class="statement-drawer-backdrop" aria-label="Close statement" data-close-statement></button>
        <aside class="statement-drawer" role="dialog" aria-modal="true" aria-label="Customer statement" tabindex="-1">
          <div class="statement-drawer-body"><p class="empty">Loading customer statement…</p></div>
        </aside>`;
      document.body.appendChild(layer);
      setBackgroundInert(true);
      window.requestAnimationFrame(() => {
        if (layer) layer.classList.add('is-open');
      });
      layer.querySelector('.statement-drawer').focus({ preventScroll: true });
    } else {
      layer.setAttribute('aria-busy', 'true');
    }

    try {
      const response = await fetch(url, { headers: { Accept: 'text/html' } });
      if (!response.ok) throw new Error('Statement request failed');
      const html = await response.text();
      const page = new DOMParser().parseFromString(html, 'text/html');
      const statementLayer = page.querySelector('[data-statement-layer]');
      if (!statementLayer) throw new Error('Statement unavailable');
      if (currentRequest !== requestId || !layer) return;
      layer.innerHTML = statementLayer.innerHTML;
      layer.removeAttribute('aria-busy');
      layer.querySelector('.statement-drawer')?.focus({ preventScroll: true });
    } catch {
      if (currentRequest !== requestId || !layer) return;
      layer.removeAttribute('aria-busy');
      layer.querySelector('.statement-drawer-body').innerHTML =
        '<p class="notice warning" role="alert">Could not load the statement. Open the full report to try again.</p>';
      const link = document.createElement('a');
      link.className = 'button';
      const fullUrl = new URL(url, window.location.href);
      fullUrl.searchParams.set('view', 'full');
      link.href = fullUrl.href;
      link.textContent = 'Open report';
      layer.querySelector('.statement-drawer-body').appendChild(link);
    }
  }

  rows.forEach((row) => {
    const link = row.querySelector('a[href]');
    if (!link) return;
    row.addEventListener('click', (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (event.target.closest('a') && event.target.closest('a') !== link) return;
      event.preventDefault();
      openStatement(link.href, event.target === link ? link : row);
    });
    row.addEventListener('keydown', (event) => {
      if (event.target !== row || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      openStatement(link.href, row);
    });
  });

  document.addEventListener('click', (event) => {
    if (!layer || !layer.contains(event.target)) return;
    if (event.target.closest('[data-close-statement]')) {
      event.preventDefault();
      closeStatement();
      return;
    }
    const clearLink = event.target.closest('.statement-date-range a[href]');
    if (clearLink) {
      event.preventDefault();
      openStatement(clearLink.href, lastTrigger);
      return;
    }
    if (event.target.closest('[data-print-statement]')) {
      layer.querySelector('[data-statement]')?.classList.add('is-print-target');
      document.body.classList.add('printing-statement');
      window.print();
      return;
    }
    if (event.target.closest('[data-export-statement]')) {
      const statement = layer.querySelector('[data-statement]');
      const rows = statement?.querySelectorAll('.statement-table tr') || [];
      if (!rows.length) return;
      const csv = [...rows].map((row) => [...row.querySelectorAll('th, td')]
        .map((cell) => `"${cell.textContent.trim().replace(/"/g, '""')}"`)
        .join(','))
        .join('\r\n');
      const objectUrl = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
      const download = document.createElement('a');
      download.href = objectUrl;
      download.download = statement.dataset.exportName || 'customer-statement.csv';
      download.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    }
  });

  document.addEventListener('submit', (event) => {
    const form = event.target.closest('.statement-date-range');
    if (!layer || !form || !layer.contains(form)) return;
    event.preventDefault();
    const url = new URL(form.action, window.location.href);
    url.search = new URLSearchParams(new FormData(form)).toString();
    openStatement(url.href, lastTrigger);
  });

  document.addEventListener('keydown', (event) => {
    if (!layer || document.querySelector('[data-voucher-layer].is-open, dialog[open]')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeStatement();
      return;
    }
    if (event.key !== 'Tab') return;
    const dialog = layer.querySelector('.statement-drawer');
    const focusable = [...dialog.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter((element) => element.getClientRects().length);
    if (!focusable.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  });

  window.addEventListener('afterprint', () => {
    document.body.classList.remove('printing-statement');
    layer?.querySelector('.is-print-target')?.classList.remove('is-print-target');
  });
})();

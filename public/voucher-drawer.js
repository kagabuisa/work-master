(function () {
  const existing = document.querySelector('[data-voucher-layer]');
  if (existing) existing.remove();

  const layer = document.createElement('div');
  layer.className = 'statement-drawer-layer';
  layer.setAttribute('data-voucher-layer', '');
  layer.innerHTML = `
    <button type="button" class="statement-drawer-backdrop" aria-label="Close voucher" data-voucher-close></button>
    <aside class="statement-drawer voucher-drawer" role="dialog" aria-modal="true" aria-labelledby="voucher-drawer-title" tabindex="-1">
      <header class="statement-drawer-header voucher-drawer-header">
        <div>
          <p class="eyebrow" data-voucher-eyebrow>Voucher</p>
          <h2 id="voucher-drawer-title">Details</h2>
        </div>
        <div class="voucher-drawer-header-actions">
          <a class="button button-light" href="#" data-voucher-full hidden>Open full view</a>
          <button type="button" class="statement-drawer-close" aria-label="Close voucher" data-voucher-close>&times;</button>
        </div>
      </header>
      <div class="statement-drawer-body voucher-drawer-body" data-voucher-body>
        <p class="empty">Loading voucher…</p>
      </div>
    </aside>
  `;
  document.body.appendChild(layer);

  const drawer = layer.querySelector('.voucher-drawer');
  const body = layer.querySelector('[data-voucher-body]');
  const title = layer.querySelector('#voucher-drawer-title');
  const eyebrow = layer.querySelector('[data-voucher-eyebrow]');
  const fullLink = layer.querySelector('[data-voucher-full]');
  let lastTrigger = null;
  let requestId = 0;
  let closeToken = 0;

  const setOpen = (open) => {
    layer.classList.toggle('is-open', open);
    document.body.classList.toggle('drawer-open', open);
    if (open) {
      layer.removeAttribute('inert');
      layer.removeAttribute('aria-hidden');
    } else {
      layer.setAttribute('inert', '');
      layer.setAttribute('aria-hidden', 'true');
    }
    if (open && drawer) drawer.focus({ preventScroll: true });
    if (!open && lastTrigger) {
      lastTrigger.focus({ preventScroll: true });
      lastTrigger = null;
    }
  };

  setOpen(false);

  const reset = () => {
    if (body) body.innerHTML = '<p class="empty">Loading voucher…</p>';
    if (title) title.textContent = 'Details';
    if (eyebrow) eyebrow.textContent = 'Voucher';
    if (fullLink) {
      fullLink.hidden = true;
      fullLink.removeAttribute('href');
    }
  };

  const close = () => {
    if (!layer.classList.contains('is-open')) return;
    setOpen(false);
    const token = ++closeToken;
    window.setTimeout(() => {
      if (token === closeToken && !layer.classList.contains('is-open')) reset();
    }, 180);
  };

  async function openVoucher(url, fullUrl) {
    const current = ++requestId;
    closeToken += 1;
    if (body) body.innerHTML = '<p class="empty">Loading voucher…</p>';
    if (title) title.textContent = 'Details';
    if (eyebrow) eyebrow.textContent = 'Voucher';
    if (fullLink) {
      if (fullUrl) {
        fullLink.href = fullUrl;
        fullLink.hidden = false;
      } else {
        fullLink.hidden = true;
        fullLink.removeAttribute('href');
      }
    }
    setOpen(true);

    try {
      const response = await fetch(url, { headers: { Accept: 'text/html' } });
      if (!response.ok) throw new Error('Unable to load voucher.');
      const html = await response.text();
      if (current !== requestId) return;
      if (body) body.innerHTML = html;
      const content = body && body.querySelector('.invoice-drawer-content');
      if (content) {
        if (title) title.textContent = content.dataset.voucherTitle || 'Details';
        if (eyebrow) eyebrow.textContent = content.dataset.voucherEyebrow || 'Voucher';
      }
    } catch (err) {
      if (current !== requestId) return;
      if (body) body.innerHTML = '<p class="notice warning">Unable to load voucher. Please try again.</p>';
    }
  }

  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-voucher-drawer]');
    if (!trigger) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    lastTrigger = trigger;
    const drawerUrl = trigger.getAttribute('data-voucher-drawer');
    const fullUrl = trigger.getAttribute('href') || trigger.getAttribute('data-full-url') || '';
    if (drawerUrl) openVoucher(drawerUrl, fullUrl);
  });

  layer.querySelectorAll('[data-voucher-close]').forEach((control) => {
    control.addEventListener('click', close);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && layer.classList.contains('is-open')) {
      close();
    }
    if (event.key === 'Tab' && layer.classList.contains('is-open') && drawer) {
      const focusable = [...drawer.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )].filter((element) => !element.hidden);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });

  // Audit toggle for dynamically injected drawer content.
  document.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-tracking-toggle]');
    if (!toggle || !layer.contains(toggle)) return;
    const visible = document.body.classList.toggle('tracking-visible');
    layer.querySelectorAll('[data-tracking-toggle]').forEach((button) => {
      button.textContent = visible ? 'Hide tracking' : 'Show tracking';
      button.setAttribute('aria-expanded', String(visible));
    });
  });
})();

(() => {
  'use strict';
  document.documentElement.classList.add('entry-sharing-ready');

  function feedback(panel, message, error = false) {
    const status = panel.querySelector('[data-share-feedback]');
    status.textContent = message;
    status.dataset.tone = error ? 'error' : 'normal';
    status.setAttribute('role', error ? 'alert' : 'status');
  }

  document.addEventListener('change', event => {
    const form = event.target.closest('[data-share-mode="permission"]');
    if (form && event.target.matches('select[name="permission"]')) form.requestSubmit();
  });

  document.addEventListener('submit', async event => {
    const form = event.target.closest('[data-entry-sharing-form]');
    if (!form) return;
    event.preventDefault();
    const panel = form.closest('[data-entry-sharing-panel]');
    if (panel.getAttribute('aria-busy') === 'true') return;
    const mode = form.dataset.shareMode;
    const body = new URLSearchParams(new FormData(form));
    const userId = body.get('user_id');
    const controls = [...panel.querySelectorAll('button, select')].map(control => [control, control.disabled]);
    panel.setAttribute('aria-busy', 'true');
    controls.forEach(([control]) => { control.disabled = true; });
    feedback(panel, mode === 'revoke' ? 'Removing access…' : 'Saving access…');
    try {
      const response = await fetch(form.getAttribute('action'), {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
        body: body.toString(),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || 'Could not save access. Please try again.');
      if (!result?.html) throw new Error('Could not refresh sharing. Reload this entry to check access.');
      const template = document.createElement('template');
      template.innerHTML = result.html.trim();
      const replacement = template.content.querySelector('[data-entry-sharing-panel]');
      if (!replacement) throw new Error('Could not refresh sharing. Reload this entry to check access.');
      panel.replaceWith(replacement);
      feedback(replacement, mode === 'revoke' ? 'Access removed.' : mode === 'invite' ? 'Entry shared.' : 'Access updated.');
      const focus = mode === 'revoke'
        ? replacement.querySelector('[data-share-mode="invite"] select[name="user_id"]')
        : replacement.querySelector(`[data-share-user="${CSS.escape(userId)}"] select[name="permission"]`);
      focus?.focus({ preventScroll: true });
    } catch (error) {
      const select = form.querySelector('select[data-current-permission]');
      if (select) select.value = select.dataset.currentPermission;
      feedback(panel, error.message || 'Could not save access. Please try again.', true);
    } finally {
      if (panel.isConnected) {
        controls.forEach(([control, disabled]) => { control.disabled = disabled; });
        panel.removeAttribute('aria-busy');
      }
    }
  });
})();

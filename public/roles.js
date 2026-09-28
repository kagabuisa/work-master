document.addEventListener('DOMContentLoaded', () => {
  const search = document.querySelector('#role-search, #user-search');
  const select = document.querySelector('#role-select, select[name="user"]');
  if (search && select) {
    const options = [...select.options];
    search.addEventListener('input', () => {
      const term = search.value.trim().toLowerCase();
      for (const option of options) option.hidden = Boolean(term && !option.textContent.toLowerCase().includes(term));
      const visible = options.find((option) => !option.hidden);
      if (visible && select.selectedOptions[0]?.hidden) select.value = visible.value;
    });
  }

  const addForm = document.querySelector('[data-role-add-row]');
  const typeSelect = addForm?.querySelector('[data-record-type]');
  const table = document.querySelector('[data-auto-permissions]');
  const status = document.querySelector('[data-permission-status]');
  if (table && status) {
    table.addEventListener('change', async (event) => {
      const input = event.target;
      if (!input.matches('input[name="actions"]')) return;
      const form = input.form;
      const controls = [...table.querySelectorAll('input, button'), ...addForm.querySelectorAll('input, select, button')];
      const disabled = controls.map((control) => control.disabled);
      const previous = [...table.querySelectorAll('input[name="actions"]')].map((control) => [control, control === input ? !control.checked : control.checked]);
      if (input.value === 'view' && !input.checked) {
        for (const [control] of previous) if (control.form === form) control.checked = false;
      } else if (input.value !== 'view' && input.checked) {
        for (const [control] of previous) {
          if (control.form === form && control.value === 'view') control.checked = true;
        }
      }
      const body = new URLSearchParams(new FormData(form));
      controls.forEach((control) => { control.disabled = true; });
      status.textContent = 'Saving…';
      try {
        const response = await fetch(form.action + (body.has('actions') ? '' : '/remove'), {
          method: 'POST', headers: { Accept: 'application/json' }, body,
        });
        if (response.redirected || !response.headers.get('content-type')?.includes('application/json')) {
          throw new Error('Your session may have expired. Reload the page before trying again.');
        }
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Unable to save permissions.');
        const permissions = new Set(result.permissions);
        for (const [control] of previous) control.checked = permissions.has(control.dataset.permission);
        for (const option of typeSelect.options) {
          if (!option.dataset.permissions) continue;
          option.dataset.grantedActions = Object.entries(JSON.parse(option.dataset.permissions))
            .filter(([, permission]) => permissions.has(permission)).map(([action]) => action).join(',');
        }
        status.textContent = 'Permissions saved.';
      } catch (error) {
        for (const [control, checked] of previous) control.checked = checked;
        status.textContent = `Save failed. ${error.message} Reload to confirm saved permissions.`;
      } finally {
        controls.forEach((control, index) => { control.disabled = disabled[index]; });
        typeSelect.dispatchEvent(new Event('change'));
      }
    });
  }
  if (addForm && typeSelect) {
    const updateActions = () => {
      const actions = new Set(typeSelect.selectedOptions[0]?.dataset.actions?.split(',') || []);
      const granted = new Set(typeSelect.selectedOptions[0]?.dataset.grantedActions?.split(',') || []);
      for (const input of addForm.querySelectorAll('input[name="actions"]')) {
        input.disabled = !actions.has(input.value);
        input.parentElement.hidden = input.disabled;
        input.checked = !input.disabled && granted.has(input.value);
      }
    };
    typeSelect.addEventListener('change', updateActions);
    addForm.addEventListener('change', (event) => {
      const input = event.target;
      if (!input.matches('input[name="actions"]')) return;
      const read = addForm.querySelector('input[name="actions"][value="view"]');
      if (!read || read.disabled) return;
      if (input === read && !read.checked) {
        for (const action of addForm.querySelectorAll('input[name="actions"]')) action.checked = false;
      } else if (input !== read && input.checked) {
        read.checked = true;
      }
    });
    updateActions();
  }
});

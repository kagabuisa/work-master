(() => {
  const input = document.querySelector('[data-cost-center-input]');
  const list = input && document.getElementById(input.getAttribute('list'));
  if (!input || !list || input.readOnly || input.disabled) return;
  const idInput = document.querySelector('[data-cost-center-id]');
  const preferred = input.dataset.defaultCostCenter || '';
  let timer;
  let sequence = 0;
  let touched = false;
  let choices = [];
  const key = value => String(value || '').trim().toLowerCase();
  function select(row) {
    if (idInput) idInput.value = row.cost_center;
    input.value = idInput ? row.cost_center_name || row.cost_center : row.cost_center;
    input.setCustomValidity?.('');
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function resolve() {
    if (!idInput) return;
    const selected = choices.find(row => key(row.cost_center_name || row.cost_center) === key(input.value));
    if (selected) {
      idInput.value = selected.cost_center;
      input.setCustomValidity('');
    } else if (!input.value.trim()) {
      idInput.value = '';
      input.setCustomValidity('');
    } else if (!idInput.value) {
      input.setCustomValidity('Select a cost center from the suggestions.');
    }
  }
  async function search(autofill = false) {
    const current = ++sequence;
    const query = input.value.trim();
    try {
      const response = await fetch(`/api/cost-centers?q=${encodeURIComponent(query)}`);
      if (!response.ok) return;
      const rows = await response.json();
      if (current !== sequence || query !== input.value.trim() || !Array.isArray(rows)) return;
      choices = rows.filter(row => row.disabled !== '1' && row.is_group !== true);
      list.replaceChildren();
      for (const row of choices) {
        const option = document.createElement('option');
        option.value = idInput ? row.cost_center_name || row.cost_center : row.cost_center;
        list.appendChild(option);
      }
      resolve();
      if (autofill && !touched && !input.value.trim()) {
        let selected = choices.find(row => row.cost_center === preferred);
        if (!selected && preferred) {
          const response = await fetch(`/api/cost-centers?q=${encodeURIComponent(preferred)}`);
          if (response.ok) {
            const matches = await response.json();
            if (Array.isArray(matches)) selected = matches.find(row => row.cost_center === preferred
              && row.disabled !== '1' && row.is_group !== true);
          }
        }
        if (current !== sequence || touched || input.value.trim()) return;
        selected ||= choices.length === 1 ? choices[0] : null;
        if (selected) select(selected);
      }
    } catch { /* Keep the saved ID when a lookup fails; unresolved edits remain invalid. */ }
  }
  input.addEventListener('focus', () => search(!touched && !input.value.trim()));
  input.addEventListener('input', () => {
    touched = true;
    if (idInput) idInput.value = '';
    resolve();
    clearTimeout(timer);
    timer = setTimeout(() => search(), 180);
  });
  input.addEventListener('change', resolve);
  if (!input.value.trim()) search(true);
})();

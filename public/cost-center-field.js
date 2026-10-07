(() => {
  const input = document.querySelector('[data-cost-center-input]');
  const list = input && document.getElementById(input.getAttribute('list'));
  if (!input || !list || input.readOnly || input.disabled) return;
  const preferred = input.dataset.defaultCostCenter || '';
  let timer;
  let sequence = 0;
  let touched = false;
  async function search(autofill = false) {
    const current = ++sequence;
    const query = input.value.trim();
    try {
      const response = await fetch(`/api/cost-centers?q=${encodeURIComponent(query)}`);
      if (!response.ok) return;
      const rows = await response.json();
      if (current !== sequence || query !== input.value.trim() || !Array.isArray(rows)) return;
      const choices = rows.filter((row) => row.disabled !== '1' && row.is_group !== true);
      list.replaceChildren();
      for (const row of choices) {
        const option = document.createElement('option');
        option.value = row.cost_center;
        option.label = row.cost_center_name || row.cost_center;
        list.appendChild(option);
      }
      if (autofill && !touched && !input.value.trim()) {
        let selected = choices.find((row) => row.cost_center === preferred);
        if (!selected && preferred) {
          try {
            const preferredResponse = await fetch(`/api/cost-centers?q=${encodeURIComponent(preferred)}`);
            if (preferredResponse.ok) {
              const matches = await preferredResponse.json();
              if (Array.isArray(matches)) {
                selected = matches.find((row) => row.cost_center === preferred
                  && row.disabled !== '1' && row.is_group !== true);
              }
            }
          } catch { /* The first lookup still supplies any available single choice. */ }
        }
        if (current !== sequence || touched || input.value.trim()) return;
        selected ||= choices.length === 1 ? choices[0] : null;
        if (selected) {
          input.value = selected.cost_center;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    } catch { /* Server validation handles unavailable lookups. */ }
  }
  input.addEventListener('focus', () => search(!touched && !input.value.trim()));
  input.addEventListener('input', () => {
    touched = true;
    clearTimeout(timer);
    timer = setTimeout(() => search(), 180);
  });
  if (!input.value.trim()) search(true);
})();

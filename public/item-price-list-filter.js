(() => {
  if (window.location.pathname === '/settings/item-prices' && window.location.search) {
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.hash);
  }
  const input = document.querySelector('[data-price-list-filter]');
  if (!input?.form || !input.list) return;
  const itemSearch = document.querySelector('[data-item-price-search]');
  const codeInput = document.querySelector('[data-item-code-filter]');
  const codeExact = document.querySelector('[data-item-code-exact]');
  const codeStatus = document.getElementById('item-price-code-status');
  if (performance.getEntriesByType('navigation')[0]?.type === 'reload') {
    for (const field of [input, itemSearch, codeInput]) if (field) field.value = '';
    if (codeExact) codeExact.value = '0';
  }
  const names = new Set(Array.from(input.list.options, (option) => option.value));
  for (const field of [input, itemSearch, codeInput]) {
    field?.addEventListener('focus', () => { field.value = ''; });
  }
  input.addEventListener('change', () => {
    if (names.has(input.value.trim())) input.form.requestSubmit();
  });

  if (!codeInput?.list || !codeExact) return;
  let timer;
  let requestId = 0;
  const loadCodes = async () => {
    const current = ++requestId;
    const query = new URLSearchParams({ q: codeInput.value.trim(), price_list: input.value.trim(),
      price_list_exact: names.has(input.value.trim()) ? '1' : '0' });
    codeStatus.textContent = 'Loading item codes…';
    try {
      const response = await fetch(`/api/item-price-codes?${query}`);
      if (!response.ok) throw new Error('Item code lookup failed');
      const codes = await response.json();
      if (current !== requestId) return;
      codeInput.list.replaceChildren(...codes.map((code) => {
        const option = document.createElement('option');
        option.value = code;
        return option;
      }));
      codeStatus.textContent = codes.length ? 'Choose a matching item code.' : 'No matching item codes.';
    } catch {
      if (current !== requestId) return;
      codeInput.list.replaceChildren();
      codeStatus.textContent = 'Could not load item codes. Try again.';
    }
  };
  codeInput.addEventListener('focus', loadCodes);
  codeInput.addEventListener('input', () => {
    requestId += 1;
    codeExact.value = '0';
    clearTimeout(timer);
    timer = setTimeout(loadCodes, 200);
  });
  codeInput.addEventListener('change', () => {
    if (!Array.from(codeInput.list.options).some((option) => option.value === codeInput.value.trim())) return;
    clearTimeout(timer);
    codeExact.value = '1';
    codeInput.form.requestSubmit();
  });
})();

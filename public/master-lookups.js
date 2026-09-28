(() => {
  document.querySelectorAll('[data-master-lookup]').forEach((input) => {
    const list = document.getElementById(input.getAttribute('list'));
    const status = document.getElementById(input.getAttribute('aria-describedby'));
    const retry = input.parentElement.querySelector('[data-lookup-retry]');
    let timer;
    let requestId = 0;
    const load = async () => {
      clearTimeout(timer);
      const current = ++requestId;
      status.textContent = 'Loading…';
      retry.hidden = true;
      try {
        const url = new URL(input.dataset.masterLookup, window.location.origin);
        url.searchParams.set('q', input.value.trim());
        const response = await fetch(url);
        if (!response.ok) throw new Error('Lookup failed');
        const rows = await response.json();
        if (current !== requestId) return;
        list.replaceChildren(...rows.map((row) => {
          const option = document.createElement('option');
          option.value = row.value;
          option.label = row.label;
          return option;
        }));
        const selected = rows.find((row) => row.value === input.value.trim());
        status.textContent = selected ? selected.label : rows.length ? 'Choose a matching record.' : 'No active submitted records match. Try a different search.';
      } catch {
        if (current !== requestId) return;
        list.replaceChildren();
        status.textContent = 'Could not load records. Please retry.';
        retry.hidden = false;
      }
    };
    input.addEventListener('input', () => {
      requestId += 1;
      clearTimeout(timer);
      list.replaceChildren();
      timer = setTimeout(load, 200);
    });
    input.addEventListener('focus', load);
    retry.addEventListener('click', load);
    if (input.value) load();
  });
})();

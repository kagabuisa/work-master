(function () {
  const accountInput = document.querySelector('[data-gl-account]');
  const accountResults = document.querySelector('.gl-account-results');
  const partyInput = document.querySelector('[data-gl-party]');
  const partyResults = document.querySelector('.gl-party-results');
  const filterForm = document.querySelector('[data-general-ledger-filters]');
  const resetLink = document.querySelector('[data-general-ledger-reset]');

  function clearFilters() {
    if (!filterForm) return;
    ['q', 'account', 'party', 'from', 'to'].forEach((name) => {
      const input = filterForm.querySelector(`[name="${name}"]`);
      if (input) input.value = '';
    });
    const voucherType = filterForm.querySelector('[name="voucher_type"]');
    if (voucherType) voucherType.value = '';
    const partyScope = filterForm.querySelector('[name="party_scope"]');
    if (partyScope) partyScope.value = 'related';
    const groupBy = filterForm.querySelector('[name="group_by"]');
    if (groupBy) groupBy.value = 'date';
    filterForm.querySelectorAll('input[type="hidden"][name="voucher_id"]').forEach((input) => input.remove());
    if (accountResults) accountResults.innerHTML = '';
    if (partyResults) partyResults.innerHTML = '';
  }

  resetLink?.addEventListener('click', (event) => {
    event.preventDefault();
    clearFilters();
    window.location.assign(resetLink.href);
  });

  window.addEventListener('pageshow', () => {
    if (!window.location.search) clearFilters();
  });

  bindLookup(accountInput, accountResults, '/api/general-ledger/accounts', (row) => `
    <button type="button" data-value="${escapeAttr(row.value)}">
      <strong>${escapeHtml(row.account_code)}</strong>
      <span>${escapeHtml(row.account_name)}</span>
    </button>
  `);
  bindLookup(partyInput, partyResults, '/api/general-ledger/parties', (row) => `
    <button type="button" data-value="${escapeAttr(row.value)}">
      <strong>${escapeHtml(row.value)}</strong>
      <span>${escapeHtml(row.party_type || '')}</span>
    </button>
  `);

  function bindLookup(input, results, endpoint, renderRow) {
    if (!input || !results) {
      return;
    }
    let timer;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => loadOptions(input, results, endpoint, renderRow), 180);
    });
    input.addEventListener('focus', () => loadOptions(input, results, endpoint, renderRow));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        results.innerHTML = '';
        return;
      }
      if (event.key === 'Enter') {
        const first = results.querySelector('[data-value]');
        if (first) {
          event.preventDefault();
          selectOption(input, results, first);
        }
      }
    });
    results.addEventListener('click', (event) => {
      const button = event.target.closest('[data-value]');
      if (button) {
        selectOption(input, results, button);
      }
    });
    document.addEventListener('click', (event) => {
      if (event.target !== input && !results.contains(event.target)) {
        results.innerHTML = '';
      }
    });
  }

  async function loadOptions(input, results, endpoint, renderRow) {
    const q = input.value.trim();
    try {
      const response = await fetch(`${endpoint}?q=${encodeURIComponent(q)}`);
      if (!response.ok) {
        throw new Error('Lookup failed.');
      }
      const rows = await response.json();
      results.innerHTML = rows.map(renderRow).join('') || '<p>No matches.</p>';
    } catch {
      results.innerHTML = '<p>Could not load options.</p>';
    }
  }

  function selectOption(input, results, button) {
    input.value = button.dataset.value || '';
    results.innerHTML = '';
    input.focus();
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    }[char]));
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, '&#096;');
  }
}());

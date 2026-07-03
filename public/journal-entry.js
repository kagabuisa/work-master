const journalForm = document.querySelector('#journal-entry-form');
const journalType = document.querySelector('#journal-type');
const partyType = document.querySelector('#party-type');
const partySearch = document.querySelector('#party-search');
const partyResults = document.querySelector('#party-results');
const partyId = document.querySelector('#party-id');
const partyName = document.querySelector('#party-name');
const referenceSearch = document.querySelector('#reference-search');
const referenceResults = document.querySelector('#reference-results');
const journalLinesBody = document.querySelector('#journal-lines tbody');
const addJournalRow = document.querySelector('#add-journal-row');
const totalDebit = document.querySelector('#journal-total-debit');
const totalCredit = document.querySelector('#journal-total-credit');
const balanceStatus = document.querySelector('#journal-balance-status');
const journalRowTemplate = journalLinesBody.querySelector('tr').cloneNode(true);
const partyEndpoints = {
  customer: '/api/customers',
  supplier: '/api/suppliers',
  employee: '/api/employees',
};

let partyTimer;
let referenceTimer;
let preloadedParties = [];
let preloadedReferences = [];
let partiesLoading = false;
let referencesLoading = false;

addJournalRow.addEventListener('click', () => {
  journalLinesBody.appendChild(blankJournalRow());
  updateJournalTotals();
});

journalType.addEventListener('change', () => {
  if (hasEnteredAmounts()) {
    updateJournalTotals();
    return;
  }
  applyJournalTypeTemplate();
});

if (partyType && partySearch) {
  partyType.addEventListener('change', () => {
    clearPartySelection();
    configurePartySearch();
    configureReferenceSearch();
    preloadParties();
  });

  partySearch.addEventListener('input', () => {
    partyId.value = '';
    partyName.value = '';
    clearTimeout(partyTimer);
    partyTimer = setTimeout(searchParties, 220);
  });

  partySearch.addEventListener('focus', () => {
    showPreloadedParties();
  });

  partySearch.addEventListener('click', () => {
    showPreloadedParties();
  });

  partySearch.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.ctrlKey) {
      return;
    }
    const firstResult = partyResults.querySelector('[data-id]');
    if (!firstResult) {
      return;
    }
    event.preventDefault();
    selectParty(firstResult);
  });

  partySearch.addEventListener('blur', () => {
    setTimeout(clearUnselectedParty, 150);
  });

  document.addEventListener('click', (event) => {
    if (event.target === partySearch || partyResults.contains(event.target)) {
      return;
    }
    partyResults.innerHTML = '';
    clearUnselectedParty();
  });
}

if (referenceSearch) {
  referenceSearch.addEventListener('input', () => {
    clearTimeout(referenceTimer);
    referenceTimer = setTimeout(searchReferences, 220);
  });

  referenceSearch.addEventListener('focus', () => {
    showPreloadedReferences();
  });

  referenceSearch.addEventListener('click', () => {
    showPreloadedReferences();
  });

  referenceSearch.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.ctrlKey) {
      return;
    }
    const firstResult = referenceResults.querySelector('[data-reference]');
    if (!firstResult) {
      return;
    }
    event.preventDefault();
    selectReference(firstResult);
  });

  document.addEventListener('click', (event) => {
    if (event.target === referenceSearch || referenceResults.contains(event.target)) {
      return;
    }
    referenceResults.innerHTML = '';
  });
}

journalLinesBody.addEventListener('input', (event) => {
  if (event.target.matches('[name="debit"]')) {
    const row = event.target.closest('tr');
    if (Number(event.target.value || 0) > 0) {
      row.querySelector('[name="credit"]').value = '';
    }
  }
  if (event.target.matches('[name="credit"]')) {
    const row = event.target.closest('tr');
    if (Number(event.target.value || 0) > 0) {
      row.querySelector('[name="debit"]').value = '';
    }
  }
  updateJournalTotals();
});

journalLinesBody.addEventListener('click', (event) => {
  if (!event.target.matches('[data-remove-journal-row]')) {
    return;
  }
  if (journalLinesBody.querySelectorAll('tr').length <= 2) {
    clearJournalRow(event.target.closest('tr'));
  } else {
    event.target.closest('tr').remove();
  }
  updateJournalTotals();
});

journalForm.addEventListener('submit', (event) => {
  if (partyType && partyType.value && !partyId.value) {
    event.preventDefault();
    balanceStatus.textContent = 'Select a party from the database before posting.';
    partySearch.focus();
    return;
  }
  const totals = journalTotals();
  if (totals.debit <= 0 || totals.debit !== totals.credit) {
    event.preventDefault();
    balanceStatus.textContent = 'Debits and credits must balance before posting.';
  }
});

if (!hasEnteredAmounts()) {
  applyJournalTypeTemplate();
}
configurePartySearch();
configureReferenceSearch();
preloadParties();
updateJournalTotals();

function applyJournalTypeTemplate() {
  const rows = [...journalLinesBody.querySelectorAll('tr')];
  while (rows.length < 2) {
    journalLinesBody.appendChild(blankJournalRow());
    rows.push(journalLinesBody.lastElementChild);
  }
  rows.forEach(clearJournalRow);
  if (journalType.value === 'cash_receipt') {
    rows[0].querySelector('[name="debit"]').placeholder = 'Cash received';
    rows[1].querySelector('[name="credit"]').placeholder = 'Income or receivable';
  } else if (journalType.value === 'payment_journal') {
    rows[0].querySelector('[name="debit"]').placeholder = 'Expense or payable';
    rows[1].querySelector('[name="credit"]').placeholder = 'Cash paid';
  } else {
    rows[0].querySelector('[name="debit"]').placeholder = 'Debit';
    rows[1].querySelector('[name="credit"]').placeholder = 'Credit';
  }
}

function configurePartySearch() {
  if (!partyType || !partySearch) {
    return;
  }
  const type = partyType.value;
  partySearch.disabled = !type;
  partySearch.placeholder = type ? `Search ${partyTypeLabel(type)} ID or name` : 'Choose a party type first';
  if (!type) {
    partyResults.innerHTML = '';
  }
}

function configureReferenceSearch() {
  if (!referenceSearch) {
    return;
  }
  const hasParty = Boolean(partyType && partyType.value && partyId && partyId.value);
  referenceSearch.disabled = !hasParty;
  referenceSearch.placeholder = hasParty ? 'Search this party transactions' : 'Select a party first';
  if (!hasParty) {
    referenceResults.innerHTML = '';
    preloadedReferences = [];
  }
}

async function searchParties() {
  const type = partyType.value;
  if (!type) {
    partyResults.innerHTML = '<p>Choose a party type first.</p>';
    return;
  }
  const q = partySearch.value.trim();
  if (!q) {
    showPreloadedParties();
    return;
  }
  try {
    const rows = await fetchParties(type, q);
    renderPartyResults(type, rows);
  } catch {
    partyResults.innerHTML = '<p>Could not load parties.</p>';
  }
}

async function fetchParties(type, q = '') {
  const endpoint = partyEndpoints[type];
  if (!endpoint) {
    return [];
  }
  const response = await fetch(`${endpoint}?q=${encodeURIComponent(q)}`);
  if (!response.ok) {
    throw new Error('Party request failed.');
  }
  return response.json();
}

async function preloadParties() {
  if (!partyType || !partyType.value) {
    preloadedParties = [];
    return;
  }
  const type = partyType.value;
  partiesLoading = true;
  try {
    preloadedParties = await fetchParties(type);
  } catch {
    preloadedParties = [];
  } finally {
    partiesLoading = false;
    if (document.activeElement === partySearch && partyType.value === type && !partySearch.value.trim()) {
      showPreloadedParties();
    }
  }
}

function showPreloadedParties() {
  if (!partyType || !partyType.value) {
    partyResults.innerHTML = '<p>Choose a party type first.</p>';
    return;
  }
  if (partiesLoading) {
    partyResults.innerHTML = '<p>Loading parties...</p>';
    return;
  }
  renderPartyResults(partyType.value, preloadedParties);
}

function renderPartyResults(type, rows) {
  partyResults.innerHTML = rows.map((party) => {
    const normalized = normalizeParty(type, party);
    return `
      <button type="button" data-id="${escapeAttr(normalized.id)}" data-name="${escapeAttr(normalized.name)}">
        <strong>${escapeHtml(normalized.id)}</strong>
        <span>${escapeHtml([normalized.name, normalized.meta].filter(Boolean).join(' - '))}</span>
      </button>
    `;
  }).join('') || '<p>No matching parties.</p>';

  partyResults.querySelectorAll('[data-id]').forEach((button) => {
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      selectParty(button);
    });
    button.addEventListener('click', () => {
      selectParty(button);
    });
  });
}

function normalizeParty(type, party) {
  if (type === 'supplier') {
    return {
      id: party.supplier_id,
      name: party.supplier_name,
      meta: party.supplier_type,
    };
  }
  if (type === 'employee') {
    return {
      id: party.employee_id,
      name: party.employee_name,
      meta: [party.department, party.designation, party.status].filter(Boolean).join(' - '),
    };
  }
  return {
    id: party.customer_id,
    name: party.customer_name,
    meta: [party.territory, party.customer_group].filter(Boolean).join(' - '),
  };
}

function selectParty(button) {
  partyId.value = button.dataset.id;
  partyName.value = button.dataset.name;
  partySearch.value = button.dataset.id;
  partyResults.innerHTML = '';
  clearReferenceSelection();
  configureReferenceSearch();
  preloadReferences();
}

function clearPartySelection() {
  partyId.value = '';
  partyName.value = '';
  partySearch.value = '';
  partyResults.innerHTML = '';
  preloadedParties = [];
  clearReferenceSelection();
}

function clearUnselectedParty() {
  if (partyId.value || !partySearch) {
    return;
  }
  partySearch.value = '';
  partyResults.innerHTML = '';
}

function partyTypeLabel(type) {
  if (type === 'customer') {
    return 'customer';
  }
  if (type === 'supplier') {
    return 'supplier';
  }
  return 'employee';
}

async function searchReferences() {
  if (!hasSelectedParty()) {
    referenceResults.innerHTML = '<p>Select a party first.</p>';
    return;
  }
  const q = referenceSearch.value.trim();
  if (!q) {
    showPreloadedReferences();
    return;
  }
  try {
    const rows = await fetchReferences(q);
    renderReferenceResults(rows);
  } catch {
    referenceResults.innerHTML = '<p>Could not load references.</p>';
  }
}

async function fetchReferences(q = '') {
  const params = new URLSearchParams({
    party_type: partyType.value,
    party_id: partyId.value,
    party_name: partyName.value,
    q,
  });
  const response = await fetch(`/api/journal-reference-options?${params.toString()}`);
  if (!response.ok) {
    throw new Error('Reference request failed.');
  }
  return response.json();
}

async function preloadReferences() {
  if (!hasSelectedParty()) {
    preloadedReferences = [];
    return;
  }
  referencesLoading = true;
  try {
    preloadedReferences = await fetchReferences();
  } catch {
    preloadedReferences = [];
  } finally {
    referencesLoading = false;
    if (document.activeElement === referenceSearch && !referenceSearch.value.trim()) {
      showPreloadedReferences();
    }
  }
}

function showPreloadedReferences() {
  if (!hasSelectedParty()) {
    referenceResults.innerHTML = '<p>Select a party first.</p>';
    return;
  }
  if (referencesLoading) {
    referenceResults.innerHTML = '<p>Loading references...</p>';
    return;
  }
  renderReferenceResults(preloadedReferences);
}

function renderReferenceResults(rows) {
  referenceResults.innerHTML = rows.map((row) => `
    <button type="button" data-reference="${escapeAttr(row.reference)}">
      <strong>${escapeHtml(row.reference)}</strong>
      <span>${escapeHtml(referenceMeta(row))}</span>
    </button>
  `).join('') || '<p>No transactions found for this party.</p>';

  referenceResults.querySelectorAll('[data-reference]').forEach((button) => {
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      selectReference(button);
    });
    button.addEventListener('click', () => {
      selectReference(button);
    });
  });
}

function referenceMeta(row) {
  return [
    row.type,
    row.posting_date,
    row.amount ? formatMoney(row.amount) : '',
    row.status,
  ].filter(Boolean).join(' - ');
}

function selectReference(button) {
  referenceSearch.value = button.dataset.reference;
  referenceResults.innerHTML = '';
}

function clearReferenceSelection() {
  if (!referenceSearch) {
    return;
  }
  referenceSearch.value = '';
  referenceResults.innerHTML = '';
  preloadedReferences = [];
}

function hasSelectedParty() {
  return Boolean(partyType && partyType.value && partyId && partyId.value);
}

function blankJournalRow() {
  const row = journalRowTemplate.cloneNode(true);
  clearJournalRow(row);
  return row;
}

function clearJournalRow(row) {
  row.querySelectorAll('input').forEach((input) => {
    input.value = '';
    input.placeholder = '';
  });
  const select = row.querySelector('select');
  if (select) {
    select.value = '';
  }
}

function hasEnteredAmounts() {
  return [...journalLinesBody.querySelectorAll('[name="debit"], [name="credit"]')]
    .some((input) => Number(input.value || 0) > 0);
}

function journalTotals() {
  return [...journalLinesBody.querySelectorAll('tr')].reduce((totals, row) => {
    totals.debit += Math.round(Number(row.querySelector('[name="debit"]').value || 0));
    totals.credit += Math.round(Number(row.querySelector('[name="credit"]').value || 0));
    return totals;
  }, { debit: 0, credit: 0 });
}

function updateJournalTotals() {
  const totals = journalTotals();
  totalDebit.textContent = formatMoney(totals.debit);
  totalCredit.textContent = formatMoney(totals.credit);
  if (totals.debit === 0 && totals.credit === 0) {
    balanceStatus.textContent = '';
  } else if (totals.debit === totals.credit) {
    balanceStatus.textContent = 'Balanced';
  } else {
    balanceStatus.textContent = `Difference: ${formatMoney(Math.abs(totals.debit - totals.credit))}`;
  }
}

function formatMoney(value) {
  return new Intl.NumberFormat('en-UG', {
    style: 'currency',
    currency: 'UGX',
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

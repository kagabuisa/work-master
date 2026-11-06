(() => {
  const form = document.querySelector('[data-employee-statement-filters]');
  const search = document.querySelector('[data-employee-statement-search]');
  const employeeId = document.querySelector('[data-employee-statement-id]');
  const results = document.querySelector('[data-employee-statement-results]');
  const status = document.querySelector('[data-employee-statement-status]');
  const source = document.querySelector('#employee-statement-options');
  const employees = source ? JSON.parse(source.textContent) : [];

  const closeResults = () => {
    if (!results) return;
    results.replaceChildren();
    search?.setAttribute('aria-expanded', 'false');
  };

  const clearStatus = () => {
    if (!status) return;
    status.textContent = '';
    status.hidden = true;
  };

  const chooseEmployee = (employee) => {
    employeeId.value = employee.id;
    search.value = employee.name;
    clearStatus();
    closeResults();
  };

  const showResults = () => {
    if (!results || !search) return;
    const query = search.value.trim().toLowerCase();
    const matches = employees.filter((employee) => (
      !query || [employee.name, employee.id, employee.company, employee.costCenter]
        .some((value) => String(value || '').toLowerCase().includes(query))
    )).slice(0, 25);
    results.replaceChildren();
    for (const employee of matches) {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'option');
      const name = document.createElement('strong');
      name.textContent = employee.name;
      const detail = document.createElement('span');
      detail.textContent = [employee.id, employee.company, employee.status, employee.costCenter].filter(Boolean).join(' · ');
      button.append(name, detail);
      button.addEventListener('mousedown', (event) => { event.preventDefault(); chooseEmployee(employee); });
      button.addEventListener('click', () => chooseEmployee(employee));
      results.appendChild(button);
    }
    if (!matches.length) {
      const empty = document.createElement('p');
      empty.textContent = 'No matching employees.';
      results.appendChild(empty);
    }
    search.setAttribute('aria-expanded', 'true');
  };

  if (search) {
    search.addEventListener('focus', showResults);
    search.addEventListener('click', showResults);
    search.addEventListener('input', () => {
      employeeId.value = '';
      clearStatus();
      showResults();
    });
    search.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeResults();
      } else if (event.key === 'ArrowDown') {
        const first = results?.querySelector('button');
        if (first) { event.preventDefault(); first.focus(); }
      }
    });
  }

  form?.addEventListener('submit', (event) => {
    if (employeeId?.value) return;
    event.preventDefault();
    status.textContent = 'Choose an employee from the results.';
    status.hidden = false;
    search?.focus();
    showResults();
  });

  document.querySelectorAll('[data-employee-statement-print]').forEach((button) => {
    button.addEventListener('click', () => {
      const statement = button.closest('[data-employee-statement]');
      if (statement) statement.classList.add('is-print-target');
      document.body.classList.add('printing-statement', 'printing-full-statement');
      window.print();
    });
  });
  window.addEventListener('afterprint', () => {
    document.body.classList.remove('printing-statement', 'printing-full-statement');
    document.querySelectorAll('[data-employee-statement].is-print-target')
      .forEach((statement) => statement.classList.remove('is-print-target'));
  });
})();

(() => {
  document.querySelectorAll('.debtor-date-filter input[type="date"]').forEach((input) => {
    const field = input.closest('.debtor-date-filter');
    const syncValueState = () => field.classList.toggle('has-value', Boolean(input.value));

    syncValueState();
    input.addEventListener('input', syncValueState);
    input.addEventListener('change', syncValueState);
  });

  const drawerLayer = document.querySelector('[data-statement-layer]');
  const drawer = drawerLayer && drawerLayer.querySelector('.statement-drawer');

  document.querySelectorAll('[data-statement-href]').forEach((row) => {
    const openStatement = () => {
      window.location.assign(row.dataset.statementHref);
    };

    row.addEventListener('click', (event) => {
      if (event.target.closest('a, button, input, select, textarea')) return;
      openStatement();
    });
    row.addEventListener('keydown', (event) => {
      if (event.target.closest('a, button, input, select, textarea')) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openStatement();
    });
  });

  const closeDrawer = (link) => {
    if (!drawerLayer) return;
    drawerLayer.classList.remove('is-open');
    window.setTimeout(() => window.location.assign(link.href), 180);
  };

  document.querySelectorAll('[data-close-statement]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      closeDrawer(link);
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !drawerLayer) return;
    const closeLink = drawerLayer.querySelector('[data-close-statement]');
    if (closeLink) closeDrawer(closeLink);
  });

  if (drawer) {
    window.requestAnimationFrame(() => {
      drawerLayer.classList.add('is-open');
      drawer.focus({ preventScroll: true });
    });
  }

  document.querySelectorAll('[data-print-statement]').forEach((button) => {
    button.addEventListener('click', () => {
      const statement = button.closest('[data-statement]');
      if (statement) statement.classList.add('is-print-target');
      document.body.classList.add('printing-statement');
      if (statement && statement.classList.contains('debtor-full-statement')) {
        document.body.classList.add('printing-full-statement');
      }
      window.print();
    });
  });
  window.addEventListener('afterprint', () => {
    document.body.classList.remove('printing-statement');
    document.body.classList.remove('printing-full-statement');
    document.querySelectorAll('.is-print-target').forEach((statement) => statement.classList.remove('is-print-target'));
  });

  document.querySelectorAll('[data-export-statement]').forEach((button) => {
    button.addEventListener('click', () => {
      const statement = button.closest('[data-statement]');
      const rows = statement ? statement.querySelectorAll('.statement-table tr') : [];
      if (!rows.length) return;

      const csv = Array.from(rows).map((row) => Array.from(row.querySelectorAll('th, td'))
        .map((cell) => `"${cell.textContent.trim().replace(/"/g, '""')}"`)
        .join(','))
        .join('\r\n');
      const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = statement.dataset.exportName || 'customer-statement.csv';
      link.click();
      URL.revokeObjectURL(url);
    });
  });
})();

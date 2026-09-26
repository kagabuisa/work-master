(function () {
  const DEFAULT_PAGE_SIZE = 25;
  const PAGE_SIZES = [10, 25, 50, 100];
  const states = new WeakMap();

  function directRows(table) {
    const body = table.tBodies && table.tBodies[0];
    return body ? [...body.rows] : [];
  }

  function dataRows(table) {
    return directRows(table).filter((row) => !row.classList.contains('empty-row') && !row.classList.contains('movement-detail-row'));
  }

  function shouldPaginate(table) {
    if (table.classList.contains('editable') || table.classList.contains('print-invoice-table')) {
      return false;
    }
    if (table.closest('.print-page') || table.dataset.pagination === 'off') {
      return false;
    }
    return dataRows(table).length > DEFAULT_PAGE_SIZE;
  }

  function clampPage(state) {
    const pageCount = Math.max(1, Math.ceil(state.rows.length / state.pageSize));
    state.page = Math.min(Math.max(1, state.page), pageCount);
    return pageCount;
  }

  function render(table) {
    const state = states.get(table);
    if (!state) {
      return;
    }
    state.rows = dataRows(table);
    const pageCount = clampPage(state);
    const start = (state.page - 1) * state.pageSize;
    const end = Math.min(start + state.pageSize, state.rows.length);
    const visible = new Set(state.rows.slice(start, end));

    directRows(table).forEach((row) => {
      if (row.classList.contains('movement-detail-row')) {
        row.hidden = true;
        return;
      }
      if (!state.rows.includes(row)) {
        row.hidden = false;
        return;
      }
      row.hidden = !visible.has(row);
    });

    state.info.textContent = `${state.rows.length ? start + 1 : 0}-${end} of ${state.rows.length}`;
    state.prev.disabled = state.page <= 1;
    state.next.disabled = state.page >= pageCount;
  }

  function makeControls(table) {
    const controls = document.createElement('div');
    controls.className = 'table-pagination';

    const label = document.createElement('label');
    label.textContent = 'Rows';

    const select = document.createElement('select');
    PAGE_SIZES.forEach((size) => {
      const option = document.createElement('option');
      option.value = String(size);
      option.textContent = String(size);
      if (size === DEFAULT_PAGE_SIZE) {
        option.selected = true;
      }
      select.appendChild(option);
    });
    label.appendChild(select);

    const info = document.createElement('span');
    info.className = 'table-pagination-info';

    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'button-light';
    prev.textContent = 'Prev';

    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'button-light';
    next.textContent = 'Next';

    controls.append(label, info, prev, next);
    table.insertAdjacentElement('afterend', controls);

    return { controls, info, next, prev, select };
  }

  function initTable(table) {
    if (states.has(table)) {
      const state = states.get(table);
      if (!shouldPaginate(table)) {
        state.controls.remove();
        directRows(table).forEach((row) => {
          row.hidden = row.classList.contains('movement-detail-row') ? row.hidden : false;
        });
        states.delete(table);
      } else {
        render(table);
      }
      return;
    }
    if (!shouldPaginate(table)) {
      return;
    }

    const controls = makeControls(table);
    const state = {
      ...controls,
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      rows: dataRows(table),
    };
    states.set(table, state);

    controls.select.addEventListener('change', () => {
      state.pageSize = Number(controls.select.value || DEFAULT_PAGE_SIZE);
      state.page = 1;
      render(table);
    });
    controls.prev.addEventListener('click', () => {
      state.page -= 1;
      render(table);
    });
    controls.next.addEventListener('click', () => {
      state.page += 1;
      render(table);
    });
    render(table);
  }

  function initTables(root = document) {
    root.querySelectorAll('table').forEach(initTable);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initTables());
  } else {
    initTables();
  }

  const observer = new MutationObserver((mutations) => {
    const roots = new Set();
    mutations.forEach((mutation) => {
      if (mutation.type !== 'childList') {
        return;
      }
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          roots.add(node);
        }
      });
      const table = mutation.target && mutation.target.closest ? mutation.target.closest('table') : null;
      if (table) {
        roots.add(table);
      }
    });
    roots.forEach((root) => {
      if (root.matches && root.matches('table')) {
        initTable(root);
      }
      if (root.querySelectorAll) {
        initTables(root);
      }
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
}());

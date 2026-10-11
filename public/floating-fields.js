(() => {
  const controlSelector = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="range"]):not([type="color"]):not([type="submit"]):not([type="reset"]):not([type="button"]):not([type="image"]), select:not([multiple]), textarea';
  let helpSequence = 0;
  const resizeObserver = new ResizeObserver((entries) => {
    entries.forEach(({ target: field }) => {
      const label = field.querySelector(':scope > .app-floating-label');
      if (!label) return;
      // Measure without the helper reservation so resizing does not toggle repeatedly.
      const available = field.clientWidth - (field.closest('.hr-money-field') ? 44 : 24);
      const needsHelp = label.scrollWidth > available;
      field.classList.toggle('app-outline-long', needsHelp);
      let help = field.querySelector(':scope > .app-outline-help');
      if (!needsHelp) {
        if (help) help.hidden = true;
        const popup = field.querySelector(':scope > .app-outline-help-text');
        if (popup) popup.hidden = true;
        if (help) help.setAttribute('aria-expanded', 'false');
        return;
      }
      if (help) { help.hidden = false; return; }
      help = document.createElement('button');
      help.type = 'button';
      help.className = 'app-outline-help';
      help.textContent = 'i';
      help.setAttribute('aria-label', `Show full field label: ${label.textContent.trim()}`);
      help.setAttribute('aria-expanded', 'false');
      const popup = document.createElement('span');
      popup.id = `outline-label-help-${++helpSequence}`;
      popup.className = 'app-outline-help-text';
      popup.textContent = label.textContent.trim();
      popup.hidden = true;
      help.setAttribute('aria-controls', popup.id);
      const close = () => { popup.hidden = true; help.setAttribute('aria-expanded', 'false'); };
      help.addEventListener('click', (event) => {
        event.preventDefault();
        popup.hidden = !popup.hidden;
        help.setAttribute('aria-expanded', String(!popup.hidden));
      });
      help.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
      help.addEventListener('blur', close);
      field.append(help, popup);
    });
  });

  function activate(field, control, label) {
    if (field.classList.contains('app-outline-field')) return;
    field.classList.add('app-floating-field', 'app-floating-choice', 'app-outline-field');
    label.classList.add('app-floating-label');
    if (control.matches('textarea')) field.classList.add('app-floating-textarea');
    resizeObserver.observe(field);
  }

  function enhanceLabel(field) {
    if (field.closest('table, .results, .table-pagination, [data-standard-labels]')) return;
    const controls = Array.from(field.children).filter((child) => child.matches(controlSelector) && !child.hidden && child.style.display !== 'none');
    if (controls.length !== 1) return;
    const textNodes = Array.from(field.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    const plainSpan = Array.from(field.children).find((child) => child.matches('span') && !child.children.length && !child.classList.contains('field-hint'));
    if (!textNodes.length && !plainSpan) return;
    const label = plainSpan || document.createElement('span');
    if (!plainSpan) {
      label.textContent = textNodes.map((node) => node.textContent.trim()).join(' ');
      field.prepend(label);
    }
    textNodes.forEach((node) => node.remove());
    activate(field, controls[0], label);
  }

  function enhanceSeparateLabel(label) {
    if (label.closest('table, .results, .table-pagination, [data-standard-labels]')) return;
    const control = document.getElementById(label.htmlFor);
    if (!control || control.parentElement !== label.parentElement || !control.matches(controlSelector)) return;
    activate(label.parentElement, control, label);
  }

  function enhance(root) {
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    const parentLabel = root.closest('label');
    if (parentLabel) enhanceLabel(parentLabel);
    root.querySelectorAll('label').forEach(enhanceLabel);
    if (root.matches('label[for]')) enhanceSeparateLabel(root);
    root.querySelectorAll('label[for]').forEach(enhanceSeparateLabel);
    // Some reports already provide a separate outline-label span.
    root.querySelectorAll('.general-ledger-floating-field').forEach((field) => {
      const control = field.querySelector(controlSelector);
      const label = field.querySelector('.floating-label');
      if (control && label) activate(field, control, label);
    });
  }

  enhance(document.body);
  new MutationObserver((changes) => {
    changes.forEach((change) => change.addedNodes.forEach(enhance));
  }).observe(document.body, { childList: true, subtree: true });
})();

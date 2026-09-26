(() => {
  const controlSelector = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), select, textarea';

  function activate(field, control, label) {
    field.classList.add('app-floating-field');
    label.classList.add('app-floating-label');
    if (control.matches('select, input[type="date"], input[type="datetime-local"], input[type="time"]')) {
      field.classList.add('app-floating-choice');
    }
    if (control.matches('textarea')) {
      field.classList.add('app-floating-textarea');
    }

    const sync = () => field.classList.toggle('app-floating-filled', Boolean(control.value));
    sync();
    control.addEventListener('input', sync);
    control.addEventListener('change', sync);
    control.addEventListener('blur', sync);
  }

  function enhanceLabel(field) {
    if (field.matches('.general-ledger-floating-field, .app-floating-field') || field.closest('table, .results, .table-pagination')) return;
    const controls = Array.from(field.children).filter((child) => child.matches(controlSelector));
    if (controls.length !== 1) return;

    const textNodes = Array.from(field.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    const plainSpan = Array.from(field.children).find((child) => child.matches('span') && !child.children.length && !child.classList.contains('field-hint'));
    if (!textNodes.length && !plainSpan) return;

    const label = plainSpan || document.createElement('span');
    if (!plainSpan) {
      label.textContent = textNodes.map((node) => node.textContent.trim()).join(' ');
      field.appendChild(label);
    }
    textNodes.forEach((node) => node.remove());
    activate(field, controls[0], label);
  }

  function enhanceSeparateLabel(label) {
    if (label.parentElement.classList.contains('app-floating-field')) return;
    const control = document.getElementById(label.htmlFor);
    if (!control || control.parentElement !== label.parentElement || !control.matches(controlSelector)) return;
    activate(label.parentElement, control, label);
  }

  function enhance(root) {
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    if (root.matches('label')) enhanceLabel(root);
    root.querySelectorAll('label').forEach(enhanceLabel);
    if (root.matches('.form-field > label.field-label[for]')) enhanceSeparateLabel(root);
    root.querySelectorAll('.form-field > label.field-label[for]').forEach(enhanceSeparateLabel);
  }

  enhance(document.body);
  new MutationObserver((changes) => {
    changes.forEach((change) => change.addedNodes.forEach(enhance));
  }).observe(document.body, { childList: true, subtree: true });
})();

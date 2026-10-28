(() => {
  document.querySelectorAll('[data-multi-select]').forEach(picker => {
    const boxes = [...picker.querySelectorAll('input[type="checkbox"]')];
    const search = picker.querySelector('[data-multi-select-search]');
    const count = picker.querySelector('[data-multi-select-count]');
    const submits = picker.closest('form')?.querySelectorAll('[data-multi-select-submit]') || [];
    const update = () => {
      const selected = boxes.filter(box => box.checked).length;
      count.textContent = `${selected} selected`;
      submits.forEach(submit => { submit.disabled = selected === 0; });
    };
    search.addEventListener('input', () => {
      const needle = search.value.trim().toLocaleLowerCase();
      boxes.forEach(box => { box.closest('label').hidden = !box.value.toLocaleLowerCase().includes(needle); });
      picker.querySelector('[data-multi-select-empty]').hidden = boxes.some(box => !box.closest('label').hidden);
    });
    picker.querySelector('[data-multi-select-all]').addEventListener('click', () => {
      boxes.filter(box => !box.closest('label').hidden).forEach(box => { box.checked = true; });
      update();
    });
    picker.querySelector('[data-multi-select-clear]').addEventListener('click', () => {
      boxes.forEach(box => { box.checked = false; });
      update();
    });
    boxes.forEach(box => box.addEventListener('change', update));
    window.addEventListener('pageshow', update);
    update();
  });
})();

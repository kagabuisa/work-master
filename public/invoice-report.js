'use strict';

const columnPicker = document.querySelector('.invoice-report-columns');
if (columnPicker) {
  const firstColumn = columnPicker.dataset.firstColumn || 'invoice_no';
  const checkboxes = [...columnPicker.querySelectorAll('input[name="columns"]')];
  const count = columnPicker.querySelector('summary span');
  const updateCount = () => {
    let selected = checkboxes.filter((checkbox) => checkbox.checked).length;
    if (!selected) {
      checkboxes.find((checkbox) => checkbox.value === firstColumn).checked = true;
      selected = 1;
    }
    count.textContent = `${selected} selected`;
  };
  columnPicker.addEventListener('change', updateCount);
  columnPicker.querySelector('[data-columns-all]').addEventListener('click', () => {
    checkboxes.forEach((checkbox) => { checkbox.checked = true; });
    updateCount();
  });
  columnPicker.querySelector('[data-columns-invoice]').addEventListener('click', () => {
    checkboxes.forEach((checkbox) => { checkbox.checked = checkbox.value === firstColumn; });
    updateCount();
  });
}

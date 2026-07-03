(function () {
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-movement-toggle]');
    if (!button) {
      return;
    }

    const detailRow = document.getElementById(button.dataset.movementToggle);
    if (!detailRow) {
      return;
    }

    const isOpen = !detailRow.hidden;
    detailRow.hidden = isOpen;
    button.setAttribute('aria-expanded', String(!isOpen));
  });
}());

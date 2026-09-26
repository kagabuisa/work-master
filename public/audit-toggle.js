(function () {
  const buttons = [...document.querySelectorAll('[data-tracking-toggle]')];
  if (!buttons.length) {
    return;
  }

  buttons.forEach((button) => {
    button.addEventListener('click', () => {
      const visible = document.body.classList.toggle('tracking-visible');
      buttons.forEach((item) => {
        item.textContent = visible ? 'Hide tracking' : 'Show tracking';
        item.setAttribute('aria-expanded', String(visible));
      });
    });
  });
}());

(() => {
  const search = document.querySelector('[data-files-search]');
  const rows = [...document.querySelectorAll('[data-file-row]')];
  const noResults = document.querySelector('[data-files-no-results]');
  if (search) {
    search.addEventListener('input', () => {
      const term = search.value.trim().toLocaleLowerCase();
      let visible = 0;
      rows.forEach((row) => {
        row.hidden = !row.dataset.fileName.includes(term);
        if (!row.hidden) visible += 1;
      });
      if (noResults) noResults.hidden = !term || visible > 0;
    });
  }

  const input = document.querySelector('[data-files-input]');
  const dropzone = document.querySelector('[data-files-dropzone]');
  const selection = document.querySelector('[data-files-selection]');
  if (!input || !dropzone || !selection) return;

  const showSelection = () => {
    const files = [...input.files];
    selection.textContent = files.length === 1 ? files[0].name
      : files.length ? `${files.length} files selected` : 'Up to 10 files · 20 MB each';
  };
  input.addEventListener('change', showSelection);
  ['dragenter', 'dragover'].forEach((eventName) => dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add('is-dragging');
  }));
  ['dragleave', 'drop'].forEach((eventName) => dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove('is-dragging');
  }));
  dropzone.addEventListener('drop', (event) => {
    if (event.dataTransfer?.files?.length) {
      input.files = event.dataTransfer.files;
      showSelection();
    }
  });
})();

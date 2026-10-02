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
  const form = document.querySelector('[data-files-upload]');
  const error = document.querySelector('[data-files-upload-error]');
  if (!input || !dropzone || !selection || !form || !error) return;

  const validate = () => {
    const files = [...input.files];
    let message = '';
    if (files.length > 10) message = 'Choose up to 10 files at a time.';
    else if (files.some((file) => file.size > 20 * 1024 * 1024)) message = 'Each file must be 20 MB or smaller.';
    error.textContent = message;
    error.hidden = !message;
    return !message;
  };

  const showSelection = () => {
    const files = [...input.files];
    selection.textContent = files.length === 1 ? files[0].name
      : files.length ? `${files.length} files selected` : 'Up to 10 files · 20 MB each';
  };
  input.addEventListener('change', () => { showSelection(); validate(); });
  form.addEventListener('submit', (event) => {
    if (!validate()) event.preventDefault();
    else {
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      button.textContent = 'Uploading…';
    }
  });
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
      validate();
    }
  });
})();

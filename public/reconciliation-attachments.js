(() => {
  const section = document.querySelector('[data-reconciliation-attachments]');
  if (!section?.dataset.voucherId) return;
  const endpoint = `/stock/reconciliations/${section.dataset.voucherId}/attachments`;
  const rows = section.querySelector('[data-scan-rows]');
  const table = section.querySelector('[data-scan-table]');
  const empty = section.querySelector('[data-scan-empty]');
  const status = section.querySelector('[data-scan-status]');
  const upload = section.querySelector('[data-scan-upload]');
  const canManage = section.dataset.canManage === 'true';

  function message(text, error = false) {
    status.textContent = text;
    status.hidden = !text;
    status.classList.toggle('warning-text', error);
  }
  async function jsonRequest(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { Accept: 'application/json' } });
    if (response.status === 413) throw new Error('Upload rejected because the request is too large. Choose up to three files, maximum 10 MB each. If smaller files are rejected, the server upload limit needs to be increased.');
    if (!response.headers.get('Content-Type')?.includes('application/json')) throw new Error('Could not access the scanned sheets. Reload the page and try again.');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not update scanned sheets.');
    return data;
  }
  async function refresh() {
    const files = await jsonRequest(endpoint);
    rows.replaceChildren();
    for (const file of files) {
      const row = document.createElement('tr');
      const fileCell = row.insertCell();
      const link = document.createElement('a');
      link.href = `${endpoint}/${encodeURIComponent(file.id)}`;
      link.textContent = file.file_name;
      fileCell.appendChild(link);
      row.insertCell().textContent = Number(file.byte_size) >= 1024 * 1024
        ? `${(Number(file.byte_size) / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(Number(file.byte_size) / 1024)} KB`;
      row.insertCell().textContent = file.uploaded_by || 'Unknown';
      row.insertCell().textContent = file.uploaded_time || '';
      const actions = row.insertCell();
      if (canManage) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'button-light';
        remove.textContent = 'Remove';
        remove.setAttribute('aria-label', `Remove ${file.file_name}`);
        remove.addEventListener('click', async () => {
          if (!window.confirm(`Remove scanned sheet ${file.file_name}?`)) return;
          remove.disabled = true;
          try {
            await jsonRequest(`${endpoint}/${encodeURIComponent(file.id)}/delete`, { method: 'POST' });
            await refresh();
            message('Scanned sheet removed.');
          } catch (error) { message(error.message, true); remove.disabled = false; }
        });
        actions.appendChild(remove);
      }
      rows.appendChild(row);
    }
    table.hidden = !files.length;
    empty.hidden = Boolean(files.length);
  }
  upload?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = upload.querySelector('[name="scans"]');
    const files = [...input.files];
    if (!files.length || files.length > 3 || files.some((file) => file.size > 10 * 1024 * 1024 || !/\.(pdf|jpe?g|png|csv|xlsx?)$/i.test(file.name))) {
      message('Choose up to three PDF, JPG, PNG, CSV, or Excel (.xls/.xlsx) sheets, each no larger than 10 MB.', true); return;
    }
    const button = upload.querySelector('[type="submit"]');
    button.disabled = true;
    message('Uploading scanned sheets…');
    try {
      const data = await jsonRequest(endpoint, { method: 'POST', body: new FormData(upload) });
      input.value = '';
      await refresh();
      message(`${data.uploaded} scanned sheet${data.uploaded === 1 ? '' : 's'} attached.`);
    } catch (error) { message(error.message, true); }
    finally { button.disabled = false; }
  });
  refresh().catch((error) => message(error.message, true));
})();

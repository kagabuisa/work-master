(function () {
  let dialog;
  let messageNode;
  let confirmButton;
  let pendingAction = null;
  let pendingCancel = null;

  function ensureDialog() {
    if (dialog) {
      return;
    }

    dialog = document.createElement('dialog');
    dialog.className = 'confirm-dialog';
    dialog.setAttribute('aria-labelledby', 'confirm-dialog-title');
    dialog.innerHTML = `
      <div class="confirm-dialog-header">
        <h2 id="confirm-dialog-title">Confirm</h2>
        <button type="button" class="button-light" data-confirm-cancel>Close</button>
      </div>
      <p id="confirm-dialog-message"></p>
      <div class="confirm-dialog-actions">
        <button type="button" class="button-light" data-confirm-cancel>Cancel</button>
        <button type="button" data-confirm-ok>Confirm</button>
      </div>
    `;
    document.body.appendChild(dialog);

    messageNode = dialog.querySelector('#confirm-dialog-message');
    confirmButton = dialog.querySelector('[data-confirm-ok]');

    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeDialog(false);
    });

    dialog.querySelectorAll('[data-confirm-cancel]').forEach((button) => {
      button.addEventListener('click', () => closeDialog(false));
    });

    confirmButton.addEventListener('click', () => {
      const action = pendingAction;
      closeDialog(true);
      if (action) {
        action();
      }
    });
  }

  function openDialog(message, action, cancelAction) {
    ensureDialog();
    pendingAction = action;
    pendingCancel = cancelAction;
    messageNode.textContent = message;
    dialog.showModal();
    confirmButton.focus();
  }

  function closeDialog(confirmed) {
    const cancelAction = pendingCancel;
    pendingAction = null;
    pendingCancel = null;
    if (dialog && dialog.open) {
      dialog.close();
    }
    if (!confirmed && cancelAction) {
      cancelAction();
    }
  }

  window.WorkMasterConfirm = (message) => new Promise((resolve) => {
    openDialog(message, () => resolve(true), () => resolve(false));
  });

  window.dispatchEvent(new CustomEvent('WorkMasterConfirmReady'));

  document.addEventListener('submit', (event) => {
    const form = event.target.closest('form[data-confirm]');
    if (!form || form.dataset.confirmPending === '1') {
      return;
    }

    event.preventDefault();
    openDialog(form.dataset.confirm, () => {
      form.dataset.confirmPending = '1';
      form.requestSubmit();
      delete form.dataset.confirmPending;
    });
  });

  document.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-confirm]');
    if (!button || button.dataset.confirmPending === '1') {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    openDialog(button.dataset.confirm, () => {
      button.dataset.confirmPending = '1';
      button.click();
      delete button.dataset.confirmPending;
    });
  });
})();

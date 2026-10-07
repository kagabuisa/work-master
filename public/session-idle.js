(() => {
  const idleMs = 5 * 60 * 1000;
  const heartbeatMs = 60 * 1000;
  const activityKey = 'wm_session_last_activity';
  let lastActivity = Date.now();
  let lastHeartbeat = lastActivity;
  let timer;
  let ending = false;

  function sharedActivity() {
    try {
      const saved = Number(localStorage.getItem(activityKey));
      return Number.isFinite(saved) && saved <= Date.now() ? saved : 0;
    } catch {
      return 0;
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(checkIdle, Math.max(0, Math.max(lastActivity, sharedActivity()) + idleMs - Date.now()));
  }

  async function endSession() {
    if (ending) return;
    ending = true;
    try {
      await fetch('/logout', { method: 'POST', credentials: 'same-origin', keepalive: true });
    } catch {
      // The server also rejects the session after five minutes of inactivity.
    }
    window.location.replace('/login?expired=1');
  }

  function checkIdle() {
    if (Date.now() - Math.max(lastActivity, sharedActivity()) >= idleMs) {
      endSession();
    } else {
      schedule();
    }
  }

  function recordActivity() {
    if (ending) return;
    const now = Date.now();
    if (now - Math.max(lastActivity, sharedActivity()) >= idleMs) {
      endSession();
      return;
    }
    if (now - lastActivity < 1000) return;
    lastActivity = now;
    try { localStorage.setItem(activityKey, String(now)); } catch { /* Storage may be disabled. */ }
    schedule();
    if (now - lastHeartbeat >= heartbeatMs) {
      lastHeartbeat = now;
      fetch('/session/activity', { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then((response) => { if (response.status === 401) endSession(); })
        .catch(() => { /* The next activity can retry. */ });
    }
  }

  try { localStorage.setItem(activityKey, String(lastActivity)); } catch { /* Storage may be disabled. */ }
  for (const event of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'input']) {
    document.addEventListener(event, recordActivity, { passive: true });
  }
  window.addEventListener('storage', (event) => { if (event.key === activityKey) schedule(); });
  window.addEventListener('focus', checkIdle);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkIdle(); });
  schedule();
})();

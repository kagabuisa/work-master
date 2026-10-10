(() => {
  const clock = document.querySelector('[data-home-clock]');
  if (!clock) return;
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Kampala', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  function updateClock() {
    const now = new Date();
    const parts = Object.fromEntries(formatter.formatToParts(now).map(({ type, value }) => [type, value]));
    const { year, month, day, hour, minute } = parts;
    const dates = {
      'YYYY-MM-DD': `${year}-${month}-${day}`,
      'DD/MM/YYYY': `${day}/${month}/${year}`,
      'MM/DD/YYYY': `${month}/${day}/${year}`,
      'DD-MM-YYYY': `${day}-${month}-${year}`,
    };
    const time = clock.dataset.timeFormat === '12h'
      ? `${Number(hour) % 12 || 12}:${minute} ${Number(hour) < 12 ? 'AM' : 'PM'}`
      : `${hour}:${minute}`;
    clock.textContent = `${dates[clock.dataset.dateFormat] || dates['YYYY-MM-DD']} ${time}`;
    clock.dateTime = now.toISOString();
  }
  updateClock();
  setInterval(updateClock, 1000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) updateClock();
  });
})();

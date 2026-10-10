'use strict';

const ejs = require('ejs');
const { DEFAULT_DATE_TIME_SETTINGS, formatDate, formatTime, formatDateTime, formatTimestamp } =
  require('../../src/date-time-format');

// Direct template tests bypass the middleware that supplies display locals and
// the authenticated user's username. Keep permissions and view inputs explicit.
function renderView(file, locals = {}) {
  const settings = locals.dateTimeSettings || { ...DEFAULT_DATE_TIME_SETTINGS };
  return ejs.renderFile(file, {
    dateTimeSettings: settings,
    formatDate: (value) => formatDate(value, settings),
    formatTime: (value) => formatTime(value, settings),
    formatDateTime: (date, time) => formatDateTime(date, time, settings),
    formatTimestamp: (value, timeZone) => formatTimestamp(value, settings, timeZone),
    ...locals,
    currentUser: locals.currentUser ? { username: 'test-user', ...locals.currentUser } : null,
  });
}

module.exports = { renderView };

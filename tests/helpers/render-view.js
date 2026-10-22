'use strict';

const ejs = require('ejs');
const { DEFAULT_DATE_TIME_SETTINGS, formatDate, formatTime, formatDateTime, formatTimestamp } =
  require('../../src/date-time-format');

// Direct template tests bypass the middleware that supplies display locals and
// the authenticated user's username. Keep permissions and view inputs explicit.
function renderView(file, locals = {}) {
  const settings = locals.dateTimeSettings || { ...DEFAULT_DATE_TIME_SETTINGS };
  return ejs.renderFile(file, {
    rateMoney: require('../../src/web/format').rateMoney,
    countEffects: require('../../public/count-effects'),
    stockEntryChoices: require('../../src/constants').STOCK_ENTRY_CHOICES,
    stockEntryTypeLabels: require('../../src/constants').STOCK_ENTRY_TYPE_LABELS,
    stockTransferTypes: require('../../src/constants').STOCK_TRANSFER_TYPES,
    deliveryStatuses: require('../../src/stock-entry-workflow').DELIVERY_STATUSES,
    dateTimeSettings: settings,
    formatDate: (value) => formatDate(value, settings),
    formatTime: (value) => formatTime(value, settings),
    formatDateTime: (date, time) => formatDateTime(date, time, settings),
    formatTimestamp: (value, timeZone) => formatTimestamp(value, settings, timeZone),
    ...locals,
    costCenterName: locals.costCenterName || (id => id || ''),
    currentUser: locals.currentUser ? { username: 'test-user', ...locals.currentUser } : null,
  });
}

module.exports = { renderView };

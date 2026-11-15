// Constructing an Intl.DateTimeFormat is expensive relative to formatting with it, and these run
// on every request render and every voucher validation. Build them once.
const POSTING_TIME_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Kampala', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const POSTING_DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Kampala', year: 'numeric', month: '2-digit', day: '2-digit',
});

function currentPostingTime() {
  return POSTING_TIME_FORMAT.format(new Date());
}

function currentPostingDate() {
  const parts = POSTING_DATE_FORMAT.formatToParts(new Date());
  let year = '', month = '', day = '';
  for (const part of parts) {
    if (part.type === 'year') year = part.value;
    else if (part.type === 'month') month = part.value;
    else if (part.type === 'day') day = part.value;
  }
  return `${year}-${month}-${day}`;
}

function assertPostingDate(value) {
  const { dateOnly, isValidIsoDate } = require('./lib/dates');
  const day = dateOnly(value);
  const valid = isValidIsoDate(day);
  const future = valid && day > currentPostingDate();
  if (!valid || future) {
    const error = new Error(!valid ? 'Choose a valid posting date.' : 'Posting date cannot be in the future (Africa/Kampala).');
    error.status = 400;
    error.code = future ? 'future_posting_date' : 'invalid_posting_date';
    throw error;
  }
  return day;
}

function normalizePostingTime(value, { required = false } = {}) {
  const time = String(value ?? '').trim();
  if (!time && !required) return currentPostingTime();
  if (/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time)) return time.slice(0, 5);
  const error = new Error('Choose a valid posting time.');
  error.status = 400;
  throw error;
}

function storedPostingTime(value) {
  return value ? String(value).slice(0, 5) : '00:00';
}

module.exports = { assertPostingDate, currentPostingDate, currentPostingTime, normalizePostingTime, storedPostingTime };

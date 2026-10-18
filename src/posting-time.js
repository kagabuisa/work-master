function currentPostingTime() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Kampala', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date());
}

function currentPostingDate() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Kampala', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
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

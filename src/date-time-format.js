const DEFAULT_DATE_TIME_SETTINGS = Object.freeze({ date_format: 'YYYY-MM-DD', time_format: '24h' });
const DATE_FORMATS = ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD-MM-YYYY'];
const TIME_FORMATS = ['24h', '12h'];

function normalizeDateTimeSettings(value = {}) {
  return {
    date_format: DATE_FORMATS.includes(value.date_format) ? value.date_format : DEFAULT_DATE_TIME_SETTINGS.date_format,
    time_format: TIME_FORMATS.includes(value.time_format) ? value.time_format : DEFAULT_DATE_TIME_SETTINGS.time_format,
  };
}

function validateDateTimeSettings(value = {}) {
  if (!DATE_FORMATS.includes(value.date_format) || !TIME_FORMATS.includes(value.time_format)) {
    const error = new Error('Choose a valid date and time format.');
    error.status = 400;
    throw error;
  }
  return normalizeDateTimeSettings(value);
}

function formatDate(value, settings = DEFAULT_DATE_TIME_SETTINGS) {
  if (value == null || value === '') return '';
  const input = value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : String(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(input);
  if (!match) return input;
  const [, year, month, day] = match;
  switch (settings.date_format) {
    case 'DD/MM/YYYY': return `${day}/${month}/${year}`;
    case 'MM/DD/YYYY': return `${month}/${day}/${year}`;
    case 'DD-MM-YYYY': return `${day}-${month}-${year}`;
    default: return `${year}-${month}-${day}`;
  }
}

function formatTime(value, settings = DEFAULT_DATE_TIME_SETTINGS) {
  if (value == null || value === '') return '';
  const input = String(value);
  const match = /^(\d{1,2}):(\d{2})/.exec(input);
  if (!match) return input;
  const hour = Number(match[1]);
  if (hour > 23 || Number(match[2]) > 59) return input;
  if (settings.time_format === '12h') return `${hour % 12 || 12}:${match[2]} ${hour < 12 ? 'AM' : 'PM'}`;
  return `${String(hour).padStart(2, '0')}:${match[2]}`;
}

function formatDateTime(date, time, settings = DEFAULT_DATE_TIME_SETTINGS) {
  return [formatDate(date, settings), formatTime(time, settings)].filter(Boolean).join(' ');
}

function formatTimestamp(value, settings = DEFAULT_DATE_TIME_SETTINGS, timeZone = 'Africa/Kampala') {
  if (!value) return '';
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant).map(({ type, value: part }) => [type, part]));
  return formatDateTime(`${parts.year}-${parts.month}-${parts.day}`, `${parts.hour}:${parts.minute}`, settings);
}

module.exports = { DEFAULT_DATE_TIME_SETTINGS, DATE_FORMATS, TIME_FORMATS,
  normalizeDateTimeSettings, validateDateTimeSettings, formatDate, formatTime, formatDateTime, formatTimestamp };

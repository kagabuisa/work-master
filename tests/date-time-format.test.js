const test = require('node:test');
const assert = require('node:assert/strict');
const { formatDate, formatTime, formatDateTime, formatTimestamp,
  normalizeDateTimeSettings, validateDateTimeSettings } = require('../src/date-time-format');

test('date and time formats cover voucher display choices', () => {
  const date = '2026-09-29';
  const time = '19:40:35';
  assert.equal(formatDateTime(date, time), '2026-09-29 19:40');
  assert.equal(formatDateTime(date, time, { date_format: 'DD/MM/YYYY', time_format: '12h' }), '29/09/2026 7:40 PM');
  assert.equal(formatDate(date, { date_format: 'MM/DD/YYYY' }), '09/29/2026');
  assert.equal(formatDate(date, { date_format: 'DD-MM-YYYY' }), '29-09-2026');
  assert.equal(formatTime('00:05', { time_format: '12h' }), '12:05 AM');
  assert.equal(formatTime('12:05', { time_format: '12h' }), '12:05 PM');
});

test('timestamp format uses the selected display format and Kampala time', () => {
  assert.equal(formatTimestamp('2026-09-29T16:40:00Z', { date_format: 'DD/MM/YYYY', time_format: '12h' }), '29/09/2026 7:40 PM');
  assert.equal(formatTimestamp('2026-09-29T16:40:00Z', { date_format: 'DD/MM/YYYY', time_format: '12h' }, 'UTC'), '29/09/2026 4:40 PM');
});

test('saved format options are validated, older settings use defaults', () => {
  assert.deepEqual(normalizeDateTimeSettings({ date_format: 'invalid' }), { date_format: 'YYYY-MM-DD', time_format: '24h' });
  assert.throws(() => validateDateTimeSettings({ date_format: 'invalid', time_format: '24h' }), { status: 400 });
});

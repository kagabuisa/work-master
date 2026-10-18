const test = require('node:test');
const assert = require('node:assert/strict');
const { formatDate, formatTime, formatDateTime, formatTimestamp,
  normalizeDateTimeSettings, validateDateTimeSettings } = require('../src/date-time-format');

test('voucher posting fields collapse without losing submitted values or invoice selectors', async () => {
  const { renderView } = require('./helpers/render-view');
  const path = require('node:path');
  const file = path.join(__dirname, '../views/voucher-posting-fields.ejs');
  const html = await renderView(file, { postingFields: { date: '2026-10-14', time: '15:10',
    dateName: 'invoice_date', dateId: 'invoice-date', timeId: 'invoice-posting-time' } });
  assert.doesNotMatch(html.match(/<details[^>]*>/)[0], /\bopen\b/);
  assert.match(html, /Edit date \/ time/);
  assert.match(html, /id="invoice-date"[^>]*name="invoice_date" value="2026-10-14"/);
  assert.match(html, /id="invoice-posting-time"[^>]*name="posting_time" value="15:10"/);
  const locked = await renderView(file, { postingFields: { date: '2025-01-02', time: '09:15', readOnly: true } });
  assert.match(locked, /View date \/ time/);
  assert.match(locked, /value="2025-01-02" required readonly/);
  assert.match(locked, /value="09:15" required readonly/);
  const invalid = await renderView(file, { postingFields: { date: '', time: '' } });
  assert.match(invalid.match(/<details[^>]*>/)[0], /\bopen\b/);
  const payment = await renderView(file, { postingFields: { date: '2026-10-14', dateName: 'payment_date', label: 'Payment Date' } });
  assert.match(payment, /Edit payment date/);
  assert.match(payment, /name="payment_date" value="2026-10-14"/);
  assert.doesNotMatch(payment, /type="time"/);
});

test('validation opens a collapsed voucher posting field', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  let handler;
  const disclosure = { open: false };
  vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, '../public/voucher-posting-fields.js'), 'utf8'), {
    document: { addEventListener: (event, callback, capture) => {
      if (event === 'invalid') { assert.equal(capture, true); handler = callback; }
    } },
  });
  handler({ target: { closest: () => disclosure } });
  assert.equal(disclosure.open, true);
  assert.doesNotThrow(() => handler({ target: { closest: () => null } }));
});

test('floating posting editor dismisses outside clicks and Escape while retaining values', () => {
  const handlers = {};
  let focused = false;
  const input = { value: '14:35' };
  const disclosure = { open: true, contains: (target) => target === input,
    querySelector: () => ({ focus: () => { focused = true; } }) };
  require('node:vm').runInNewContext(require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../public/voucher-posting-fields.js'), 'utf8'), {
    document: { activeElement: input, addEventListener: (event, handler) => { handlers[event] = handler; },
      querySelectorAll: () => disclosure.open ? [disclosure] : [] },
  });
  handlers.click({ composedPath: () => [input, disclosure] });
  assert.equal(disclosure.open, true);
  handlers.click({ composedPath: () => [{}] });
  assert.equal(disclosure.open, false);
  assert.equal(input.value, '14:35');
  disclosure.open = true;
  handlers.keydown({ key: 'Enter' });
  assert.equal(disclosure.open, true);
  handlers.keydown({ key: 'Escape' });
  assert.equal(disclosure.open, false);
  assert.equal(focused, true);
  assert.equal(input.value, '14:35');
});

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

'use strict';
// The stock availability scan is skipped only when a posting is at/after the pair's latest
// movement. That is safe because it proves there are no later rows, which makes both quantities
// the scan computes equal to the locked balance. These tests pin the three cases that matter:
// skip when provably unnecessary, scan when backdated, and scan when the pair predates the
// column (NULL), where the shortcut cannot prove anything.
const test = require('node:test');
const assert = require('node:assert');
const { applyPostgresStockMovement } = require('../src/domain/posting');

function stubClient({ balance, availability }) {
  const calls = [];
  const client = {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      if (/INSERT INTO app_stock_balances/.test(text)) return { rows: [balance] };
      if (/WITH history AS/.test(text)) return { rows: [availability || { quantity: '0', minimum_future_quantity: null }] };
      if (/UPDATE app_stock_balances/.test(text)) return { rows: [] };
      if (/INSERT INTO app_stock_ledger/.test(text)) return { rows: [{ id: 42 }] };
      throw new Error('Unexpected query: ' + String(text).trim().slice(0, 90));
    },
  };
  return client;
}

const movement = (overrides = {}) => ({
  posting_date: '2026-11-15',
  posting_time: '23:59',
  item_code: 'EB-I-0001',
  item_name: 'Benchmark Item 0001',
  warehouse: 'EB Warehouse 0001',
  voucher_type: 'stock_transfer',
  voucher_id: 1,
  voucher_no: 'STK-000001',
  qty_change: -5,
  ...overrides,
});

const scanned = (client) => client.calls.some((c) => /WITH history AS/.test(c.text));

test('a posting at/after the latest movement skips the history scan', async () => {
  const client = stubClient({
    balance: { quantity: 100, stock_value: 900000, valuation_rate: 9000,
      last_movement_at: '2026-11-15 10:00:00', posting_covers_history: true },
  });
  const result = await applyPostgresStockMovement(client, movement());
  assert.equal(scanned(client), false, 'scan must be skipped when the posting covers the history');
  assert.equal(result.quantity, 95);
  assert.equal(result.previous_quantity, 100);
});

test('a skipped scan still rejects an over-draw from the locked balance', async () => {
  const client = stubClient({
    balance: { quantity: 3, stock_value: 27000, valuation_rate: 9000,
      last_movement_at: '2026-11-15 10:00:00', posting_covers_history: true },
  });
  await assert.rejects(() => applyPostgresStockMovement(client, movement()), (error) => {
    assert.equal(error.code, 'INSUFFICIENT_STOCK');
    assert.match(error.message, /Insufficient stock/i);
    return true;
  });
  assert.equal(scanned(client), false);
});

test('a backdated posting runs the history scan', async () => {
  const client = stubClient({
    balance: { quantity: 100, stock_value: 900000, valuation_rate: 9000,
      last_movement_at: '2026-11-20 10:00:00', posting_covers_history: false },
    availability: { quantity: '100', minimum_future_quantity: '98' },
  });
  await applyPostgresStockMovement(client, movement({ posting_date: '2026-11-15' }));
  assert.equal(scanned(client), true, 'a backdated posting must consult later movements');
});

test('a backdated posting is rejected when later movements would go negative', async () => {
  const client = stubClient({
    balance: { quantity: 100, stock_value: 900000, valuation_rate: 9000,
      last_movement_at: '2026-11-20 10:00:00', posting_covers_history: false },
    // The pair closes at 3 later; taking 5 now would drive it to -2 at that point.
    availability: { quantity: '100', minimum_future_quantity: '3' },
  });
  await assert.rejects(
    () => applyPostgresStockMovement(client, movement({ posting_date: '2026-11-15', qty_change: -5 })),
    (error) => {
      assert.equal(error.code, 'INSUFFICIENT_STOCK');
      return true;
    },
  );
  assert.equal(scanned(client), true);
});

test('a pair with no recorded latest movement runs the scan (column predates it)', async () => {
  const client = stubClient({
    balance: { quantity: 100, stock_value: 900000, valuation_rate: 9000,
      last_movement_at: null, posting_covers_history: false },
    availability: { quantity: '100', minimum_future_quantity: null },
  });
  await applyPostgresStockMovement(client, movement());
  assert.equal(scanned(client), true, 'NULL last_movement_at cannot prove the scan is unnecessary');
});

test('the balance update records the latest movement for the pair', async () => {
  const client = stubClient({
    balance: { quantity: 100, stock_value: 900000, valuation_rate: 9000,
      last_movement_at: '2026-11-15 10:00:00', posting_covers_history: true },
  });
  await applyPostgresStockMovement(client, movement());
  const update = client.calls.find((c) => /UPDATE app_stock_balances/.test(c.text));
  assert.ok(update, 'balance update must run');
  assert.match(update.text, /last_movement_at\s*=\s*GREATEST/, 'update must advance last_movement_at');
  assert.ok(update.params.includes('2026-11-15'), 'posting date is bound into the update');
  assert.ok(update.params.includes('23:59'), 'posting time is bound into the update');
});

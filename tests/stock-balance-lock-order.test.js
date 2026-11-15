'use strict';
// Two transfers in opposite directions on the same item deadlocked, because each leg locked its
// own warehouse's balance row in voucher order (A->B locks A then B; B->A locks B then A). The
// fix takes every balance row the voucher touches up front, in one canonical order. These tests
// pin that ordering and that it happens before any movement is applied.
const test = require('node:test');
const assert = require('node:assert');
const { postStockEntryMovements } = require('../src/domain/posting');

function stubClient(balanceFor, { voucherId = 7, sourceWarehouse = 'EB Warehouse 0002', itemCode = 'EB-I-0002' } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      // The incoming leg of a transfer validates the outgoing ledger row it takes its value from.
      if (/FROM app_stock_ledger WHERE id=\$1 FOR SHARE/.test(text)) {
        return { rows: [{ id: 1, item_code: itemCode, warehouse: sourceWarehouse,
          voucher_type: 'stock_transfer', voucher_id: voucherId, qty_change: -1,
          is_reversal: false, stock_value_change: 9000 }] };
      }
      // Order matters: the movement's own UPSERT must be matched before the pre-lock INSERT.
      if (/DO UPDATE SET item_name = EXCLUDED.item_name/.test(text)) {
        const [itemCode, warehouse] = params;
        return { rows: [balanceFor(itemCode, warehouse)] };
      }
      if (/DO NOTHING/.test(text)) return { rows: [] };
      if (/FOR UPDATE/.test(text)) return { rows: [] };
      if (/UPDATE app_stock_balances/.test(text)) return { rows: [] };
      if (/INSERT INTO app_stock_ledger/.test(text)) return { rows: [{ id: 1 }] };
      return { rows: [] };
    },
  };
}

const balance = () => ({ quantity: 100, stock_value: 900000, valuation_rate: 9000,
  last_movement_at: '2026-11-15 10:00:00', posting_covers_history: true });

test('a transfer locks source and target balances in canonical order before moving stock', async () => {
  const client = stubClient(balance, { voucherId: 7, sourceWarehouse: 'EB Warehouse 0002' });
  await postStockEntryMovements(client, {
    id: 7, entryNo: 'STK-000007', entryType: 'transfer',
    postingDate: '2026-11-15', postingTime: '23:59',
    items: [
      { item_code: 'EB-I-0002', item_name: 'Item 2', warehouse: 'EB Warehouse 0002', target_warehouse: 'EB Warehouse 0001', quantity: 1 },
    ],
  });

  const insert = client.calls.findIndex((c) => /INSERT INTO app_stock_balances \(item_code, warehouse, item_name\) VALUES/.test(c.text));
  const lock = client.calls.findIndex((c) => /FOR UPDATE/.test(c.text));
  const firstMovement = client.calls.findIndex((c) => /DO UPDATE SET item_name = EXCLUDED.item_name/.test(c.text));

  assert.ok(insert >= 0, 'balances are inserted before locking');
  assert.ok(lock > insert, 'rows are locked after being created');
  assert.ok(firstMovement > lock, 'locking happens before any movement is applied');

  // Canonical order is by (item_code, warehouse), regardless of the voucher's line order.
  const lockCall = client.calls[lock];
  assert.match(lockCall.text, /ORDER BY item_code, warehouse/);
  assert.deepEqual(lockCall.params[0], ['EB-I-0002', 'EB-I-0002']);
  assert.deepEqual(lockCall.params[1], ['EB Warehouse 0001', 'EB Warehouse 0002']);
});

test('the pre-lock covers every warehouse the voucher touches, deduplicated', async () => {
  const client = stubClient(balance, { voucherId: 8, sourceWarehouse: 'WB', itemCode: 'EB-I-0001' });
  await postStockEntryMovements(client, {
    id: 8, entryNo: 'STK-000008', entryType: 'transfer',
    postingDate: '2026-11-15', postingTime: '23:59',
    items: [
      { item_code: 'EB-I-0001', item_name: 'Item 1', warehouse: 'WB', target_warehouse: 'WA', quantity: 1 },
      { item_code: 'EB-I-0001', item_name: 'Item 1', warehouse: 'WB', target_warehouse: 'WA', quantity: 1 },
    ],
  });
  const lock = client.calls.find((c) => /FOR UPDATE/.test(c.text));
  assert.deepEqual(lock.params[0], ['EB-I-0001', 'EB-I-0001'], 'duplicate pairs collapse');
  assert.deepEqual(lock.params[1], ['WA', 'WB'], 'warehouses are ordered');
});

test('a non-transfer movement locks only its own warehouse', async () => {
  const client = stubClient(balance);
  await postStockEntryMovements(client, {
    id: 9, entryNo: 'STK-000009', entryType: 'receipt',
    postingDate: '2026-11-15', postingTime: '23:59',
    items: [{ item_code: 'EB-I-0003', item_name: 'Item 3', warehouse: 'EB Warehouse 0005', quantity: 5 }],
  });
  const lock = client.calls.find((c) => /FOR UPDATE/.test(c.text));
  assert.deepEqual(lock.params[0], ['EB-I-0003']);
  assert.deepEqual(lock.params[1], ['EB Warehouse 0005']);
});

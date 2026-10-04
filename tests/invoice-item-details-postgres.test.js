'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const { FIXED, seedGoldenData } = require('./helpers/golden-seed');

test('sales invoice rows snapshot master category, source and cost without trusting the form', {
  skip: process.env.ITEM_DETAILS_TEST_POSTGRES !== '1',
}, async () => {
  try {
    await seedGoldenData();
    await store.getPostgresPool().query(`INSERT INTO app_master_items
      (item_code, item_name, category, source, unit_cost) VALUES ($1, $2, 'Hardware', 'Import', 42)`, [FIXED.itemCode, FIXED.itemName]);
    const payload = { invoice_date: FIXED.date, due_date: FIXED.date,
      customer_id: FIXED.customerId, customer_name: FIXED.customerName,
      items: [{ item_code: FIXED.itemCode, item_name: FIXED.itemName,
        item_category: 'Forged', source: 'Local', cost: 999,
        warehouse: FIXED.warehouse, quantity: 1, unit_price: 180 }] };
    const id = await store.createInvoice(payload);
    let item = (await store.findInvoice(id)).items[0];
    assert.deepEqual([item.item_category, item.source, item.cost], ['Hardware', 'Import', 42]);

    await store.getPostgresPool().query(`UPDATE app_master_items SET category = 'Tools',
      source = 'Local', unit_cost = 36 WHERE item_code = $1`, [FIXED.itemCode]);
    await store.updateInvoice(id, { ...payload, items: [{ ...payload.items[0], id: item.id }] });
    item = (await store.findInvoice(id)).items[0];
    assert.deepEqual([item.item_category, item.source, item.cost], ['Tools', 'Local', 36]);
  } finally {
    await store.closeStore();
  }
});

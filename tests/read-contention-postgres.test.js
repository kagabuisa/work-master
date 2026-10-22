'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const { seedGoldenData, FIXED } = require('./helpers/golden-seed');
const { voucherWarehousesAllowed, invoiceAllowed } = require('../src/access');
const { runWithAuditUser } = require('../src/audit');

test('bounded invoice reads preserve permissions and a consistent financial snapshot', {
  skip: process.env.GL_EXPORT_TEST_POSTGRES !== '1',
}, async t => {
  try {
    const { invoiceId, openingId, purchaseId, adjustmentId } = await runWithAuditUser(
      {id:'READ-A', username:'Read A'}, () => seedGoldenData());
    const pool = store.getPostgresPool();
    assert.match((await pool.query('SELECT current_database() name')).rows[0].name, /_hr_test$/);
    await pool.query(`INSERT INTO app_master_customers(customer_id, customer_name, customer_group)
      VALUES ($1, 'Read customer', ' Retail ')`, [FIXED.customerId]);
    await t.test('stock ownership retains creator, assigned employee and reversal membership without resetting balances', async () => {
      const otherId = await runWithAuditUser({id:'READ-B', username:'Read B'}, () => store.createStockEntry({
        entry_type:'opening', posting_date:FIXED.date,
        items:[{item_code:FIXED.itemCode, item_name:FIXED.itemName, warehouse:FIXED.warehouse, quantity:1, valuation_rate:50}],
      }));
      await pool.query('UPDATE app_invoices SET invoicer_id = $1 WHERE id = $2', ['READ-EA', invoiceId]);
      const reference = (await pool.query(`SELECT id, voucher_no, voucher_type, voucher_id, reversal_of_voucher_id,
        SUM(qty_change) OVER (PARTITION BY item_code, warehouse ORDER BY posting_date, movement_at, id)::float balance
        FROM app_stock_ledger ORDER BY posting_date, movement_at, id`)).rows;
      assert.ok(reference.length >= 5);
      for (const access of [{ownerId:'READ-A'}, {ownerId:'READ-B', ownerEmployeeId:'READ-EA'},
        {ownerId:'READ-B'}, {ownerId:'missing'}]) {
        const permitted = reference.filter(row => row.voucher_type.startsWith('stock_')
          ? ([openingId, purchaseId, adjustmentId].map(Number).includes(Number(row.voucher_id ?? row.reversal_of_voucher_id))
            ? access.ownerId === 'READ-A' : access.ownerId === 'READ-B')
          : row.voucher_type === 'invoice' && (access.ownerId === 'READ-A' || access.ownerEmployeeId === 'READ-EA'));
        const report = await store.stockLedgerReport({...access, page_size:200});
        assert.equal(report.pagination.total, permitted.length);
        assert.deepEqual(report.rows.map(row => ({voucher_no:row.voucher_no, balance:row.qty_after_transaction})),
          permitted.map(row => ({voucher_no:row.voucher_no, balance:row.balance})));
      }
      assert.ok(reference.some(row => Number(row.voucher_id) === Number(otherId)));
    });
    await t.test('warehouse checks retain grants, denials, empty items and missing-record rules', async () => {
      const selected = values => ({role:'standard', scopes:{warehouses:{mode:'selected', values}}});
      const user = selected([FIXED.warehouse]);
      assert.equal(await voucherWarehousesAllowed(user, 'sales', invoiceId), true);
      assert.equal(await voucherWarehousesAllowed(selected([]), 'sales', invoiceId), false);
      assert.equal(await voucherWarehousesAllowed({...user, permission_denials:[`warehouse.view:${FIXED.warehouse}`]}, 'sales', invoiceId), false);
      assert.equal(await voucherWarehousesAllowed({...selected([]), permission_grants:[`warehouse.view:${FIXED.warehouse}`]}, 'sales', invoiceId), true);
      const empty = (await pool.query(`INSERT INTO app_invoices(invoice_no, invoice_date, customer_name)
        VALUES ('READ-EMPTY', '2026-01-15', 'Empty') RETURNING id`)).rows[0].id;
      assert.equal(await voucherWarehousesAllowed(selected([]), 'sales', empty), true);
      assert.equal(await voucherWarehousesAllowed(user, 'sales', 999999), false);
      for (const id of ['invalid', 0, -1, Number.MAX_SAFE_INTEGER + 1]) {
        assert.equal(await voucherWarehousesAllowed(user, 'sales', id), false);
      }
      await pool.query('UPDATE app_invoice_items SET warehouse = NULL WHERE invoice_pk = $1', [invoiceId]);
      assert.equal(await voucherWarehousesAllowed(selected([]), 'sales', invoiceId), true);
      await pool.query('UPDATE app_invoice_items SET warehouse = $2 WHERE invoice_pk = $1', [invoiceId, FIXED.warehouse]);
    });
    await t.test('customer checks retain category normalization and fail closed for missing records', async () => {
      const selected = values => ({role:'standard', scopes:{customers:{mode:'selected', values}}});
      assert.equal(await invoiceAllowed(selected(['RETAIL']), invoiceId), true);
      assert.equal(await invoiceAllowed(selected(['Wholesale']), invoiceId), false);
      assert.equal(await invoiceAllowed(selected([]), invoiceId), false);
      assert.equal(await invoiceAllowed(selected(['Retail']), 999999), false);
      assert.equal(await invoiceAllowed(selected(['Retail']), 'invalid'), false);
      await pool.query('UPDATE app_invoices SET customer_id = $2 WHERE id = $1', [invoiceId, 'MISSING-MASTER']);
      assert.equal(await invoiceAllowed(selected(['Retail']), invoiceId), false);
      await pool.query('UPDATE app_invoices SET customer_id = $2 WHERE id = $1', [invoiceId, FIXED.customerId]);
    });
    await t.test('a detail uses one checkout and includes existing items and payment history', async () => {
      const original = pool.connect;
      let checkouts = 0;
      pool.connect = function(...args) {
        if (typeof args[0] === 'function') checkouts++;
        return original.apply(this, args);
      };
      try {
        const invoice = await store.findInvoice(invoiceId);
        assert.equal(invoice.items.length, 1);
        assert.equal(invoice.items[0].item_name, FIXED.itemName);
        assert.equal(invoice.payments.length, 1);
        assert.equal(invoice.amount_paid, 200);
        assert.equal(checkouts, 1);
      } finally { pool.connect = original; }
    });
    await t.test('a concurrent commit cannot mix invoice header and line versions', async () => {
      const id = await store.createInvoice({invoice_date:FIXED.date, customer_name:'Snapshot customer', notes:'Before',
        items:[{item_code:FIXED.itemCode, item_name:'Before item', warehouse:FIXED.warehouse, quantity:1, unit_price:180}]});
      const original = pool.connect;
      let committed = false;
      pool.connect = function(...args) {
        if (typeof args[0] === 'function') return original.apply(this, args);
        return original.apply(this, args).then(client => {
          const query = client.query, release = client.release;
          client.query = async function(...queryArgs) {
            const result = await query.apply(this, queryArgs);
            if (!committed && /SELECT \* FROM app_invoices WHERE id = \$1/.test(String(queryArgs[0]))) {
              committed = true;
              const writer = await original.call(pool);
              try {
                await writer.query('BEGIN');
                await writer.query("UPDATE app_invoices SET notes = 'After' WHERE id = $1", [id]);
                await writer.query("UPDATE app_invoice_items SET item_name = 'After item' WHERE invoice_pk = $1", [id]);
                await writer.query('COMMIT');
              } finally { writer.release(); }
            }
            return result;
          };
          client.release = function(error) {
            client.query = query; client.release = release;
            return release.call(this, error);
          };
          return client;
        });
      };
      try {
        const invoice = await store.findInvoice(id);
        assert.equal(committed, true);
        assert.equal(invoice.notes, 'Before');
        assert.equal(invoice.items[0].item_name, 'Before item');
      } finally { pool.connect = original; }
      const refreshed = await store.findInvoice(id);
      assert.equal(refreshed.notes, 'After');
      assert.equal(refreshed.items[0].item_name, 'After item');
    });
  } finally { await store.closeStore(); }
});

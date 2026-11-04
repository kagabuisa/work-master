'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const { FIXED, resetGoldenSchema } = require('./helpers/golden-seed');
const { SCHEMA_VERSION } = require('../src/migrate');

test('control-account guards reject missing parties without blocking valid posting', {
  skip: process.env.SCHEMA_TEST_POSTGRES !== '1',
  timeout: 60000,
}, async () => {
  try {
    await resetGoldenSchema();
    const pool = store.getPostgresPool();
    assert.equal((await pool.query(
      'SELECT max(version)::int AS version FROM wm_schema_version',
    )).rows[0].version, SCHEMA_VERSION);
    const settings = (await pool.query(`SELECT setting_key, account_id
      FROM app_accounting_settings`)).rows;
    const accountId = (key) => Number(settings.find((row) => row.setting_key === key).account_id);
    const receivable = accountId('accounts_receivable');
    const payable = accountId('accounts_payable');
    const bank = Number((await pool.query(
      "SELECT id FROM app_accounts WHERE account_code='1110'",
    )).rows[0].id);

    const triggers = (await pool.query(`SELECT tgname, tgenabled, tgtype::int
      FROM pg_trigger WHERE tgrelid='app_gl_entries'::regclass
        AND tgname IN ('app_gl_control_party_insert','app_gl_control_party_update')
      ORDER BY tgname`)).rows;
    assert.deepEqual(triggers.map((row) => row.tgname),
      ['app_gl_control_party_insert', 'app_gl_control_party_update']);
    assert.ok(triggers.every((row) => row.tgenabled === 'O'));
    assert.equal((await pool.query(
      "SELECT 1 FROM pg_views WHERE schemaname='public' AND viewname='wm_control_account_exceptions'",
    )).rowCount, 1);
    const debtorIndex = (await pool.query(`SELECT i.indisvalid,i.indisready,
      pg_get_indexdef(i.indexrelid) AS definition
      FROM pg_index i WHERE i.indexrelid='app_gl_entries_debtor_account_cover_idx'::regclass`)).rows[0];
    assert.equal(debtorIndex.indisvalid, true);
    assert.equal(debtorIndex.indisready, true);
    assert.match(debtorIndex.definition,
      /INCLUDE \(id, posting_date, party_type, party_id, party_name, voucher_no, remarks, debit, credit\)/);

    await assert.rejects(pool.query(`
      INSERT INTO app_gl_entries
        (posting_date,account_id,voucher_type,voucher_id,line_no,debit,credit)
      VALUES ('2026-01-16',$1,'guard_test',910001,1,10,0),
        ('2026-01-16',$2,'guard_test',910001,2,0,10)
    `, [receivable, bank]), (error) => (
      error.code === '23514' && /control_account_party_required/.test(error.message)
    ));
    assert.equal((await pool.query(
      "SELECT count(*)::int AS count FROM app_gl_entries WHERE voucher_type='guard_test' AND voucher_id=910001",
    )).rows[0].count, 0);

    await assert.rejects(pool.query(`
      INSERT INTO app_gl_entries
        (posting_date,account_id,voucher_type,voucher_id,line_no,debit,credit)
      VALUES ('2026-01-16',$1,'guard_test',910002,1,10,0),
        ('2026-01-16',$2,'guard_test',910002,2,0,10)
    `, [payable, bank]), (error) => (
      error.code === '23514' && /control_account_party_required/.test(error.message)
    ));

    const valid = await pool.query(`
      INSERT INTO app_gl_entries
        (posting_date,account_id,party_type,party_id,party_name,voucher_type,
         voucher_id,line_no,debit,credit)
      VALUES ('2026-01-16',$1,'customer',$3,$4,'guard_test',910003,1,10,0),
        ('2026-01-16',$2,NULL,NULL,NULL,'guard_test',910003,2,0,10)
      RETURNING id, account_id
    `, [receivable, bank, FIXED.customerId, FIXED.customerName]);
    assert.equal(valid.rowCount, 2);
    const validReceivableRow = valid.rows.find((row) => Number(row.account_id) === receivable);

    await assert.rejects(pool.query(
      'UPDATE app_gl_entries SET party_id=NULL WHERE id=$1',
      [validReceivableRow.id],
    ), (error) => error.code === '23514' && /control_account_party_required/.test(error.message));
    assert.equal((await pool.query(
      'SELECT party_id FROM app_gl_entries WHERE id=$1',
      [validReceivableRow.id],
    )).rows[0].party_id, FIXED.customerId);

    await pool.query(`
      INSERT INTO app_gl_entries
        (posting_date,account_id,party_type,party_id,party_name,voucher_type,
         voucher_id,line_no,debit,credit)
      VALUES ('2026-01-17',$1,'supplier',$3,$4,'guard_test',910004,1,0,10),
        ('2026-01-17',$2,NULL,NULL,NULL,'guard_test',910004,2,10,0)
    `, [payable, bank, FIXED.supplierRef, FIXED.supplierName]);

    await assert.rejects(store.createStockEntry({
      entry_type: 'purchase',
      posting_date: FIXED.date,
      items: [{ item_code: FIXED.itemCode, item_name: FIXED.itemName,
        warehouse: FIXED.warehouse, quantity: 1, valuation_rate: 10 }],
    }), /supplier information/i);
    const stockPurchaseId = await store.createStockEntry({
      entry_type: 'purchase',
      posting_date: FIXED.date,
      supplier_name: FIXED.supplierName,
      supplier_reference: FIXED.supplierRef,
      items: [{ item_code: FIXED.itemCode, item_name: FIXED.itemName,
        warehouse: FIXED.warehouse, quantity: 1, valuation_rate: 10 }],
    });
    const stockPayable = (await pool.query(`SELECT party_type,party_id,party_name
      FROM app_gl_entries
      WHERE voucher_type='stock_purchase' AND voucher_id=$1
        AND account_id=$2`, [stockPurchaseId, payable])).rows[0];
    assert.deepEqual(stockPayable, {
      party_type: 'supplier',
      party_id: FIXED.supplierName,
      party_name: FIXED.supplierName,
    });

    // Migration must install the new guard without scanning or altering
    // pre-existing historical exceptions.
    await pool.query('DROP TRIGGER app_gl_control_party_insert ON app_gl_entries');
    await pool.query('DROP TRIGGER app_gl_control_party_update ON app_gl_entries');
    await pool.query('DROP VIEW wm_control_account_exceptions');
    await pool.query(`INSERT INTO app_gl_entries
      (posting_date,account_id,voucher_type,voucher_id,line_no,debit,credit)
      VALUES ('2026-01-18',$1,'legacy_guard_test',910005,1,25,0)`, [receivable]);
    await pool.query('DELETE FROM wm_schema_version WHERE version>=58');
    await store.initStore();
    assert.equal((await pool.query(
      "SELECT count(*)::int AS count FROM app_gl_entries WHERE voucher_type='legacy_guard_test' AND voucher_id=910005",
    )).rows[0].count, 1);
    const exception = (await pool.query(`SELECT row_count::int, balance::float
      FROM wm_control_account_exceptions
      WHERE setting_key='accounts_receivable' AND party_type='' AND party_id=''`)).rows[0];
    assert.equal(exception.row_count, 1);
    assert.equal(exception.balance, 25);
    await assert.rejects(pool.query(`INSERT INTO app_gl_entries
      (posting_date,account_id,voucher_type,voucher_id,line_no,debit,credit)
      VALUES ('2026-01-19',$1,'guard_test',910006,1,1,0)`, [receivable]),
    (error) => error.code === '23514');
  } finally {
    await store.closeStore();
  }
});

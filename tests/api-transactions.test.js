'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

test('API sales reliability, final validation, lock ordering and financial parity', {
  skip: process.env.API_TEST_POSTGRES !== '1', timeout: 120000,
}, async t => {
  const store = require('../src/store');
  const auth = require('../src/auth');
  const apiAuth = require('../src/api/auth');
  const { runWithAuditUser } = require('../src/audit');
  const { executeInvoiceOperation } = require('../src/services/sales');
  const { atomicMutation } = require('../src/api/transactions');
  const { resetGoldenSchema } = require('./helpers/golden-seed');
  try {
    await resetGoldenSchema();
    const pool = store.getPostgresPool();
    const user = await auth.createUser('txn-admin', 'Transactions123!', { role: 'admin' });
    const other = await auth.createUser('txn-other', 'Transactions123!', { role: 'admin' });
    const login = async account => {
      const tokens = await apiAuth.login(account.username, 'Transactions123!', crypto.randomUUID());
      return { actor: await apiAuth.resolveBearer(tokens.access_token, crypto.randomUUID()), tokens };
    };
    const first = await login(user), second = await login(other);
    const cash = (await pool.query("SELECT id FROM app_accounts WHERE account_code='1110'")).rows[0].id;
    await pool.query(`INSERT INTO app_master_customers(customer_id,customer_name,customer_group,docstatus)
      VALUES ('C1','Authoritative Customer','Retail','submitted');
      INSERT INTO app_master_warehouses(warehouse,docstatus) VALUES ('Main','submitted');
      INSERT INTO app_master_price_lists(price_list,currency,price_type,active) VALUES ('Retail','UGX','selling',1);
      INSERT INTO app_master_cost_centers(cost_center,cost_center_name) VALUES ('CC1','Allowed Center');
      INSERT INTO app_master_employees(employee_id,employee_name,status,disabled) VALUES ('E1','Authoritative Invoicer','Active',false);
      INSERT INTO app_master_items(item_code,item_name,stock_uom,docstatus) VALUES
        ('I1','First Item','Each','submitted'),('I2','Second Item','Each','submitted'),('SCARCE','Scarce Item','Each','submitted');`);
    await store.createStockEntry({ entry_type: 'opening', posting_date: '2026-10-01', items: [
      { item_code: 'I1', item_name: 'First Item', warehouse: 'Main', quantity: 40, valuation_rate: 20 },
      { item_code: 'I2', item_name: 'Second Item', warehouse: 'Main', quantity: 40, valuation_rate: 30 },
      { item_code: 'SCARCE', item_name: 'Scarce Item', warehouse: 'Main', quantity: 2, valuation_rate: 10 },
    ] });
    const payload = (code = 'I1', quantity = 1) => ({ invoice_date: '2026-10-01', customer_id: 'C1',
      customer_name: 'Forged client name', price_list: 'Retail', invoicer_id: 'E1', invoicer: 'Forged employee name',
      cost_center: 'CC1', warehouse: 'Main', items: [{ item_code: code, item_name: 'Forged item name', quantity, unit_price: 100 }] });
    const create = async (key, body = payload(), actor = first.actor) => Number((await executeInvoiceOperation(actor, 'invoice.create', null, key, body)).body.data.id);
    const submit = (id, key, actor = first.actor) => executeInvoiceOperation(actor, 'invoice.submit', id, key, {});
    const receipt = (reference, amount = 10) => ({ payment_date: '2026-10-01', amount, account_id: cash,
      external_source: 'provider', external_reference: reference });
    const pay = (id, key, body, actor = first.actor) => executeInvoiceOperation(actor, 'payment.record', id, key, body);
    const waitForBlocked = async (ownerPid, queryPattern) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const row = (await pool.query(`SELECT query FROM pg_stat_activity
          WHERE wait_event_type='Lock' AND $1::int=ANY(pg_blocking_pids(pid)) LIMIT 1`, [ownerPid])).rows[0];
        // Activity text and live lock state can be sampled across a statement
        // transition. Wait for the intended statement as well as its blocker.
        if (row && queryPattern.test(row.query)) return row.query;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail('Expected a real PostgreSQL lock wait');
    };
    const snapshot = async () => (await pool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM app_invoices i) AS invoices,
      (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM app_invoice_payments p) AS payments,
      (SELECT jsonb_agg(to_jsonb(g) ORDER BY g.id) FROM app_gl_entries g) AS gl,
      (SELECT jsonb_agg(to_jsonb(j) ORDER BY j.id) FROM app_journal_entries j) AS journals,
      (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.item_code,s.warehouse) FROM app_stock_balances s) AS stock,
      (SELECT count(*)::int FROM wm_api_payment_references) AS refs`)).rows[0];
    let main;

    await t.test('draft retries capture authoritative names once and do not depend on mutable defaults', async () => {
      const body = payload();
      const ids = await Promise.all([create('draft-key', body), create('draft-key', body)]);
      assert.equal(ids[0], ids[1]); main = ids[0];
      let invoice = await store.findInvoice(main);
      assert.equal(invoice.customer_name, 'Authoritative Customer');
      assert.equal(invoice.invoicer, 'Authoritative Invoicer');
      assert.equal(invoice.items[0].item_name, 'First Item');
      assert.equal(invoice.items[0].stock_at_sale, 40);
      assert.equal(invoice.created_by_user_id, String(user.id));
      await pool.query("UPDATE app_master_customers SET customer_name='Changed Customer',disabled=true WHERE customer_id='C1'");
      assert.equal(await create('draft-key', body), main);
      await assert.rejects(create('new-disabled-customer', body), error => error.status === 422);
      assert.equal((await pool.query("SELECT 1 FROM wm_api_idempotency WHERE key='new-disabled-customer'")).rowCount, 0);
      await pool.query("UPDATE app_master_customers SET disabled=false WHERE customer_id='C1'");
      invoice = await store.findInvoice(main); assert.equal(invoice.customer_name, 'Authoritative Customer');
      const audit = (await pool.query("SELECT resource_type,resource_id FROM wm_api_audit WHERE operation='invoice.create' AND outcome='replayed' ORDER BY id DESC LIMIT 1")).rows[0];
      assert.deepEqual(audit, { resource_type: 'invoice', resource_id: String(main) });
    });

    await t.test('failed reference validation is not cached; corrected references work with the same key', async () => {
      await pool.query("UPDATE app_master_items SET disabled=true WHERE item_code='I2'");
      const body = payload('I2');
      const before = await snapshot();
      await assert.rejects(create('corrected-item', body), error => error.status === 422);
      assert.deepEqual(await snapshot(), before);
      await pool.query("UPDATE app_master_items SET disabled=false WHERE item_code='I2'");
      assert(await create('corrected-item', body));
      await assert.rejects(create('zero-quantity', payload('I1', 0)), error => error.status === 422);
      await assert.rejects(create('boolean-quantity', payload('I1', true)), error => error.status === 422);
    });

    await t.test('submission retry posts stock and accounting exactly once and keeps original line order', async () => {
      const before = (await pool.query("SELECT quantity FROM app_stock_balances WHERE item_code='I1' AND warehouse='Main'")).rows[0].quantity;
      const results = await Promise.all([submit(main, 'submit-main'), submit(main, 'submit-main')]);
      assert.deepEqual(results.map(result => result.replayed).sort(), [false, true]);
      assert.deepEqual(results[0].body, results[1].body);
      assert.equal(Number((await pool.query("SELECT quantity FROM app_stock_balances WHERE item_code='I1' AND warehouse='Main'")).rows[0].quantity), Number(before) - 1);
      assert.equal((await pool.query("SELECT 1 FROM app_stock_ledger WHERE voucher_type='invoice' AND voucher_id=$1", [main])).rowCount, 1);
      await assert.rejects(submit(main, 'another-submit'), error => error.status === 409 && error.code === 'state_conflict');
    });

    await t.test('opposite item order across actors completes without reordering invoice lines', async () => {
      const body = { ...payload(), items: [...payload('I1').items, ...payload('I2').items] };
      const a = await create('ordered-a', body), b = await create('ordered-b', { ...body, items: [...body.items].reverse() }, second.actor);
      await Promise.all([submit(a, 'ordered-a-submit'), submit(b, 'ordered-b-submit', second.actor)]);
      assert.deepEqual((await store.findInvoice(a)).items.map(item => item.item_code), ['I1', 'I2']);
      assert.deepEqual((await store.findInvoice(b)).items.map(item => item.item_code), ['I2', 'I1']);
    });

    await t.test('competing scarce-stock submissions leave one draft and no partial posting', async () => {
      const a = await create('scarce-a', payload('SCARCE', 2)), b = await create('scarce-b', payload('SCARCE', 2), second.actor);
      const results = await Promise.allSettled([submit(a, 'scarce-submit-a'), submit(b, 'scarce-submit-b', second.actor)]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(results.find(result => result.status === 'rejected').reason.code, 'insufficient_stock');
      const failed = results[0].status === 'rejected' ? { id: a, key: 'scarce-submit-a', actor: first.actor } : { id: b, key: 'scarce-submit-b', actor: second.actor };
      assert.equal((await store.findInvoice(failed.id)).docstatus, 'draft');
      assert.equal((await pool.query('SELECT 1 FROM wm_api_idempotency WHERE key=$1', [failed.key])).rowCount, 0);
      assert.equal((await pool.query("SELECT 1 FROM app_stock_ledger WHERE voucher_type='invoice' AND voucher_id=$1", [failed.id])).rowCount, 0);
      await store.createStockEntry({ entry_type: 'opening', posting_date: '2026-10-01', items: [
        { item_code: 'SCARCE', item_name: 'Scarce Item', warehouse: 'Main', quantity: 2, valuation_rate: 10 },
      ] });
      assert.equal((await submit(failed.id, failed.key, failed.actor)).status, 200);
    });

    await t.test('new-key duplicates, key expiry and existing cancellation never free a payment reference', async () => {
      const body = receipt('permanent-1');
      const results = await Promise.all([pay(main, 'payment-a', body), pay(main, 'payment-b', body)]);
      assert.deepEqual(results[0].body, results[1].body);
      const id = results[0].body.data.id;
      assert.equal((await pool.query('SELECT 1 FROM app_invoice_payments WHERE invoice_id=$1', [main])).rowCount, 1);
      await pool.query("UPDATE wm_api_idempotency SET expires_at=now()-interval '1 second' WHERE key='payment-a'");
      assert.equal((await pay(main, 'payment-a', body)).body.data.id, id);
      await assert.rejects(pay(main, 'changed-payment', receipt('permanent-1', 11)), error => error.code === 'payment_reference_conflict');
      const paymentNo = (await pool.query('SELECT payment_no FROM app_invoice_payments WHERE id=$1', [id])).rows[0].payment_no;
      await store.cancelInvoicePayment(main, paymentNo);
      assert.equal((await pay(main, 'after-cancellation', body)).body.data.id, id);
      assert.equal((await pool.query('SELECT docstatus FROM app_invoice_payments WHERE id=$1', [id])).rows[0].docstatus, 'cancelled');
      assert.equal((await pool.query('SELECT 1 FROM app_invoice_payments WHERE invoice_id=$1', [main])).rowCount, 1);
      // Existing website cancellation remains a reversal; no allocation changes.
      assert.equal((await store.findInvoice(main)).amount_paid, 0);
    });

    await t.test('repeated item lines share one locked stock budget and cannot partially submit', async () => {
      await store.createStockEntry({ entry_type: 'opening', posting_date: '2026-10-01', items: [
        { item_code: 'SCARCE', item_name: 'Scarce Item', warehouse: 'Main', quantity: 3, valuation_rate: 10 },
      ] });
      const body = payload('SCARCE', 2);
      const id = await create('repeated-lines', { ...body, items: [...body.items, ...body.items] });
      const before = await snapshot();
      await assert.rejects(submit(id, 'repeated-lines-submit'), error => error.code === 'insufficient_stock');
      assert.deepEqual(await snapshot(), before);
      assert.equal((await store.findInvoice(id)).docstatus, 'draft');
      assert.equal((await pool.query("SELECT 1 FROM wm_api_idempotency WHERE key='repeated-lines-submit'")).rowCount, 0);
    });

    await t.test('audit and retry-record failures roll back domain postings and permanent references', async () => {
      await pool.query(`CREATE FUNCTION phase3_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected audit failure'; END $$;
        CREATE TRIGGER phase3_audit_failure BEFORE INSERT ON wm_api_audit
        FOR EACH ROW WHEN (NEW.operation='payment.record') EXECUTE FUNCTION phase3_reject_audit()`);
      let before = await snapshot();
      await assert.rejects(pay(main, 'audit-failure', receipt('audit-failure')));
      assert.deepEqual(await snapshot(), before);
      assert.equal((await pool.query("SELECT 1 FROM wm_api_idempotency WHERE key='audit-failure'")).rowCount, 0);
      await pool.query('DROP TRIGGER phase3_audit_failure ON wm_api_audit; DROP FUNCTION phase3_reject_audit()');
      await pool.query(`CREATE FUNCTION phase3_reject_retry() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected retry result failure'; END $$;
        CREATE TRIGGER phase3_retry_failure BEFORE INSERT ON wm_api_idempotency
        FOR EACH ROW WHEN (NEW.key='retry-failure') EXECUTE FUNCTION phase3_reject_retry()`);
      before = await snapshot();
      await assert.rejects(pay(main, 'retry-failure', receipt('retry-failure')));
      assert.deepEqual(await snapshot(), before);
      await pool.query('DROP TRIGGER phase3_retry_failure ON wm_api_idempotency; DROP FUNCTION phase3_reject_retry()');
      assert.equal((await pay(main, 'retry-failure', receipt('retry-failure'))).status, 201);
    });

    await t.test('account eligibility changes block new receipts but not authorized committed retries', async () => {
      const body = receipt('account-status');
      const result = await pay(main, 'account-status-key', body);
      await pool.query('UPDATE app_accounts SET is_active=false WHERE id=$1', [cash]);
      assert.deepEqual((await pay(main, 'account-status-key', body)).body, result.body);
      assert.deepEqual((await pay(main, 'account-status-new-key', body)).body, result.body);
      const before = await snapshot();
      await assert.rejects(pay(main, 'new-inactive-receipt', receipt('new-inactive')), error => error.status === 422);
      assert.deepEqual(await snapshot(), before);
      await pool.query('UPDATE app_accounts SET is_active=true WHERE id=$1', [cash]);
    });

    await t.test('historical header references retain website submission/payment eligibility', async () => {
      const id = await create('historic-headers');
      await pool.query("UPDATE app_master_customers SET disabled=true WHERE customer_id='C1'; UPDATE app_master_price_lists SET active=0 WHERE price_list='Retail'; UPDATE app_master_employees SET disabled=true WHERE employee_id='E1'");
      assert.equal((await submit(id, 'historic-submit')).status, 200);
      assert.equal((await pay(id, 'historic-payment', receipt('historic-payment'))).status, 201);
      await pool.query("UPDATE app_master_customers SET disabled=false WHERE customer_id='C1'; UPDATE app_master_price_lists SET active=1 WHERE price_list='Retail'; UPDATE app_master_employees SET disabled=false WHERE employee_id='E1'");
    });

    await t.test('stock lock contention returns a bounded conflict and same-key retry remains safe', async () => {
      const id = await create('contention-draft');
      const blocker = await pool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query("SELECT 1 FROM app_stock_balances WHERE item_code='I1' AND warehouse='Main' FOR UPDATE");
        await assert.rejects(submit(id, 'contention-submit'), error => error.status === 409 && error.code === 'operation_in_progress');
        assert.equal((await pool.query("SELECT 1 FROM wm_api_idempotency WHERE key='contention-submit'")).rowCount, 0);
      } finally { await blocker.query('ROLLBACK'); blocker.release(); }
      assert.equal((await submit(id, 'contention-submit')).status, 200);
    });

    await t.test('refresh and financial requests share a consistent user-before-session lock order', async () => {
      const { actor, tokens } = await login(other);
      const started = Promise.withResolvers(), release = Promise.withResolvers();
      const mutation = atomicMutation(actor, 'lock-order.test', '/lock-order', 'lock-key', {}, async () => {}, async client => {
        started.resolve((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        await release.promise; return { status: 200, data: { ok: true } };
      });
      const pid = await started.promise;
      const rotating = apiAuth.refresh(tokens.refresh_token, crypto.randomUUID());
      try { await waitForBlocked(pid, /FOR NO KEY UPDATE OF u/); }
      finally { release.resolve(); await Promise.allSettled([mutation, rotating]); }
      const [result, updated] = await Promise.all([mutation, rotating]);
      assert.equal(result.status, 200); assert(updated.access_token);
      await assert.rejects(atomicMutation(actor, 'lock-order.test', '/lock-order', 'lock-key', {}, async () => {}, () => assert.fail()), /no longer valid/);
    });

    await t.test('revocation waits for an already authorized commit and denies later replay', async () => {
      const role = await auth.createRole('Transaction Service', ['vouchers.sales.view']);
      const issued = await runWithAuditUser(user, () => apiAuth.createIntegration(first.actor, 'txn-service', role.slug, ['invoices:read']));
      const actor = await apiAuth.resolveBearer(issued.token, crypto.randomUUID());
      const started = Promise.withResolvers(), release = Promise.withResolvers();
      const mutation = atomicMutation(actor, 'revocation.test', '/revocation', 'revocation-key', {}, async () => {}, async client => {
        started.resolve((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        await release.promise; return { status: 200, data: { ok: true } };
      });
      const pid = await started.promise;
      let timer;
      try {
        const probe = async () => {
          const checked = await apiAuth.resolveBearer(issued.token, crypto.randomUUID());
          await require('../src/api/audit').recordApiAudit(pool, checked, 'phase3.auth_read', 'allowed');
          return checked;
        };
        const checked = await Promise.race([probe(),
          new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Activity metadata blocked authentication')), 1000); })]);
        assert.equal(checked.credentialId, issued.id);
      } catch (error) {
        release.resolve(); await mutation; throw error;
      } finally { clearTimeout(timer); }
      const revoke = apiAuth.revokeCredential(first.actor, issued.id);
      try { await waitForBlocked(pid, /UPDATE wm_api_credentials/); }
      finally { release.resolve(); await Promise.allSettled([mutation, revoke]); }
      await Promise.all([mutation, revoke]);
      assert.equal(await apiAuth.resolveBearer(issued.token, crypto.randomUUID()), null);
      await assert.rejects(atomicMutation(actor, 'revocation.test', '/revocation', 'revocation-key', {}, async () => {}, () => assert.fail()), /no longer valid/);
    });

    await t.test('logout uses user-before-session order and allows an earlier authorized commit', async () => {
      const { actor } = await login(other);
      const started = Promise.withResolvers(), release = Promise.withResolvers();
      const mutation = atomicMutation(actor, 'logout-order.test', '/logout-order', 'logout-key', {}, async () => {}, async client => {
        started.resolve((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        await release.promise; return { status: 200, data: { ok: true } };
      });
      const pid = await started.promise;
      const loggingOut = apiAuth.logout(actor);
      try { await waitForBlocked(pid, /FOR NO KEY UPDATE/); }
      finally { release.resolve(); await Promise.allSettled([mutation, loggingOut]); }
      await Promise.all([mutation, loggingOut]);
      await assert.rejects(atomicMutation(actor, 'logout-order.test', '/logout-order', 'logout-key', {}, async () => {}, () => assert.fail()), /no longer valid/);
    });

    await t.test('fresh actor identity stamps creator, submission and payment records consistently', async () => {
      await pool.query("UPDATE app_users SET username='txn-renamed' WHERE id=$1", [user.id]);
      const id = await create('fresh-identity');
      assert.equal((await store.findInvoice(id)).created_by, 'txn-renamed');
      await submit(id, 'fresh-identity-submit');
      const invoice = await store.findInvoice(id);
      assert.equal(invoice.submitted_by, 'txn-renamed');
      assert.equal(invoice.submitted_by_user_id, String(user.id));
      const paid = await pay(id, 'fresh-identity-payment', receipt('fresh-identity-payment'));
      assert.equal((await pool.query('SELECT created_by FROM app_invoice_payments WHERE id=$1', [paid.body.data.id])).rows[0].created_by, 'txn-renamed');
    });

    await t.test('single-connection services respect shorter configured deadlines and roll back timeouts', async () => {
      const { spawnSync } = require('node:child_process');
      const script = `const crypto=require('node:crypto');
        const assert=require('node:assert/strict');
        const store=require('./src/store'); const apiAuth=require('./src/api/auth');
        const {executeInvoiceOperation}=require('./src/services/sales');
        const {atomicMutation}=require('./src/api/transactions');
        (async()=>{ const actor=await apiAuth.resolveBearer(process.env.PHASE3_TOKEN,crypto.randomUUID());
          const body=JSON.parse(process.env.PHASE3_BODY);
          const draft=await executeInvoiceOperation(actor,'invoice.create',null,'single-connection-create',body);
          const id=draft.body.data.id;
          await executeInvoiceOperation(actor,'invoice.submit',id,'single-connection-submit',{});
          await executeInvoiceOperation(actor,'payment.record',id,'single-connection-payment',
            {payment_date:'2026-10-01',amount:5,account_id:process.env.PHASE3_CASH,external_source:'pool-test',external_reference:'single'});
          await atomicMutation(actor,'budget.check','/budget','budget-key',{},async()=>{},async client=>{
            const {rows}=await client.query("SELECT setting::int AS ms FROM pg_settings WHERE name='statement_timeout'");
            assert.equal(rows[0].ms,1000); return {status:200,data:{ok:true}};
          });
          await assert.rejects(atomicMutation(actor,'deadline.test','/deadline','deadline-key',{},async()=>{},async client=>{
            await require('./src/domain/sales').addPostgresInvoicePaymentInTransaction(client,id,
              {payment_date:'2026-10-01',amount:5,account_id:process.env.PHASE3_CASH});
            await client.query('SELECT pg_sleep(2)');return {status:200,data:{ok:true}};
          }),error=>error.status===503&&error.code==='operation_timed_out');
          assert.equal((await store.getPostgresPool().query('SELECT 1 FROM app_invoice_payments WHERE invoice_id=$1',[id])).rowCount,1);
          assert.equal((await store.getPostgresPool().query("SELECT 1 FROM wm_api_idempotency WHERE key='deadline-key'")).rowCount,0);
          await store.closeStore();
        })().catch(async()=>{ await store.closeStore(); process.exitCode=1; });`;
      const result = spawnSync(process.execPath, ['-e', script], { timeout: 15000, encoding: 'utf8', env: { ...process.env,
        POSTGRES_POOL_MAX: '1', POSTGRES_CONNECTION_TIMEOUT_MS: '300', POSTGRES_STATEMENT_TIMEOUT_MS: '1000', PHASE3_TOKEN: first.tokens.access_token,
        PHASE3_BODY: JSON.stringify(payload()), PHASE3_CASH: String(cash) } });
      assert.equal(result.status, 0, result.stderr);
    });
  } finally { await store.closeStore(); }
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Exercise the registered middleware without starting a server or loading app secrets.
function receiptMiddleware(load) {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const start = source.indexOf("app.use(async (req, res, next) => {\n  if (!req.path.startsWith('/invoices')");
  const end = source.indexOf("\n\napp.use('/reports'", start);
  assert.ok(start >= 0 && end > start);
  let middleware;
  vm.runInNewContext(source.slice(start, end), {
    app: { use: handler => { middleware = handler; } },
    receivingAccounts: load, accountAccessOptions: user => ({ userId: user.id }),
  });
  return middleware;
}

test('invoice POST skips display queries while rendered errors load permitted choices once', async () => {
  let calls = 0;
  const accounts = [{ id: 7, account_name: 'Bank' }];
  const middleware = receiptMiddleware(async options => {
    calls++;
    assert.equal(options.userId, 'restricted-user');
    return accounts;
  });
  const res = { locals: {} };
  let nextCalls = 0;
  await middleware({ method: 'POST', path: '/invoices', currentUser: { id: 'restricted-user' } }, res, error => {
    assert.equal(error, undefined); nextCalls++;
  });
  assert.equal(nextCalls, 1);
  assert.equal(calls, 0);
  const source = fs.readFileSync(path.join(__dirname, '../src/web/routes/sales.js'), 'utf8');
  const start = source.indexOf('async function renderInvoiceFormError(');
  const end = source.indexOf('\nfunction logInvoiceSaveError', start);
  const renderError = vm.runInNewContext(`(${source.slice(start, end)})`, {
    SyntaxError, invoiceFormState: body => ({ attempted: body.customer_name }),
  });
  res.status = code => { assert.equal(code, 400); return res; };
  res.render = (view, locals) => {
    assert.equal(view, 'new-invoice'); assert.equal(locals.attempted, 'Entered customer');
    assert.equal(res.locals.receiptAccounts, accounts);
  };
  await renderError(res, { customer_name: 'Entered customer' }, null, Object.assign(Error('Invalid item'), { status: 400 }));
  await res.locals.loadReceiptAccounts();
  assert.equal(calls, 1);
});

test('invoice GET retains display choices and forwards account lookup failures', async () => {
  const error = Error('database unavailable');
  const middleware = receiptMiddleware(async () => { throw error; });
  let forwarded;
  await middleware({ method: 'GET', path: '/invoices/123', currentUser: { id: 'u' } }, { locals: {} }, value => { forwarded = value; });
  assert.equal(forwarded, error);
});

function validationService(pool) {
  const source = fs.readFileSync(path.join(__dirname, '../src/services/sales-validation.js'), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(source, { module, require: name => {
    if (name === './invoice-draft-validation') return require('../src/services/invoice-draft-validation');
    if (name === '../core') return { getPostgresPool: () => pool };
    if (name === '../access') return { accountAllowed: () => true, requireInvoicePriceList: () => {} };
    throw Error(`Unexpected validation import: ${name}`);
  } });
  return module.exports;
}

for (const action of ['submit_invoice', 'cash_sale', 'save_draft']) {
  for (const available of [0, 10]) {
    test(`edit ${action} checks live items/stock once with ${available} available`, async () => {
      let referenceReads = 0, itemReads = 0, stockReads = 0, writes = 0, submissions = 0, failure, redirect;
      const validation = validationService({ query: async sql => {
        if (sql.includes('to_jsonb(c)')) {
          referenceReads++;
          return { rows: [{ customer: { customer_id: 'C', customer_name: 'Customer' },
            price_list: { active: 1, currency: 'UGX', price_type: 'selling' },
            employee: { employee_name: 'Employee', disabled: false } }] };
        }
        if (sql.includes('WITH requested AS')) { stockReads++;return {rows:[{item_code:'I',item_name:'Item',warehouse:'Main',requested:1,available_quantity:available,historical_quantity:available,current_quantity:available,closed:false}]}; }
        assert.match(sql, /app_master_items/);
        itemReads++;
        return { rows: [{ item_code: 'I', item_name: 'Item', quantity: available }] };
      } });
      const source = fs.readFileSync(path.join(__dirname, '../src/web/routes/sales.js'), 'utf8');
      const start = source.indexOf("router.post('/invoices/:id',");
      const end = source.indexOf("\nrouter.post('/invoices/:id/submit'", start);
      let handler;
      vm.runInNewContext(source.slice(start, end), {
        router: { post: (route, callback) => { handler = callback; } },
        buildInvoicePayload: validation.buildInvoicePayload,
        // A second validation pass would issue another live query and fail the count below.
        validateDbItems: validation.validateDbItems,
        requireReceiptAccount: validation.requireReceiptAccount,
        updateInvoice: async () => { writes++; return 42; },
        submitInvoice: async () => { submissions++; },
        submitCashSaleInvoice: async () => { submissions++; },
        cashSalePayment: () => ({ account_id: 7 }), clearInvoiceCaches: () => {},
        logInvoiceSaveError: () => {}, findInvoice: async () => ({ id: 42, docstatus: 'draft' }),
        renderInvoiceFormError: async (res, body, invoice, error) => { failure = error; },
      });
      await handler({ params: { id: 42 }, currentUser: { role: 'admin' }, body: {
        action, customer_id: 'C', customer_name: 'Customer', invoicer_id: 'E', price_list: 'Retail',
        warehouse: 'Main', cash_sale_account_id: 7, invoice_date:'2026-10-01', posting_time:'12:00',
        items_json: JSON.stringify([{ item_code: 'I', quantity: 1, unit_price: 100 }]),
      } }, { redirect: target => { redirect = target; } }, error => { throw error; });
      assert.equal(referenceReads, 1); assert.equal(itemReads, 1); assert.equal(stockReads, 1);
      if (available === 0) {
        assert.equal(failure?.code, 'insufficient_stock');
        assert.equal(writes, 0); assert.equal(submissions, 0); assert.equal(redirect, undefined);
      } else {
        assert.equal(failure, undefined); assert.equal(writes, 1);
        assert.equal(submissions, action === 'save_draft' ? 0 : 1);
        assert.equal(redirect, '/invoices/42');
      }
    });
  }
}

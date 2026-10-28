'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const store = require('../src/store');
const auth = require('../src/auth');
const { can, permissionCheck } = require('../src/authorize');
const { REPORTS } = require('../src/report-permissions');
const purchasing = require('../src/purchases');
const orders = require('../src/purchase-orders');
const { runWithAuditUser } = require('../src/audit');
const { resetGoldenSchema } = require('./helpers/golden-seed');
const { currentPostingDate, currentPostingTime } = require('../src/posting-time');
const password = 'Review regression 123!';
const database = { skip: process.env.ACCOUNTING_TEST_POSTGRES !== '1', timeout: 120000 };
const stamp = () => ({ posting_date: currentPostingDate(), posting_time: currentPostingTime() });
const purchase = (quantity, unit_price) => ({ ...stamp(), supplier_id: 'REVIEW-SUP', price_list: 'Review Buying',
  items: [{ item_code: 'REVIEW-ITEM', warehouse: 'Allowed', quantity, unit_price }] });
async function masters(pool) {
  await pool.query(`INSERT INTO app_master_suppliers(supplier_id,supplier_name) VALUES('REVIEW-SUP','Review supplier');
    INSERT INTO app_master_items(item_code,item_name,is_purchase_item) VALUES('REVIEW-ITEM','Review item',true);
    INSERT INTO app_master_warehouses(warehouse) VALUES('Allowed'),('Hidden');
    INSERT INTO app_master_price_lists(price_list,currency,price_type,active) VALUES('Review Buying','UGX','buying',1)`);
}
async function serve(app) {
  const server = await new Promise(resolve => { const handle = app.listen(0, '127.0.0.1', () => resolve(handle)); });
  return { server, root: `http://127.0.0.1:${server.address().port}` };
}
function browserApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((_req, res, next) => { res.render = (view, data) => res.json({ view, ...data }); next(); });
  require('../src/auth-http').installAuth(app);
  return app;
}
const errors = (error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message });

test('purchase decimals validate their decimal representation and exact line totals', () => {
  for (const [qty, rate, total] of [['1.001', '1000', 1001], ['100', '0.07', 7], ['4', '1000.25', 4001], ['1.005', '100', 101]]) {
    assert.equal(purchasing.normalizePurchase(purchase(qty, rate)).total, total);
    assert.equal(orders.normalizePurchaseOrder({ ...purchase(qty, rate), warehouse: 'Allowed' }).total, total);
  }
  for (const [qty, rate] of [['1.0001','1'], ['1','0.071'], ['Infinity','1'], ['1','NaN']]) {
    assert.throws(() => purchasing.normalizePurchase(purchase(qty,rate)));
  }
});

test('financial reports remain admin-only despite role grants, individual grants, or URL suffixes', () => {
  for (const report of REPORTS.filter(report => report.adminOnly)) {
    for (const role of ['standard', 'privileged', 'finance', 'management', 'custom-review']) {
      const user = { role, permissions: [report.permission], permission_grants: [report.permission] };
      assert.equal(can(user, report.permission), false);
      for (const suffix of ['', '/export']) assert.equal(permissionCheck({ currentUser: user,
        path: report.href + suffix, method: 'GET' }), false);
    }
    assert.equal(can({ role: 'admin' }, report.permission), true);
  }
});

test('browser purchasing, stock reports, drawers and financial pages enforce current scopes', database, async () => {
  let server;
  try {
    await resetGoldenSchema(); const pool = store.getPostgresPool(); await masters(pool);
    const permissions = ['vouchers.purchases.view','vouchers.purchase-orders.view','vouchers.stock.view',
      ...REPORTS.map(report => report.permission)];
    const role = await auth.createRole('Review reader', permissions);
    const admin = await auth.createUser('review-admin', password, { role: 'admin' });
    const assigned = await auth.createUser('review-assigned', password, { role: role.slug, record_access: { warehouse:'Allowed' } });
    const denied = await auth.createUser('review-denied', password, { role: role.slug });
    await auth.saveUserPermissionOverrides(denied.id, [], ['warehouse.view:Hidden']);
    const standard = await auth.createUser('review-standard', password, { role: 'standard', record_access: { warehouse:'Allowed' } });
    const add = (warehouses, owner = admin) => runWithAuditUser(owner, async () => {
      const payload = purchase('1','100');
      payload.items = warehouses.map(warehouse => ({ ...payload.items[0], warehouse }));
      const id = await purchasing.createPurchase(payload);
      const payment = (await pool.query(`INSERT INTO app_purchase_payments(purchase_id,payment_no,payment_date,amount,method)
        VALUES($1,1,$2,1,'cash') RETURNING id`, [id,currentPostingDate()])).rows[0].id;
      const order = await orders.createPurchaseOrder({ ...payload, warehouse: warehouses[0] });
      if (warehouses.length > 1) await pool.query(`INSERT INTO app_purchase_order_items
        (purchase_order_id,line_no,item_code,item_name,warehouse,quantity,unit_price,line_total)
        VALUES($1,99,'REVIEW-ITEM','Review item','Hidden',1,100,100)`, [order]);
      return { id, payment, order };
    });
    const allowed = await add(['Allowed']); const hidden = await add(['Hidden']); const mixed = await add(['Allowed','Hidden']);
    const ownedHidden = await add(['Hidden'], standard);
    const stock = {};
    await runWithAuditUser(admin, async () => {
      for (const warehouse of ['Allowed','Hidden']) stock[warehouse] = await store.createStockEntry({ ...stamp(), entry_type:'opening',
        items:[{item_code:'REVIEW-ITEM',item_name:'Review item',warehouse,quantity:2,valuation_rate:100}] });
      stock.mixed = await store.createStockEntry({ ...stamp(), entry_type:'opening',items:['Allowed','Hidden'].map(warehouse =>
        ({item_code:'REVIEW-ITEM',item_name:'Review item',warehouse,quantity:1,valuation_rate:100})) });
      await store.createStockEntry({ ...stamp(), entry_type:'transfer', action:'save_draft', items:[
        {item_code:'REVIEW-ITEM',item_name:'Review item',warehouse:'Allowed',target_warehouse:'Hidden',quantity:1,valuation_rate:100}] });
    });
    const app = browserApp(); app.use(require('../src/web/routes/purchasing'));
    app.use('/reports', require('../src/web/routes/reports')); app.use(errors);
    ({server,root:stock.root} = await serve(app));
    const request = async (user, path) => fetch(stock.root + path, {redirect:'manual',headers:{
      Cookie:`wm_session=${await auth.createSession(user.id)}`,Accept:'application/json'}});
    for (const user of [assigned,denied]) {
      for (const doc of [hidden,mixed]) for (const path of [`/purchases/${doc.id}`,`/purchases/payments/${doc.payment}/drawer`,
        `/purchase-orders/${doc.order}`]) assert.equal((await request(user,path)).status,403,path);
      assert.equal((await request(user,`/purchases/payments/${allowed.payment}/drawer`)).status,200);
      for (const path of ['/purchases?page_size=10','/purchase-orders?page_size=10']) {
        const {result} = await (await request(user,path)).json();
        assert.equal(result.pagination.total,1,path); assert.equal(result.rows.length,1);
      }
      for (const path of ['/reports/stock-ledger','/reports/stock-movement']) {
        const {report} = await (await request(user,path)).json();
        assert.ok(report.rows.length); assert.ok(report.rows.every(row=>row.warehouse==='Allowed'));
        const hiddenResponse = await request(user,path+'?warehouse=Hidden'); assert.equal(hiddenResponse.status,403);
      }
      assert.equal((await request(user,'/reports/stock-movement/details?item_code=REVIEW-ITEM&warehouse=Hidden&direction=in')).status,403);
      const draft = await (await request(user,'/reports/stock-ledger?status=draft')).json();
      assert.equal(draft.report.pagination.total,0,'a draft transfer cannot reveal its hidden target');
      for (const id of [stock.Hidden,stock.mixed]) assert.equal((await request(user,`/reports/stock-ledger/vouchers/stock_opening/${id}`)).status,403);
      assert.equal((await request(user,`/reports/stock-ledger/vouchers/stock_opening/${stock.Allowed}`)).status,200);
      for (const report of REPORTS.filter(report=>report.adminOnly)) assert.equal((await request(user,report.href)).status,403);
    }
    assert.equal((await request(standard,`/purchases/payments/${ownedHidden.payment}/drawer`)).status,403);
    assert.equal((await request(admin,`/purchases/payments/${hidden.payment}/drawer`)).status,200);
    for (const report of REPORTS.filter(report=>report.adminOnly)) assert.equal((await request(admin,report.href)).status,200,report.href);
  } finally { if(server) await new Promise(resolve=>server.close(resolve)); await store.closeStore(); }
});

for (const controlled of [false,true]) test(`fractional purchase submission and cancellation reconcile (${controlled?'controlled':'legacy'})`, database, async () => {
  try {
    await resetGoldenSchema(); const pool=store.getPostgresPool(); await masters(pool);
    const admin=await auth.createUser('fraction-admin',password,{role:'admin'});
    if(controlled) await pool.query('SELECT wm_inventory_activate()');
    await runWithAuditUser(admin,async()=>{
      const id=await purchasing.createPurchase(purchase('4','1000.25')); await purchasing.submitPurchase(id);
      const saved=await purchasing.loadPurchase(id); assert.equal(saved.docstatus,'submitted'); assert.equal(saved.total,4001);
      const stock=(await pool.query("SELECT sum(stock_value_change)::int value FROM app_stock_ledger WHERE voucher_type='purchase' AND voucher_id=$1",[id])).rows[0];
      assert.equal(stock.value,4001);
      const gl=(await pool.query("SELECT sum(debit)::float debit,sum(credit)::float credit FROM app_gl_entries WHERE voucher_type='purchase' AND voucher_id=$1",[id])).rows[0];
      assert.deepEqual(gl,{debit:4001,credit:4001});
      await purchasing.cancelPurchase(id,{posting_date:currentPostingDate(),reason:'Review reversal'});
      const balance=(await pool.query("SELECT quantity::float quantity,stock_value::float value FROM app_stock_balances WHERE item_code='REVIEW-ITEM' AND warehouse='Allowed'")).rows[0];
      assert.deepEqual(balance,{quantity:0,value:0});
    });
  }finally{await store.closeStore();}
});

test('financial reports retain fractional payroll and inactive accounts and share a snapshot', database, async () => {
  let hookedClient, originalQuery;
  try {
    await resetGoldenSchema(); const pool=store.getPostgresPool(); const hr=require('../src/hr');
    const admin=await auth.createUser('report-admin',password,{role:'admin'});
    const accounts={};
    for(const [name,type] of [['expense-a','expense'],['expense-b','expense'],['payable','liability'],['bank','asset'],['income','income'],['equity','equity']]) {
      accounts[name]=(await pool.query(`INSERT INTO app_accounts(account_code,account_name,account_type,normal_balance)
        VALUES($1,$1,$2,$3) RETURNING id`,['REVIEW-'+name,type,['asset','expense'].includes(type)?'debit':'credit'])).rows[0].id;
    }
    await runWithAuditUser(admin,async()=>{
      await pool.query("INSERT INTO app_master_employees(employee_id,employee_name,company,status) VALUES('REPORT-EMP','Report employee','Report Co','Active')");
      await hr.saveSettings({action:'accounts',salary_payable_account_id:accounts.payable},admin);
      await hr.savePayPlan('REPORT-EMP',{effective_from:'2026-01-01',components:[
        {label:'Salary',kind:'earning',amount:'1000.50',account_id:accounts['expense-a']},
        {label:'Allowance',kind:'earning',amount:'1000.50',account_id:accounts['expense-b']}]},admin);
      const run=await hr.createPayroll({company:'Report Co',period:'2026-01',posting_date:'2026-01-31',employee_ids:['REPORT-EMP']},admin);
      const slip=(await hr.payrollDetails(run,admin)).slips[0];
      await hr.updateSlip(run,slip.id,{paid_days:31,input_note:'Reviewed report amounts',components:slip.components},admin);
      await hr.payrollAction(run,'submit',admin);
    });
    let tb=await store.trialBalanceReport(); assert.equal(tb.is_balanced,true); assert.equal(tb.summary.closing_debit,2001);
    assert.equal((await store.profitAndLossReport()).summary.total_expenses,2001);
    assert.equal((await store.balanceSheetReport()).equity.find(row=>row.account_name==='Current Earnings').amount,-2001);
    const contribution=()=>store.createJournalEntry({journal_type:'journal_entry',posting_date:'2026-02-01',lines:[
      {account_id:accounts.bank,debit:100},{account_id:accounts.equity,credit:100}]});
    await contribution();
    const before=await store.balanceSheetReport();
    const bank=await store.findAccountingAccount(accounts.bank);
    await store.updateAccountingAccount(accounts.bank,{...bank,is_active:'0'});
    assert.deepEqual(await store.balanceSheetReport(),before);
    tb=await store.trialBalanceReport(); assert.equal(tb.is_balanced,true); assert.ok(tb.rows.some(row=>row.account_name==='REVIEW-bank'));
    assert.equal((await store.trialBalanceReport({from:'2026-03-01'})).summary.opening_debit,2101);
    await store.updateAccountingAccount(accounts.bank,{...bank,is_active:'1'});
    const connect=pool.connect.bind(pool); hookedClient=await connect(); originalQuery=hookedClient.query;
    let committed=false;
    hookedClient.query=async function(sql,...args){
      const result=await originalQuery.call(this,sql,...args);
      if(!committed && typeof sql==='string' && sql.includes('LEFT JOIN app_gl_entries gl ON gl.account_id = account.id')){
        committed=true;
        await store.createJournalEntry({journal_type:'journal_entry',posting_date:'2026-02-02',lines:[
          {account_id:accounts.bank,debit:50},{account_id:accounts.income,credit:50}]});
      }
      return result;
    };
    pool.connect=function(...args){ pool.connect=connect; assert.equal(args.length,0); return Promise.resolve(hookedClient); };
    const concurrent=await store.balanceSheetReport();
    hookedClient.query=originalQuery; hookedClient=null;
    assert.equal(committed,true); assert.deepEqual(concurrent,before);
    const after=await store.balanceSheetReport(); assert.equal(after.summary.total_assets,150); assert.equal(after.summary.is_balanced,true);
  }finally{if(hookedClient){hookedClient.query=originalQuery;} await store.closeStore();}
});

test('browser login and replacement sessions cannot outlive a password change or reset', database, async () => {
  let server, release, pool, connect;
  try {
    await resetGoldenSchema(); pool=store.getPostgresPool();
    const user=await auth.createUser('race-review',password,{role:'standard'});
    const app=browserApp();app.get('/',(req,res)=>res.json({username:req.currentUser.username}));app.use(errors);
    const started=await serve(app);server=started.server;
    let current=password;
    for(const action of ['change','reset']){
      const oldToken=await auth.createSession(user.id);
      const next=action==='change'?'Changed review 123!':'Reset review 123!';
      let reached; const paused=new Promise(resolve=>{reached=resolve;});const resume=new Promise(resolve=>{release=resolve;});
      connect=pool.connect.bind(pool); let armed=false; const query=pool.query.bind(pool);
      pool.query=async function(sql,...args){const rows=await query(sql,...args);if(sql.includes('FROM app_users WHERE username = $1')) armed=true;return rows;};
      pool.connect=function(...args){if(armed && args.length===0){armed=false;reached();return resume.then(()=>connect(...args));}return connect(...args);};
      const pending=fetch(started.root+'/login',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({username:user.username,password:current})});
      await paused; pool.query=query;
      let replacement;
      if(action==='change') replacement=await auth.changePassword(user.id,current,next);
      else await auth.resetUserPassword(user.username,next);
      release();const response=await pending;pool.connect=connect;
      assert.equal(response.status,401);assert.equal(response.headers.get('set-cookie'),null);
      assert.equal(await auth.sessionUser(oldToken),null);assert.equal(await auth.authenticate(user.username,current),null);
      if(replacement){assert.ok(await auth.sessionUser(replacement));await auth.resetUserPassword(user.username,next);assert.equal(await auth.sessionUser(replacement),null);}
      current=next;
    }
  }finally{release?.();if(pool&&connect)pool.connect=connect;if(server)await new Promise(resolve=>server.close(resolve));await store.closeStore();}
});

test('integration creation uses the existing transaction with a single pool connection', database, async () => {
  const previous=process.env.POSTGRES_POOL_MAX;
  try {
    await resetGoldenSchema(); await auth.createUser('pool-admin',password,{role:'admin'});
    await store.closeStore();process.env.POSTGRES_POOL_MAX='1';
    const api=require('../src/api/auth');const requestId=require('node:crypto').randomUUID();
    const tokens=await api.login('pool-admin',password,requestId);
    const actor=await api.resolveBearer(tokens.access_token,requestId);
    const result=await api.createIntegration(actor,'pool-integration','standard',['invoices:read']);
    assert.ok(result.token);
    await assert.rejects(api.createIntegration(actor,'pool-invalid','missing-role',['invoices:read']),/existing role/);
    const pool=store.getPostgresPool();assert.equal((await pool.query("SELECT count(*)::int n FROM app_users WHERE username='pool-invalid'")).rows[0].n,0);
  }finally{await store.closeStore();if(previous===undefined)delete process.env.POSTGRES_POOL_MAX;else process.env.POSTGRES_POOL_MAX=previous;}
});

test('v48 upgrade preserves posted history and function privileges and expires unversioned sessions', database, async () => {
  try {
    const {seedGoldenData}=require('./helpers/golden-seed'); await seedGoldenData(); const pool=store.getPostgresPool();
    const user=await auth.createUser('upgrade-review',password,{role:'admin'});const cookie=await auth.createSession(user.id);
    const definition=(await pool.query("SELECT pg_get_functiondef('wm_inventory_apply(jsonb)'::regprocedure) definition")).rows[0].definition;
    const precise="IF q>0 THEN ir:=COALESCE(NULLIF((m->>'rate')::numeric,0),b.valuation_rate,0);val:=round(q*ir);";
    const rounded="IF q>0 THEN ir:=round(COALESCE(NULLIF((m->>'rate')::numeric,0),b.valuation_rate,0));val:=round(q*ir);";
    assert.ok(definition.includes(precise));await pool.query(definition.replace(precise,rounded));
    await pool.query('ALTER TABLE app_user_sessions DROP COLUMN password_version; DELETE FROM wm_schema_version WHERE version>=49');
    const snapshot=async()=>(await pool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM app_stock_ledger l) stock,
      (SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM app_gl_entries g) gl,
      (SELECT jsonb_build_object('oid',oid::text,'owner',proowner,'acl',proacl,'security_definer',prosecdef,'config',proconfig)
        FROM pg_proc WHERE oid='wm_inventory_apply(jsonb)'::regprocedure) guarded_function`)).rows[0];
    const before=await snapshot();await store.initStore();assert.deepEqual(await snapshot(),before);
    assert.equal(await auth.sessionUser(cookie),null);assert.ok(await auth.sessionUser(await auth.createSession(user.id)));
    assert.ok((await pool.query("SELECT pg_get_functiondef('wm_inventory_apply(jsonb)'::regprocedure) definition")).rows[0].definition.includes(precise));
    await store.initStore();assert.deepEqual(await snapshot(),before);
  }finally{await store.closeStore();}
});

test('malformed compressed requests leave an isolated middleware process serving requests', async () => {
  const {spawn}=require('node:child_process');
  const script=`
    const express=require('express'), compression=require('compression'), zlib=require('node:zlib');
    const app=express();app.use(compression({threshold:0}));app.use(express.json());
    app.post('/probe',(req,res)=>res.json(req.body));app.get('/health',(_req,res)=>res.send('ready'));
    app.use((error,_req,res,_next)=>res.status(400).end());
    const server=app.listen(0,'127.0.0.1',async()=>{
      try{
        const root='http://127.0.0.1:'+server.address().port;
        const body=Buffer.concat([zlib.gzipSync(Buffer.from('{"probe":true}')),Buffer.from('trailing junk')]);
        await fetch(root+'/probe',{method:'POST',headers:{'Content-Type':'application/json','Content-Encoding':'gzip'},body});
        await new Promise(resolve=>setTimeout(resolve,50));
        const response=await fetch(root+'/health');if(response.status!==200)throw Error('health failed');
        await response.text();server.close();
      }catch(error){console.error(error.message);process.exitCode=1;server.close();}
    });`;
  const child=spawn(process.execPath,['-e',script],{stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
  const timer=setTimeout(()=>child.kill(),10000);
  try{const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert.equal(code,0,output);}
  finally{clearTimeout(timer);}
});

test('purchase and order form previews round each exact line before summing', () => {
  const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
  const values=[['0.005','100'],['0.005','100'],['1.005','100']];
  const rows=values.map(([quantity,unit_price])=>{
    const fields={'.row-number':{},'.purchase-line-total':{},'[name="quantity"]':{value:quantity},'[name="unit_price"]':{value:unit_price}};
    return {fields,querySelector:selector=>fields[selector]};
  });
  const totalLabel={};
  const source=fs.readFileSync(path.join(__dirname,'../public/purchase-form.js'),'utf8');
  const update=source.match(/function updateTotals\(\) \{[\s\S]*?\n\}/)[0];
  const context={purchaseRows:{rows},totalLabel,InvoiceMath:require('../src/shared/invoice-math'),formatMoney:String};
  vm.runInNewContext(update+'\nupdateTotals();',context);
  assert.deepEqual(rows.map(row=>row.fields['.purchase-line-total'].textContent),['1','1','101']);
  assert.equal(totalLabel.textContent,'103');
  for(const name of ['purchase-form','purchase-order-form']){
    const html=fs.readFileSync(path.join(__dirname,`../views/${name}.ejs`),'utf8');
    assert.ok(html.indexOf('/shared/invoice-math.js')>=0);
    assert.ok(html.indexOf('/shared/invoice-math.js')<html.indexOf('/purchase-form.js'));
  }
});

test('simultaneous password changes for different users do not contend on expired sessions', database, async () => {
  let pool,connect,unblock;
  try {
    await resetGoldenSchema();pool=store.getPostgresPool();
    const users=[];
    for(const name of ['parallel-user-a','parallel-user-b']){
      const user=await auth.createUser(name,password,{role:'standard'});users.push(user);await auth.createSession(user.id);
    }
    await pool.query("UPDATE app_user_sessions SET expires_at=now()-interval '1 day'");
    let arrived=0;const barrier=new Promise(resolve=>{unblock=resolve;});connect=pool.connect.bind(pool);
    pool.connect=function(callback){
      if(callback)return connect(callback);
      return connect().then(client=>{
        const query=client.query,release=client.release;
        client.query=function(sql,...args){
          const result=query.call(this,sql,...args);
          if(sql==='DELETE FROM app_user_sessions WHERE user_id = $1')return result.then(async rows=>{
            if(++arrived===2)unblock();await barrier;return rows;
          });
          return result;
        };
        client.release=function(...args){client.query=query;client.release=release;return release(...args);};
        return client;
      });
    };
    const sessions=await Promise.all(users.map(user=>auth.changePassword(user.id,password,'Parallel replacement 123!')));
    pool.connect=connect;
    assert.equal(arrived,2);
    for(const token of sessions)assert.ok(await auth.sessionUser(token));
  }finally{unblock?.();if(pool&&connect)pool.connect=connect;await store.closeStore();}
});

test('purchase and payment cancellations use Kampala today after UTC midnight differs', database, async t => {
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-17T21:15:00Z')});
  try {
    await resetGoldenSchema();const pool=store.getPostgresPool();await masters(pool);
    const admin=await auth.createUser('midnight-admin',password,{role:'admin'});
    await runWithAuditUser(admin,async()=>{
      const payload={...purchase('4','1000.25'),posting_date:'2026-10-18',posting_time:'00:00'};
      const id=await purchasing.createPurchase(payload);await purchasing.submitPurchase(id);
      const cash=(await pool.query("SELECT id FROM app_accounts WHERE account_code='1110'")).rows[0].id;
      await purchasing.addPurchasePayment(id,{payment_date:'2026-10-18',amount:500,account_id:cash});
      const journal=(await pool.query('SELECT journal_entry_id FROM app_purchase_payments WHERE purchase_id=$1',[id])).rows[0].journal_entry_id;
      await purchasing.cancelPurchasePayment(id,1);
      const paymentDates=(await pool.query("SELECT DISTINCT posting_date::text FROM app_gl_entries WHERE voucher_type='payment_journal_cancellation' AND voucher_id=$1",[journal])).rows;
      assert.deepEqual(paymentDates,[{posting_date:'2026-10-18'}]);
      await purchasing.cancelPurchase(id);
      assert.equal((await purchasing.loadPurchase(id)).docstatus,'cancelled');
      const stockDates=(await pool.query("SELECT DISTINCT posting_date::text FROM app_stock_ledger WHERE voucher_type='purchase' AND voucher_id=$1 AND is_reversal",[id])).rows;
      assert.deepEqual(stockDates,[{posting_date:'2026-10-18'}]);
      const purchaseDates=(await pool.query("SELECT DISTINCT posting_date::text FROM app_gl_entries WHERE voucher_type='purchase_cancellation' AND voucher_id=$1",[id])).rows;
      assert.deepEqual(purchaseDates,[{posting_date:'2026-10-18'}]);
    });
  }finally{await store.closeStore();}
});

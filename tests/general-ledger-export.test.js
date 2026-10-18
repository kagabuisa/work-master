'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sendGeneralLedgerExport } = require('../src/web/general-ledger-export');
const report = { filters: { from: '2026-10-01', to: '2026-10-08', account: 'Cash' }, summary: { debit: 10, credit: 2, balance: 8 }, rows: Array.from({ length: 205 }, (_,index) => ({ posting_date: '2026-10-08', account_code: '=SUM(1,2)', account_name: 'Cash "Desk"', debit: 10, credit: 2, running_balance: index * 8, voucher_type: 'journal_entry', voucher_no: `JE-${index}`, party_name: 'Counter', remarks: 'Count\nchecked' })) };
const response = () => {
  const { Writable } = require('node:stream');
  const chunks = [];
  const res = new Writable({ write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  res.headers = {};
  res.set = (name, value) => { res.headers[name] = value; };
  res.attachment = name => { res.filename = name; };
  res.type = value => { res.contentType = value; };
  Object.defineProperty(res, 'body', { get() {
    const buffer = Buffer.concat(chunks);
    return res.contentType === 'text/csv' ? buffer.toString() : buffer;
  } });
  return res;
};
test('General Ledger CSV includes all entries, safe text, totals and numeric negatives', async () => {
  const res = response();
  await sendGeneralLedgerExport(res, report, 'csv');
  assert.match(res.body, /JE-204/);
  assert.match(res.body, /'\=SUM/);
  assert.match(res.body, /Cash ""Desk""/);
  assert.match(res.body, /"Total","10","2","8"/);
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
});
test('General Ledger Excel preserves numeric amounts and all rows', async () => {
  const ExcelJS = require('exceljs');
  const res = response(); await sendGeneralLedgerExport(res, report, 'xlsx');
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(res.body);
  const sheet = workbook.getWorksheet('General Ledger');
  assert.equal(sheet.rowCount, 207);
  assert.equal(sheet.getCell('D2').value, 10);
  assert.equal(sheet.getCell('B2').value, '=SUM(1,2)');
  assert.equal(sheet.getCell('H206').value, 'JE-204');
  assert.equal(sheet.getCell('F207').value, 8);
  assert.match(workbook.getWorksheet('Report Details').getCell('B2').value, /account: Cash/);
});
test('General Ledger PDF handles multiple pages and empty reports', async () => {
  for (const rows of [report.rows, [{ ...report.rows[0], remarks: 'Detailed count confirmation. '.repeat(600) }], []]) {
    const res = response(); await sendGeneralLedgerExport(res, { ...report, rows }, 'pdf');
    assert.equal(res.body.subarray(0,5).toString(), '%PDF-');
    assert.match(res.body.toString('latin1'), /\/Type \/Page/);
    if (rows.length) assert.ok((res.body.toString('latin1').match(/\/Type \/Page\b/g) || []).length > 1);
    else assert.equal((res.body.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 1);
  }
});

test('General Ledger exports use the same filters and access options without pagination', async () => {
  const store = require('../src/store');
  const jobs = require('../src/web/ledger-export-jobs');
  const original = jobs.sendGeneralLedgerDownload;
  const modulePath = require.resolve('../src/web/routes/reports');
  const calls = [];
  jobs.sendGeneralLedgerDownload = async (req, res, filters, access, format) => {
    calls.push({ filters, access, format });
    await sendGeneralLedgerExport(res, report, format);
  };
  delete require.cache[modulePath];
  try {
    const handler = require(modulePath).stack.find(layer => layer.route?.path === '/general-ledger').route.stack[0].handle;
    const user = { role: 'standard', id: 33, permissions: ['reports.general-ledger.view'], scopes: {}, record_access: {} };
    const res = response();
    await handler({ query: { format: 'csv', account: 'Cash', q: 'Counter', from: '2026-10-01', page: '5' }, currentUser: user }, res, error => { throw error; });
    assert.equal(calls[0].format, 'csv');
    assert.equal(calls[0].access.ownerId, '33');
    assert.equal(calls[0].filters.account, 'Cash');
    assert.equal(calls[0].filters.search, 'Counter');
    assert.equal(calls[0].filters.party_scope, 'related');
    await handler({ query: { format: 'csv', party: 'Counter', party_scope: 'lines' }, currentUser: user }, response(), error => { throw error; });
    assert.equal(calls[1].filters.party_scope, 'lines');
    assert.match(res.body, /JE-204/);
  } finally { jobs.sendGeneralLedgerDownload = original; delete require.cache[modulePath]; }
});

test('General Ledger database export removes the page limit and retains access restrictions', { skip: process.env.GL_EXPORT_TEST_POSTGRES !== '1' }, async () => {
  const store = require('../src/store');
  const { seedGoldenData } = require('./helpers/golden-seed');
  try {
    await seedGoldenData();
    const pool = store.getPostgresPool();
    const account = (await pool.query('SELECT id FROM app_accounts ORDER BY id LIMIT 1')).rows[0].id;
    await pool.query(`INSERT INTO app_gl_entries (posting_date, account_id, debit, credit, voucher_type, voucher_id, voucher_no, line_no)
      SELECT '2026-10-08', $1, 10, 0, 'export_test', sequence, 'EXPORT-' || sequence, 1 FROM generate_series(1,205) sequence`, [account]);
    await pool.query(`UPDATE app_gl_entries SET party_id='LONUS-TEST', party_name='Lonus Test'
      WHERE voucher_type='sales_invoice' AND account_id IN
        (SELECT id FROM app_accounts WHERE account_name='Accounts Receivable')`);
    await pool.query(`INSERT INTO app_gl_entries
      (posting_date, account_id, debit, credit, voucher_type, voucher_id, voucher_no, line_no, party_id, party_name)
      SELECT posting_date, account_id, 25, 0, voucher_type, voucher_id, voucher_no, 999, party_id, party_name
      FROM app_gl_entries WHERE party_id='LONUS-TEST' ORDER BY id LIMIT 1`);
    const expected = await pool.query(`SELECT gl.id FROM app_gl_entries gl WHERE gl.party_id='LONUS-TEST' ORDER BY gl.posting_date,gl.id`);
    assert.ok(expected.rows.length > 1);
    const partyReport = await store.generalLedgerReport({ party: 'Lonus Test' }, { exportAll: true });
    assert.deepEqual(partyReport.rows.map(row => row.id), expected.rows.map(row => row.id));
    assert.ok(partyReport.rows.every(row => row.party_id === 'LONUS-TEST'));
    assert.deepEqual((await store.generalLedgerReport({ party: 'LONUS-TEST' }, { exportAll: true })).rows, partyReport.rows);
    const voucherReport = await store.generalLedgerReport({ search: partyReport.rows[0].voucher_no }, { exportAll: true });
    assert.ok(voucherReport.rows.some(row => !row.party_id));
    const partyPage = await store.generalLedgerReport({ party: 'Lonus Test', page_size: 1, page: 2 });
    assert.deepEqual(partyPage.rows, partyReport.rows.slice(1,2));
    assert.deepEqual(partyPage.summary, partyReport.summary);
    assert.equal((await store.generalLedgerReport({ party: 'Lonus Test' }, { allowedAccounts: [] })).rows.length, 0);
    const filters = { voucher_type: 'export_test', page: 4, page_size: 50 };
    const paged = await store.generalLedgerReport(filters);
    assert.equal(paged.rows.length, 50);
    const all = await store.generalLedgerReport(filters, { exportAll: true });
    assert.equal(all.rows.length, 205);
    assert.equal(all.rows[204].running_balance, 2050);
    assert.deepEqual(all.summary, paged.summary);
    assert.equal((await store.generalLedgerReport(filters, { exportAll: true, allowedAccounts: [] })).rows.length, 0);
    assert.equal((await store.generalLedgerReport(filters, { exportAll: true, deniedAccounts: [String(account)] })).rows.length, 0);
    assert.equal((await store.generalLedgerReport(filters, { exportAll: true, ownerId: '99999' })).rows.length, 0);
  } finally { await store.closeStore(); }
});

test('opening rows precede transactions and carry historical balances through pages and exports', {
  skip: process.env.GL_EXPORT_TEST_POSTGRES !== '1',
}, async () => {
  const store=require('../src/store');
  const {withGeneralLedgerExport}=require('../src/domain/ledger');
  const {seedGoldenData}=require('./helpers/golden-seed');
  try {
    await seedGoldenData();
    const pool=store.getPostgresPool();
    const accounts=(await pool.query('SELECT id,account_code FROM app_accounts ORDER BY id LIMIT 2')).rows;
    await pool.query(`INSERT INTO app_gl_entries(posting_date,account_id,debit,credit,voucher_type,voucher_id,voucher_no,line_no,party_id)
      VALUES ('2026-01-01',$1,100,0,'opening_test',9001,'OPEN-1',1,'OPEN-PARTY'),
      ('2026-01-01',$2,0,100,'opening_test',9001,'OPEN-1',2,NULL),
      ('2026-01-03',$1,20,0,'opening_test',9002,'OPEN-2',1,'OPEN-PARTY'),
      ('2026-01-03',$2,0,20,'opening_test',9002,'OPEN-2',2,NULL),
      ('2026-02-01',$1,999,0,'opening_test',9003,'OPEN-FUTURE',1,'OTHER'),
      ('2026-02-01',$2,0,999,'opening_test',9003,'OPEN-FUTURE',2,NULL)`,accounts.map(row=>row.id));
    const filters={voucher_type:'opening_test',from:'2026-01-03',to:'2026-01-03'};
    const all=await store.generalLedgerReport(filters,{exportAll:true});
    assert.deepEqual(all.opening_rows.map(row=>row.running_balance),[100,-100]);
    assert.deepEqual(all.rows.map(row=>row.running_balance),[120,-120]);
    assert.deepEqual(all.summary,{debit:20,credit:20,balance:0});
    assert.equal(all.pagination.total,2);
    for(const page of [1,2,3]) {
      const r=await store.generalLedgerReport({...filters,page,page_size:1});
      assert.deepEqual(r.rows,all.rows.slice(page-1,page));
      assert.deepEqual(r.opening_rows,all.opening_rows);
      assert.deepEqual(r.summary,all.summary);
      assert.equal(r.pagination.total,2);
    }
    const idle=await store.generalLedgerReport({...filters,from:'2026-01-04',to:'2026-01-04'});
    assert.equal(idle.rows.length,0);assert.deepEqual(idle.opening_rows.map(row=>row.running_balance),[120,-120]);
    const unrestricted=await store.generalLedgerReport({...filters,from:''});
    assert.ok(unrestricted.opening_rows.every(row=>row.running_balance===0));
    assert.deepEqual(unrestricted.summary,{debit:120,credit:120,balance:0});
    assert.equal(unrestricted.pagination.total,4);
    const beforeHistory=await store.generalLedgerReport({...filters,from:'2025-01-01',to:'2025-01-02'});
    assert.deepEqual(beforeHistory.opening_rows,[]);
    assert.deepEqual(beforeHistory.summary,{debit:0,credit:0,balance:0});
    assert.equal(beforeHistory.pagination.total,0);
    const party=await store.generalLedgerReport({...filters,party:'OPEN-PARTY'});
    assert.deepEqual(party.opening_rows.map(row=>row.running_balance),[100]);
    assert.deepEqual(party.rows.map(row=>row.running_balance),[120]);
    assert.deepEqual(party.summary,{debit:20,credit:0,balance:120});
    const creditAccount=await store.generalLedgerReport({...filters,account:accounts[1].account_code});
    assert.deepEqual(creditAccount.summary,{debit:0,credit:20,balance:-120});
    const idleParty=await store.generalLedgerReport({...filters,party:'OPEN-PARTY',from:'2026-01-04',to:'2026-01-04'});
    assert.deepEqual(idleParty.summary,{debit:0,credit:0,balance:120});
    await withGeneralLedgerExport({...filters,party:'OPEN-PARTY'},{},async streamed=>{
      assert.deepEqual(streamed.summary,party.summary);
      const csv=response();await sendGeneralLedgerExport(csv,{...streamed,rows:party.rows},'csv');
      assert.match(csv.body,/'?"Total","20","0","120"/);
    });
    for(const access of [{allowedAccounts:[]},{ownerId:'no-access'}]) {
      const hidden=await store.generalLedgerReport(filters,access);
      assert.deepEqual(hidden.opening_rows,[]);assert.deepEqual(hidden.rows,[]);
    }
    await withGeneralLedgerExport(filters,{},async r=>{
      const rows=[];for await(const row of r.rows)rows.push(row);
      assert.deepEqual(rows,all.rows);assert.deepEqual(r.opening_rows,all.opening_rows);
    },{batchSize:1});
    const csv=response();await sendGeneralLedgerExport(csv,all,'csv');
    assert.match(csv.body.split('\r\n')[1],/^"Opening balance"/);
    const xlsx=response();await sendGeneralLedgerExport(xlsx,all,'xlsx');
    const workbook=new (require('exceljs').Workbook)();await workbook.xlsx.load(xlsx.body);
    const sheet=workbook.getWorksheet('General Ledger');
    assert.equal(sheet.getCell('A2').value,'Opening balance');assert.equal(sheet.getCell('F2').value,100);
    assert.equal(sheet.getCell('F4').value,120);
    const {renderView}=require('./helpers/render-view');
    for(const report of [all,idle]) {
      const html=await renderView(require('node:path').join(__dirname,'..','views','general-ledger.ejs'),{
        report,query:{},filterOptions:{voucher_types:[]},currentUser:{role:'admin'},availableReports:[],
        assetVersion:'test',can:()=>false,money:value=>String(value),
      });
      assert.ok(html.indexOf('Opening balance</th>')<html.indexOf('No general ledger entries found') || report.rows.length);
      assert.match(html,/Opening balance<\/th>/);
      assert.match(html,/>Net Balance</);
      assert.match(html,/<summary class="button button-light">Download /);
      assert.match(html,/role="group" aria-label="Download format"/);
      for(const format of ['csv','xlsx','pdf']) assert.match(html,new RegExp('name="format" value="'+format+'"'));
    }
  }finally{await store.closeStore();}
});

test('party scope, complete voucher drilldown, account grouping and customer balances remain distinct', {
  skip: process.env.GL_EXPORT_TEST_POSTGRES !== '1',
}, async () => {
  const store=require('../src/store');
  const {withGeneralLedgerExport}=require('../src/domain/ledger');
  const {seedGoldenData,FIXED}=require('./helpers/golden-seed');
  try {
    const seed=await seedGoldenData();
    const pool=store.getPostgresPool();
    const filters={party:FIXED.customerId,party_scope:'related',group_by:'account'};
    const all=await store.generalLedgerReport(filters,{exportAll:true});
    const direct=await store.generalLedgerReport({party:FIXED.customerId},{exportAll:true});
    assert.ok(all.rows.length>direct.rows.length);
    assert.ok(all.rows.some(row=>row.account_name==='Sales Income'));
    assert.ok(all.rows.some(row=>row.account_name==='Cost of Goods Sold'));
    assert.ok(all.rows.some(row=>row.account_name==='Tax Payable'));
    assert.equal(all.summary.debit,all.summary.credit);
    assert.equal(all.customer_balances[0].balance,394);
    const explicitLines=await store.generalLedgerReport({party:FIXED.customerId,party_scope:'lines'});
    assert.equal(explicitLines.filters.party_scope,'lines');
    assert.equal(explicitLines.rows.some(row=>row.account_name==='Sales Income'),false);
    assert.deepEqual(all.rows.map(row=>row.account_code),all.rows.map(row=>row.account_code).sort());
    assert.ok(all.account_summaries.every(row=>row.closing_balance===row.opening_balance+row.debit-row.credit));
    for(const page of [1,2,3]) {
      const paged=await store.generalLedgerReport({...filters,page,page_size:2});
      assert.deepEqual(paged.rows,all.rows.slice((page-1)*2,page*2));
      assert.deepEqual(paged.account_summaries,all.account_summaries);
    }
    const narrowed=await store.generalLedgerReport({...filters,account:'Sales Income',search:'no such narration'});
    assert.equal(narrowed.rows.length,0);assert.equal(narrowed.customer_balances[0].balance,394);
    const detail=await store.generalLedgerReport({voucher_type:'sales_invoice',voucher_id:String(seed.invoiceId)},{exportAll:true});
    assert.ok(detail.rows.length>1);
    assert.ok(detail.rows.every(row=>row.voucher_type==='sales_invoice'&&String(row.voucher_id)===String(seed.invoiceId)));
    assert.equal(detail.summary.balance,0);
    await assert.rejects(store.generalLedgerReport({voucher_id:'1'}),{status:400});
    await assert.rejects(store.generalLedgerReport({voucher_type:'sales_invoice',voucher_id:'bad'}),{status:400});
    for(const access of [{allowedAccounts:[]},{ownerId:'no-access'}]) {
      const hidden=await store.generalLedgerReport(filters,access);
      assert.deepEqual(hidden.rows,[]);assert.deepEqual(hidden.customer_balances,[]);assert.deepEqual(hidden.account_summaries,[]);
      assert.deepEqual((await store.generalLedgerReport({voucher_type:'sales_invoice',voucher_id:String(seed.invoiceId)},access)).rows,[]);
    }
    const ar=(await pool.query("SELECT id FROM app_accounts WHERE account_name='Accounts Receivable'")).rows[0].id;
    const restricted=await store.generalLedgerReport(filters,{allowedAccounts:[String(ar)],exportAll:true});
    assert.ok(restricted.rows.length>0);assert.ok(restricted.rows.every(row=>row.account_name==='Accounts Receivable'));
    await withGeneralLedgerExport(filters,{},async report=>{
      const rows=[];for await(const row of report.rows)rows.push(row);
      assert.deepEqual(rows,all.rows);assert.deepEqual(report.customer_balances,all.customer_balances);
      assert.deepEqual(report.account_summaries,all.account_summaries);
    },{batchSize:2});
    const invoice=await store.findInvoice(seed.invoiceId);
    const cash=(await pool.query("SELECT id FROM app_accounts WHERE account_name='Cash'")).rows[0].id;
    const id=await store.createJournalEntry({journal_type:'cash_receipt',party_type:'customer',party_id:FIXED.customerId,
      party_name:FIXED.customerName,posting_date:FIXED.date,reference_no:invoice.invoice_no,remarks:'Allocated receipt',
      lines:[{account_id:cash,debit:50,credit:0},{account_id:ar,debit:0,credit:50}]});
    const receipt=await store.generalLedgerReport({voucher_type:'cash_receipt',voucher_id:String(id)},{exportAll:true});
    assert.equal(receipt.allocations.length,1);assert.equal(receipt.allocations[0].reference_no,invoice.invoice_no);
    assert.equal(receipt.allocations[0].credit,50);
    const {renderView}=require('./helpers/render-view');
    for(const report of [all,receipt]) {
      const html=await renderView(require('node:path').join(__dirname,'..','views','general-ledger.ejs'),{
        report,query:{},filterOptions:{voucher_types:[]},currentUser:{role:'admin'},availableReports:[],assetVersion:'test',can:()=>false,money:String,
      });
      assert.match(html,/Account Running Balance/);assert.match(html,/View posting/);assert.match(html,/Narration/);
      if(report===all){assert.match(html,/Balances by GL account/);assert.match(html,/Customer receivables/);assert.match(html,/scope="rowgroup"/);}
      else {assert.match(html,/Invoice allocations/);assert.match(html,/Displayed debit and credit totals balance/);}
    }
    const csv=response();await sendGeneralLedgerExport(csv,all,'csv');assert.match(csv.body,/Customer receivable/);assert.match(csv.body,/Account period summary/);
    const xlsx=response();await sendGeneralLedgerExport(xlsx,all,'xlsx');
    const workbook=new (require('exceljs').Workbook)();await workbook.xlsx.load(xlsx.body);assert.ok(workbook.getWorksheet('Ledger Review'));
    const pdf=response();await sendGeneralLedgerExport(pdf,receipt,'pdf');assert.equal(pdf.body.subarray(0,5).toString(),'%PDF-');
  }finally{await store.closeStore();}
});

test('supplier payable strips retain payment position, credit direction, as-of dates and access restrictions', {
  skip: process.env.GL_EXPORT_TEST_POSTGRES !== '1',
}, async () => {
  const store=require('../src/store');
  const {seedGoldenData}=require('./helpers/golden-seed');
  const {withGeneralLedgerExport}=require('../src/domain/ledger');
  try{
    await seedGoldenData();const pool=store.getPostgresPool();
    const account=async name=>(await pool.query('SELECT id FROM app_accounts WHERE account_name=$1',[name])).rows[0].id;
    const ap=await account('Accounts Payable');const cash=await account('Cash');const ar=await account('Accounts Receivable');
    await pool.query(`INSERT INTO app_gl_entries(posting_date,account_id,debit,credit,voucher_type,voucher_id,voucher_no,line_no,party_type,party_id,party_name)
      VALUES ('2026-01-01',$1,0,100,'supplier_strip',9001,'STRIP-OPEN',1,'supplier','STRIP-SUP','Supplier <Example>'),
      ('2026-01-01',$2,100,0,'supplier_strip',9001,'STRIP-OPEN',2,NULL,NULL,NULL),
      ('2026-01-02',$1,30,0,'supplier_strip',9002,'STRIP-PAY',1,'supplier','STRIP-SUP','Supplier <Example>'),
      ('2026-01-02',$2,0,30,'supplier_strip',9002,'STRIP-PAY',2,NULL,NULL,NULL),
      ('2026-01-03',$1,80,0,'supplier_strip',9003,'STRIP-ADVANCE',1,'supplier','STRIP-SUP','Supplier <Example>'),
      ('2026-01-03',$2,0,80,'supplier_strip',9003,'STRIP-ADVANCE',2,NULL,NULL,NULL),
      ('2026-01-04',$1,0,10,'supplier_strip',9004,'STRIP-SETTLE',1,'supplier','STRIP-SUP','Supplier <Example>'),
      ('2026-01-04',$2,10,0,'supplier_strip',9004,'STRIP-SETTLE',2,NULL,NULL,NULL),
      ('2026-01-01',$3,5,0,'supplier_strip',9005,'STRIP-CUSTOMER',1,'customer','STRIP-SUP','Customer same ID'),
      ('2026-01-01',$2,0,5,'supplier_strip',9005,'STRIP-CUSTOMER',2,NULL,NULL,NULL)`,[ap,cash,ar]);
    const filters={party:'STRIP-SUP',from:'2026-01-02',to:'2026-01-02',account:'Cash',search:'unmatched'};
    const r=await store.generalLedgerReport(filters);
    assert.equal(r.rows.length,0);assert.equal(r.supplier_balances[0].balance,70);assert.equal(r.customer_balances[0].balance,5);
    const reports=[r];
    for(const [to,balance] of [['2026-01-03',-10],['2026-01-04',0]]){
      const report=await store.generalLedgerReport({...filters,to});assert.equal(report.supplier_balances[0].balance,balance);reports.push(report);
    }
    for(const access of [{allowedAccounts:[]},{ownerId:'no-access'}]){
      const hidden=await store.generalLedgerReport(filters,access);assert.deepEqual(hidden.supplier_balances,[]);assert.deepEqual(hidden.customer_balances,[]);
    }
    const restricted=await store.generalLedgerReport(filters,{deniedAccounts:[String(ap)]});assert.deepEqual(restricted.supplier_balances,[]);
    await withGeneralLedgerExport(filters,{},async report=>{
      assert.deepEqual(report.supplier_balances,r.supplier_balances);
      const csv=response();await sendGeneralLedgerExport(csv,report,'csv');assert.match(csv.body,/Supplier payable/);assert.match(csv.body,/"70"/);
    });
    const {renderView}=require('./helpers/render-view');
    for(const [index,report] of reports.entries()){
      const html=await renderView(require('node:path').join(__dirname,'..','views','general-ledger.ejs'),{report,query:{},filterOptions:{voucher_types:[]},currentUser:{role:'admin'},availableReports:[],assetVersion:'test',can:()=>false,money:String});
      assert.match(html,/Supplier payables/);assert.match(html,/Customer receivables/);assert.match(html,/Supplier &lt;Example&gt;/);
      assert.equal((html.match(/Payment position/g)||[]).length,2);
      assert.match(html,new RegExp(['Outstanding payable','Supplier advance','Settled'][index]));
      assert.match(html,/Outstanding receivable/);
    }
    const xlsx=response();await sendGeneralLedgerExport(xlsx,r,'xlsx');
    const workbook=new (require('exceljs').Workbook)();await workbook.xlsx.load(xlsx.body);
    const review=workbook.getWorksheet('Ledger Review');let found=false;review.eachRow(row=>{if(row.getCell(1).value==='Supplier payable'){found=true;assert.equal(row.getCell(6).value,70);}});assert.equal(found,true);
    const pdf=response();await sendGeneralLedgerExport(pdf,r,'pdf');assert.equal(pdf.body.subarray(0,5).toString(),'%PDF-');
  }finally{await store.closeStore();}
});

test('export queue bounds workers, cancels queued work and limits PDF workers', async () => {
  const { ExportQueue } = require('../src/web/ledger-export-jobs');
  const queue = new ExportQueue({ workers: 2, pdfWorkers: 1, queue: 1, waitMs: 1000 });
  const pdf = await queue.acquire('pdf');
  const cancelled = new AbortController();
  const waitingPdf = queue.acquire('pdf', cancelled.signal);
  await assert.rejects(queue.acquire('pdf'), { status: 429 });
  cancelled.abort(new Error('closed'));
  await assert.rejects(waitingPdf, /closed/);
  const csv = await queue.acquire('csv');
  assert.equal(queue.active, 2);
  const waiting = queue.acquire('xlsx');
  csv();
  const xlsx = await waiting;
  assert.equal(queue.active, 2);
  xlsx(); pdf(); pdf();
  assert.equal(queue.active, 0);
  assert.equal(queue.pdfActive, 0);
});

test('export queue expires queued downloads and releases their place', async () => {
  const { ExportQueue } = require('../src/web/ledger-export-jobs');
  const queue = new ExportQueue({ workers: 1, pdfWorkers: 1, queue: 1, waitMs: 10 });
  const release = await queue.acquire('csv');
  await assert.rejects(queue.acquire('xlsx'), { status: 429 });
  assert.equal(queue.waiting.length, 0);
  release();
  (await queue.acquire('pdf'))();
});

test('streamed ledger snapshot retains balances across batches and releases its cursor after failures', {
  skip: process.env.GL_EXPORT_TEST_POSTGRES !== '1',
}, async () => {
  const store = require('../src/store');
  const { withGeneralLedgerExport } = require('../src/domain/ledger');
  const { seedGoldenData } = require('./helpers/golden-seed');
  try {
    await seedGoldenData();
    const pool = store.getPostgresPool();
    const account = (await pool.query('SELECT id FROM app_accounts ORDER BY id LIMIT 1')).rows[0].id;
    await pool.query(`INSERT INTO app_gl_entries (posting_date, account_id, debit, credit, voucher_type, voucher_id, voucher_no, line_no)
      SELECT '2026-10-08', $1, 10, 0, 'stream_test', sequence, 'STREAM-' || sequence, 1 FROM generate_series(1,12) sequence`, [account]);
    await pool.query(`INSERT INTO app_gl_entries
      (posting_date,account_id,debit,credit,voucher_type,voucher_no,line_no)
      VALUES ('2026-10-07',$1,1.23,0,'stream_test','OPENING',1)`,[account]);
    const filters = { voucher_type: 'stream_test', from:'2026-10-08', to:'2026-10-08', page: 5, page_size: 1 };
    const expected = await store.generalLedgerReport(filters, { exportAll: true });
    await withGeneralLedgerExport(filters, {}, async report => {
      assert.deepEqual(report.summary, expected.summary);
      assert.deepEqual(report.opening_rows, expected.opening_rows);
      const rows = [];
      for await (const row of report.rows) {
        rows.push(row);
        // Concurrent period and backdated inserts must not change this snapshot.
        if (rows.length === 1) await pool.query(`INSERT INTO app_gl_entries
          (posting_date,account_id,debit,credit,voucher_type,voucher_no,line_no)
          VALUES ('2026-10-08',$1,99,0,'stream_test','LATE',1),
            ('2026-10-07',$1,0,0.17,'stream_test','LATE-OPENING',1)`, [account]);
      }
      assert.deepEqual(rows, expected.rows);
    }, { batchSize: 3 });
    for (const access of [{ allowedAccounts: [] }, { deniedAccounts: [String(account)] }, { ownerId: '99999' }]) {
      await withGeneralLedgerExport(filters, access, async report => {
        const rows = []; for await (const row of report.rows) rows.push(row);
        assert.equal(rows.length, 0); assert.equal(report.pagination.total, 0);
      }, { batchSize: 2 });
    }
    await assert.rejects(withGeneralLedgerExport(filters, {}, async report => {
      for await (const row of report.rows) { assert.ok(row); throw new Error('output failed'); }
    }), /output failed/);
    assert.equal((await pool.query('SELECT 1 AS value')).rows[0].value, 1);
  } finally { await store.closeStore(); }
});

test('download workers generate files and clean up after completion or cancellation', {
  skip: process.env.GL_EXPORT_TEST_POSTGRES !== '1',
}, async () => {
  const { EventEmitter } = require('node:events');
  const { sendGeneralLedgerDownload } = require('../src/web/ledger-export-jobs');
  const store = require('../src/store');
  const { seedGoldenData } = require('./helpers/golden-seed');
  const fs = require('node:fs');
  const os = require('node:os');
  const leftovers = () => fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('wm-ledger-export-'));
  try {
    await seedGoldenData();
    const before = leftovers();
    for (const format of ['csv', 'xlsx', 'pdf']) {
      const req = new EventEmitter();
      const res = response();
      await sendGeneralLedgerDownload(req, res, {}, {}, format);
      assert.ok(res.body.length);
      assert.equal(res.writableFinished, true);
      assert.deepEqual(leftovers(), before);
    }
    const req = new EventEmitter();
    const res = response();
    const pending = sendGeneralLedgerDownload(req, res, {}, {}, 'pdf');
    await new Promise(resolve => setTimeout(resolve, 20));
    req.emit('aborted');
    await pending;
    assert.deepEqual(leftovers(), before);
    const jobsPath = require.resolve('../src/web/ledger-export-jobs');
    const original = process.env.LEDGER_EXPORT_JOB_TIMEOUT_MS;
    const previousModule = require.cache[jobsPath];
    process.env.LEDGER_EXPORT_JOB_TIMEOUT_MS = '5';
    delete require.cache[jobsPath];
    try {
      const { sendGeneralLedgerDownload: timedDownload } = require(jobsPath);
      await assert.rejects(timedDownload(new EventEmitter(), response(), {}, {}, 'pdf'), { status: 503 });
      assert.deepEqual(leftovers(), before);
    } finally {
      if (original === undefined) delete process.env.LEDGER_EXPORT_JOB_TIMEOUT_MS;
      else process.env.LEDGER_EXPORT_JOB_TIMEOUT_MS = original;
      require.cache[jobsPath] = previousModule;
    }
  } finally { await store.closeStore(); }
});

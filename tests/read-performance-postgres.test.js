'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const { seedGoldenData } = require('./helpers/golden-seed');
const { sqlLikePattern } = require('../src/lib/search');
const { clearReadCaches } = require('../src/read-cache');
const { invoiceSearchSql, journalSearchSql, invoiceTextOnlyPattern, textOnlyPattern } = require('../src/domain/search-sql');

test('optimized reads preserve filtered running balances, opening balances, search patterns and scoped concurrency', {
  skip: process.env.GL_EXPORT_TEST_POSTGRES !== '1',
}, async t => {
  try {
    await seedGoldenData();
    const pool = store.getPostgresPool();
    assert.match((await pool.query('SELECT current_database() name')).rows[0].name, /_hr_test$/);
    const indexes=await pool.query(`SELECT c.relname,i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      WHERE c.relname=ANY($1::text[])`,[['app_invoices_search_trgm_idx','app_journals_search_trgm_idx',
        'app_journals_sales_reference_idx','app_journals_customer_payments_idx','app_journal_lines_reference_idx','app_invoices_creator_id_idx','app_invoices_invoicer_id_idx','app_journals_payment_reference_idx','app_invoice_items_warehouse_lookup_idx']]);
    assert.equal(indexes.rows.length,9);assert.ok(indexes.rows.every(index=>index.indisvalid));
    await t.test('stock report pages match full-history balances after date, search and ownership filters', async () => {
      await pool.query(`INSERT INTO app_stock_ledger
        (posting_date,movement_at,item_code,item_name,warehouse,voucher_type,voucher_no,
         qty_change,qty_after_transaction,stock_value_after_transaction)
        SELECT date '2026-01-01' + (n%5)::int,
          CASE WHEN n%7=0 THEN NULL ELSE
            timestamp with time zone '2026-01-01 10:00:00+00' + (n%3)*interval '1 minute' END,
          'READ-STOCK-'||(n%3), 'Read stock', 'READ-W-'||(n%2), 'read_test',
          'READ-STOCK-'||n, CASE WHEN n%4=0 THEN -1 ELSE 3 END, -999, 0
        FROM generate_series(1,180) n`);
      // Insert order differs from chronology; stored balances deliberately cannot
      // substitute for the full chronological window used by this report.
      const reference = (await pool.query(`SELECT voucher_no, balance_qty::float AS qty_after_transaction
        FROM (SELECT *, SUM(qty_change) OVER (PARTITION BY item_code,warehouse
          ORDER BY posting_date,movement_at,id ROWS UNBOUNDED PRECEDING) balance_qty
          FROM app_stock_ledger) history
        WHERE voucher_type='read_test' ORDER BY posting_date,movement_at,id`)).rows;
      for (const filters of [{}, {from:'2026-01-03',to:'2026-01-04'},
        {warehouse:'READ-W-1'}, {search:'READ-STOCK-1'}, {ownerId:'missing-owner'}]) {
        const all = await store.stockLedgerReport({...filters,page_size:200});
        const expected = reference.filter(row => all.rows.some(actual=>actual.voucher_no===row.voucher_no));
        assert.deepEqual(all.rows.filter(row=>row.voucher_type==='read_test')
          .map(({voucher_no,qty_after_transaction})=>({voucher_no,qty_after_transaction})),expected);
        for (const page of [1,2,4,20]) {
          const actual = await store.stockLedgerReport({...filters,page,page_size:50});
          assert.deepEqual(actual.rows,all.rows.slice((page-1)*50,page*50));
          assert.equal(actual.pagination.total,all.pagination.total);
        }
      }
    });
    const accounts = (await pool.query('SELECT id,account_code FROM app_accounts ORDER BY id LIMIT 2')).rows;
    const account = accounts[0];
    await pool.query(`INSERT INTO app_gl_entries(posting_date,account_id,debit,credit,voucher_type,voucher_id,voucher_no,line_no,party_name)
      SELECT date '2026-01-01'+(n%7)::int, CASE WHEN n%2=0 THEN $1::bigint ELSE $2::bigint END,
        CASE WHEN n%3=0 THEN 0 ELSE n::numeric/100 END,CASE WHEN n%3=0 THEN n::numeric/100 ELSE 0 END,
        'read_test',n,'READ-'||n,1,CASE WHEN n%2=0 THEN 'Alpha' ELSE 'Beta' END
      FROM generate_series(1,211) n`, accounts.map(x => x.id));
    // Several pages on one date, then backdated entries with higher IDs.
    await pool.query(`INSERT INTO app_gl_entries(posting_date,account_id,debit,credit,voucher_type,voucher_id,voucher_no,line_no,party_name)
      SELECT CASE WHEN n<=120 THEN date '2026-01-04' ELSE date '2025-12-31' END,
        CASE WHEN n%2=0 THEN $1::bigint ELSE $2::bigint END,
        CASE WHEN n%3=0 THEN 0 ELSE n END,CASE WHEN n%3=0 THEN n ELSE 0 END,
        'read_test',1000+n,'READ-BACKDATED-'||n,1,CASE WHEN n%2=0 THEN 'Alpha' ELSE 'Beta' END
      FROM generate_series(1,140) n`, accounts.map(x => x.id));
    await require('../src/audit').runWithAuditUser({id:'READ-A',username:'Read A'}, () => store.createJournalEntry({
      journal_type:'journal_entry',posting_date:'2026-01-04',remarks:'Read owner fixture',
      lines:Array.from({length:60},(_,i)=>({account_id:accounts[i<30?0:1].id,debit:i<30?10:0,credit:i<30?0:10})),
    }));
    await pool.query(`INSERT INTO app_gl_entries(posting_date,account_id,debit,credit,voucher_type,voucher_id,voucher_no,line_no,party_id)
      VALUES ('2026-01-04',$1,20,0,'hr_payroll',90001,'READ-HR-1',1,'READ-E1'),
        ('2026-01-04',$1,30,0,'hr_payroll',90002,'READ-HR-2',1,'READ-E2')`,[account.id]);
    await t.test('pages and summaries match full-window reference across account, party, search and access filters', async () => {
      const cases = [
        [{voucher_type:'read_test'}, {}],
        [{voucher_type:'read_test',from:'2026-01-02',to:'2026-01-06'}, {}],
        [{voucher_type:'read_test',from:'2026-01-04',to:'2026-01-04'}, {}],
        [{voucher_type:'read_test',account:account.account_code}, {}],
        [{voucher_type:'read_test',party:'Alpha'}, {}],
        [{voucher_type:'read_test',search:'READ-1'}, {}],
        [{voucher_type:'read_test'}, {allowedAccounts:[String(account.id)]}],
        [{voucher_type:'read_test'}, {deniedAccounts:[String(account.id)]}],
        [{voucher_type:'read_test'}, {allowedAccounts:[]}],
        [{voucher_type:'read_test'}, {ownerId:'nobody'}],
        [{voucher_type:'read_test'}, {hrAccess:{payroll:false,money:false}}],
        [{voucher_type:'journal_entry'}, {ownerId:'READ-A'}],
        [{voucher_type:'journal_entry',account:account.account_code}, {ownerId:'READ-A',allowedAccounts:accounts.map(a=>String(a.id))}],
        [{}, {ownerId:'READ-A',hrAccess:{payroll:true,money:false,employees:['READ-E1']}}],
        [{from:'2026-01-02',to:'2026-01-06'}, {ownerId:'READ-A',ownerEmployeeId:'READ-E1',hrAccess:{payroll:false,money:false,employees:['READ-E1'],deniedEmployees:['READ-E2'],costCenters:['HR Shop'],deniedCostCenters:['Other Shop']}}],
        [{voucher_type:'hr_payroll'}, {hrAccess:{payroll:true,money:false,deniedEmployees:['READ-E2']}}],
      ];
      for (const [filters,access] of cases) {
        const reference = await store.generalLedgerReport(filters, {...access,exportAll:true});
        for (const page of [1,2,4,20]) {
          const actual = await store.generalLedgerReport({...filters,page,page_size:50},access);
          assert.deepEqual(actual.rows,reference.rows.slice((page-1)*50,page*50));
          assert.deepEqual(actual.summary,reference.summary);
          assert.equal(actual.pagination.total,reference.rows.length);
        }
      }
      const [all,none] = await Promise.all([
        store.generalLedgerReport({voucher_type:'read_test'}),
        store.generalLedgerReport({voucher_type:'read_test'},{allowedAccounts:[]}),
      ]);
      assert.equal(all.rows.length,50); assert.equal(none.rows.length,0);
      for (const owner of [{}, {ownerId:'READ-A',ownerEmployeeId:'READ-E1'}]) {
        const filters={from:'2026-01-02',to:'2026-01-06'};
        const deniedHr={payroll:false,money:false};
        const expected=await store.generalLedgerReport(filters,{...owner,hrAccess:deniedHr});
        const restricted=await store.generalLedgerReport(filters,{...owner,hrAccess:{...deniedHr,
          employees:['READ-E1'],deniedEmployees:['READ-E2'],costCenters:['HR Shop'],deniedCostCenters:['Other Shop']}});
        assert.deepEqual(restricted,expected,'HR record restrictions preserve permitted non-HR results when HR access is denied');
        assert.ok(restricted.rows.every(row=>!row.voucher_type.startsWith('hr_')));
      }
      const [upper,lower]=await Promise.all([
        store.generalLedgerReport({voucher_type:'read_test',party:'Alpha'}),
        store.generalLedgerReport({voucher_type:'read_test',party:'alpha'}),
      ]);
      assert.deepEqual(upper.rows,lower.rows);
      assert.equal(upper.filters.party,'Alpha');assert.equal(lower.filters.party,'alpha');
    });
    await t.test('streamed exports match full-history windows for daily openings and detailed restrictions', async () => {
      const { withGeneralLedgerExport } = require('../src/domain/ledger');
      const period = {from:'2026-01-04',to:'2026-01-06'};
      const cases = [
        [{}, {}],
        [{to:'2026-01-04'}, {}],
        [period, {}],
        [{from:'2026-01-04',to:'2026-01-04'}, {}],
        [{from:'2025-01-01',to:'2025-01-02'}, {}],
        [{from:'2026-10-01',to:'2026-10-02'}, {}],
        [{...period,account:account.account_code}, {}],
        [{...period,voucher_type:'read_test'}, {}],
        [{...period,voucher_type:'read_test',voucher_id:'1001'}, {}],
        [{...period,party:'Alpha'}, {}],
        [{...period,search:'READ-'}, {}],
        [period, {allowedAccounts:[String(account.id)]}],
        [period, {deniedAccounts:[String(account.id)]}],
        [period, {allowedAccounts:[]}],
        [period, {ownerId:'nobody'}],
        [period, {ownerId:'READ-A',allowedAccounts:accounts.map(a=>String(a.id))}],
        [period, {hrAccess:{payroll:false,money:false}}],
        [period, {hrAccess:{payroll:true,money:false,employees:['READ-E1']}}],
        [{from:'2026-01-05',to:'2026-01-06'}, {hrAccess:{payroll:true,money:false,deniedEmployees:['READ-E2']}}],
        [period, {hrAccess:{payroll:true,money:false,costCenters:[],deniedCostCenters:['Other Shop']}}],
        [period, {ownerId:'READ-A',ownerEmployeeId:'READ-E1',hrAccess:{payroll:true,money:false,employees:['READ-E1']}}],
      ];
      for (const [filters,access] of cases) for (const group_by of [undefined,'account']) {
        const selected = {...filters,group_by};
        // exportAll deliberately retains the full-history window as an
        // independent reference for the streaming period-only window.
        const reference = await store.generalLedgerReport(selected,{...access,exportAll:true});
        await withGeneralLedgerExport(selected,access,async report => {
          const rows=[];
          for await (const row of report.rows) rows.push(row);
          const label=JSON.stringify({selected,access});
          assert.deepEqual(rows,reference.rows,label);
          assert.deepEqual(report.opening_rows,reference.opening_rows,label);
          assert.deepEqual(report.summary,reference.summary,label);
          assert.deepEqual(report.account_summaries,reference.account_summaries,label);
          assert.equal(report.pagination.total,reference.rows.length,label);
        },{batchSize:7});
      }
    });
    await t.test('a concurrent commit cannot mix report totals and page rows', async () => {
      const original = pool.connect.bind(pool); let inserted = false;
      pool.connect = (...args) => {
        if (typeof args[0] === 'function') return original(...args);
        return original(...args).then(client => {
        const query = client.query.bind(client);
        client.query = async (...args) => {
          const result = await query(...args);
          if (!inserted && /::int AS total,/.test(String(args[0]))) {
            inserted = true;
            await pool.query(`INSERT INTO app_gl_entries(posting_date,account_id,debit,credit,voucher_type,voucher_no,line_no)
              VALUES ('2026-01-01',$1,99,0,'read_test','LATE-READ',1)`,[account.id]);
          }
          return result;
        };
        const release = client.release.bind(client);
        client.release = error => { client.query = query; release(error); };
        return client;
        });
      };
      try {
        const report = await store.generalLedgerReport({voucher_type:'read_test',page_size:200});
        assert.equal(report.pagination.total,351);
        assert.equal(report.rows.some(row => row.voucher_no==='LATE-READ'),false);
      } finally { pool.connect = original; }
      assert.equal((await store.generalLedgerReport({voucher_type:'read_test'})).pagination.total,352);
    });
    await t.test('trial balance retains opening history and rejects reversed dates', async () => {
      const report = await store.trialBalanceReport({from:'2026-01-03',to:'2026-01-05'});
      const reference = await pool.query(`SELECT account.account_code,
        COALESCE(sum(CASE WHEN posting_date<'2026-01-03' THEN debit-credit ELSE 0 END),0)::float opening,
        COALESCE(sum(CASE WHEN posting_date BETWEEN '2026-01-03' AND '2026-01-05' THEN debit ELSE 0 END),0)::float debit,
        COALESCE(sum(CASE WHEN posting_date BETWEEN '2026-01-03' AND '2026-01-05' THEN credit ELSE 0 END),0)::float credit,
        COALESCE(sum(CASE WHEN posting_date<='2026-01-05' THEN debit-credit ELSE 0 END),0)::float closing
        FROM app_accounts account LEFT JOIN app_gl_entries gl ON gl.account_id=account.id
        WHERE NOT account.is_group AND account.is_active GROUP BY account.id`);
      for (const row of report.rows) {
        const expected = reference.rows.find(r => r.account_code===row.account_code);
        const { formatTrialBalanceRow } = require('../src/domain/normalization');
        assert.deepEqual(row, formatTrialBalanceRow({ ...row,
          opening_balance: expected.opening, period_debit: expected.debit,
          period_credit: expected.credit, closing_balance: expected.closing }));
      }
      await assert.rejects(store.trialBalanceReport({from:'2026-02-01',to:'2026-01-01'}),{status:400});
    });
    await t.test('indexed candidate prefilters preserve per-field LIKE anchoring and escapes', async () => {
      await pool.query(`INSERT INTO app_invoices(invoice_no,invoice_date,customer_name,non_system_invoice)
        VALUES ('INV-ESCAPE','2026-01-01','Search Customer','external_ref'),
          ('Search-Invoice','2026-01-01','Other','outside\\reference')`);
      await pool.query(`INSERT INTO app_journal_entries(journal_no,journal_type,posting_date,remarks)
        VALUES ('JRN-SEARCH','journal_entry','2026-01-01','Search Customer'),
        ('Other-Journal','cash_receipt','2026-01-01','outside_ref')`);
      for (const input of ['Search','Search%','Customer','external\\_ref','outside_ref','outside%ref','draft','paid','123','%']) {
        const pattern=sqlLikePattern(input.toLowerCase());
        const invoices=await store.paginatedInvoices({search:input});
        // Hydrate the full invoice list to obtain authoritative computed statuses,
        // then apply PostgreSQL LIKE to each individual field as the old query did.
        const all=await store.paginatedInvoices({page_size:200});
        const ids=[];
        for(const row of all.rows){
          const external=(await pool.query('SELECT non_system_invoice FROM app_invoices WHERE id=$1',[row.id])).rows[0].non_system_invoice;
          const match=await pool.query(`SELECT EXISTS(SELECT 1 FROM unnest($1::text[]) value WHERE lower(value) LIKE $2) matched`,
            [[row.invoice_no,external,row.invoice_date,row.customer_name,Number(row.total).toFixed(2),Number(row.amount_paid).toFixed(2),row.status,row.docstatus],pattern]);
          if(match.rows[0].matched)ids.push(Number(row.id));
        }
        assert.deepEqual(invoices.rows.map(r=>r.id),ids,input);
        if(invoiceTextOnlyPattern(pattern)) {
          const check=await pool.query(`SELECT id FROM app_invoices WHERE ${invoiceSearchSql()} LIKE $1`,[`%${pattern}%`]);
          for(const id of ids)assert.ok(check.rows.some(row=>Number(row.id)===id));
        }
        const journals=await store.journalEntries({search:input});
        if(textOnlyPattern(pattern)) {
          const candidates=await pool.query(`SELECT id FROM app_journal_entries WHERE ${journalSearchSql()} LIKE $1`,[`%${pattern}%`]);
          for(const row of journals)assert.ok(candidates.rows.some(candidate=>Number(candidate.id)===row.id));
        }
      }
      clearReadCaches();
    });
    await t.test('count-free lists fetch one extra row and retain scoped exact totals on demand', async () => {
      clearReadCaches();
      const exact = await store.paginatedInvoices({page_size:1});
      const calls = [], original = pool.query, originalConnect = pool.connect;
      pool.connect = function(...args) {
        if (typeof args[0] === 'function') return originalConnect.apply(this,args);
        return originalConnect.apply(this,args).then(client => {
          const query = client.query, release = client.release;
          client.query = function(...queryArgs) { calls.push(String(queryArgs[0])); return query.apply(this,queryArgs); };
          client.release = function(error) { client.query=query; client.release=release; return release.call(this,error); };
          return client;
        });
      };
      pool.query = function(...args) { calls.push(String(args[0])); return original.apply(this,args); };
      try {
        const [page, duplicate] = await Promise.all([store.paginatedInvoices({page_size:1,includeTotal:false}),store.paginatedInvoices({page_size:1,includeTotal:false})]);
        assert.deepEqual(page,duplicate);
        assert.equal(calls.filter(sql=>sql.includes('WITH selected_invoices AS MATERIALIZED')).length,1);
        assert.equal(page.rows.length,1);assert.equal(page.pagination.total,null);
        assert.equal(page.pagination.has_next,exact.pagination.total>1);
        assert.deepEqual(page.rows,exact.rows);
        const journals = await store.journalEntries({page_size:1,includeTotal:false});
        assert.equal(journals.length,1);assert.equal(journals.pagination.total,null);
        assert.equal(calls.some(sql=>/SELECT COUNT\(\*\)::int AS total/.test(sql)),false);
        const none = await store.paginatedInvoices({includeTotal:false,ownerId:'invisible-owner'});
        assert.equal(none.rows.length,0);assert.equal(none.pagination.has_next,false);
        const last = await store.paginatedInvoices({includeTotal:false,page:999,page_size:1});
        assert.equal(last.rows.length,0);assert.equal(last.pagination.has_previous,true);
      } finally { pool.query = original; pool.connect = originalConnect; }
    });
    await t.test('creator and assigned employee pages preserve access, ordering and deduplication', async () => {
      const {runWithAuditUser}=require('../src/audit');
      for(const owner of ['OWNER-A','OWNER-B','OWNER-C']) {
        await runWithAuditUser({id:owner,username:owner},()=>pool.query(`INSERT INTO app_invoices
          (invoice_no,invoice_date,customer_name,invoicer_id)
          SELECT $1||'-'||n,'2026-01-04','Ownership Regression',
            CASE WHEN n%3=0 THEN 'EMP-A' ELSE 'EMP-B' END FROM generate_series(1,60) n`,[owner]));
      }
      for(const [ownerId,ownerEmployeeId] of [['OWNER-A',null],['OWNER-A','EMP-A'],
        ['nobody','EMP-A'],['nobody','missing'],['nobody',null],['OWNER-B','EMP-B']]) {
        for(const order of ['asc','desc']) {
          const reference=await pool.query(`SELECT id FROM app_invoices WHERE customer_name='Ownership Regression'
            AND (created_by_user_id=$1 OR ($2::text IS NOT NULL AND invoicer_id=$2)) ORDER BY id ${order}`,
          [ownerId,ownerEmployeeId]);
          for(const page of [1,2,9,100]) {
            const options={ownerId,ownerEmployeeId,order,page,page_size:7,search:'Ownership Regression'};
            const actual=await store.paginatedInvoices({...options,includeTotal:false});
            const expected=reference.rows.slice((page-1)*7,page*7).map(row=>Number(row.id));
            assert.deepEqual(actual.rows.map(row=>row.id),expected);
            assert.equal(actual.pagination.has_next,reference.rows.length>page*7);
            const exact=await store.paginatedInvoices(options);
            assert.equal(exact.pagination.total,reference.rows.length);
            assert.deepEqual(exact.rows,actual.rows);
          }
        }
      }
      const restricted=await store.paginatedInvoices({ownerId:'OWNER-A',ownerEmployeeId:'EMP-A',
        search:'Ownership Regression',allowedGroups:[],includeTotal:false});
      assert.equal(restricted.rows.length,0,'ownership never bypasses category restrictions');
    });
    await t.test('a queued report shares a fresh post-commit snapshot without retaining stale totals', async () => {
      const {runHeavyReport,workloadMetrics}=require('../src/workload-control');
      const {clearReadCaches}=require('../src/read-cache');clearReadCaches();
      let release;const blocking=runHeavyReport(()=>new Promise(resolve=>{release=resolve;}));
      const filters={search:'QUEUED-COMMIT'};let first,second;
      const post=()=>store.createJournalEntry({journal_type:'journal_entry',posting_date:'2026-01-04',remarks:'QUEUED-COMMIT',
        lines:[{account_id:accounts[0].id,debit:7,credit:0},{account_id:accounts[1].id,debit:0,credit:7}]});
      try {
        first=store.generalLedgerReport(filters);
        await new Promise(resolve=>setImmediate(resolve));
        assert.equal(workloadMetrics().reports.queued,1);
        await post();second=store.generalLedgerReport(filters);
        await new Promise(resolve=>setImmediate(resolve));
        assert.equal(workloadMetrics().reports.queued,1,'commit does not duplicate a report whose snapshot has not started');
      } finally {release();await blocking;}
      const [a,b]=await Promise.all([first,second]);
      assert.equal(a,b);assert.equal(b.rows.length,2);assert.equal(b.summary.debit,7);
      await post();const fresh=await store.generalLedgerReport(filters);
      assert.equal(fresh.rows.length,4);assert.equal(fresh.summary.debit,14);
      const hidden=await store.generalLedgerReport(filters,{ownerId:'nobody'});
      assert.equal(hidden.rows.length,0);
    });
    await t.test('warehouse choices match distinct historical values including legacy and empty codes', async () => {
      const {clearReadCaches}=require('../src/read-cache');clearReadCaches();
      const invoice=(await pool.query('SELECT invoice_pk AS id,invoice_no FROM app_invoice_items ORDER BY id LIMIT 1')).rows[0];
      const original=(await pool.query('SELECT * FROM app_invoice_items WHERE invoice_pk=$1 ORDER BY line_no LIMIT 1',[invoice.id])).rows[0];
      assert.ok(original);
      for(const [n,warehouse] of ['Legacy warehouse','lower case','UPPER CASE','Warehouse_%',null,'',' '].entries()) {
        await pool.query(`INSERT INTO app_invoice_items(invoice_pk,line_no,item_code,item_name,quantity,unit_price,line_total,warehouse,invoice_no,invoice_id,cost_rate,cost_amount,gross_profit)
          VALUES ($1,$2,$3,$4,1,1,1,$5,$6,$7,0,0,1)`,[invoice.id,9000+n,original.item_code,original.item_name,warehouse,invoice.invoice_no,original.invoice_id]);
      }
      try {
        const expected=(await pool.query(`SELECT DISTINCT warehouse FROM app_invoice_items
          WHERE COALESCE(warehouse,'')<>'' ORDER BY warehouse`)).rows.map(row=>row.warehouse);
        assert.deepEqual(await store.invoiceWarehouses(),expected);
      } finally {
        await pool.query('DELETE FROM app_invoice_items WHERE invoice_pk=$1 AND line_no>=9000',[invoice.id]);
        clearReadCaches();
      }
    });
    await t.test('blocked expensive reads leave pool connections for a financial transaction', async () => {
      const {runExpensiveRead,runInteractiveRead,workloadMetrics}=require('../src/workload-control');
      for (const classify of [runExpensiveRead,runInteractiveRead]) {
      const client=await pool.connect(), key=1901026415, limit=workloadMetrics().read_connection_limit;
      await client.query('SELECT pg_advisory_lock($1)',[key]);
      let reads;
      try {
        reads=classify(()=>Promise.all(Array.from({length:limit*2},()=>pool.query('SELECT pg_advisory_xact_lock($1)',[key]))));
        for(let n=0;n<100&&workloadMetrics().reads?.active!==limit;n++)await new Promise(r=>setTimeout(r,10));
        assert.equal(workloadMetrics().reads.active,limit);
        await store.createJournalEntry({journal_type:'journal_entry',posting_date:'2026-01-04',remarks:'Reserved posting capacity',
          lines:[{account_id:accounts[0].id,debit:1,credit:0},{account_id:accounts[1].id,debit:0,credit:1}]});
        assert.equal(workloadMetrics().reads.active,limit,'financial write finished while expensive reads remained blocked');
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)',[key]);client.release();if(reads)await reads;
      }
      }
    });
  } finally { await store.closeStore(); }
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createReportGate, measurePosting, postingStage } = require('../src/workload-control');
test('reports queue in order, reject overflow, and release capacity on failure', async () => {
  const gate = createReportGate({ limit: 1, maxQueue: 1, timeoutMs: 1000 });
  let finish; const order = [];
  const first = gate(() => new Promise(resolve => { finish = resolve; }));
  const second = gate(async () => { order.push(2); throw Error('query failed'); });
  const secondCheck = assert.rejects(second, /query failed/);
  await assert.rejects(gate(async () => 3), error => error.status === 503);
  finish(1); assert.equal(await first, 1); await secondCheck;
  assert.equal(await gate(async () => 4), 4); assert.deepEqual(order, [2]);
});
test('expired and cancelled queue entries never execute or leak a slot', async () => {
  const gate = createReportGate({ limit: 1, maxQueue: 3, timeoutMs: 15 });
  let finish; const first = gate(() => new Promise(resolve => { finish = resolve; }));
  let executed = false;
  await assert.rejects(gate(async () => { executed = true; }), error => error.code === 'REPORT_BUSY');
  const controller = new AbortController();
  const cancelled = gate(async () => { executed = true; }, { signal: controller.signal });
  controller.abort(Error('cancelled'));
  await assert.rejects(cancelled, /cancelled/);
  finish(); await first;
  assert.equal(executed, false); assert.equal(await gate(async () => 'ok'), 'ok');
});
test('posting timing isolates concurrent contexts and logs failed operations without payloads', async () => {
  const previous = process.env.POSTING_TIMINGS; const log = console.info; const records = [];
  process.env.POSTING_TIMINGS = '1'; console.info = value => records.push(JSON.parse(value));
  try {
    await Promise.all([
      measurePosting('one', () => postingStage('stock', async () => 1)),
      assert.rejects(measurePosting('two', () => postingStage('accounting', async () => { throw Error('private data'); })), /private data/),
    ]);
    assert.equal(records.length, 2);
    assert.deepEqual(Object.keys(records.find(r => r.operation === 'one').stages_ms), ['stock']);
    assert.equal(records.find(r => r.operation === 'two').success, false);
    assert.ok(!JSON.stringify(records).includes('private data'));
  } finally { console.info = log; if (previous === undefined) delete process.env.POSTING_TIMINGS; else process.env.POSTING_TIMINGS = previous; }
});
test('inventory movement batches use one database validation entry point', async () => {
  const posting = require('../src/services/inventory-posting');
  const calls = [];
  const movements = [
    { item_code: 'A', warehouse: 'Main', voucher_type: 'invoice', voucher_id: 7, qty_change: -1 },
    { item_code: 'B', warehouse: 'Main', voucher_type: 'invoice', voucher_id: 7, qty_change: -2 },
  ];
  const client = {
    query: async (sql, params) => {
      if (sql.includes('to_regprocedure')) return { rows: [{ exists: true }] };
      if (sql.includes('wm_inventory_enabled()')) return { rows: [{ enabled: true }] };
      if (sql.includes('wm_inventory_apply_batch')) {
        calls.push({ sql, params });
        return { rows: [{ movements: [{ ledger_id: 1, qty_change: -1 }, { ledger_id: 2, qty_change: -2 }] }] };
      }
      throw Error(`Unexpected query: ${sql}`);
    },
  };
  posting.inventorySchemaReady();
  await posting.loadTransactionMode(client);
  const result = await posting.inventoryMovements(client, movements);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].params[0]), movements);
  assert.deepEqual(result.map(row => row.qty_change), [-1, -2]);
});

test('expensive read lease budget is shared while ordinary work acquires no reader lease', async () => {
 const {runExpensiveRead,acquireReadLease,workloadMetrics}=require('../src/workload-control');
 const limit=workloadMetrics().read_connection_limit;
 let unlock;
 const pending=runExpensiveRead(async()=>{
  const releases=await Promise.all(Array.from({length:limit},()=>acquireReadLease()));
  await new Promise(resolve=>{unlock=()=>{releases.forEach(release=>release());resolve();};});
 });
 while(!unlock)await new Promise(r=>setImmediate(r));
 try {
  assert.equal(workloadMetrics().reads.active,limit);
  const ordinary=await acquireReadLease();ordinary();
  assert.equal(workloadMetrics().reads.active,limit,'ordinary checkout does not wait for or consume reader capacity');
 }finally{unlock();await pending;}
});

test('queued reports leave list admission available and interactive reads share the hard budget', async () => {
 const {runHeavyReport,runExpensiveRead,runInteractiveRead,runSessionRead,acquireReadLease,workloadMetrics,requestReadBudget}=require('../src/workload-control');
 let finish;
 const first=runHeavyReport(()=>new Promise(resolve=>{finish=resolve;}));
 const second=runHeavyReport(async()=>2);
 try {
  assert.equal(await runExpensiveRead(async()=>7),7,'report queue does not hold list slots');
  assert.equal(workloadMetrics().reports.queued,1);
 }finally{finish();await first;await second;}
 const limit=workloadMetrics().read_connection_limit;
 await runInteractiveRead(async()=>{
  const releases=await Promise.all(Array.from({length:limit},()=>acquireReadLease()));
  let entered=false;
  const extra=acquireReadLease().then(release=>{entered=true;release();});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(entered,false);
  let sessionEntered=false;
  const session=runSessionRead(()=>acquireReadLease()).then(release=>{sessionEntered=true;release();});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(sessionEntered,true,'session work does not wait for page-read capacity');
  await session;
  releases.pop()();await extra;releases.forEach(release=>release());
 });
 const {connectionWorkload}=require('../src/workload-control');
 requestReadBudget({method:'GET'},null,()=>assert.equal(connectionWorkload(),'interactive'));
 requestReadBudget({method:'POST'},null,()=>assert.equal(connectionWorkload(),'unclassified'));
 requestReadBudget({method:'POST',path:'/api/invoice-stock-balances'},null,()=>assert.equal(connectionWorkload(),'interactive'));
 requestReadBudget({method:'POST',path:'/api/invoice-stock-balances/'},null,()=>assert.equal(connectionWorkload(),'interactive'));
 requestReadBudget({method:'POST',path:'/invoices/1/submit'},null,()=>assert.equal(connectionWorkload(),'unclassified'));
 assert.equal(workloadMetrics().reads.active,0);
});

test('ledger and inventory report lanes isolate head-of-line blocking and record queue and execution time', async () => {
 const {runHeavyReport,workloadMetrics}=require('../src/workload-control');
 let release;
 const blocked=runHeavyReport(()=>new Promise(resolve=>{release=resolve;}),
   {lane:'ledger',label:'lane-ledger'});
 try {
  const inventory=await runHeavyReport(async()=>{
   await new Promise(resolve=>setTimeout(resolve,5));
   return 'inventory-finished';
  }, {lane:'inventory',label:'lane-inventory'});
  assert.equal(inventory,'inventory-finished');
  const queued=runHeavyReport(async()=>2,{lane:'ledger',label:'lane-ledger-queued'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(workloadMetrics().report_lanes.ledger.queued,1);
  release();await blocked;assert.equal(await queued,2);
 } finally {
  release?.();
 }
 const timings=workloadMetrics().report_timings;
 assert.ok(timings['inventory:lane-inventory'].execution_mean_ms>=4);
 assert.ok(timings['ledger:lane-ledger-queued'].queue_wait_mean_ms>=0);
 const previous=process.env.REPORT_TIMINGS;
 const log=console.info;
 const records=[];
 process.env.REPORT_TIMINGS='1';console.info=value=>records.push(JSON.parse(value));
 try {
  await runHeavyReport(async()=>3,{lane:'inventory',label:'lane-timed'});
 } finally {
  console.info=log;
  if(previous===undefined)delete process.env.REPORT_TIMINGS;else process.env.REPORT_TIMINGS=previous;
 }
 assert.deepEqual(records.map(record=>({event:record.event,lane:record.lane,report:record.report,success:record.success})),
   [{event:'report_timing',lane:'inventory',report:'lane-timed',success:true}]);
 assert.ok(Number.isFinite(records[0].queue_wait_ms));
 assert.ok(Number.isFinite(records[0].execution_ms));
});

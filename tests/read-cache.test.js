'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { shareRead, invalidateFinancialReads, clearReadCaches, readSnapshot, readParallelSnapshot } = require('../src/read-cache');
const { invoiceTextOnlyPattern, textOnlyPattern, likeMatches } = require('../src/domain/search-sql');

test('queued reads follow commits without retaining completed data or joining an older running snapshot', async () => {
  const {createReportGate}=require('../src/workload-control');
  const {markReadQueued,markReadStarted,readSharingMetrics}=require('../src/read-cache');
  const pool={},gate=createReportGate({limit:1,maxQueue:10,timeoutMs:1000});
  let value='old',finishFirst,startedFirst;
  const firstStarted=new Promise(resolve=>{startedFirst=resolve;});
  const load=()=>{
    markReadQueued();
    return gate(async()=>{
      markReadStarted();const snapshot=value;
      if(snapshot==='old') {startedFirst();await new Promise(resolve=>{finishFirst=resolve;});}
      return snapshot;
    });
  };
  const first=shareRead(pool,['report','allowed-A'],load);
  await firstStarted;
  value='commit-1';invalidateFinancialReads(pool);
  const queued=shareRead(pool,['report','allowed-A'],load);
  await new Promise(resolve=>setImmediate(resolve));
  value='commit-2';invalidateFinancialReads(pool);
  const latest=shareRead(pool,['report','allowed-A'],load);
  assert.equal(latest,queued,'new callers join the future snapshot, not a new queued copy');
  assert.notEqual(latest,first,'running snapshots never move to the new committed generation');
  const otherAccess=shareRead(pool,['report','allowed-B'],load);
  assert.notEqual(otherAccess,queued);
  finishFirst();
  assert.deepEqual(await Promise.all([first,queued,latest,otherAccess]),['old','commit-2','commit-2','commit-2']);
  assert.equal(readSharingMetrics(pool).entries,0,'completed financial results are removed at their moved keys');
  value='fresh';assert.equal(await shareRead(pool,['report','allowed-A'],load),'fresh');
  assert.ok(readSharingMetrics(pool).queued_rekeyed>0);
});

test('a failed queued read is removed after its generation changes', async () => {
  const {markReadQueued,markReadStarted,readSharingMetrics}=require('../src/read-cache');
  const pool={};let rejectRead;
  const pending=shareRead(pool,'failure',()=>{markReadQueued();return new Promise((_resolve,reject)=>{rejectRead=reject;});});
  const rejected=assert.rejects(pending,/failed/);
  await new Promise(resolve=>setImmediate(resolve));
  invalidateFinancialReads(pool);assert.equal(shareRead(pool,'failure',()=>0),pending);
  rejectRead(Error('failed'));await rejected;
  assert.equal(readSharingMetrics(pool).entries,0);
  assert.equal(await shareRead(pool,'failure',()=>{markReadStarted();return 9;}),9);
});

test('read sharing separates pools, access keys and committed generations without retaining completed financial data', async () => {
  clearReadCaches();
  const pool = {}, other = {}, pending = [];
  const load = () => new Promise(resolve => pending.push(resolve));
  const a = shareRead(pool, ['report', 'owner-a'], load);
  const duplicate = shareRead(pool, ['report', 'owner-a'], load);
  const b = shareRead(pool, ['report', 'owner-b'], load);
  const c = shareRead(other, ['report', 'owner-a'], load);
  assert.equal(a, duplicate);
  invalidateFinancialReads(pool);
  const afterCommit = shareRead(pool, ['report', 'owner-a'], load);
  await Promise.resolve();
  assert.equal(pending.length, 4);
  pending.forEach((resolve, index) => resolve(index));
  assert.deepEqual(await Promise.all([a, duplicate, b, c, afterCommit]), [0, 0, 1, 2, 3]);
  assert.equal(await shareRead(pool, ['report', 'owner-a'], async () => 'fresh'), 'fresh');
});

test('metadata has a bounded lifetime, shares misses, survives financial writes and retries errors', async () => {
  const pool = {}; let calls = 0;
  const read = () => shareRead(pool, 'choices', async () => ++calls, { metadata: true, ttlMs: 5 });
  assert.deepEqual(await Promise.all([read(), read()]), [1, 1]);
  invalidateFinancialReads(pool);
  assert.equal(await read(), 1);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await read(), 2);
  await assert.rejects(shareRead(pool, 'failure', async () => { throw Error('failed'); }), /failed/);
  assert.equal(await shareRead(pool, 'failure', async () => 'retried'), 'retried');
});

test('interactive snapshots scope JIT and timeout, then roll back and release on errors', async () => {
  const commands = []; let released;
  const client = {
    query: async (sql, values) => { commands.push({ sql, values }); },
    release: error => { released = { error }; },
  };
  const pool = { connect: async () => client };
  await assert.rejects(readSnapshot(pool, async () => { throw Error('read failed'); }), /read failed/);
  assert.deepEqual(commands, [
    { sql: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', values: undefined },
    { sql: 'SET LOCAL jit = off', values: undefined },
    { sql: "SELECT set_config('statement_timeout', $1, true)", values: ['240000ms'] },
    { sql: 'ROLLBACK', values: undefined },
  ]);
  assert.deepEqual(released, { error: undefined });
});

test('parallel report scans import one exported repeatable-read snapshot', async () => {
  const commands = [[], []];
  const releases = [];
  const clients = commands.map((entries, index) => ({
    query: async (sql) => {
      entries.push(sql);
      if (sql === 'SELECT pg_export_snapshot() AS snapshot') {
        return { rows: [{ snapshot: '00000003-TEST' }] };
      }
      return { rows: [] };
    },
    release: error => { releases[index] = error; },
  }));
  let next = 0;
  const pool = { connect: async () => clients[next++] };
  const result = await readParallelSnapshot(pool, [
    async () => 'invoice aggregate',
    async () => 'party aggregate',
  ], async (_primary, [invoices, parties]) => ({ invoices, parties }));
  assert.deepEqual(result, { invoices: 'invoice aggregate', parties: 'party aggregate' });
  assert.match(commands[1].join('\n'), /SET TRANSACTION SNAPSHOT '00000003-TEST'/);
  assert.equal(commands[0].at(-1), 'COMMIT');
  assert.equal(commands[1].at(-1), 'COMMIT');
  assert.deepEqual(releases, [undefined, undefined]);
});

test('text search optimization conservatively preserves numeric, date, status and wildcard matching', () => {
  for (const pattern of ['%Load Customer 15%', 'INV-LOAD-%', '%draft%', '%external_ref%']) {
    assert.equal(invoiceTextOnlyPattern(pattern.toLowerCase()), true, pattern);
  }
  for (const pattern of ['%123%', '%2026-10%', '%paid%', '%partial%', 'p%', '%', '%BC%', '%infinity%', '%_a_%']) {
    assert.equal(invoiceTextOnlyPattern(pattern.toLowerCase()), false, pattern);
  }
  assert.equal(textOnlyPattern('%JRN-123%'), true);
  assert.equal(likeMatches('p%', 'paid'), true);
  assert.equal(likeMatches('p%', 'unpaid'), false);
  assert.equal(likeMatches('%p_id%', 'unpaid'), true);
  assert.equal(likeMatches('%p\\_id%', 'unpaid'), false);
});

test('draft-only invalidation preserves unrelated journal sharing and metadata', async () => {
  clearReadCaches();const pool={},pending=[];
  const load=()=>new Promise(resolve=>pending.push(resolve));
  const invoice=shareRead(pool,'page',load,{scope:'invoice-list'});
  const journal=shareRead(pool,'page',load,{scope:'journals'});
  invalidateFinancialReads(pool,['invoice-list']);
  assert.equal(shareRead(pool,'page',load,{scope:'journals'}),journal);
  assert.notEqual(shareRead(pool,'page',load,{scope:'invoice-list'}),invoice);
  invalidateFinancialReads(pool);
  assert.notEqual(shareRead(pool,'page',load,{scope:'journals'}),journal);
  await Promise.resolve();pending.forEach(r=>r('done'));
});

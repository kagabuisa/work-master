'use strict';

// Financial results are shared only while in flight. Completed financial reads
// are never retained. Metadata has a short TTL and is filtered by callers.
const { AsyncLocalStorage } = require('node:async_hooks');
const activeRead = new AsyncLocalStorage();
let states = new WeakMap();
function stateFor(pool) {
  let state = states.get(pool);
  if (!state) { state = { generation: 0, allGeneration: 0, scopes: new Map(), entries: new Map(), queuedShares:0, queuedMoves:0 }; states.set(pool, state); }
  return state;
}
function readKey(state, entry) {
  const version=entry.scope ? [state.allGeneration,state.scopes.get(entry.scope)||0] : state.generation;
  return JSON.stringify([entry.metadata ? 'metadata' : version,entry.identity]);
}
function markReadQueued() { const entry=activeRead.getStore();if(entry&&!entry.metadata)entry.queued=true; }
function markReadStarted() { const entry=activeRead.getStore();if(entry)entry.queued=false; }
function readSharingMetrics(pool) { const s=stateFor(pool);return {queued_shared:s.queuedShares,queued_rekeyed:s.queuedMoves,entries:s.entries.size}; }
function shareRead(pool, key, load, { metadata = false, ttlMs = 30000, scope = null } = {}) {
  const state = stateFor(pool);
  const descriptor={metadata,scope,identity:JSON.stringify([scope,key])};
  const cacheKey=readKey(state,descriptor);
  const cached = state.entries.get(cacheKey);
  if (cached && cached.expires > Date.now()) {if(cached.queued)state.queuedShares++;return cached.promise;}
  if (cached) state.entries.delete(cacheKey);
  for (const [key, entry] of state.entries) {
    if (entry.expires <= Date.now()) state.entries.delete(key);
  }
  if (state.entries.size >= 200) return Promise.resolve().then(()=>activeRead.run(null,load));
  const entry = {...descriptor,cacheKey,queued:false,expires:Infinity};
  entry.promise = Promise.resolve().then(()=>activeRead.run(entry,load)).then(value => {
    if (state.entries.get(entry.cacheKey) === entry) {
      if (metadata) entry.expires = Date.now() + ttlMs;
      else state.entries.delete(entry.cacheKey);
    }
    return value;
  }, error => {
    if (state.entries.get(entry.cacheKey) === entry) state.entries.delete(entry.cacheKey);
    throw error;
  });
  state.entries.set(cacheKey, entry);
  return entry.promise;
}
function invalidateFinancialReads(pool, scopes) {
  const state = stateFor(pool); state.generation++;
  if (!scopes) state.allGeneration++;
  else for (const scope of scopes) state.scopes.set(scope, (state.scopes.get(scope) || 0) + 1);
  // Queued reads have not started their snapshot. A later caller can safely
  // join that future fresh read, even after intervening commits. Running reads
  // keep their original generation so callers after a commit never join them.
  for(const entry of [...state.entries.values()]) {
    if(entry.metadata||!entry.queued)continue;
    const next=readKey(state,entry);
    if(next===entry.cacheKey||state.entries.has(next))continue;
    state.entries.delete(entry.cacheKey);entry.cacheKey=next;
    state.entries.set(next,entry);state.queuedMoves++;
  }

}
function clearReadCaches() { states = new WeakMap(); }

async function readSnapshot(pool, read) {
  markReadStarted();
  const client = await pool.connect();
  let failed;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // Interactive page plans can otherwise spend seconds compiling expressions.
    await client.query('SET LOCAL jit = off');
    const result = await read(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) { failed = rollbackError; }
    throw error;
  } finally { client.release(failed); }
}
module.exports = { markReadQueued, markReadStarted, readSharingMetrics, shareRead, invalidateFinancialReads, clearReadCaches, readSnapshot };

'use strict';
// Detached Docker entrypoint. Ordinary Node/Postgres/HTTP code; no AI calls.
const fs=require('node:fs');
const {spawn}=require('node:child_process');
const {profile,guard,fingerprint}=require('./profile');
const state=require('./state');
const {bootstrap,seed}=require('./seed');
const {verify}=require('./verify');
const {run}=require('./workload');
const abort=new AbortController();
let child,ctx,timer,phase='starting';
function raw(file){try{return fs.readFileSync(file,'utf8').trim();}catch{return null;}}
async function metrics(p){
  const database=(await ctx.pool.query(`SELECT pg_database_size(current_database())::text bytes,
    (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND state='active') active,
    (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock') lock_waiting`)).rows[0];
  const sample={at:new Date().toISOString(),phase,disk_available_bytes:state.diskGuard(p.mode),database,
    job_memory_current:raw('/sys/fs/cgroup/memory.current'),job_memory_events:raw('/sys/fs/cgroup/memory.events'),job_cpu_stat:raw('/sys/fs/cgroup/cpu.stat')};
  fs.appendFileSync(state.OUT+'/resources.jsonl',JSON.stringify(sample)+'\n',{mode:0o600});
}
async function stopServer(){if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,5000))]);if(child.exitCode===null)child.kill('SIGKILL');}}
async function server(){
  const logfile=fs.openSync(state.OUT+'/app.log','a',0o600);
  child=spawn(process.execPath,['--max-old-space-size=256','server.js'],{stdio:['ignore',logfile,logfile],env:{...process.env,POSTGRES_POOL_MAX:'10'}});
  fs.closeSync(logfile);
  child.once('exit',code=>{if(!['complete','failed','stopping'].includes(phase))abort.abort(new Error('Benchmark app exited unexpectedly (code '+code+').'));});
  for(let n=0;n<60;n++){abort.signal.throwIfAborted();try{const r=await fetch('http://127.0.0.1:3020/login',{signal:AbortSignal.timeout(2000)});await r.arrayBuffer();if(r.status===200)return;}catch{}
    await new Promise(resolve=>setTimeout(resolve,1000));}
  throw new Error('Isolated benchmark app did not become ready.');
}
function markdown(summary){
  const lines=['# ERPNext-matched benchmark', '',`Run: ${summary.run_id}`,`Mode: ${summary.mode}`,`HTTP/integrity result: ${summary.passed?'PASS':'FAIL'}`, '',
    `Elapsed: ${summary.elapsed_seconds} seconds. Seeded through application lifecycle functions; source ERPNext was not contacted.`, '',
    '| Users | Phase | Transactions | Failed | Transactions/s |','| --- | --- | ---: | ---: | ---: |'];
  for(const r of summary.workload?.phases||[])lines.push(`| ${r.users} | ${r.name} | ${r.transactions} | ${r.failed_transactions} | ${r.transactions_per_second} |`);
  lines.push('',`Database size: ${(summary.after.database_bytes/1024**3).toFixed(3)} GiB.`,
    `GL: ${summary.after.counts.app_gl_entries}; stock ledger: ${summary.after.counts.app_stock_ledger}.`,
    '', 'Operation p50/p95/p99, statuses and errors are in workload.json. Every phase uses distinct accounts; warmup is reported separately.',
    '', 'This is a synthetic capacity test of this app on the shared local host. It does not establish ERPNext performance or exact business equivalence.',
    '', '## Profile limitations', '',...summary.limitations.map(text=>'- '+text));
  return lines.join('\n')+'\n';
}
async function main(){
  guard();const p=profile(process.env.BENCHMARK_MODE),started=Date.now();state.diskGuard(p.mode);
  const prior=state.read('status.json');
  if(prior?.stage==='complete')throw new Error('This run already completed; it will not be replayed.');
  if(state.read('traffic-started.json'))throw new Error('A traffic phase already started. Preserve it and start a fresh run; automatic replay would change the baseline.');
  state.progress('starting',{mode:p.mode,fingerprint:fingerprint(p)});state.event({event:'job_start',mode:p.mode});
  ctx=await bootstrap(p);ctx.signal=abort.signal;
  let sampling=false;
  timer=setInterval(()=>{if(!sampling){sampling=true;metrics(p).catch(e=>abort.abort(e)).finally(()=>{sampling=false;});}},15000);
  timer.unref();
  phase='seeding';await seed(p,ctx);abort.signal.throwIfAborted();
  await require('./pilot-checks').pilotChecks(p,ctx);
  phase='integrity-before';state.progress(phase);const before=await verify(p,ctx,'before');
  await require('./footprint').footprint(p,ctx,before);
  state.write('seed-ready.json',{at:new Date().toISOString(),elapsed_seconds:Math.round((Date.now()-started)/1000),database_bytes:before.database_bytes,profile_fingerprint:fingerprint(p)});
  phase='http-starting';state.progress(phase);await server();
  state.write('traffic-started.json',{at:new Date().toISOString()});
  phase='concurrency';let workload;
  try{workload=await run(p,ctx,abort.signal);}
  catch(e){
    // A request/export failure must not suppress the final integrity check or
    // erase already-completed phases. A stopped/unreachable database may still
    // prevent verification, in which case the job remains explicitly failed.
    const phases=fs.readdirSync(state.OUT).filter(name=>/^phase-.*\.json$/.test(name)).sort().map(name=>state.read(name));
    workload={at:new Date().toISOString(),mode:p.mode,passed:false,error:e.message,phases};state.write('workload.json',workload);
    state.event({event:'workload_failed',error:e.message});
  }
  phase='integrity-after';state.progress(phase);const after=await verify(p,ctx,'after');
  await metrics(p);
  const summary={run_id:process.env.BENCHMARK_RUN_ID,at:new Date().toISOString(),mode:p.mode,passed:before.passed&&after.passed&&workload.passed,
    elapsed_seconds:Math.round((Date.now()-started)/1000),before,after,workload,limitations:p.assumptions};
  state.write('summary.json',summary);fs.writeFileSync(state.OUT+'/summary.md',markdown(summary),{mode:0o600});
  phase='complete';state.progress('complete',{mode:p.mode,passed:summary.passed,elapsed_seconds:summary.elapsed_seconds});
  state.event({event:'job_complete',passed:summary.passed});if(!summary.passed)process.exitCode=2;
}
process.on('SIGTERM',()=>abort.abort(new Error('Benchmark was stopped.')));
process.on('SIGINT',()=>abort.abort(new Error('Benchmark was stopped.')));
main().catch(e=>{
  phase='failed';state.progress('failed',{error:e.message,code:e.code||null});state.event({event:'job_failed',error:e.message,code:e.code||null});process.exitCode=1;
}).finally(async()=>{clearInterval(timer);phase=phase==='complete'?'complete':'stopping';await stopServer();
  if(ctx){ctx.release();await ctx.store.closeStore();}
});

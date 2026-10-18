'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const { AuditPool }=require('../src/audit');
test('idle pool errors are handled without logging connection strings or messages',async()=>{
 const pool=new AuditPool({max:1});const log=console.error,records=[];console.error=value=>records.push(JSON.parse(value));
 try{assert.equal(pool.emit('error',Object.assign(Error('private connection string'),{code:'ECONNRESET'})),true);assert.deepEqual(records,[{event:'postgres_pool_error',code:'ECONNRESET'}]);}
 finally{console.error=log;await pool.end();}
});
test('checked-out and idle terminated connections do not crash the process and are replaced',{
 skip:process.env.API_TEST_POSTGRES!=='1',timeout:30000,
},async()=>{
 const {getPostgresPool,closeStore,withPostgresTransaction}=require('../src/core');
 const p=getPostgresPool();let victim;
 try{
  assert.match((await p.query('SELECT current_database() name')).rows[0].name,/_hr_test$/);
  victim=await p.connect();const pid=(await victim.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  const disconnected=new Promise(resolve=>victim.once('error',resolve));
  await p.query('SELECT pg_terminate_backend($1)',[pid]);await disconnected;
  await assert.rejects(victim.query('SELECT 1'));victim.release();victim=null;
  assert.equal((await p.query('SELECT 1 n')).rows[0].n,1);
  await assert.rejects(withPostgresTransaction(async client=>{
   const id=(await client.query('SELECT pg_backend_pid() pid')).rows[0].pid;
   const stopped=new Promise(resolve=>client.once('error',resolve));
   await p.query('SELECT pg_terminate_backend($1)',[id]);await stopped;
   throw Object.assign(Error('Original write failure'),{code:'ORIGINAL'});
  }),error=>error.code==='ORIGINAL');
  const idle=new AuditPool({...p.options,password:p.options.password,max:1});
  try{
   const id=(await idle.query('SELECT pg_backend_pid() pid')).rows[0].pid;
   const stopped=new Promise(resolve=>idle.once('error',resolve));
   await p.query('SELECT pg_terminate_backend($1)',[id]);await stopped;
   assert.equal((await idle.query('SELECT 1 n')).rows[0].n,1);
  }finally{await idle.end();}
 }finally{if(victim)victim.release();await closeStore();}
});

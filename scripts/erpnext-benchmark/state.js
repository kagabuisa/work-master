'use strict';
const fs=require('node:fs');
const path=require('node:path');
const OUT=process.env.BENCHMARK_OUTPUT||'/output';
function write(name,value){const file=path.join(OUT,name);const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(tmp,file);}
function read(name,fallback=null){try{return JSON.parse(fs.readFileSync(path.join(OUT,name),'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
function event(value){const row={at:new Date().toISOString(),...value};fs.appendFileSync(path.join(OUT,'events.jsonl'),JSON.stringify(row)+'\n',{mode:0o600});console.log(JSON.stringify(row));}
function progress(stage,extra={}){write('status.json',{run_id:process.env.BENCHMARK_RUN_ID,stage,at:new Date().toISOString(),...extra});}
function diskGuard(mode){const s=fs.statfsSync(OUT);const available=s.bavail*s.bsize;const reserve=(mode==='full'?6:1)*1024**3;if(available<reserve)throw new Error('Benchmark stopped: free storage fell below its reserve.');return available;}
module.exports={OUT,write,read,event,progress,diskGuard};

'use strict';
require('dotenv').config({quiet:true});
for(const key of ['POSTGRES_RUNTIME_USER','POSTGRES_RUNTIME_PASSWORD','POSTGRES_RUNTIME_URL'])delete process.env[key];
const store=require('../src/store');
for(const key of ['POSTGRES_RUNTIME_USER','POSTGRES_RUNTIME_PASSWORD','POSTGRES_RUNTIME_URL'])delete process.env[key];
store.initStore().then(()=>store.closeStore()).catch(error=>{console.error(error.message);process.exitCode=1;});

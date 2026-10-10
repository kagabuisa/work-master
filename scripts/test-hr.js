'use strict';
require('dotenv').config({quiet:true});
const {spawnSync}=require('node:child_process');
const result=spawnSync(process.execPath,['--test','tests/hr.test.js','tests/hr-postgres.test.js'],{
  stdio:'inherit',env:{...process.env,HR_TEST_POSTGRES:'1'},
});
if(result.error)throw result.error;
process.exitCode=result.status??1;

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const reset = require('../src/transaction-reset');
const { permissionCheck } = require('../src/authorize');
const { renderView } = require('./helpers/render-view');

test('maintenance is admin-only and reset remains disabled without a verified backup',async()=>{
  for(const role of ['standard','finance','sales']) for(const [method,url] of [
    ['GET','/settings/maintenance'],['POST','/settings/maintenance/backup'],
    ['POST','/settings/maintenance/reset'],['GET','/settings/maintenance/backups/id'],
  ]) assert.equal(permissionCheck({currentUser:{role,permissions:['sync.run','masters.items.delete']},method,path:url,body:{}}),false);
  assert.equal(permissionCheck({currentUser:{role:'admin'},method:'GET',path:'/settings/maintenance',body:{}}),true);
  const html=await renderView(path.join(__dirname,'../views/maintenance.ejs'),{
    assetVersion:'test',currentUser:{role:'admin'},can:()=>true,availableReports:[],
    resetScope:'financial',counts:{Sales:{app_invoices:3}},backup:null,
    history:[{actor_name:'admin',scope:'all',created_at:'2026-10-14T10:00:00Z',counts:{Sales:{app_invoices:3}}}],error:null,csrfToken:'test-token',
  });
  assert.match(html,/fieldset class="ui-form-section" disabled/);
  assert.match(html,/name="confirmation"[^>]*pattern="RESET TRANSACTIONS"/);
  assert.match(html,/type="password" autocomplete="current-password"/);
  assert.match(html,/HR attendance, leave, payroll, employee money, and their ledger entries remain/);
  assert.match(html,/<td>All transactions, including HR<\/td>/);
  assert.throws(()=>reset.validateScope('masters'),{status:400});
});

test('verified backups and scoped resets preserve masters, HR accounting, recovery and permissions',{
  skip:process.env.SCHEMA_TEST_POSTGRES!=='1',
},async t=>{
  const store=require('../src/store');
  const auth=require('../src/auth');
  const backupRoot=path.join(__dirname,'../data/transaction-reset-backups');
  let server;
  const backupIds=[];
  const restoreDb='wm_maintenance_restore_hr_test';
  const url=new URL(process.env.POSTGRES_URL);
  const env={...process.env,PGHOST:url.hostname,PGPORT:url.port||'5432',PGDATABASE:decodeURIComponent(url.pathname.slice(1)),
    PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),PGSSLMODE:'disable'};
  try{
    await require('./helpers/golden-seed').seedGoldenData();
    const pool=store.getPostgresPool();
    assert.match((await pool.query('SELECT current_database() AS name')).rows[0].name,/_hr_test$/);
    const admin=await auth.createUser('reset-admin','ResetExample123!',{role:'admin'});
    const other=await auth.createUser('reset-other','ResetExample123!',{role:'admin'});
    const standard=await auth.createUser('reset-standard','ResetExample123!',{role:'standard'});
    const session=await auth.createSession(admin.id);
    const account=Number((await pool.query('SELECT id FROM app_accounts ORDER BY id LIMIT 1')).rows[0].id);
    await pool.query(`INSERT INTO app_master_employees(employee_id,employee_name,status) VALUES('RESET-E','Reset Employee','Active');
      INSERT INTO app_hr_profiles(employee_id,joining_date) VALUES('RESET-E','2026-01-01');
      INSERT INTO app_hr_pay_plans(employee_id,effective_from,components) VALUES('RESET-E','2026-01-01','[]');
      INSERT INTO app_hr_attendance(employee_id,attendance_date,status) VALUES('RESET-E','2026-10-01','present');
      INSERT INTO app_hr_leave_requests(employee_id,leave_type_id,from_date,to_date,days,reason)
        SELECT 'RESET-E',id,'2026-10-02','2026-10-02',1,'Test' FROM app_hr_leave_types LIMIT 1;`);
    await pool.query(`INSERT INTO app_gl_entries(posting_date,account_id,party_type,party_id,voucher_type,voucher_id,voucher_no,line_no,debit)
      VALUES('2026-10-01',$1,'employee','RESET-E','hr_payroll',10,'PAY-RESET',1,100)`,[account]);
    await pool.query(`INSERT INTO wm_api_idempotency(actor_id,operation,resource_path,key,payload_hash,response,status,expires_at)
      VALUES($1,'invoice.create','/invoices','old-key','hash','{}',200,now()+interval '1 hour')`,[admin.id]);
    await pool.query(`INSERT INTO wm_api_sessions(id,user_id,password_version,access_hash,access_expires_at,expires_at)
      VALUES($1,$2,'version','hash',now()+interval '1 hour',now()+interval '1 day')`,[crypto.randomUUID(),admin.id]);
    const credential=crypto.randomUUID();
    await pool.query(`INSERT INTO wm_api_credentials(id,user_id,token_hash,scopes,expires_at)
      VALUES($1,$2,'integration-hash','[]',now()+interval '1 day')`,[credential,standard.id]);
    const masters=(await pool.query('SELECT id,account_code,account_name FROM app_accounts ORDER BY id')).rows;
    const profiles=(await pool.query('SELECT * FROM app_hr_profiles ORDER BY employee_id')).rows;
    const plans=(await pool.query('SELECT * FROM app_hr_pay_plans ORDER BY id')).rows;
    const roles=(await pool.query('SELECT * FROM app_roles ORDER BY slug')).rows;
    const users=(await pool.query('SELECT * FROM app_users ORDER BY id')).rows;
    const hrLedger=(await pool.query("SELECT * FROM app_gl_entries WHERE left(voucher_type,3)='hr_' ORDER BY id")).rows;
    const before=(await pool.query('SELECT COUNT(*)::int AS count FROM app_invoices')).rows[0].count;
    const performReset=(user,scope,id,confirmation,password='ResetExample123!')=>reset.resetTransactions(user,scope,id,confirmation,password);
    const uploadedFile=path.join(__dirname,'../data/project-files/reset-backup-fixture.txt');
    await fs.mkdir(path.dirname(uploadedFile),{recursive:true});
    await fs.writeFile(uploadedFile,'Uploaded project file survives reset and backup restoration.');
    await t.test('a maintenance lock rejects other app queries without mutating records',async()=>{
      const client=await pool.connect();
      try{
        await client.query('SELECT pg_advisory_lock($1)',[require('../src/maintenance-lock').MAINTENANCE_LOCK]);
        await assert.rejects(pool.query('DELETE FROM app_invoices'),{status:503});
      }finally{await client.query('SELECT pg_advisory_unlock($1)',[require('../src/maintenance-lock').MAINTENANCE_LOCK]);client.release();}
      assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM app_invoices')).rows[0].count,before);
    });
    await assert.rejects(reset.createBackup(standard,'financial'),{status:403});
    await assert.rejects(reset.createBackup({...standard,role:'admin'},'financial'),{status:403});
    const stale=await reset.createBackup(admin,'financial');backupIds.push(stale.id);
    await pool.query("UPDATE app_invoices SET notes='Changed after backup'");
    await assert.rejects(performReset(admin,'financial',stale.id,'RESET TRANSACTIONS'),/changed after the backup/);
    const fileStale=await reset.createBackup(admin,'financial');backupIds.push(fileStale.id);
    await fs.appendFile(uploadedFile,'\nA later file change.');
    await assert.rejects(performReset(admin,'financial',fileStale.id,'RESET TRANSACTIONS'),/changed after the backup/);
    const expired=await reset.createBackup(admin,'financial');backupIds.push(expired.id);
    await pool.query("UPDATE wm_maintenance_backups SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[expired.id]);
    await assert.rejects(performReset(admin,'financial',expired.id,'RESET TRANSACTIONS'),/expired/);
    await pool.query(`CREATE TABLE app_reset_test_link(invoice_id bigint REFERENCES app_invoices(id));
      INSERT INTO app_reset_test_link SELECT id FROM app_invoices LIMIT 1`);
    const linked=await reset.createBackup(admin,'financial');backupIds.push(linked.id);
    await assert.rejects(performReset(admin,'financial',linked.id,'RESET TRANSACTIONS'),/linked records/i);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM wm_api_idempotency')).rows[0].count,1);
    await pool.query('DROP TABLE app_reset_test_link');
    const valid=await reset.createBackup(admin,'financial');backupIds.push(valid.id);
    await assert.rejects(performReset(other,'financial',valid.id,'RESET TRANSACTIONS'),{status:409});
    await assert.rejects(performReset(admin,'all',valid.id,'RESET TRANSACTIONS'),{status:409});
    await assert.rejects(performReset(admin,'financial',valid.id,'reset transactions'),{status:400});
    const corrupt=await reset.createBackup(admin,'financial');backupIds.push(corrupt.id);
    await fs.appendFile(path.join(backupRoot,`${corrupt.id}.tar`),'tampered');
    await assert.rejects(performReset(admin,'financial',corrupt.id,'RESET TRANSACTIONS'),/backup has changed/);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM app_invoices')).rows[0].count,before);

    await t.test('HTTP routes require the session-bound token and current administrator password',async()=>{
      const express=require('express');const app=express();
      app.set('view engine','ejs');app.set('views',path.join(__dirname,'../views'));
      app.locals.assetVersion='test';app.use(express.urlencoded({extended:false}));
      app.use(require('../src/maintenance-lock').captureResetEpoch);
      app.use((req,res,next)=>{req.currentUser=req.get('x-test-role')==='standard'?standard:admin;
        res.locals.currentUser=req.currentUser;res.locals.can=()=>true;res.locals.availableReports=[];
        res.locals.dateTimeSettings={date_format:'YYYY-MM-DD',time_format:'24h'};
        res.locals.formatTimestamp=String;next();});
      app.use(require('../src/web/routes/maintenance'));app.use((error,req,res,next)=>res.status(error.status||500).send(error.message));
      server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});
      const root=`http://127.0.0.1:${server.address().port}`;
      const headers={cookie:`wm_session=${session}`,'content-type':'application/x-www-form-urlencoded'};
      assert.equal((await fetch(root+'/settings/maintenance',{headers:{...headers,'x-test-role':'standard'}})).status,403);
      const page=await (await fetch(root+'/settings/maintenance?scope=financial&backup='+valid.id,{headers})).text();
      const token=page.match(/name="csrf_token" value="([^"]+)"/)[1];
      const post=body=>fetch(root+'/settings/maintenance/reset',{method:'POST',headers,body:new URLSearchParams(body),redirect:'manual'});
      assert.equal((await post({scope:'financial',backup_id:valid.id,confirmation:'RESET TRANSACTIONS',password:'ResetExample123!'})).status,403);
      assert.equal((await post({scope:'financial',backup_id:valid.id,csrf_token:token,confirmation:'RESET TRANSACTIONS',password:'WrongExample123!'})).status,401);
      assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM app_invoices')).rows[0].count,before);
      const response=await post({scope:'financial',backup_id:valid.id,csrf_token:token,confirmation:'RESET TRANSACTIONS',password:'ResetExample123!'});
      assert.equal(response.status,303);assert.equal(response.headers.get('location'),'/login?reset=complete');
      assert.ok(await auth.sessionUser(session)===null);
    });
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM app_invoices')).rows[0].count,0);
    await require('../src/maintenance-lock').withResetEpoch('0',async()=>{
      await assert.rejects(pool.query("UPDATE app_invoices SET notes='Old pending request'"),{status:503});
    });
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM app_stock_balances')).rows[0].count,0);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM app_hr_attendance')).rows[0].count,1);
    assert.deepEqual((await pool.query("SELECT * FROM app_gl_entries WHERE left(voucher_type,3)='hr_' ORDER BY id")).rows,hrLedger);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM wm_api_idempotency')).rows[0].count,0);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM wm_api_sessions')).rows[0].count,0);
    assert.ok((await pool.query('SELECT revoked_at FROM wm_api_credentials WHERE id=$1',[credential])).rows[0].revoked_at);
    await assert.rejects(performReset(admin,'financial',valid.id,'RESET TRANSACTIONS'),/already used/);

    await t.test('the downloaded database archive actually restores into an isolated test database',async()=>{
      const backup=await reset.backupDownload(admin,valid.id);
      const directory=await fs.mkdtemp(path.join(backupRoot,'restore-'));
      try{
        await execFile('tar',['--extract','--file',backup.file,'--directory',directory]);
        await fs.mkdir(path.join(directory,'files'));
        await execFile('tar',['--extract','--gzip','--file',path.join(directory,'files.tar.gz'),'--directory',path.join(directory,'files')]);
        assert.equal(await fs.readFile(path.join(directory,'files/project-files/reset-backup-fixture.txt'),'utf8'),await fs.readFile(uploadedFile,'utf8'));
        await execFile('createdb',['--template=template0',restoreDb],{env});
        await execFile('pg_restore',['--exit-on-error','--no-owner','--dbname',restoreDb,path.join(directory,'database.dump')],{env});
        const {Pool}=require('pg');const restored=new Pool({host:env.PGHOST,port:Number(env.PGPORT),user:env.PGUSER,password:env.PGPASSWORD,database:restoreDb});
        try{assert.equal((await restored.query('SELECT COUNT(*)::int AS count FROM app_invoices')).rows[0].count,before);}
        finally{await restored.end();}
      }finally{await execFile('dropdb',['--if-exists',restoreDb],{env});await fs.rm(directory,{recursive:true,force:true});}
    });
    const full=await reset.createBackup(admin,'all');backupIds.push(full.id);
    await performReset(admin,'all',full.id,'RESET TRANSACTIONS');
    for(const table of ['app_gl_entries','app_hr_attendance','app_hr_leave_requests','app_hr_runs','app_hr_slips'])
      assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0].count,0);
    assert.deepEqual((await pool.query('SELECT id,account_code,account_name FROM app_accounts ORDER BY id')).rows,masters);
    assert.deepEqual((await pool.query('SELECT * FROM app_hr_profiles ORDER BY employee_id')).rows,profiles);
    assert.deepEqual((await pool.query('SELECT * FROM app_hr_pay_plans ORDER BY id')).rows,plans);
    assert.deepEqual((await pool.query('SELECT * FROM app_roles ORDER BY slug')).rows,roles);
    assert.deepEqual((await pool.query('SELECT * FROM app_users ORDER BY id')).rows,users);
    assert.match(await fs.readFile(uploadedFile,'utf8'),/Uploaded project file survives reset/);
    assert.deepEqual((await pool.query('SELECT actor_name,scope FROM wm_transaction_resets ORDER BY id')).rows,
      [{actor_name:'reset-admin',scope:'financial'},{actor_name:'reset-admin',scope:'all'}]);
  }finally{
    if(server)await new Promise(resolve=>server.close(resolve));
    await store.closeStore();
    for(const id of backupIds)await fs.rm(path.join(backupRoot,`${id}.tar`),{force:true});
  }
});

'use strict';
// Local operational setup. Secrets are never printed or put in process arguments.
const fs=require('node:fs');const crypto=require('node:crypto');
require('dotenv').config({quiet:true});
for(const key of ['POSTGRES_RUNTIME_USER','POSTGRES_RUNTIME_PASSWORD','POSTGRES_RUNTIME_URL'])delete process.env[key];
const store=require('../src/store');
for(const key of ['POSTGRES_RUNTIME_USER','POSTGRES_RUNTIME_PASSWORD','POSTGRES_RUNTIME_URL'])delete process.env[key];
async function main(){
 await store.initStore();
 const pool=store.getPostgresPool();const client=await pool.connect();
 const database=(await client.query('SELECT current_database() AS name')).rows[0].name;
 const role='wm_inventory_runtime_'+crypto.createHash('sha256').update(database).digest('hex').slice(0,12);const password=crypto.randomBytes(36).toString('base64url');
 try{
 await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(1776342162)');
 const exists=(await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount;
 if(!exists)await client.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
 await client.query(`ALTER ROLE ${role} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
 const unsafe=(await client.query(`SELECT EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=$1) OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE r.rolname=$1) OR EXISTS(SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner WHERE r.rolname=$1) OR EXISTS(SELECT 1 FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE r.rolname=$1) AS unsafe`,[role])).rows[0].unsafe;
 if(unsafe)throw new Error('Runtime role must have no role memberships or database/schema/table ownership.');
 await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
 await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
 await client.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
 await client.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC,${role}`);
 await client.query(`REVOKE ALL ON wm_schema_version FROM ${role}; GRANT SELECT ON wm_schema_version TO ${role}`);
 for(const table of ['wm_inventory_policy','wm_inventory_control','wm_inventory_counts','wm_inventory_count_lines','wm_inventory_closures','wm_inventory_events','wm_inventory_count_audit','wm_inventory_corrections','wm_inventory_correction_audit','app_stock_ledger','app_stock_balances'])
  await client.query(`REVOKE ALL ON ${table} FROM ${role}; GRANT SELECT ON ${table} TO ${role}`);
 for(const table of ['wm_gl_owned_entries','wm_gl_owned_daily','wm_gl_owned_scopes'])
  await client.query(`REVOKE ALL ON ${table} FROM ${role}; GRANT SELECT ON ${table} TO ${role}`);
 for(const signature of ['wm_inventory_enabled()','wm_inventory_begin(text,bigint,boolean,text[])','wm_inventory_apply(jsonb)','wm_inventory_count_action(text,jsonb)','wm_inventory_correction_action(text,jsonb)'])
  await client.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${role}`);
 // Activation is one-way for runtime. Legacy reconciliations are deliberately not converted to closures.
 await client.query('SELECT wm_inventory_activate()');
 // Write credentials atomically before commit; retain owner settings only for the separate migration process.
 const file=process.env.INVENTORY_ENV_FILE||'.env';let body=fs.readFileSync(file,'utf8');
 body=body.replace(/^POSTGRES_RUNTIME_(USER|PASSWORD|URL)=.*\r?\n?/gm,'');
 body+=`\nPOSTGRES_RUNTIME_USER=${role}\nPOSTGRES_RUNTIME_PASSWORD=${password}\n`;
 const temp=`${file}.inventory-tmp`;fs.writeFileSync(temp,body,{mode:0o600});fs.renameSync(temp,file);
 await client.query('COMMIT');console.log('Controlled inventory enabled. Runtime credentials saved. Restart the app before admitting traffic.');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();await store.closeStore();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});

const test = require('node:test');
const assert = require('node:assert/strict');
const { AuditPool, runWithAuditUser, initRecordAudit, recordAuditFields } = require('../src/audit');

const alice = { id: 11, username: 'alice' };
const bob = { id: 22, username: 'bob' };

test('record audit fields preserve unknown historical values', () => {
  assert.deepEqual(recordAuditFields({ created_by: 'alice', created_at: '2020-01-01' }), {
    created_by: 'alice', created_by_user_id: null, created_at: '2020-01-01',
    updated_by: null, updated_by_user_id: null, updated_at: null,
  });
});

test('Postgres auditing covers every app table and isolates concurrent users and pooled connections', {
  skip: process.env.AUDIT_TEST_POSTGRES !== '1',
}, async () => {
  const { getPostgresPool, closeStore } = require('../src/store');
  const bootstrap = getPostgresPool();
  const schema = `audit_test_${process.pid}_${Date.now()}`;
  let pool;
  try {
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    pool = new AuditPool({ ...bootstrap.options, password: bootstrap.options.password, max: 1, options: `-c search_path=${schema}` });
    const { rows: tables } = await bootstrap.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND left(tablename, 4) = 'app_' ORDER BY tablename");
    assert(tables.length >= 20);
    for (const { tablename } of tables) {
      await pool.query(`CREATE TABLE "${tablename}" (id TEXT PRIMARY KEY, value TEXT, created_at TIMESTAMPTZ DEFAULT now())`);
    }
    await pool.query("INSERT INTO app_master_customers(id,value,created_at) VALUES ('legacy','old','2020-01-01T00:00:00Z')");
    await initRecordAudit(pool);
    await initRecordAudit(pool); // Migration must be repeatable.
    for (const { tablename } of tables) {
      const result = await runWithAuditUser(alice, () => pool.query(`INSERT INTO "${tablename}" (id,value,created_by,created_at) VALUES ('new','first','forged','1990-01-01') RETURNING *`));
      const row = result.rows[0];
      assert.equal(row.created_by, 'alice', tablename);
      assert.equal(row.created_by_user_id, '11', tablename);
      assert.equal(row.updated_by, 'alice', tablename);
      assert(row.created_at.getFullYear() > 2020);
      const updated = (await runWithAuditUser(bob, () => pool.query(`UPDATE "${tablename}" SET value='second',created_by='forged',created_at='1990-01-01' WHERE id='new' RETURNING *`))).rows[0];
      assert.equal(updated.created_by, 'alice');
      assert.equal(updated.updated_by, 'bob');
      assert.equal(updated.created_at.toISOString(), row.created_at.toISOString());
      const noop = (await runWithAuditUser(alice, () => pool.query(`UPDATE "${tablename}" SET value=value,updated_at=now() WHERE id='new' RETURNING *`))).rows[0];
      assert.equal(noop.updated_by, 'bob');
      assert.equal(noop.updated_at.toISOString(), updated.updated_at.toISOString());
    }
    const legacy = (await runWithAuditUser(bob, () => pool.query("UPDATE app_master_customers SET value='edited' WHERE id='legacy' RETURNING *"))).rows[0];
    assert.equal(legacy.created_by, null);
    assert.equal(legacy.created_at.toISOString(), '2020-01-01T00:00:00.000Z');
    assert.equal(legacy.updated_by, 'bob');
    await Promise.all(Array.from({ length: 20 }, (_, index) => {
      const user = index % 2 ? bob : alice;
      return runWithAuditUser(user, async () => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const row = (await client.query('INSERT INTO app_invoice_payments(id,value) VALUES ($1,$2) RETURNING *', [`parallel-${index}`, user.username])).rows[0];
          assert.equal(row.created_by, user.username);
          await client.query(index === 0 ? 'ROLLBACK' : 'COMMIT');
        } finally { client.release(); }
      });
    }));
    assert.equal((await pool.query("SELECT * FROM app_invoice_payments WHERE id='parallel-0'")).rowCount, 0);
    const system = (await pool.query("INSERT INTO app_master_customers(id,value) VALUES ('system','background') RETURNING *")).rows[0];
    assert.equal(system.created_by, 'System');
    assert.equal(system.created_by_user_id, null);
    await runWithAuditUser(bob, () => new Promise((resolve, reject) => pool.query("INSERT INTO app_master_customers(id,value) VALUES ('callback','callback') RETURNING *", (error, result) => {
      if (error) return reject(error);
      try { assert.equal(result.rows[0].created_by, 'bob'); resolve(); } catch (failure) { reject(failure); }
    })));
    // An aborted transaction must not poison the next pool checkout's identity.
    const client = await runWithAuditUser(alice, () => pool.connect());
    await client.query('BEGIN');
    await assert.rejects(client.query('SELECT missing_column FROM app_master_customers'));
    client.release();
    await assert.rejects(pool.query('SELECT 1'));
    assert.equal((await runWithAuditUser(bob, () => pool.query("INSERT INTO app_master_customers(id,value) VALUES ('recovered','ok') RETURNING *"))).rows[0].created_by, 'bob');
  } finally {
    if (pool) await pool.end();
    await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await closeStore();
  }
});

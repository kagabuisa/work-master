// Test-only fixture seeding: opening documents, ledger and balances are atomic.
async function seedLoadStock(pool, items) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [db] } = await client.query('SELECT current_database() name');
    if (!['load_3m_hr_test', 'resilience_4y_hr_test'].includes(db.name)) throw Error('Isolated load database required');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('load-stock-fixture'))");
    await client.query("SET LOCAL app.audit_username='Load fixture generator'");
    const { rows: [opening] } = await client.query("SELECT coalesce(min(posting_date)-1,'2022-10-14'::date) posting_date FROM app_stock_ledger");
    for (const item of items) {
      if (!/^LOAD-(SERVICE|VARIED-\d{1,2})$/.test(item.item_code)) throw Error('Unexpected fixture item');
      const inserted = await client.query(`INSERT INTO app_stock_balances(item_code,warehouse,item_name,quantity)
        VALUES ($1,'Load Warehouse',$2,10000) ON CONFLICT DO NOTHING RETURNING item_code`, [item.item_code,item.item_name]);
      if (!inserted.rowCount) {
        const { rows: [check] } = await client.query(`SELECT b.quantity=coalesce(sum(l.qty_change),0)
          AND b.stock_value=coalesce(sum(l.stock_value_change),0) valid FROM app_stock_balances b
          LEFT JOIN app_stock_ledger l USING(item_code,warehouse)
          WHERE b.item_code=$1 AND b.warehouse='Load Warehouse' GROUP BY b.quantity,b.stock_value`, [item.item_code]);
        if (!check?.valid) throw Error('Existing fixture stock lacks history; repair before reuse');
        continue;
      }
      const { rows: [entry] } = await client.query(`INSERT INTO app_stock_entries(entry_type,posting_date,remarks,submitted_by,submitted_at)
        VALUES ('opening',$1,
        'Load fixture opening: 10000 zero-value units','Load fixture generator',now()) RETURNING id,posting_date`,[opening.posting_date]);
      const no = `FIXTURE-SEED-${entry.id}`;
      await client.query('UPDATE app_stock_entries SET entry_no=$2 WHERE id=$1',[entry.id,no]);
      await client.query(`INSERT INTO app_stock_entry_items(stock_entry_id,line_no,item_code,item_name,warehouse,quantity,valuation_rate)
        VALUES($1,1,$2,$3,'Load Warehouse',10000,0)`,[entry.id,item.item_code,item.item_name]);
      await client.query(`INSERT INTO app_stock_ledger(posting_date,item_code,item_name,warehouse,voucher_type,voucher_id,voucher_no,
        qty_change,qty_after_transaction,stock_value_change,stock_value_after_transaction,remarks)
        VALUES($1,$2,$3,'Load Warehouse','stock_opening',$4,$5,10000,10000,0,0,'Load fixture opening')`,
        [entry.posting_date,item.item_code,item.item_name,entry.id,no]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
module.exports = { seedLoadStock };

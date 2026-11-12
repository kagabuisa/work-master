'use strict';
const {KINDS,LINES,withinRange}=require('./profile');
const {TABLES}=require('./seed');
const state=require('./state');

async function verify(p,ctx,label) {
  const checks=[];
  const check=(name,passed,details)=>{checks.push({name,passed,...(details?{details}:{})});};
  const q=(sql,params)=>ctx.pool.query(sql,params);
  for(const kind of KINDS){
    const [table,column]=TABLES[kind];
    const counts=(await q(`SELECT docstatus,count(*)::int n FROM ${table} WHERE ${column} LIKE $1 GROUP BY docstatus`,['ERP-BENCH:seed:'+kind+':%'])).rows;
    const actual=Object.fromEntries(['draft','submitted','cancelled'].map(k=>[k,counts.find(r=>r.docstatus===k)?.n||0]));
    check(kind+'_source_statuses',JSON.stringify(actual)===JSON.stringify(p.statuses[kind]),{expected:p.statuses[kind],actual});
    const children={invoices:['app_invoice_items','invoice_pk'],journals:['app_journal_entry_lines','journal_entry_id'],purchases:['app_purchase_items','purchase_id'],stock:['app_stock_entry_items','stock_entry_id'],orders:['app_purchase_order_items','purchase_order_id']}[kind];
    const n=Number((await q(`SELECT count(*) n FROM ${children[0]} child JOIN ${table} parent ON parent.id=child.${children[1]} WHERE parent.${column} LIKE $1`,['ERP-BENCH:seed:'+kind+':%'])).rows[0].n);
    check(kind+'_source_lines',n===p.counts[LINES[kind]],{expected:p.counts[LINES[kind]],actual:n});
  }
  const masterTables={customers:'app_master_customers',suppliers:'app_master_suppliers',items:'app_master_items',warehouses:'app_master_warehouses',accounts:'app_accounts',users:'app_users'};
  for(const [kind,table]of Object.entries(masterTables)){const actual=Number((await q(`SELECT count(*) n FROM ${table}`)).rows[0].n);check(kind+'_count',actual===p.counts[kind],{expected:p.counts[kind],actual});}
  const rowCounts=(await q(`SELECT
    (SELECT count(*) FROM app_invoices)::int invoices,
    (SELECT count(*) FROM app_invoice_items)::int invoice_items,
    (SELECT count(*) FROM app_gl_entries)::int gl_rows,
    (SELECT count(*) FROM app_stock_ledger)::int stock_ledger_rows`)).rows[0];
  for(const [name,key]of [
    ['invoice_row_target','invoices'],
    ['invoice_item_row_target','invoice_items'],
    ['gl_row_target','gl_rows'],
    ['stock_ledger_row_target','stock_ledger_rows']
  ]) {
    const actual=Number(rowCounts[key]);
    const expected=p.targets.ranges[key];
    check(name,withinRange(actual,expected,label!=='before'),{expected,actual});
  }
  const lengths=(await q(`WITH invoice_lengths AS (
      SELECT invoice_pk,count(*)::int item_count FROM app_invoice_items GROUP BY invoice_pk
    ) SELECT COALESCE(min(item_count),0)::int minimum,COALESCE(avg(item_count),0) mean,
      count(DISTINCT item_count)::int distinct_sizes,COALESCE(max(item_count),0)::int maximum
    FROM invoice_lengths`)).rows[0];
  const minimum=Number(lengths.minimum),mean=Number(lengths.mean),maximum=Number(lengths.maximum);
  check('invoice_minimum_items',minimum>=p.invoice_lengths.minimum,{expected_at_least:p.invoice_lengths.minimum,actual:minimum});
  check('invoice_average_items',Math.abs(mean-p.targets.average_invoice_items)<=p.targets.tolerances.average_invoice_items,
    {expected:p.targets.average_invoice_items,tolerance:p.targets.tolerances.average_invoice_items,actual:mean});
  check('invoice_length_variation',Number(lengths.distinct_sizes)>=3&&maximum>p.targets.average_invoice_items,
    {minimum_distinct_sizes:3,minimum_maximum:Math.floor(p.targets.average_invoice_items)+1,
      actual:{distinct_sizes:Number(lengths.distinct_sizes),maximum}});
  const invariants={
    journal_totals:`SELECT count(*) n FROM app_journal_entries j LEFT JOIN LATERAL (SELECT sum(debit) d,sum(credit) c,count(*) n FROM app_journal_entry_lines l WHERE l.journal_entry_id=j.id) x ON true WHERE x.n<2 OR j.total_debit<>x.d OR j.total_credit<>x.c OR x.d<>x.c`,
    invoice_line_totals:`SELECT count(*) n FROM app_invoices i LEFT JOIN LATERAL (SELECT sum(line_total) total,count(*) n FROM app_invoice_items l WHERE l.invoice_pk=i.id) x ON true WHERE x.n=0 OR x.total<>i.subtotal OR i.total<>i.subtotal+i.tax_amount-i.discount_amount`,
    invoice_receipt_totals:`SELECT count(*) n FROM app_invoices i WHERE i.amount_paid<>COALESCE((SELECT sum(amount) FROM app_invoice_payments p WHERE p.invoice_id=i.id AND p.docstatus='submitted'),0)`,
    invoice_payment_links:`SELECT count(*) n FROM app_invoice_payments p LEFT JOIN app_journal_entries j ON j.id=p.journal_entry_id WHERE j.id IS NULL OR j.journal_type<>'cash_receipt' OR j.docstatus<>p.docstatus OR j.total_debit<>p.amount`,
    submitted_invoice_gl:`SELECT count(*) n FROM app_invoices i LEFT JOIN LATERAL(SELECT count(*) n,sum(debit) d,sum(credit) c FROM app_gl_entries g WHERE g.voucher_type='sales_invoice' AND g.voucher_id=i.id AND NOT g.is_reversal)x ON true WHERE i.docstatus='submitted' AND (x.n<2 OR x.d<>x.c OR x.d<>i.total+COALESCE((SELECT sum(cost_amount) FROM app_invoice_items it WHERE it.invoice_pk=i.id),0))`,
    gl_voucher_balance:`SELECT count(*) n FROM (SELECT voucher_type,voucher_id FROM app_gl_entries GROUP BY 1,2 HAVING sum(debit)<>sum(credit)) x`,
    stock_balance_reconciliation:`SELECT count(*) n FROM app_stock_balances b FULL JOIN(SELECT item_code,warehouse,sum(qty_change) q,sum(stock_value_change) v FROM app_stock_ledger GROUP BY 1,2) l USING(item_code,warehouse) WHERE b.item_code IS NULL OR l.item_code IS NULL OR b.quantity<>l.q OR b.stock_value<>l.v OR b.quantity<0 OR b.stock_value<0 OR abs(b.stock_value-b.quantity*b.valuation_rate)>0.01`,
    stock_movement_values:`SELECT count(*) n FROM app_stock_ledger WHERE stock_value_change<>qty_change*CASE WHEN qty_change>0 THEN incoming_rate ELSE outgoing_rate END`,
    generated_invoice_journals:`SELECT count(*) n FROM app_invoices i LEFT JOIN LATERAL(SELECT count(*) n FROM app_journal_entries j WHERE j.journal_type='sales_invoice' AND j.reference_no=i.invoice_no AND j.docstatus=i.docstatus)x ON true WHERE (i.docstatus<>'draft' AND x.n<>1) OR (i.docstatus='draft' AND x.n<>0)`,
    customer_receipt_gl:`SELECT count(*) n FROM app_invoice_payments p LEFT JOIN LATERAL(SELECT sum(debit) d,sum(credit)c FROM app_gl_entries g WHERE g.voucher_type='cash_receipt' AND g.voucher_id=p.journal_entry_id AND NOT g.is_reversal)x ON true WHERE x.d IS NULL OR x.d<>p.amount OR x.d<>x.c`,
    cancelled_invoice_reversals:`SELECT count(*) n FROM app_invoices i WHERE i.docstatus='cancelled' AND (NOT EXISTS(SELECT 1 FROM app_gl_entries g WHERE g.voucher_type='sales_invoice_cancellation' AND g.voucher_id=i.id) OR EXISTS(SELECT 1 FROM app_gl_entries g WHERE g.voucher_type IN('sales_invoice','sales_invoice_cancellation') AND g.voucher_id=i.id GROUP BY g.account_id HAVING sum(g.debit-g.credit)<>0))`,
    draft_gl_absence:`SELECT count(*) n FROM app_gl_entries g JOIN app_invoices i ON g.voucher_type='sales_invoice' AND g.voucher_id=i.id WHERE i.docstatus='draft'`,
    future_dates:`SELECT count(*) n FROM(SELECT invoice_date d FROM app_invoices UNION ALL SELECT posting_date FROM app_journal_entries UNION ALL SELECT posting_date FROM app_stock_entries UNION ALL SELECT posting_date FROM app_purchases)x WHERE d>(now() AT TIME ZONE 'Africa/Kampala')::date`,
  };
  for(const [name,sql]of Object.entries(invariants)){state.diskGuard(p.mode);const invalid=Number((await q(sql)).rows[0].n);check(name,invalid===0,{invalid});}
  const summary=(await q(`WITH raw AS(SELECT count(*) n,COALESCE(sum(debit),0) d,COALESCE(sum(credit),0)c FROM app_gl_entries),
    derived AS(SELECT COALESCE(sum(entry_count),0)n,COALESCE(sum(debit),0)d,COALESCE(sum(credit),0)c FROM wm_gl_daily)
    SELECT raw.n::text rows,raw.d=raw.c balanced,raw.n=derived.n AND raw.d=derived.d AND raw.c=derived.c AS summary_matches FROM raw,derived`)).rows[0];
  check('global_gl_balanced',summary.balanced);check('derived_gl_totals',summary.summary_matches);
  const stockGl=(await q(`SELECT COALESCE((SELECT sum(debit-credit) FROM app_gl_entries WHERE account_id=$1),0)=
    COALESCE((SELECT sum(stock_value) FROM app_stock_balances),0) AS valid`,[ctx.settings.inventory])).rows[0].valid;
  check('inventory_gl_value',stockGl);
  const sourceOutstanding=Number((await q(`SELECT count(*) n FROM app_invoices WHERE notes LIKE 'ERP-BENCH:seed:invoices:%' AND docstatus='submitted' AND total>amount_paid`)).rows[0].n);
  check('source_positive_outstanding',sourceOutstanding===p.positive_outstanding,{expected:p.positive_outstanding,actual:sourceOutstanding});
  const counts={};
  for(const table of ['app_invoices','app_invoice_items','app_invoice_payments','app_journal_entries','app_journal_entry_lines','app_gl_entries','app_stock_entries','app_stock_ledger','app_stock_balances','app_purchases','app_purchase_items','app_purchase_orders'])counts[table]=Number((await q('SELECT count(*) n FROM '+table)).rows[0].n);
  const bytes=Number((await q('SELECT pg_database_size(current_database()) bytes')).rows[0].bytes);
  const report={at:new Date().toISOString(),label,lane:p.lane,passed:checks.every(c=>c.passed),checks,counts,database_bytes:bytes,
    row_targets:{targets:p.targets,actual:rowCounts,invoice_lengths:{minimum,mean,maximum,distinct_sizes:Number(lengths.distinct_sizes)}},
    ledger_comparison:{gl_source:p.counts.gl_rows,gl_actual:counts.app_gl_entries,stock_source:p.counts.stock_ledger_rows,stock_actual:counts.app_stock_ledger},
    limitations:p.assumptions};
  state.write('integrity-'+label+'.json',report);state.event({event:'integrity',label,passed:report.passed,checks:checks.length,database_bytes:bytes});
  if(!report.passed)throw new Error('Benchmark integrity checks failed: '+checks.filter(c=>!c.passed).map(c=>c.name).join(', '));
  return report;
}
module.exports={verify};

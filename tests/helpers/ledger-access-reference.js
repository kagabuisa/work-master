// Frozen pre-optimization access predicate: independent ownership regression oracle.
'use strict';
function addGeneralLedgerAccessFilter(where, params, access = {}) {
  let hrRule='';
  if(access.hrAccess) {
    const hr=access.hrAccess;const rules=[];
    const source='COALESCE(gl.reversal_of_voucher_id,gl.voucher_id)';
    if(hr.payroll)rules.push("gl.voucher_type IN ('hr_payroll','hr_payroll_cancellation')");
    if(hr.money)rules.push("gl.voucher_type IN ('hr_money','hr_money_cancellation')");
    if(hr.payroll||hr.money)rules.push(`(gl.voucher_type IN ('hr_payment','hr_payment_cancellation') AND EXISTS (
      SELECT 1 FROM app_hr_payments hp WHERE hp.id=${source} AND (${hr.payroll?'hp.slip_id IS NOT NULL':'false'} OR ${hr.money?'hp.money_id IS NOT NULL':'false'})))`);
    const restrictions=[];
    for(const [values,column,denial] of [[hr.employees,'gl.party_id',false],[hr.deniedEmployees,'gl.party_id',true],
      [hr.costCenters,'gl.cost_center',false],[hr.deniedCostCenters,'gl.cost_center',true]]) {
      if(rules.length&&Array.isArray(values)&&(!denial||values.length)) {
        params.push(values);
        restrictions.push(column==='gl.cost_center'
          ? `(${column} IS NULL OR ${column} ${denial?'<> ALL':'= ANY'}($${params.length}::text[]))`
          : `${column} ${denial?'<> ALL':'= ANY'}($${params.length}::text[])`);
      }
    }
    hrRule=rules.length?`((${rules.join(' OR ')})${restrictions.length?' AND '+restrictions.join(' AND '):''})`:'false';
    where.push(`(gl.voucher_type NOT LIKE 'hr_%' OR ${hrRule})`);
  }
  const accountRules = [];
  if (Array.isArray(access.allowedAccounts)) {
    params.push(access.allowedAccounts);
    const position = params.length;
    accountRules.push((column) => `${column}::text = ANY($${position}::text[])`);
  }
  if (Array.isArray(access.deniedAccounts) && access.deniedAccounts.length) {
    params.push(access.deniedAccounts);
    const position = params.length;
    accountRules.push((column) => `${column}::text <> ALL($${position}::text[])`);
  }
  if (accountRules.length) where.push(accountRules.map((rule) => rule('gl.account_id')).join(' AND '));

  if (access.ownerId === null || access.ownerId === undefined) return;
  let customerRule = '';
  if (Array.isArray(access.customerGroups)) {
    params.push(access.customerGroups);
    customerRule = `AND EXISTS (SELECT 1 FROM app_master_customers customer
      WHERE customer.customer_id = i.customer_id
        AND LOWER(customer.customer_group) = ANY($${params.length}::text[]))`;
  }
  let supplierRule = '';
  if (Array.isArray(access.supplierTypes)) {
    params.push(access.supplierTypes);
    supplierRule = `AND EXISTS (SELECT 1 FROM app_master_suppliers supplier
      WHERE supplier.supplier_id = purchase.supplier_id
        AND LOWER(supplier.supplier_type) = ANY($${params.length}::text[]))`;
  }
  const partyScopeRestricted = Boolean(customerRule || supplierRule);
  params.push(String(access.ownerId), String(access.ownerEmployeeId || ''));
  const owner = `$${params.length - 1}`;
  const employee = `$${params.length}`;
  const sourceId = 'COALESCE(gl.reversal_of_voucher_id, gl.voucher_id)';
  const invoiceOwner = `(i.created_by_user_id = ${owner} OR i.invoicer_id = ${employee})`;
  const journalAccounts = accountRules.length ? `AND NOT EXISTS (
    SELECT 1 FROM app_journal_entry_lines line
    WHERE line.journal_entry_id = journal.id
      AND NOT (${accountRules.map((rule) => rule('line.account_id')).join(' AND ')})
  )` : '';
  where.push(`(
    (gl.voucher_type IN ('sales_invoice', 'sales_invoice_cancellation') AND EXISTS (
      SELECT 1 FROM app_invoices i WHERE i.id = ${sourceId} AND ${invoiceOwner} ${customerRule}))
    OR (gl.voucher_type IN ('customer_payment', 'customer_payment_cancellation') AND EXISTS (
      SELECT 1 FROM app_invoice_payments payment
      JOIN app_invoices i ON i.id = payment.invoice_id
      WHERE payment.id = ${sourceId} AND ${invoiceOwner} ${customerRule}))
    OR (gl.voucher_type='inventory_correction' AND EXISTS(SELECT 1 FROM wm_inventory_corrections correction WHERE correction.id=gl.voucher_id AND correction.prepared_by::text=${owner}))
    OR (gl.voucher_type IN ('purchase', 'purchase_cancellation') AND EXISTS (
      SELECT 1 FROM app_purchases purchase
      WHERE purchase.id = ${sourceId} AND purchase.created_by_user_id = ${owner} ${supplierRule}))
    OR (gl.voucher_type IN ('purchase_payment', 'purchase_payment_cancellation') AND EXISTS (
      SELECT 1 FROM app_purchase_payments payment
      JOIN app_purchases purchase ON purchase.id = payment.purchase_id
      WHERE payment.id = ${sourceId} AND purchase.created_by_user_id = ${owner} ${supplierRule}))
    OR (gl.voucher_type IN ('payment_journal', 'payment_journal_cancellation') AND EXISTS (
      SELECT 1 FROM app_purchase_payments payment
      JOIN app_purchases purchase ON purchase.id = payment.purchase_id
      WHERE payment.journal_entry_id = ${sourceId} AND payment.method <> 'journal'
        AND purchase.created_by_user_id = ${owner} ${supplierRule}))
    ${partyScopeRestricted ? '' : `OR (gl.voucher_type IN ('cash_receipt', 'payment_journal', 'journal_entry',
        'cash_receipt_cancellation', 'payment_journal_cancellation', 'journal_entry_cancellation')
      AND EXISTS (SELECT 1 FROM app_journal_entries journal
        WHERE journal.id = ${sourceId} AND journal.created_by_user_id = ${owner} ${journalAccounts}))
    OR (gl.voucher_type LIKE 'stock_%' AND EXISTS (
      SELECT 1 FROM app_stock_entries stock
      WHERE stock.id = ${sourceId} AND stock.created_by_user_id = ${owner}))`}
    ${hrRule ? `OR (${hrRule})` : ''}
  )`);
}

module.exports={addGeneralLedgerAccessFilter};

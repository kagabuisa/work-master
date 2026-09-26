const { getPostgresPool, findInvoice } = require('./store');
const { purchaseForPayment } = require('./purchases');

function selectedCategories(user, kind) {
  if (user?.role === 'admin') return null;
  const scope = user?.scopes?.[kind];
  if (!scope || scope.mode !== 'selected') return null;
  return Array.isArray(scope.values) ? scope.values.map((value) => String(value).trim().toLowerCase()) : [];
}

function scopeRestricted(user, kind) {
  return selectedCategories(user, kind) !== null;
}

function anyScopeRestricted(user) {
  return scopeRestricted(user, 'customers') || scopeRestricted(user, 'suppliers');
}

function categoryAllowed(user, kind, category) {
  const selected = selectedCategories(user, kind);
  return selected === null || selected.includes(String(category || '').trim().toLowerCase());
}

async function masterRecordAllowed(user, kind, id) {
  if (!scopeRestricted(user, kind)) return true;
  const value = String(id || '').trim();
  if (!value) return false;
  const customer = kind === 'customers';
  const table = customer ? 'app_master_customers' : 'app_master_suppliers';
  const idField = customer ? 'customer_id' : 'supplier_id';
  const categoryField = customer ? 'customer_group' : 'supplier_type';
  const { rows } = await getPostgresPool().query(
    `SELECT ${categoryField} AS category FROM ${table} WHERE ${idField} = $1 LIMIT 1`, [value],
  );
  return Boolean(rows[0] && categoryAllowed(user, kind, rows[0].category));
}

async function invoiceAllowed(user, id) {
  if (!scopeRestricted(user, 'customers')) return true;
  const invoice = await findInvoice(id);
  return Boolean(invoice && await masterRecordAllowed(user, 'customers', invoice.customer_id));
}

async function purchaseAllowed(user, id) {
  if (!scopeRestricted(user, 'suppliers')) return true;
  const { rows } = await getPostgresPool().query('SELECT supplier_id FROM app_purchases WHERE id = $1', [id]);
  return Boolean(rows[0] && await masterRecordAllowed(user, 'suppliers', rows[0].supplier_id));
}

async function purchasePaymentAllowed(user, paymentId) {
  if (!scopeRestricted(user, 'suppliers')) return true;
  try { return purchaseAllowed(user, await purchaseForPayment(paymentId)); }
  catch (error) { if (error.status === 404) return false; throw error; }
}

module.exports = {
  selectedCategories,
  scopeRestricted,
  anyScopeRestricted,
  categoryAllowed,
  masterRecordAllowed,
  invoiceAllowed,
  purchaseAllowed,
  purchasePaymentAllowed,
};

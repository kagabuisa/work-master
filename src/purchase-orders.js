const { getPostgresPool, withPostgresTransaction } = require('./store');
const { normalizePurchase, resolvePurchaseMasters } = require('./purchases');
const { storedPostingTime } = require('./posting-time');
const { auditActor } = require('./audit');
const { addVoucherOwnerFilter } = require('./voucher-ownership');

function error(message, status = 400) {
  const result = new Error(message);
  result.status = status;
  return result;
}

function orderId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw error('Purchase order not found.', 404);
  return id;
}

function normalizePurchaseOrder(payload) {
  const warehouse = String(payload.warehouse || '').trim();
  if (!warehouse) throw error('Choose a warehouse for this purchase order.');
  const items = Array.isArray(payload.items) ? payload.items : [];
  return normalizePurchase({ ...payload,
    items: items.map((item) => ({ ...item, warehouse })) });
}

async function insertItems(client, id, items) {
  for (const item of items) {
    await client.query(`INSERT INTO app_purchase_order_items
      (purchase_order_id, line_no, item_code, item_name, warehouse, quantity, unit_price, line_total)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, item.line_no, item.item_code, item.item_name, item.warehouse,
      item.quantity, item.unit_price, item.line_total]);
  }
}

async function createPurchaseOrder(payload) {
  const order = normalizePurchaseOrder(payload);
  return withPostgresTransaction(async (client) => {
    await resolvePurchaseMasters(client, order);
    const result = await client.query(`INSERT INTO app_purchase_orders
      (posting_date, posting_time, due_date, supplier_id, supplier_name, price_list,
       supplier_reference, remarks, subtotal, total, cost_center)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [order.posting_date, order.posting_time, order.due_date, order.supplier_id,
      order.supplier_name, order.price_list, order.supplier_reference, order.remarks,
      order.subtotal, order.total, order.cost_center]);
    const id = Number(result.rows[0].id);
    await client.query('UPDATE app_purchase_orders SET order_no = $1 WHERE id = $2',
      [`PO-${String(id).padStart(6, '0')}`, id]);
    await insertItems(client, id, order.items);
    return id;
  });
}

async function updatePurchaseOrder(value, payload) {
  const id = orderId(value);
  const order = normalizePurchaseOrder(payload);
  return withPostgresTransaction(async (client) => {
    const existing = await client.query('SELECT docstatus FROM app_purchase_orders WHERE id = $1 FOR UPDATE', [id]);
    if (!existing.rows.length) throw error('Purchase order not found.', 404);
    if (existing.rows[0].docstatus !== 'draft') throw error('Only draft purchase orders can be edited.');
    await resolvePurchaseMasters(client, order);
    await client.query(`UPDATE app_purchase_orders SET posting_date=$1, posting_time=$2, due_date=$3,
      supplier_id=$4, supplier_name=$5, price_list=$6, supplier_reference=$7, remarks=$8,
      subtotal=$9, total=$10, cost_center=$12, updated_at=now() WHERE id=$11`,
    [order.posting_date, order.posting_time, order.due_date, order.supplier_id,
      order.supplier_name, order.price_list, order.supplier_reference, order.remarks,
      order.subtotal, order.total, id, order.cost_center]);
    await client.query('DELETE FROM app_purchase_order_items WHERE purchase_order_id = $1', [id]);
    await insertItems(client, id, order.items);
    return id;
  });
}

async function listPurchaseOrders(filters = {}) {
  const page = Math.max(1, Number.parseInt(filters.page, 10) || 1);
  const requestedLimit = Number.parseInt(filters.page_size, 10);
  const limit = [10, 25, 50, 100].includes(requestedLimit) ? requestedLimit : 25;
  const params = [];
  const where = [];
  addVoucherOwnerFilter(where, params, 'o', filters.ownerId);
  if (Array.isArray(filters.allowedTypes)) {
    params.push(filters.allowedTypes);
    where.push(`EXISTS (SELECT 1 FROM app_master_suppliers s WHERE s.supplier_id = o.supplier_id
      AND LOWER(TRIM(COALESCE(s.supplier_type, ''))) = ANY($${params.length}::text[]))`);
  }
  const search = String(filters.q || '').trim();
  if (search) {
    params.push(`%${search.replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(o.order_no ILIKE $${params.length} OR o.supplier_id ILIKE $${params.length}
      OR o.supplier_name ILIKE $${params.length} OR o.supplier_reference ILIKE $${params.length})`);
  }
  for (const [key, operator] of [['from', '>='], ['to', '<=']]) {
    const date = String(filters[key] || '').trim();
    if (date) { params.push(date); where.push(`o.posting_date ${operator} $${params.length}`); }
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const pool = getPostgresPool();
  const count = await pool.query(`SELECT COUNT(*)::int AS total FROM app_purchase_orders o ${whereSql}`, params);
  const total = Number(count.rows[0].total);
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * limit;
  const rows = await pool.query(`SELECT o.id, o.order_no, o.docstatus, o.posting_date::text,
    o.posting_time::text, o.due_date::text, o.supplier_id, o.supplier_name,
    o.supplier_reference, o.total::float FROM app_purchase_orders o ${whereSql}
    ORDER BY o.posting_date DESC, o.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
  [...params, limit, offset]);
  return { rows: rows.rows.map((row) => ({ ...row, posting_time: storedPostingTime(row.posting_time) })),
    pagination: { page: safePage, limit, total_pages: totalPages, total, offset,
      start: total ? offset + 1 : 0, end: Math.min(offset + limit, total) } };
}

async function loadPurchaseOrder(value, options = {}) {
  const id = orderId(value);
  const pool = getPostgresPool();
  const result = await pool.query(`SELECT *, posting_date::text AS posting_date,
    posting_time::text AS posting_time, due_date::text AS due_date, subtotal::float AS subtotal,
    total::float AS total FROM app_purchase_orders WHERE id=$1`, [id]);
  if (!result.rows.length) throw error('Purchase order not found.', 404);
  const items = await pool.query(`SELECT oi.*, oi.quantity::float AS quantity, oi.unit_price::float AS unit_price,
    oi.line_total::float AS line_total, COALESCE(receipts.received, 0)::float AS received
    FROM app_purchase_order_items oi LEFT JOIN LATERAL (
      SELECT SUM(pi.quantity) AS received FROM app_purchase_items pi
      JOIN app_purchases p ON p.id = pi.purchase_id
      WHERE pi.purchase_order_item_id = oi.id AND p.docstatus = 'submitted'
    ) receipts ON true WHERE oi.purchase_order_id=$1 ORDER BY oi.line_no`, [id]);
  const invoiceParams = [id];
  const ownerFilter = options.ownerId === null || options.ownerId === undefined ? ''
    : ' AND created_by_user_id = $2';
  if (ownerFilter) invoiceParams.push(String(options.ownerId));
  const invoices = await pool.query(`SELECT id, purchase_no, docstatus FROM app_purchases
    WHERE purchase_order_id=$1${ownerFilter} ORDER BY id DESC`, invoiceParams);
  const warehouses = [...new Set(items.rows.map((item) => item.warehouse).filter(Boolean))];
  return { ...result.rows[0], posting_time: storedPostingTime(result.rows[0].posting_time),
    warehouse: warehouses.length === 1 ? warehouses[0] : '',
    mixedWarehouses: warehouses.length > 1,
    items: items.rows, invoices: invoices.rows };
}

async function listReceivablePurchaseOrders() {
  const result = await getPostgresPool().query(`SELECT o.id, o.order_no, o.supplier_name
    FROM app_purchase_orders o WHERE o.docstatus = 'submitted' AND EXISTS (
      SELECT 1 FROM app_purchase_order_items oi WHERE oi.purchase_order_id = o.id
      AND oi.quantity > COALESCE((SELECT SUM(pi.quantity) FROM app_purchase_items pi
        JOIN app_purchases p ON p.id = pi.purchase_id
        WHERE pi.purchase_order_item_id = oi.id AND p.docstatus = 'submitted'), 0)
    ) ORDER BY o.posting_date DESC, o.id DESC LIMIT 100`);
  return result.rows;
}

async function changeStatus(value, from, to) {
  const id = orderId(value);
  return withPostgresTransaction(async (client) => {
    const result = await client.query('SELECT docstatus FROM app_purchase_orders WHERE id=$1 FOR UPDATE', [id]);
    if (!result.rows.length) throw error('Purchase order not found.', 404);
    if (result.rows[0].docstatus !== from) throw error(`Only ${from} purchase orders can be ${to}.`);
    if (to === 'cancelled') {
      const receipts = await client.query(`SELECT 1 FROM app_purchases
        WHERE purchase_order_id=$1 AND docstatus='submitted' LIMIT 1`, [id]);
      if (receipts.rows.length) throw error('Cancel the linked purchase invoices before cancelling this order.');
    }
    const actor = auditActor();
    const column = to === 'submitted' ? 'submitted' : 'cancelled';
    await client.query(`UPDATE app_purchase_orders SET docstatus=$1, ${column}_by=$2,
      ${column}_by_user_id=$3, ${column}_at=now(), updated_at=now() WHERE id=$4`,
    [to, actor.name || null, actor.id || null, id]);
    return id;
  });
}

async function deleteDraftPurchaseOrder(value, { allowCancelled = false } = {}) {
  const id = orderId(value);
  return withPostgresTransaction(async (client) => {
    const result = await client.query('SELECT docstatus FROM app_purchase_orders WHERE id=$1 FOR UPDATE', [id]);
    if (!result.rows.length) throw error('Purchase order not found.', 404);
    if (result.rows[0].docstatus !== 'draft' && !(allowCancelled && result.rows[0].docstatus === 'cancelled')) {
      throw error(allowCancelled
        ? 'Only draft or cancelled purchase orders can be deleted. Cancel a submitted order first.'
        : 'Only draft purchase orders can be deleted.');
    }
    const linked = await client.query('SELECT 1 FROM app_purchases WHERE purchase_order_id=$1 LIMIT 1', [id]);
    if (linked.rows.length) throw error('Delete linked purchase invoices before deleting this order.');
    await client.query('DELETE FROM app_purchase_orders WHERE id=$1', [id]);
  });
}

module.exports = { normalizePurchaseOrder, createPurchaseOrder, updatePurchaseOrder, listPurchaseOrders, loadPurchaseOrder,
  listReceivablePurchaseOrders,
  submitPurchaseOrder: (id) => changeStatus(id, 'draft', 'submitted'),
  cancelPurchaseOrder: (id) => changeStatus(id, 'submitted', 'cancelled'),
  deleteDraftPurchaseOrder };

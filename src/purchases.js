const {
  getPostgresPool,
  withPostgresTransaction,
  applyPostgresStockMovement,
  postGlEntry,
  reverseVoucherGlEntries,
} = require('./store');
const { auditActor } = require('./audit');
const { normalizePostingTime, storedPostingTime } = require('./posting-time');

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function notFound() {
  const error = new Error('Purchase not found.');
  error.status = 404;
  return error;
}

function money(value) {
  return Math.round(Number(value || 0));
}

function actorAuditValues() {
  const actor = auditActor();
  return {
    by: actor.name || null,
    by_user_id: actor.id || null,
    at: new Date().toISOString(),
  };
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function normalizePurchase(payload) {
  const postingDate = String(payload.posting_date || '').trim();
  const dueDate = String(payload.due_date || '').trim();
  const supplierId = String(payload.supplier_id || '').trim();
  const priceList = String(payload.price_list || '').trim();
  if (!validDate(postingDate)) throw badRequest('Choose a valid purchase date.');
  if (dueDate && !validDate(dueDate)) throw badRequest('Choose a valid due date.');
  if (dueDate && dueDate < postingDate) throw badRequest('Due date cannot be before the purchase date.');
  if (!supplierId) throw badRequest('Select a supplier.');
  if (!priceList) throw badRequest('Select a price list.');
  const rows = Array.isArray(payload.items) ? payload.items : [];
  const items = rows.map((row, index) => {
    const itemCode = String(row.item_code || '').trim();
    const warehouse = String(row.warehouse || '').trim();
    const quantity = Number(row.quantity);
    const unitPrice = Number(row.unit_price);
    if (!itemCode || !warehouse || !Number.isFinite(quantity) || quantity <= 0
      || !Number.isFinite(unitPrice) || unitPrice <= 0) {
      throw badRequest(`Complete item, warehouse, quantity, and unit price on row ${index + 1}.`);
    }
    if (Math.round(quantity * 1000) !== quantity * 1000) {
      throw badRequest(`Quantity on row ${index + 1} can have at most three decimal places.`);
    }
    if (Math.round(unitPrice * 100) !== unitPrice * 100) {
      throw badRequest(`Unit price on row ${index + 1} can have at most two decimal places.`);
    }
    return {
      id: Number(row.id || 0),
      purchase_order_item_id: Number(row.purchase_order_item_id || 0) || null,
      line_no: index + 1,
      item_code: itemCode,
      warehouse,
      quantity,
      unit_price: unitPrice,
      line_total: money(quantity * unitPrice),
    };
  });
  if (!items.length) throw badRequest('Add at least one purchase item.');
  const total = money(items.reduce((sum, item) => sum + item.line_total, 0));
  if (total <= 0) throw badRequest('Purchase total must be greater than zero.');
  return {
    posting_date: postingDate,
    posting_time: normalizePostingTime(payload.posting_time),
    due_date: dueDate || null,
    supplier_id: supplierId,
    price_list: priceList,
    purchase_order_id: payload.purchase_order_id ? Number(payload.purchase_order_id) : null,
    supplier_reference: String(payload.supplier_reference || '').trim() || null,
    remarks: String(payload.remarks || '').trim() || null,
    subtotal: total,
    total,
    items,
  };
}

async function resolvePurchaseMasters(client, purchase) {
  const priceList = await client.query(`SELECT 1 FROM app_master_price_lists
    WHERE price_list = $1 AND active = 1 AND currency = 'UGX' AND price_type IN ('buying', 'both')`, [purchase.price_list]);
  if (!priceList.rows.length) throw badRequest('Select an active UGX buying price list.');
  const supplierResult = await client.query(
    'SELECT supplier_name FROM app_master_suppliers WHERE supplier_id = $1 AND disabled = false',
    [purchase.supplier_id],
  );
  if (!supplierResult.rows.length) throw badRequest('Select an active supplier from the supplier list.');
  const itemCodes = [...new Set(purchase.items.map((item) => item.item_code))];
  const warehouseNames = [...new Set(purchase.items.map((item) => item.warehouse))];
  const itemResult = await client.query(
    'SELECT item_code, item_name FROM app_master_items WHERE item_code = ANY($1::text[]) AND disabled = false AND is_purchase_item = true',
    [itemCodes],
  );
  const warehouseResult = await client.query(
    'SELECT warehouse FROM app_master_warehouses WHERE warehouse = ANY($1::text[]) AND disabled = false AND is_group = false',
    [warehouseNames],
  );
  const itemsByCode = new Map(itemResult.rows.map((item) => [item.item_code, item.item_name]));
  const warehouses = new Set(warehouseResult.rows.map((row) => row.warehouse));
  for (const item of purchase.items) {
    if (!itemsByCode.has(item.item_code)) throw badRequest(`Item ${item.item_code} is not available for purchase.`);
    if (!warehouses.has(item.warehouse)) throw badRequest(`Warehouse ${item.warehouse} is not available.`);
    item.item_name = itemsByCode.get(item.item_code);
  }
  purchase.supplier_name = supplierResult.rows[0].supplier_name;
  return purchase;
}

async function assertUniqueSupplierReference(client, purchase, excludeId = null) {
  if (!purchase.supplier_reference) return;
  const result = await client.query(`
    SELECT 1 FROM app_purchases
    WHERE supplier_id = $1 AND LOWER(supplier_reference) = LOWER($2)
      AND ($3::bigint IS NULL OR id <> $3)
    LIMIT 1
  `, [purchase.supplier_id, purchase.supplier_reference, excludeId]);
  if (result.rows.length) throw badRequest('This supplier reference is already used on another purchase.');
}

async function insertItems(client, purchaseId, items) {
  for (const item of items) {
    await client.query(`
      INSERT INTO app_purchase_items (
        purchase_id, line_no, item_code, item_name, warehouse, quantity, unit_price, line_total,
        purchase_order_item_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [purchaseId, item.line_no, item.item_code, item.item_name, item.warehouse,
      item.quantity, item.unit_price, item.line_total, item.purchase_order_item_id]);
  }
}

async function syncItems(client, purchaseId, items) {
  const existingResult = await client.query(
    'SELECT id FROM app_purchase_items WHERE purchase_id = $1',
    [purchaseId],
  );
  const existingIds = new Set(existingResult.rows.map((row) => Number(row.id)));
  const seenIds = new Set();

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const dbId = Number(item.id || 0);
    if (dbId > 0 && existingIds.has(dbId)) {
      await client.query(
        `
        UPDATE app_purchase_items
        SET line_no = $1,
          item_code = $2,
          item_name = $3,
          warehouse = $4,
          quantity = $5,
          unit_price = $6,
          line_total = $7, purchase_order_item_id = $10
        WHERE id = $8 AND purchase_id = $9
        `,
        [
          index + 1,
          item.item_code,
          item.item_name,
          item.warehouse,
          item.quantity,
          item.unit_price,
          item.line_total,
          dbId,
          purchaseId,
          item.purchase_order_item_id,
        ],
      );
      seenIds.add(dbId);
    }
  }

  for (const dbId of existingIds) {
    if (!seenIds.has(dbId)) {
      await client.query('DELETE FROM app_purchase_items WHERE id = $1 AND purchase_id = $2', [dbId, purchaseId]);
    }
  }

  const newItems = items.filter((item) => !(Number(item.id || 0) > 0 && existingIds.has(Number(item.id))));
  await insertItems(client, purchaseId, newItems);
}

async function validatePurchaseOrder(client, purchase, excludePurchaseId = null, checkRemaining = false) {
  if (purchase.purchase_order_id === null) {
    if (purchase.items.some((item) => item.purchase_order_item_id)) throw badRequest('Select a purchase order for linked items.');
    return;
  }
  if (!Number.isSafeInteger(purchase.purchase_order_id) || purchase.purchase_order_id < 1) throw badRequest('Select a valid purchase order.');
  const { rows: orders } = await client.query(`SELECT id, order_no, supplier_id, price_list, docstatus
    FROM app_purchase_orders WHERE id=$1 FOR UPDATE`, [purchase.purchase_order_id]);
  const order = orders[0];
  if (!order || order.docstatus !== 'submitted') throw badRequest('Select a submitted purchase order.');
  if (order.supplier_id !== purchase.supplier_id || order.price_list !== purchase.price_list) {
    throw badRequest('Supplier and price list must match the purchase order.');
  }
  const { rows: orderItems } = await client.query(`SELECT id, item_code, warehouse, quantity::float AS quantity
    FROM app_purchase_order_items WHERE purchase_order_id=$1`, [order.id]);
  const byId = new Map(orderItems.map((item) => [Number(item.id), item]));
  const requested = new Map();
  for (const item of purchase.items) {
    const source = byId.get(item.purchase_order_item_id);
    if (!source || source.item_code !== item.item_code || source.warehouse !== item.warehouse) {
      throw badRequest('Invoice items must match the selected purchase order lines.');
    }
    const sourceId = Number(source.id);
    requested.set(sourceId, (requested.get(sourceId) || 0) + item.quantity);
  }
  if (!checkRemaining) return;
  const { rows: received } = await client.query(`SELECT pi.purchase_order_item_id AS id, SUM(pi.quantity)::float AS quantity
    FROM app_purchase_items pi JOIN app_purchases p ON p.id=pi.purchase_id
    WHERE p.docstatus='submitted' AND p.purchase_order_id=$1 AND ($2::bigint IS NULL OR p.id<>$2)
    GROUP BY pi.purchase_order_item_id`, [order.id, excludePurchaseId]);
  const receivedById = new Map(received.map((row) => [Number(row.id), Number(row.quantity)]));
  for (const [id, quantity] of requested) {
    if (Math.round((quantity + (receivedById.get(id) || 0)) * 1000) > Math.round(byId.get(id).quantity * 1000)) {
      throw badRequest(`Received quantity exceeds the remaining quantity for ${byId.get(id).item_code}.`);
    }
  }
}

async function createPurchase(payload) {
  const purchase = normalizePurchase(payload);
  return withPostgresTransaction(async (client) => {
    await resolvePurchaseMasters(client, purchase);
    await validatePurchaseOrder(client, purchase);
    await assertUniqueSupplierReference(client, purchase);
    const { rows } = await client.query(`
      INSERT INTO app_purchases (
        posting_date, posting_time, due_date, supplier_id, supplier_name, supplier_reference, remarks,
        subtotal, total, price_list, purchase_order_id
      ) VALUES ($1, $10, $2, $3, $4, $5, $6, $7, $8, $9, $11) RETURNING id
    `, [purchase.posting_date, purchase.due_date, purchase.supplier_id,
      purchase.supplier_name, purchase.supplier_reference, purchase.remarks,
      purchase.subtotal, purchase.total, purchase.price_list, purchase.posting_time, purchase.purchase_order_id]);
    const id = Number(rows[0].id);
    await client.query('UPDATE app_purchases SET purchase_no = $1 WHERE id = $2',
      [`PUR-${String(id).padStart(6, '0')}`, id]);
    await insertItems(client, id, purchase.items);
    return id;
  });
}

async function updatePurchase(id, payload) {
  const purchaseId = Number(id);
  if (!Number.isSafeInteger(purchaseId) || purchaseId < 1) throw notFound();
  const purchase = normalizePurchase(payload);
  return withPostgresTransaction(async (client) => {
    const existing = await client.query('SELECT docstatus, purchase_order_id FROM app_purchases WHERE id = $1 FOR UPDATE', [purchaseId]);
    if (!existing.rows.length) throw notFound();
    if (existing.rows[0].docstatus !== 'draft') throw badRequest('Only draft purchases can be edited.');
    if (existing.rows[0].purchase_order_id
      && Number(existing.rows[0].purchase_order_id) !== purchase.purchase_order_id) {
      throw badRequest('This invoice is already linked to a purchase order.');
    }
    await resolvePurchaseMasters(client, purchase);
    await validatePurchaseOrder(client, purchase);
    await assertUniqueSupplierReference(client, purchase, purchaseId);
    await client.query(`
      UPDATE app_purchases SET posting_date = $1, posting_time = $11, due_date = $2, supplier_id = $3,
        supplier_name = $4, supplier_reference = $5, remarks = $6,
        subtotal = $7, total = $8, price_list = $10, purchase_order_id = $12, updated_at = now()
      WHERE id = $9
    `, [purchase.posting_date, purchase.due_date, purchase.supplier_id,
      purchase.supplier_name, purchase.supplier_reference, purchase.remarks,
      purchase.subtotal, purchase.total, purchaseId, purchase.price_list, purchase.posting_time, purchase.purchase_order_id]);
    await syncItems(client, purchaseId, purchase.items);
    return purchaseId;
  });
}

async function listPurchases(filters = {}) {
  const search = String(filters.q || '').trim();
  const page = Math.max(1, Number.parseInt(filters.page, 10) || 1);
  const requestedLimit = Number.parseInt(filters.page_size, 10);
  const limit = [10, 25, 50, 100].includes(requestedLimit) ? requestedLimit : 25;
  const params = [];
  const where = [];
  if (Array.isArray(filters.allowedTypes)) {
    params.push(filters.allowedTypes);
    where.push(`EXISTS (
      SELECT 1 FROM app_master_suppliers supplier
      WHERE supplier.supplier_id = p.supplier_id
        AND LOWER(TRIM(COALESCE(supplier.supplier_type, ''))) = ANY($${params.length}::text[])
    )`);
  }
  if (search) {
    params.push(`%${search.replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(p.purchase_no ILIKE $${params.length} OR p.supplier_id ILIKE $${params.length}
      OR p.supplier_name ILIKE $${params.length} OR p.supplier_reference ILIKE $${params.length})`);
  }
  const from = String(filters.from || '').trim();
  const to = String(filters.to || '').trim();
  if (from) { params.push(from); where.push(`p.posting_date >= $${params.length}`); }
  if (to) { params.push(to); where.push(`p.posting_date <= $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = await getPostgresPool().query(`SELECT COUNT(*)::int AS total FROM app_purchases p ${whereSql}`, params);
  const total = Number(count.rows[0].total || 0);
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * limit;
  params.push(limit, offset);
  const result = await getPostgresPool().query(`
    SELECT p.id, p.purchase_no, p.docstatus, p.posting_date::text, p.posting_time::text, p.due_date::text,
      p.supplier_id, p.supplier_name, p.supplier_reference,
      p.total::float, p.amount_paid::float, p.status
    FROM app_purchases p ${whereSql}
    ORDER BY p.posting_date DESC, p.id DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params);
  const pagination = {
    page: safePage,
    limit,
    total_pages: totalPages,
    total,
    offset,
    start: total ? offset + 1 : 0,
    end: Math.min(offset + limit, total),
  };
  return { rows: result.rows.map((row) => ({ ...row, posting_time: storedPostingTime(row.posting_time) })),
    page: pagination.page, pages: totalPages, total, pagination };
}

async function loadPurchase(id) {
  const purchaseId = Number(id);
  if (!Number.isSafeInteger(purchaseId) || purchaseId < 1) throw notFound();
  const pool = getPostgresPool();
  const result = await pool.query(`
    SELECT created_by, created_by_user_id, created_at, updated_by, updated_by_user_id, updated_at,
      id, purchase_no, docstatus, posting_date::text, posting_time::text, due_date::text,
      supplier_id, supplier_name, price_list, supplier_reference, remarks, purchase_order_id,
      subtotal::float, submitted_by, submitted_by_user_id, submitted_at,
      cancelled_by, cancelled_by_user_id, cancelled_at,
      total::float, amount_paid::float, status
    FROM app_purchases WHERE id = $1
  `, [purchaseId]);
  if (!result.rows.length) throw notFound();
  const [items, payments] = await Promise.all([
    pool.query(`
      SELECT id, line_no, created_by, created_by_user_id, created_at,
        updated_by, updated_by_user_id, updated_at,
        item_code, item_name, warehouse, quantity::float, unit_price::float, line_total::float, purchase_order_item_id
      FROM app_purchase_items WHERE purchase_id = $1 ORDER BY line_no
    `, [purchaseId]),
    pool.query(`
      SELECT id, payment_no, created_by, created_by_user_id, created_at,
        updated_by, updated_by_user_id, updated_at,
        payment_date::text, amount::float, method, reference, notes, docstatus
      FROM app_purchase_payments WHERE purchase_id = $1 ORDER BY payment_no
    `, [purchaseId]),
  ]);
  return { ...result.rows[0], posting_time: storedPostingTime(result.rows[0].posting_time),
    items: items.rows, payments: payments.rows };
}

async function purchaseForPayment(id) {
  const paymentId = Number(id);
  if (!Number.isSafeInteger(paymentId) || paymentId < 1) throw notFound();
  const result = await getPostgresPool().query(
    'SELECT purchase_id FROM app_purchase_payments WHERE id = $1', [paymentId],
  );
  if (!result.rows.length) throw notFound();
  return Number(result.rows[0].purchase_id);
}

async function submitPurchase(id) {
  const purchaseId = Number(id);
  if (!Number.isSafeInteger(purchaseId) || purchaseId < 1) throw notFound();
  return withPostgresTransaction(async (client) => {
    const result = await client.query(`
      SELECT id, purchase_no, docstatus, posting_date::text, supplier_id, supplier_name, total::float, purchase_order_id, price_list
      FROM app_purchases WHERE id = $1 FOR UPDATE
    `, [purchaseId]);
    const purchase = result.rows[0];
    if (!purchase) throw notFound();
    if (purchase.docstatus !== 'draft') throw badRequest('Only draft purchases can be submitted.');
    const itemResult = await client.query(`
      SELECT item_code, item_name, warehouse, quantity::float, unit_price::float, purchase_order_item_id
      FROM app_purchase_items WHERE purchase_id = $1 ORDER BY line_no
    `, [purchaseId]);
    if (!itemResult.rows.length) throw badRequest('Add at least one item before submitting.');
    if (purchase.purchase_order_id) {
      await validatePurchaseOrder(client, { ...purchase, items: itemResult.rows.map((item) => ({ ...item,
        purchase_order_item_id: Number(item.purchase_order_item_id) })) }, purchaseId, true);
    }
    for (const item of itemResult.rows) {
      await applyPostgresStockMovement(client, {
        posting_date: purchase.posting_date,
        item_code: item.item_code,
        item_name: item.item_name,
        warehouse: item.warehouse,
        voucher_type: 'purchase',
        voucher_id: purchaseId,
        voucher_no: purchase.purchase_no,
        qty_change: Number(item.quantity),
        rate: Number(item.unit_price),
      });
    }
    const ledger = await client.query(`
      SELECT COALESCE(SUM(stock_value_change), 0)::float AS value
      FROM app_stock_ledger WHERE voucher_type = 'purchase' AND voucher_id = $1
    `, [purchaseId]);
    const inventoryValue = money(ledger.rows[0].value);
    if (inventoryValue !== money(purchase.total)) {
      throw badRequest('Stock value and purchase total differ. Adjust item quantities or prices before submitting.');
    }
    await postGlEntry(client, {
      posting_date: purchase.posting_date,
      voucher_type: 'purchase',
      voucher_id: purchaseId,
      voucher_no: purchase.purchase_no,
      party_type: 'supplier',
      party_id: purchase.supplier_id,
      party_name: purchase.supplier_name,
      lines: [
        { account_key: 'inventory', debit: inventoryValue },
        { account_key: 'accounts_payable', credit: inventoryValue },
      ],
    });
    const actor = actorAuditValues();
    await client.query(
      `UPDATE app_purchases
       SET docstatus = 'submitted',
           submitted_by = $2,
           submitted_by_user_id = $3,
           submitted_at = $4,
           updated_at = now()
       WHERE id = $1`,
      [purchaseId, actor.by, actor.by_user_id, actor.at],
    );
    return purchaseId;
  });
}

async function cancelPurchase(id) {
  const purchaseId = Number(id);
  if (!Number.isSafeInteger(purchaseId) || purchaseId < 1) throw notFound();
  return withPostgresTransaction(async (client) => {
    const { rows: purchases } = await client.query(
      'SELECT id, purchase_no, docstatus FROM app_purchases WHERE id = $1 FOR UPDATE',
      [purchaseId],
    );
    const purchase = purchases[0];
    if (!purchase) throw notFound();
    if (purchase.docstatus !== 'submitted') throw badRequest('Only submitted purchases can be cancelled.');

    const postingDate = new Date().toISOString().slice(0, 10);
    const { rows: stockRows } = await client.query(
      "SELECT * FROM app_stock_ledger WHERE voucher_type = 'purchase' AND voucher_id = $1 AND is_reversal = false ORDER BY id",
      [purchaseId],
    );
    for (const row of stockRows) {
      await applyPostgresStockMovement(client, {
        posting_date: postingDate,
        item_code: row.item_code,
        item_name: row.item_name,
        warehouse: row.warehouse,
        voucher_type: 'purchase',
        voucher_id: purchaseId,
        voucher_no: purchase.purchase_no,
        qty_change: -Number(row.qty_change),
        force_outgoing_rate: Number(row.incoming_rate || row.outgoing_rate || 0),
        is_reversal: true,
        reversal_of_voucher_id: purchaseId,
        reversal_of_voucher_no: purchase.purchase_no,
        remarks: `Cancellation of ${purchase.purchase_no}`,
      });
    }

    const { rows: payments } = await client.query(
      "SELECT id FROM app_purchase_payments WHERE purchase_id = $1 AND docstatus = 'submitted'", [purchaseId],
    );
    for (const payment of payments) {
      await reverseVoucherGlEntries(client, 'purchase_payment', payment.id, postingDate);
      await client.query("UPDATE app_purchase_payments SET docstatus = 'cancelled' WHERE id = $1", [payment.id]);
    }
    await reverseVoucherGlEntries(client, 'purchase', purchaseId, postingDate);
    const actor = actorAuditValues();
    await client.query(
      `UPDATE app_purchases
       SET docstatus = 'cancelled',
           amount_paid = 0,
           status = 'unpaid',
           cancelled_by = $2,
           cancelled_by_user_id = $3,
           cancelled_at = $4,
           updated_at = now()
       WHERE id = $1`,
      [purchaseId, actor.by, actor.by_user_id, actor.at],
    );
    return purchaseId;
  });
}

async function addPurchasePayment(id, payload) {
  const purchaseId = Number(id);
  if (!Number.isSafeInteger(purchaseId) || purchaseId < 1) throw notFound();
  const amount = Number(payload.amount);
  const paymentDate = String(payload.payment_date || '').trim();
  const method = String(payload.method || '').trim();
  if (!validDate(paymentDate)) throw badRequest('Choose a valid payment date.');
  if (!Number.isFinite(amount) || amount <= 0 || money(amount) !== amount) throw badRequest('Enter a valid payment amount.');
  if (!['cash', 'bank', 'mobile_money', 'card'].includes(method)) throw badRequest('Choose a payment method.');
  return withPostgresTransaction(async (client) => {
    const result = await client.query(`
      SELECT id, purchase_no, docstatus, posting_date::text, supplier_id, supplier_name, total::float, amount_paid::float
      FROM app_purchases WHERE id = $1 FOR UPDATE
    `, [purchaseId]);
    const purchase = result.rows[0];
    if (!purchase) throw notFound();
    if (purchase.docstatus !== 'submitted') throw badRequest('Submit the purchase before recording payments.');
    if (paymentDate < purchase.posting_date) throw badRequest('Payment date cannot be before the purchase date.');
    if (amount > money(purchase.total - purchase.amount_paid)) throw badRequest('Payment exceeds the outstanding balance.');
    const next = await client.query(`
      SELECT COALESCE(MAX(payment_no), 0)::int + 1 AS payment_no
      FROM app_purchase_payments WHERE purchase_id = $1
    `, [purchaseId]);
    const paymentNo = next.rows[0].payment_no;
    const reference = String(payload.reference || '').trim() || null;
    const notes = String(payload.notes || '').trim() || null;
    const payment = await client.query(`
      INSERT INTO app_purchase_payments (
        purchase_id, payment_no, payment_date, amount, method, reference, notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
    `, [purchaseId, paymentNo, paymentDate, amount, method, reference, notes]);
    const paymentId = Number(payment.rows[0].id);
    await postGlEntry(client, {
      posting_date: paymentDate,
      voucher_type: 'purchase_payment',
      voucher_id: paymentId,
      voucher_no: `${purchase.purchase_no}-PAY-${String(paymentNo).padStart(3, '0')}`,
      party_type: 'supplier',
      party_id: purchase.supplier_id,
      party_name: purchase.supplier_name,
      remarks: reference || notes || 'Supplier payment',
      lines: [
        { account_key: 'accounts_payable', debit: amount },
        { account_key: method === 'bank' ? 'bank' : method === 'mobile_money' ? 'mobile_money' : method === 'card' ? 'card_clearing' : 'cash', credit: amount },
      ],
    });
    const amountPaid = money(Number(purchase.amount_paid) + amount);
    await client.query(`
      UPDATE app_purchases SET amount_paid = $1,
        status = $2, updated_at = now() WHERE id = $3
    `, [amountPaid, amountPaid >= Number(purchase.total) ? 'paid' : 'partial', purchaseId]);
    return purchaseId;
  });
}

async function cancelPurchasePayment(id, paymentNo) {
  const purchaseId = Number(id);
  if (!Number.isSafeInteger(purchaseId) || purchaseId < 1) throw notFound();
  if (!Number.isSafeInteger(Number(paymentNo)) || Number(paymentNo) < 1) throw badRequest('Payment not found.');
  return withPostgresTransaction(async (client) => {
    const { rows: purchases } = await client.query(
      'SELECT id, total::float, docstatus FROM app_purchases WHERE id = $1 FOR UPDATE', [purchaseId],
    );
    const purchase = purchases[0];
    if (!purchase) throw notFound();
    if (purchase.docstatus !== 'submitted') throw badRequest('Only payments on submitted purchases can be cancelled.');
    const { rows: payments } = await client.query(
      'SELECT id, docstatus FROM app_purchase_payments WHERE purchase_id = $1 AND payment_no = $2 FOR UPDATE',
      [purchaseId, Number(paymentNo)],
    );
    const payment = payments[0];
    if (!payment) throw badRequest('Payment not found.');
    if (payment.docstatus !== 'submitted') throw badRequest('Payment is already cancelled.');

    const postingDate = new Date().toISOString().slice(0, 10);
    await reverseVoucherGlEntries(client, 'purchase_payment', payment.id, postingDate);
    await client.query("UPDATE app_purchase_payments SET docstatus = 'cancelled' WHERE id = $1", [payment.id]);
    const { rows: totals } = await client.query(
      "SELECT COALESCE(SUM(amount), 0)::float AS amount_paid FROM app_purchase_payments WHERE purchase_id = $1 AND docstatus = 'submitted'",
      [purchaseId],
    );
    const amountPaid = money(totals[0].amount_paid);
    await client.query(
      'UPDATE app_purchases SET amount_paid = $1, status = $2, updated_at = now() WHERE id = $3',
      [amountPaid, amountPaid <= 0 ? 'unpaid' : amountPaid >= Number(purchase.total) ? 'paid' : 'partial', purchaseId],
    );
    return purchaseId;
  });
}

module.exports = {
  normalizePurchase,
  resolvePurchaseMasters,
  validatePurchaseOrder,
  createPurchase,
  updatePurchase,
  listPurchases,
  loadPurchase,
  purchaseForPayment,
  submitPurchase,
  cancelPurchase,
  addPurchasePayment,
  cancelPurchasePayment,
};

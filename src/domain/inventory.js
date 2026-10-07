'use strict';
// Inventory domain: stock balances, stock entries, stock ledger/movement and
// gross profit. Extracted from store.js.
const { getPostgresPool, withPostgresTransaction } = require('../core');
const { STOCK_ENTRY_TYPES } = require('../constants');
const { normalizePostingTime, storedPostingTime } = require('../posting-time');
const { roundMoney, numberValue, roundReportMoney } = require('../lib/money');
const { normalizeQuantity, normalizeStockQuantity } = require('../lib/quantity');
const { optionalValue, requiredValue } = require('../lib/values');
const { dateOnly, isValidIsoDate, toIsoString, nullableIsoString, dateInRange } = require('../lib/dates');
const { sqlLikePattern, matchesSearchPattern, matchesSearchFields, normalizeSearchText, normalizeSearchPattern, wildcardRegex, orderedWildcardMatch, escapeRegex } = require('../lib/search');
const { paginationOptions, paginationResult } = require('../lib/pagination');
const { postStockEntryGlEntry, postGlEntry, reverseVoucherGlEntries, postStockEntryMovements, applyPostgresStockMovement, insertStockEntryItems, syncStockEntryItems, normalizeStockEntryItems, normalizeSupplierInfo, setVoucherDocstatus, addReportFilters, reportFilterValues, actorAuditValues } = require('./posting');
const { findMasterItem, findMasterWarehouse } = require('./master-data');
const { findPostgresInvoice } = require('./sales');
const { validateCostCenter } = require('../cost-centers');
const { addVoucherOwnerFilter, addStockLedgerOwnerFilter } = require('../voucher-ownership');

async function stockSummary() {
  const { rows } = await getPostgresPool().query(`
    SELECT
      COUNT(*)::int AS item_count,
      COALESCE(SUM(quantity), 0)::float AS total_quantity,
      COALESCE(SUM(stock_value), 0)::float AS stock_value
    FROM app_stock_balances
    WHERE quantity <> 0
  `);
  return rows[0] || { item_count: 0, total_quantity: 0, stock_value: 0 };
}

async function stockBalances(filters = {}) {
  const pagination = paginationOptions(filters, 50, 200);
  const search = String(filters.search || '').trim().toLowerCase();
  const warehouse = String(filters.warehouse || '').trim();
  const params = [];
  const where = ['quantity <> 0'];
  if (search) {
    params.push(sqlLikePattern(search));
    where.push(`(
      LOWER(item_code) LIKE $${params.length}
      OR LOWER(item_name) LIKE $${params.length}
      OR LOWER(warehouse) LIKE $${params.length}
      OR quantity::text LIKE $${params.length}
      OR valuation_rate::text LIKE $${params.length}
      OR stock_value::text LIKE $${params.length}
    )`);
  }
  if (warehouse) {
    params.push(warehouse);
    where.push(`warehouse = $${params.length}`);
  }
  const whereSql = where.join(' AND ');
  const countResult = await getPostgresPool().query(
    `
    SELECT COUNT(*)::int AS total
    FROM app_stock_balances
    WHERE ${whereSql}
    `,
    params,
  );
  params.push(pagination.limit, pagination.offset);
  const { rows } = await getPostgresPool().query(
    `
    SELECT item_code, item_name, warehouse, quantity::float, stock_value::float, valuation_rate::float
    FROM app_stock_balances
    WHERE ${whereSql}
    ORDER BY item_name, warehouse
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params,
  );
  rows.pagination = paginationResult(Number(countResult.rows[0].total || 0), pagination);
  return rows;
}

async function listStockEntries(filters = {}) {
  const pagination = paginationOptions(filters, 25, 100);
  const params = [];
  const where = [];
  addVoucherOwnerFilter(where, params, 'se', filters.ownerId);
  if (filters.excludeReconciliations) where.push("se.entry_type <> 'reconciliation'");
  const search = String(filters.q || '').trim().toLowerCase();
  const type = String(filters.entry_type || '').trim();
  const status = String(filters.status || '').trim();
  const warehouse = String(filters.warehouse || '').trim();
  if (search) {
    params.push(sqlLikePattern(search));
    where.push(`(LOWER(COALESCE(se.entry_no, '')) LIKE $${params.length}
      OR LOWER(se.entry_type) LIKE $${params.length}
      OR LOWER(COALESCE(se.remarks, '')) LIKE $${params.length}
      OR LOWER(COALESCE(se.supplier_name, '')) LIKE $${params.length}
      OR LOWER(COALESCE(se.supplier_reference, '')) LIKE $${params.length}
      OR LOWER(COALESCE(se.cost_center, '')) LIKE $${params.length}
      OR EXISTS (SELECT 1 FROM app_stock_entry_items search_item
        WHERE search_item.stock_entry_id = se.id
          AND (LOWER(search_item.item_code) LIKE $${params.length}
            OR LOWER(COALESCE(search_item.item_name, '')) LIKE $${params.length})))`);
  }
  if (type && STOCK_ENTRY_TYPES.includes(type)) {
    params.push(type);
    where.push(`se.entry_type = $${params.length}`);
  }
  if (status && ['draft', 'submitted', 'cancelled'].includes(status)) {
    params.push(status);
    where.push(`COALESCE(se.docstatus, 'submitted') = $${params.length}`);
  }
  for (const [key, operator] of [['from', '>='], ['to', '<=']]) {
    const date = String(filters[key] || '').trim();
    if (isValidIsoDate(date)) {
      params.push(date);
      where.push(`se.posting_date ${operator} $${params.length}`);
    }
  }
  if (warehouse) {
    params.push(warehouse);
    where.push(`EXISTS (SELECT 1 FROM app_stock_entry_items warehouse_item
      WHERE warehouse_item.stock_entry_id = se.id
        AND (warehouse_item.warehouse = $${params.length}
          OR warehouse_item.target_warehouse = $${params.length}))`);
  }
  if (Array.isArray(filters.allowedWarehouses)) {
    params.push(filters.allowedWarehouses);
    where.push(`NOT EXISTS (SELECT 1 FROM app_stock_entry_items restricted_item
      WHERE restricted_item.stock_entry_id = se.id AND (
        COALESCE(restricted_item.warehouse, '') <> ''
          AND restricted_item.warehouse <> ALL($${params.length}::text[])
        OR COALESCE(restricted_item.target_warehouse, '') <> ''
          AND restricted_item.target_warehouse <> ALL($${params.length}::text[])))`);
  }
  if (Array.isArray(filters.deniedWarehouses) && filters.deniedWarehouses.length) {
    params.push(filters.deniedWarehouses);
    where.push(`NOT EXISTS (SELECT 1 FROM app_stock_entry_items denied_item
      WHERE denied_item.stock_entry_id = se.id
        AND (denied_item.warehouse = ANY($${params.length}::text[])
          OR denied_item.target_warehouse = ANY($${params.length}::text[])))`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const pool = getPostgresPool();
  const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM app_stock_entries se ${whereSql}`, params);
  const total = Number(countResult.rows[0]?.total || 0);
  pagination.page = Math.min(pagination.page, Math.max(1, Math.ceil(total / pagination.limit)));
  pagination.offset = (pagination.page - 1) * pagination.limit;
  const rowsResult = await pool.query(`
    SELECT se.id, se.entry_no, se.entry_type, COALESCE(se.docstatus, 'submitted') AS docstatus,
      se.posting_date::text, se.posting_time::text, se.remarks, se.cost_center,
      COALESCE(item_summary.item_count, 0)::int AS item_count,
      COALESCE(item_summary.warehouses, '') AS warehouses
    FROM app_stock_entries se
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS item_count,
        STRING_AGG(DISTINCT item.warehouse, ', ' ORDER BY item.warehouse) AS warehouses
      FROM app_stock_entry_items item WHERE item.stock_entry_id = se.id
    ) item_summary ON true
    ${whereSql}
    ORDER BY se.posting_date DESC, se.posting_time DESC, se.id DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `, [...params, pagination.limit, pagination.offset]);
  return { rows: rowsResult.rows.map((row) => ({ ...row,
    id: Number(row.id), posting_time: storedPostingTime(row.posting_time),
  })), pagination: paginationResult(total, pagination) };
}

async function localStockQuantity(itemCode, warehouse) {
  const { rows } = await getPostgresPool().query(
    `
    SELECT quantity::float, stock_value::float, valuation_rate::float
    FROM app_stock_balances
    WHERE item_code = $1
      AND warehouse = $2
    `,
    [String(itemCode || '').trim(), String(warehouse || '').trim()],
  );
  return rows[0] || { quantity: 0, stock_value: 0, valuation_rate: 0 };
}

async function createStockEntry(payload) {
  const entryType = String(payload.entry_type || '').trim();
  if (!STOCK_ENTRY_TYPES.includes(entryType)) {
    const err = new Error('Choose a valid stock entry type.');
    err.status = 400;
    throw err;
  }
  const postingDate = String(payload.posting_date || '').trim();
  if (!isValidIsoDate(postingDate)) {
    const err = new Error('Choose a valid posting date.');
    err.status = 400;
    throw err;
  }
  const postingTime = normalizePostingTime(payload.posting_time);
  const items = normalizeStockEntryItems(payload.items, entryType);
  if (!items.length) {
    const err = new Error('Add at least one stock item.');
    err.status = 400;
    throw err;
  }
  const docstatus = payload.action === 'save_draft' ? 'draft' : 'submitted';

  return withPostgresTransaction(async (client) => {
    const costCenter = await validateCostCenter(client, payload.cost_center);
    const supplier = entryType === 'purchase' ? normalizeSupplierInfo(payload) : normalizeSupplierInfo();
    const { rows } = await client.query(
      `
      INSERT INTO app_stock_entries (
        entry_type, docstatus, posting_date, posting_time, remarks, supplier_name, supplier_contact,
        supplier_phone, supplier_reference, cost_center
      )
      VALUES ($1, $2, $3, $9, $4, $5, $6, $7, $8, $10)
      RETURNING id
      `,
      [
        entryType,
        docstatus,
        postingDate,
        String(payload.remarks || '').trim() || null,
        supplier.supplier_name || null,
        supplier.supplier_contact || null,
        supplier.supplier_phone || null,
        supplier.supplier_reference || null,
        postingTime,
        costCenter,
      ],
    );
    const id = Number(rows[0].id);
    const entryNo = `${entryType === 'reconciliation' ? 'REC' : 'STK'}-${String(id).padStart(6, '0')}`;
    await client.query('UPDATE app_stock_entries SET entry_no = $1 WHERE id = $2', [entryNo, id]);
    if (docstatus === 'submitted') {
      await setVoucherDocstatus(client, 'app_stock_entries', id, 'submitted');
    }

    await insertStockEntryItems(client, id, items);
    if (docstatus === 'submitted') {
      await postStockEntryMovements(client, { id, entryNo, entryType, postingDate, items });
      await postStockEntryGlEntry(client, { id, entryNo, entryType, postingDate });
    }

    return id;
  });
}

async function loadStockEntry(id) {
  const stockEntryId = Number(id);
  if (!Number.isFinite(stockEntryId)) {
    const err = new Error('Stock entry not found.');
    err.status = 404;
    throw err;
  }
  const { rows } = await getPostgresPool().query(
    `
    SELECT created_by, created_by_user_id, created_at, updated_by, updated_by_user_id, updated_at,
      id, entry_no, entry_type, docstatus, posting_date::text, posting_time::text, remarks, cost_center,
      supplier_name, supplier_contact, supplier_phone, supplier_reference,
      submitted_by, submitted_by_user_id, submitted_at,
      cancelled_by, cancelled_by_user_id, cancelled_at
    FROM app_stock_entries
    WHERE id = $1
    `,
    [stockEntryId],
  );
  const entry = rows[0];
  if (!entry) {
    const err = new Error('Stock entry not found.');
    err.status = 404;
    throw err;
  }
  const { rows: items } = await getPostgresPool().query(
    `
    SELECT id, created_by, created_by_user_id, created_at,
      updated_by, updated_by_user_id, updated_at,
      item_code, item_name, warehouse, target_warehouse, quantity::float,
      counted_quantity::float, valuation_rate::float
    FROM app_stock_entry_items
    WHERE stock_entry_id = $1
    ORDER BY line_no
    `,
    [stockEntryId],
  );
  let reconciliationValues = new Map();
  if (entry.entry_type === 'reconciliation' && entry.docstatus !== 'draft') {
    const { rows: movements } = await getPostgresPool().query(`SELECT item_code, warehouse,
      stock_value_change::float FROM app_stock_ledger WHERE voucher_id = $1
      AND voucher_type = 'stock_reconciliation' AND is_reversal = false`, [stockEntryId]);
    reconciliationValues = new Map(movements.map((row) =>
      [`${row.item_code}\0${row.warehouse}`, Number(row.stock_value_change || 0)]));
  }
  return {
    entry: {
      ...entry,
      posting_date: dateOnly(entry.posting_date),
      posting_time: storedPostingTime(entry.posting_time),
      ...normalizeSupplierInfo(entry),
    },
    items: items.map((item) => ({
      ...item,
      id: Number(item.id),
      quantity_change: entry.entry_type === 'reconciliation' && entry.docstatus !== 'draft'
        ? Number(item.quantity || 0) : null,
      value_change: reconciliationValues.get(`${item.item_code}\0${item.warehouse}`) ?? null,
      quantity: entry.entry_type === 'reconciliation' && item.counted_quantity != null
        ? Number(item.counted_quantity) : Number(item.quantity || 0),
      valuation_rate: Number(item.valuation_rate || 0),
    })),
  };
}

async function stockEntryCancelTemplate(identifier, ownerId = null) {
  const value = String(identifier || '').trim();
  if (!value) {
    const err = new Error('Enter a stock entry number to cancel.');
    err.status = 400;
    throw err;
  }
  const numericId = Number(value);
  const params = Number.isFinite(numericId) ? [numericId] : [value.toUpperCase()];
  const condition = Number.isFinite(numericId) ? 'id = $1' : 'UPPER(entry_no) = $1';
  const ownerCondition = ownerId === null ? '' : ' AND created_by_user_id = $2';
  if (ownerId !== null) params.push(String(ownerId));
  const { rows } = await getPostgresPool().query(
    `
    SELECT id, entry_no, entry_type, docstatus, posting_date::text, remarks
    FROM app_stock_entries
    WHERE ${condition}${ownerCondition}
    `,
    params,
  );
  const entry = rows[0];
  if (!entry) {
    const err = new Error('Stock entry to cancel was not found.');
    err.status = 404;
    throw err;
  }
  if ((entry.docstatus || 'submitted') !== 'submitted') {
    const err = new Error('Only submitted stock entries can be used for Cancel Entry.');
    err.status = 400;
    throw err;
  }
  const { rows: items } = await getPostgresPool().query(
    `
    SELECT item_code, item_name, warehouse, target_warehouse, quantity::float, valuation_rate::float
    FROM app_stock_entry_items
    WHERE stock_entry_id = $1
    ORDER BY line_no
    `,
    [entry.id],
  );
  return {
    entry: {
      id: Number(entry.id),
      entry_no: entry.entry_no,
      entry_type: entry.entry_type,
      posting_date: dateOnly(entry.posting_date),
      remarks: entry.remarks || '',
    },
    items: items.map((item) => ({
      item_code: item.item_code,
      item_name: item.item_name || item.item_code,
      warehouse: item.warehouse || '',
      target_warehouse: item.target_warehouse || '',
      quantity: Math.abs(Number(item.quantity || 0)),
      valuation_rate: Number(item.valuation_rate || 0),
    })),
  };
}

async function searchStockEntriesForCancel(search = '', ownerId = null) {
  const value = String(search || '').trim();
  const params = [];
  const where = ["COALESCE(se.docstatus, 'submitted') = 'submitted'"];
  addVoucherOwnerFilter(where, params, 'se', ownerId);
  if (value) {
    params.push(sqlLikePattern(value.toLowerCase()));
    where.push(`(
      LOWER(se.entry_no) LIKE $${params.length}
      OR LOWER(se.entry_type) LIKE $${params.length}
      OR LOWER(COALESCE(se.remarks, '')) LIKE $${params.length}
      OR se.posting_date::text LIKE $${params.length}
    )`);
  }
  const { rows } = await getPostgresPool().query(
    `
    SELECT
      se.id,
      se.entry_no,
      se.entry_type,
      se.posting_date::text AS posting_date,
      COALESCE(se.remarks, '') AS remarks,
      COUNT(item.id)::int AS item_count
    FROM app_stock_entries se
    LEFT JOIN app_stock_entry_items item
      ON item.stock_entry_id = se.id
    WHERE ${where.join(' AND ')}
    GROUP BY se.id, se.entry_no, se.entry_type, se.posting_date, se.remarks
    ORDER BY se.posting_date DESC, se.id DESC
    LIMIT 25
    `,
    params,
  );
  return rows.map((row) => ({
    id: Number(row.id),
    entry_no: row.entry_no,
    entry_type: row.entry_type,
    posting_date: dateOnly(row.posting_date),
    remarks: row.remarks || '',
    item_count: Number(row.item_count || 0),
  }));
}

async function updateStockEntry(id, payload) {
  const stockEntryId = Number(id);
  if (!Number.isFinite(stockEntryId)) {
    const err = new Error('Stock entry not found.');
    err.status = 404;
    throw err;
  }
  const entryType = String(payload.entry_type || '').trim();
  if (!STOCK_ENTRY_TYPES.includes(entryType)) {
    const err = new Error('Choose a valid stock entry type.');
    err.status = 400;
    throw err;
  }
  const postingDate = String(payload.posting_date || '').trim();
  if (!isValidIsoDate(postingDate)) {
    const err = new Error('Choose a valid posting date.');
    err.status = 400;
    throw err;
  }
  const postingTime = normalizePostingTime(payload.posting_time);
  const items = normalizeStockEntryItems(payload.items, entryType);
  if (!items.length) {
    const err = new Error('Add at least one stock item.');
    err.status = 400;
    throw err;
  }
  const docstatus = payload.action === 'save_draft' ? 'draft' : 'submitted';

  return withPostgresTransaction(async (client) => {
    const costCenter = await validateCostCenter(client, payload.cost_center);
    const { rows: existingRows } = await client.query(
      'SELECT id, entry_no, docstatus FROM app_stock_entries WHERE id = $1 FOR UPDATE',
      [stockEntryId],
    );
    const existing = existingRows[0];
    if (!existing) {
      const err = new Error('Stock entry not found.');
      err.status = 404;
      throw err;
    }
    if ((existing.docstatus || 'submitted') !== 'draft') {
      const err = new Error('Only draft stock entries can be edited.');
      err.status = 400;
      throw err;
    }

    const supplier = entryType === 'purchase' ? normalizeSupplierInfo(payload) : normalizeSupplierInfo();
    await client.query(
      `
      UPDATE app_stock_entries
      SET entry_type = $1,
          docstatus = $2,
          posting_date = $3,
          posting_time = $10,
          remarks = $4,
          supplier_name = $5,
          supplier_contact = $6,
          supplier_phone = $7,
          supplier_reference = $8,
          cost_center = $11
      WHERE id = $9
      `,
      [
        entryType,
        docstatus,
        postingDate,
        String(payload.remarks || '').trim() || null,
        supplier.supplier_name || null,
        supplier.supplier_contact || null,
        supplier.supplier_phone || null,
        supplier.supplier_reference || null,
        stockEntryId,
        postingTime,
        costCenter,
      ],
    );
    if (docstatus === 'submitted') {
      await setVoucherDocstatus(client, 'app_stock_entries', stockEntryId, 'submitted');
    }
    await syncStockEntryItems(client, stockEntryId, items);
    if (docstatus === 'submitted') {
      await postStockEntryMovements(client, {
        id: stockEntryId,
        entryNo: existing.entry_no,
        entryType,
        postingDate,
        items,
      });
      await postStockEntryGlEntry(client, {
        id: stockEntryId,
        entryNo: existing.entry_no,
        entryType,
        postingDate,
      });
    }
    return stockEntryId;
  });
}

async function updateStockEntrySupplierInfo(id, payload) {
  const stockEntryId = Number(id);
  if (!Number.isFinite(stockEntryId)) {
    const err = new Error('Stock entry not found.');
    err.status = 404;
    throw err;
  }
  const supplier = normalizeSupplierInfo(payload);
  const { rows } = await getPostgresPool().query(
    `
    UPDATE app_stock_entries
    SET supplier_name = $1,
        supplier_contact = $2,
        supplier_phone = $3,
        supplier_reference = $4
    WHERE id = $5
      AND entry_type = 'purchase'
      AND docstatus = 'draft'
    RETURNING supplier_name, supplier_contact, supplier_phone, supplier_reference
    `,
    [
      supplier.supplier_name || null,
      supplier.supplier_contact || null,
      supplier.supplier_phone || null,
      supplier.supplier_reference || null,
      stockEntryId,
    ],
  );
  if (!rows[0]) {
    const err = new Error('Only draft purchase receipts can be edited.');
    err.status = 400;
    throw err;
  }
  return normalizeSupplierInfo(rows[0]);
}

async function cancelStockEntry(id, payload = {}) {
  const stockEntryId = Number(id);
  if (!Number.isFinite(stockEntryId)) {
    const err = new Error('Stock entry not found.');
    err.status = 404;
    throw err;
  }
  const reason = String(payload.reason || '').trim() || 'Cancelled';
  const cancellationPostingDate = String(payload.posting_date || '').trim() || dateOnly(new Date());
  return withPostgresTransaction(async (client) => {
    const { rows } = await client.query(
      `
      SELECT id, entry_no, entry_type, docstatus
      FROM app_stock_entries
      WHERE id = $1
      FOR UPDATE
      `,
      [stockEntryId],
    );
    const entry = rows[0];
    if (!entry) {
      const err = new Error('Stock entry not found.');
      err.status = 404;
      throw err;
    }
    if ((entry.docstatus || 'submitted') !== 'submitted') {
      const err = new Error('Only submitted stock entries can be cancelled.');
      err.status = 400;
      throw err;
    }
    const { rows: existingReversal } = await client.query(
      `
      SELECT id
      FROM app_stock_ledger
      WHERE reversal_of_voucher_id = $1
        AND is_reversal = true
      LIMIT 1
      `,
      [stockEntryId],
    );
    if (existingReversal.length) {
      const err = new Error('This stock entry already has cancellation reversal rows.');
      err.status = 400;
      throw err;
    }
    const { rows: ledgerRows } = await client.query(
      `
      SELECT *
      FROM app_stock_ledger
      WHERE voucher_id = $1
        AND voucher_type LIKE 'stock_%'
        AND is_reversal = false
      ORDER BY id
      `,
      [stockEntryId],
    );
    if (!ledgerRows.length && entry.entry_type === 'reconciliation') {
      const actor = actorAuditValues();
      await client.query(`UPDATE app_stock_entries SET docstatus = 'cancelled',
        cancelled_by = $1, cancelled_by_user_id = $2, cancelled_at = $3,
        cancellation_reason = $4 WHERE id = $5`,
      [actor.by, actor.by_user_id, actor.at, reason, stockEntryId]);
      return stockEntryId;
    }
    if (!ledgerRows.length) {
      const err = new Error('No submitted stock movement found to reverse.');
      err.status = 400;
      throw err;
    }

    await validateStockEntryCancellation(client, ledgerRows);

    const actor = actorAuditValues();
    await client.query(
      `
      UPDATE app_stock_entries
      SET docstatus = 'cancelled',
          cancelled_by = $1,
          cancelled_by_user_id = $2,
          cancelled_at = $3,
          cancellation_reason = $4
      WHERE id = $5
      `,
      [actor.by, actor.by_user_id, actor.at, reason, stockEntryId],
    );

    for (const row of ledgerRows) {
      const qtyChange = -Number(row.qty_change || 0);
      if (qtyChange === 0) continue;
      const rate = qtyChange > 0
        ? Number(row.outgoing_rate || row.incoming_rate || 0)
        : undefined;
      const forceOutgoingRate = qtyChange < 0
        ? Number(row.incoming_rate || row.outgoing_rate || 0)
        : undefined;
      await applyPostgresStockMovement(client, {
        posting_date: cancellationPostingDate,
        item_code: row.item_code,
        item_name: row.item_name,
        warehouse: row.warehouse,
        voucher_type: row.voucher_type,
        voucher_id: stockEntryId,
        voucher_no: entry.entry_no,
        qty_change: qtyChange,
        rate,
        force_outgoing_rate: forceOutgoingRate,
        is_reversal: true,
        reversal_of_voucher_id: stockEntryId,
        reversal_of_voucher_no: entry.entry_no,
        remarks: `Cancellation of ${entry.entry_no}: ${reason}`,
      });
    }
    await postStockEntryGlEntry(client, {
      id: stockEntryId,
      entryNo: entry.entry_no,
      entryType: String(ledgerRows[0].voucher_type || '').replace(/^stock_/, ''),
      postingDate: cancellationPostingDate,
      isReversal: true,
      remarks: `Cancellation of ${entry.entry_no}: ${reason}`,
    });
    return stockEntryId;
  });
}

async function validateStockEntryCancellation(client, ledgerRows) {
  const requiredByBalance = new Map();
  for (const row of ledgerRows) {
    const reversalQty = -Number(row.qty_change || 0);
    if (reversalQty >= 0) {
      continue;
    }
    const itemCode = String(row.item_code || '').trim();
    const itemName = String(row.item_name || itemCode).trim();
    const warehouse = String(row.warehouse || '').trim();
    const key = `${itemCode}\u0000${warehouse}`;
    const existing = requiredByBalance.get(key) || {
      item_code: itemCode,
      item_name: itemName,
      warehouse,
      required: 0,
    };
    existing.required = Number((existing.required + Math.abs(reversalQty)).toFixed(3));
    requiredByBalance.set(key, existing);
  }

  for (const requirement of requiredByBalance.values()) {
    const { rows } = await client.query(
      `
      SELECT quantity::float
      FROM app_stock_balances
      WHERE item_code = $1
        AND warehouse = $2
      FOR UPDATE
      `,
      [requirement.item_code, requirement.warehouse],
    );
    const available = Number(rows[0]?.quantity || 0);
    if (available + 0.0005 < requirement.required) {
      const err = new Error(
        `Insufficient stock for ${requirement.item_name} in ${requirement.warehouse}. ` +
        `Cancellation needs ${requirement.required}, available ${available}.`,
      );
      err.status = 400;
      err.code = 'INSUFFICIENT_STOCK';
      err.stockWarning = {
        item_name: requirement.item_name,
        item_code: requirement.item_code,
        warehouse: requirement.warehouse,
        requested: requirement.required,
        available,
      };
      throw err;
    }
  }
}

async function stockLedgerReport(filters = {}) {
  if (String(filters.status || 'posted').trim() === 'draft') {
    return stockEntryDraftReport(filters);
  }
  const pagination = paginationOptions(filters, 50, 200);
  const params = [];
  const where = [];
  addReportFilters(where, params, filters);
  addStockLedgerOwnerFilter(where, params, 'l', filters.ownerId, filters.ownerEmployeeId);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const countResult = await getPostgresPool().query(
    `
    SELECT COUNT(*)::int AS total
    FROM app_stock_ledger l
    LEFT JOIN app_stock_entries se
      ON se.id = COALESCE(l.voucher_id, l.reversal_of_voucher_id)
      AND l.voucher_type LIKE 'stock_%'
    LEFT JOIN app_purchases p ON p.id = l.voucher_id AND l.voucher_type = 'purchase'
    LEFT JOIN app_invoices i ON i.id = l.voucher_id AND l.voucher_type = 'invoice'
    ${whereSql}
    `,
    params,
  );
  params.push(pagination.limit, pagination.offset);
  const { rows } = await getPostgresPool().query(
    `
    WITH ledger_running_balances AS (
      SELECT id,
        SUM(qty_change) OVER (
          PARTITION BY item_code, warehouse
          ORDER BY posting_date ASC, id ASC
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS balance_qty
      FROM app_stock_ledger
    )
    SELECT
      l.posting_date::text AS posting_date,
      l.item_code AS item_code,
      l.item_name AS item_name,
      l.warehouse AS warehouse,
      CASE
        WHEN l.voucher_type LIKE 'stock_%' THEN COALESCE(se.entry_type, replace(l.voucher_type, 'stock_', ''))
        WHEN l.voucher_type = 'purchase' THEN 'purchase'
        ELSE ''
      END AS stock_entry_type,
      CASE
        WHEN l.is_reversal THEN 'cancelled'
        WHEN l.voucher_type LIKE 'stock_%' THEN COALESCE(se.docstatus, 'deleted')
        WHEN l.voucher_type = 'purchase' THEN COALESCE(p.docstatus, 'deleted')
        WHEN l.voucher_type = 'invoice' THEN COALESCE(i.docstatus, 'deleted')
        ELSE 'submitted'
      END AS stock_entry_status,
      l.voucher_type AS voucher_type,
      CASE
        WHEN l.voucher_type LIKE 'stock_%' THEN COALESCE(l.voucher_id, l.reversal_of_voucher_id)
        ELSE l.voucher_id
      END AS voucher_id,
      l.voucher_no AS voucher_no,
      CASE
        WHEN l.voucher_type LIKE 'stock_%' THEN se.id IS NOT NULL
        WHEN l.voucher_type = 'purchase' THEN p.id IS NOT NULL
        WHEN l.voucher_type = 'invoice' THEN i.id IS NOT NULL
        ELSE false
      END AS voucher_exists,
      l.is_reversal AS is_reversal,
      l.reversal_of_voucher_id AS reversal_of_voucher_id,
      l.reversal_of_voucher_no AS reversal_of_voucher_no,
      l.remarks AS ledger_remarks,
      l.qty_change::float AS qty_change,
      l.incoming_rate::float AS incoming_rate,
      l.outgoing_rate::float AS outgoing_rate,
      l.stock_value_change::float AS stock_value_change,
      running.balance_qty::float AS qty_after_transaction,
      l.stock_value_after_transaction::float AS stock_value_after_transaction
    FROM app_stock_ledger l
    JOIN ledger_running_balances running ON running.id = l.id
    LEFT JOIN app_stock_entries se
      ON se.id = COALESCE(l.voucher_id, l.reversal_of_voucher_id)
      AND l.voucher_type LIKE 'stock_%'
    LEFT JOIN app_purchases p ON p.id = l.voucher_id AND l.voucher_type = 'purchase'
    LEFT JOIN app_invoices i ON i.id = l.voucher_id AND l.voucher_type = 'invoice'
    ${whereSql}
    ORDER BY l.posting_date ASC, l.id ASC
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params,
  );
  return { filters: reportFilterValues(filters), rows, pagination: paginationResult(Number(countResult.rows[0].total || 0), pagination) };
}

async function stockLedgerVoucherDetails(voucherType, voucherId) {
  const type = String(voucherType || '').trim();
  const id = Number(voucherId);
  if (!type || !Number.isFinite(id)) {
    return null;
  }

  if (type === 'purchase') {
    const { rows } = await getPostgresPool().query(`
      SELECT purchase_no, posting_date::text, supplier_id, supplier_name,
        supplier_reference, docstatus, status, total::float, amount_paid::float
      FROM app_purchases WHERE id = $1
    `, [id]);
    const purchase = rows[0];
    if (!purchase) return null;
    const { rows: items } = await getPostgresPool().query(`
      SELECT item_code, warehouse, quantity::float, unit_price::float, line_total::float
      FROM app_purchase_items WHERE purchase_id = $1 ORDER BY line_no
    `, [id]);
    return {
      kind: 'purchase',
      title: purchase.purchase_no,
      href: `/purchases/${id}`,
      meta: {
        Supplier: purchase.supplier_name,
        Date: purchase.posting_date,
        Status: purchase.docstatus,
        Payment: purchase.status,
        Reference: purchase.supplier_reference || '',
      },
      items: items.map((item) => ({
        item_code: item.item_code,
        warehouse: item.warehouse,
        quantity: item.quantity,
        rate: item.unit_price,
        amount: item.line_total,
      })),
      totals: {
        Total: purchase.total,
        Paid: purchase.amount_paid,
        Balance: purchase.total - purchase.amount_paid,
      },
    };
  }

  if (type === 'invoice') {
    const invoice = await findPostgresInvoice(id);
    if (!invoice) {
      return null;
    }
    return {
      kind: 'invoice',
      title: invoice.invoice_no,
      href: `/invoices/${invoice.id}`,
      meta: {
        Customer: invoice.customer_name,
        Date: invoice.invoice_date,
        Status: invoice.docstatus === 'draft' ? 'Draft' : invoice.docstatus === 'cancelled' ? 'Cancelled' : 'Submitted',
        Payment: invoice.status,
      },
      items: invoice.items.map((item) => ({
        item_code: item.item_code,
        warehouse: item.warehouse || '',
        quantity: item.quantity,
        rate: item.unit_price,
        amount: item.line_total,
      })),
      totals: {
        Subtotal: invoice.subtotal,
        Discount: invoice.discount_amount,
        Tax: invoice.tax_amount,
        Total: invoice.total,
        Paid: invoice.amount_paid,
        Balance: Number(invoice.total || 0) - Number(invoice.amount_paid || 0),
      },
    };
  }

  if (type.startsWith('stock_')) {
    const { rows } = await getPostgresPool().query(
      `
      SELECT
        id, entry_no, entry_type, docstatus, posting_date::text, remarks, supplier_name,
        supplier_contact, supplier_phone, supplier_reference, cancellation_reason,
        cancelled_at::text
      FROM app_stock_entries
      WHERE id = $1
      `,
      [id],
    );
    const entry = rows[0];
    if (!entry) {
      return null;
    }
    const { rows: items } = await getPostgresPool().query(
      `
      SELECT item.item_code, item.warehouse, item.target_warehouse,
        item.quantity::float, item.counted_quantity::float, item.valuation_rate::float,
        ledger.stock_value_change::float AS posted_value
      FROM app_stock_entry_items item
      LEFT JOIN app_stock_ledger ledger ON ledger.voucher_id = item.stock_entry_id
        AND ledger.item_code = item.item_code AND ledger.warehouse = item.warehouse
        AND ledger.voucher_type = 'stock_reconciliation' AND ledger.is_reversal = false
      WHERE item.stock_entry_id = $1
      ORDER BY item.line_no
      `,
      [id],
    );
    return {
      kind: 'stock_entry',
      id,
      entry_type: entry.entry_type,
      status: entry.docstatus || 'submitted',
      title: entry.entry_no,
      href: entry.entry_type === 'reconciliation'
        ? `/stock/reconciliations/${id}${entry.docstatus === 'draft' ? '/edit' : ''}`
        : (entry.docstatus || 'submitted') === 'draft' ? `/stock/entries/${id}/edit` : '',
      meta: {
        Type: entry.entry_type,
        Status: entry.docstatus || 'submitted',
        Date: dateOnly(entry.posting_date),
        ...(entry.cancellation_reason ? { Cancellation: entry.cancellation_reason } : {}),
        Remarks: entry.remarks || '',
      },
      supplier: normalizeSupplierInfo(entry),
      items: items.map((item) => ({
        item_code: item.item_code,
        warehouse: item.warehouse || '',
        target_warehouse: item.target_warehouse || '',
        quantity: entry.entry_type === 'reconciliation' && item.counted_quantity != null
          ? Number(item.counted_quantity) : Number(item.quantity || 0),
        difference: entry.entry_type === 'reconciliation' && entry.docstatus !== 'draft'
          ? Number(item.quantity || 0) : null,
        rate: Number(item.valuation_rate || 0),
        amount: entry.entry_type === 'reconciliation' && item.posted_value != null
          ? Number(item.posted_value) : roundMoney(Number(item.quantity || 0) * Number(item.valuation_rate || 0)),
      })),
      totals: {
        Total: roundMoney(items.reduce((sum, item) => sum + (entry.entry_type === 'reconciliation'
          && item.posted_value != null ? Number(item.posted_value)
          : Number(item.quantity || 0) * Number(item.valuation_rate || 0)), 0)),
      },
    };
  }

  return null;
}

async function stockEntryDraftReport(filters = {}) {
  const pagination = paginationOptions(filters, 50, 200);
  const params = [];
  const where = [];
  addVoucherOwnerFilter(where, params, 'se', filters.ownerId);
  const status = String(filters.status || 'draft').trim();
  const entryType = String(filters.entry_type || '').trim();
  const warehouse = String(filters.warehouse || '').trim();
  const search = String(filters.search || '').trim().toLowerCase();
  const from = String(filters.from || '').trim();
  const to = String(filters.to || '').trim();
  params.push(status);
  where.push(`se.docstatus = $${params.length}`);
  if (entryType) {
    params.push(entryType);
    where.push(`se.entry_type = $${params.length}`);
  }
  if (warehouse) {
    params.push(warehouse);
    where.push(`(item.warehouse = $${params.length} OR item.target_warehouse = $${params.length})`);
  }
  if (from) {
    params.push(from);
    where.push(`se.posting_date >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    where.push(`se.posting_date <= $${params.length}`);
  }
  if (search) {
    params.push(sqlLikePattern(search));
    where.push(`(
      LOWER(item.item_code) LIKE $${params.length}
      OR LOWER(item.item_name) LIKE $${params.length}
      OR LOWER(COALESCE(item.warehouse, '')) LIKE $${params.length}
      OR LOWER(COALESCE(item.target_warehouse, '')) LIKE $${params.length}
      OR LOWER(se.entry_type) LIKE $${params.length}
      OR LOWER(se.docstatus) LIKE $${params.length}
      OR LOWER(COALESCE(se.entry_no, '')) LIKE $${params.length}
      OR LOWER(COALESCE(se.remarks, '')) LIKE $${params.length}
      OR item.quantity::text LIKE $${params.length}
      OR item.valuation_rate::text LIKE $${params.length}
      OR (item.quantity * item.valuation_rate)::text LIKE $${params.length}
    )`);
  }
  const whereSql = where.join(' AND ');
  const countResult = await getPostgresPool().query(
    `
    SELECT COUNT(*)::int AS total
    FROM app_stock_entries se
    JOIN app_stock_entry_items item
      ON item.stock_entry_id = se.id
    WHERE ${whereSql}
    `,
    params,
  );
  params.push(pagination.limit, pagination.offset);
  const { rows } = await getPostgresPool().query(
    `
    SELECT
      se.posting_date::text AS posting_date,
      item.item_code AS item_code,
      item.item_name AS item_name,
      item.warehouse AS warehouse,
      se.entry_type AS stock_entry_type,
      se.docstatus AS stock_entry_status,
      'stock_' || se.entry_type AS voucher_type,
      se.id AS voucher_id,
      se.entry_no AS voucher_no,
      false AS is_reversal,
      NULL::bigint AS reversal_of_voucher_id,
      NULL::text AS reversal_of_voucher_no,
      NULL::text AS ledger_remarks,
      CASE WHEN se.entry_type = 'cancel' THEN -item.quantity ELSE item.quantity END::float AS qty_change,
      CASE WHEN se.entry_type = 'cancel' THEN 0 ELSE item.valuation_rate END::float AS incoming_rate,
      CASE WHEN se.entry_type = 'cancel' THEN item.valuation_rate ELSE 0 END::float AS outgoing_rate,
      CASE
        WHEN se.entry_type = 'cancel' THEN -(item.quantity * item.valuation_rate)
        ELSE item.quantity * item.valuation_rate
      END::float AS stock_value_change,
      0::float AS qty_after_transaction,
      0::float AS stock_value_after_transaction
    FROM app_stock_entries se
    JOIN app_stock_entry_items item
      ON item.stock_entry_id = se.id
    WHERE ${whereSql}
    ORDER BY se.posting_date ASC, se.id ASC, item.line_no ASC
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params,
  );
  return { filters: reportFilterValues(filters), rows, pagination: paginationResult(Number(countResult.rows[0].total || 0), pagination) };
}

async function stockMovementReport(filters = {}) {
  const pagination = paginationOptions(filters, 50, 200);
  const params = [];
  const where = [];
  addStockLedgerOwnerFilter(where, params, 'app_stock_ledger', filters.ownerId, filters.ownerEmployeeId);
  const from = String(filters.from || '').trim();
  const to = String(filters.to || '').trim();
  const warehouse = String(filters.warehouse || '').trim();
  const entryType = String(filters.entry_type || '').trim();
  const status = String(filters.status || 'posted').trim();
  const search = String(filters.search || '').trim().toLowerCase();
  if (warehouse) {
    params.push(warehouse);
    where.push(`warehouse = $${params.length}`);
  }
  if (search) {
    params.push(sqlLikePattern(search));
    where.push(`(
      LOWER(item_code) LIKE $${params.length}
      OR LOWER(item_name) LIKE $${params.length}
      OR LOWER(warehouse) LIKE $${params.length}
      OR LOWER(voucher_type) LIKE $${params.length}
      OR LOWER(COALESCE(voucher_no, '')) LIKE $${params.length}
      OR LOWER(COALESCE(reversal_of_voucher_no, '')) LIKE $${params.length}
      OR LOWER(COALESCE(remarks, '')) LIKE $${params.length}
      OR posting_date::text LIKE $${params.length}
      OR qty_change::text LIKE $${params.length}
      OR incoming_rate::text LIKE $${params.length}
      OR outgoing_rate::text LIKE $${params.length}
      OR stock_value_change::text LIKE $${params.length}
      OR qty_after_transaction::text LIKE $${params.length}
      OR stock_value_after_transaction::text LIKE $${params.length}
    )`);
  }
  const fromSql = from ? `$${params.length + 1}::date` : 'NULL::date';
  if (from) {
    params.push(from);
  }
  const toSql = to ? `$${params.length + 1}::date` : 'NULL::date';
  if (to) {
    params.push(to);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const groupedSql = `
    WITH movement AS (
      SELECT *
      FROM app_stock_ledger
      ${whereSql}
    ),
    grouped AS (
      SELECT
        item_code,
        item_name,
        warehouse,
        COALESCE(SUM(CASE WHEN ${fromSql} IS NOT NULL AND posting_date < ${fromSql} THEN qty_change ELSE 0 END), 0)::float AS opening_qty,
        COALESCE(SUM(CASE WHEN ${fromSql} IS NOT NULL AND posting_date < ${fromSql} THEN stock_value_change ELSE 0 END), 0)::float AS opening_value,
        COALESCE(SUM(CASE WHEN (${fromSql} IS NULL OR posting_date >= ${fromSql}) AND (${toSql} IS NULL OR posting_date <= ${toSql}) AND qty_change > 0 THEN qty_change ELSE 0 END), 0)::float AS in_qty,
        COALESCE(SUM(CASE WHEN (${fromSql} IS NULL OR posting_date >= ${fromSql}) AND (${toSql} IS NULL OR posting_date <= ${toSql}) AND qty_change < 0 THEN ABS(qty_change) ELSE 0 END), 0)::float AS out_qty,
        COALESCE(SUM(CASE WHEN (${fromSql} IS NULL OR posting_date >= ${fromSql}) AND (${toSql} IS NULL OR posting_date <= ${toSql}) THEN stock_value_change ELSE 0 END), 0)::float AS value_change,
        COALESCE(SUM(CASE WHEN ${toSql} IS NULL OR posting_date <= ${toSql} THEN qty_change ELSE 0 END), 0)::float AS closing_qty,
        COALESCE(SUM(CASE WHEN ${toSql} IS NULL OR posting_date <= ${toSql} THEN stock_value_change ELSE 0 END), 0)::float AS closing_value
      FROM movement
      GROUP BY item_code, item_name, warehouse
    )
  `;
  const [countResult, summaryResult] = await Promise.all([
    getPostgresPool().query(
      `${groupedSql} SELECT COUNT(*)::int AS total FROM grouped`,
      params,
    ),
    getPostgresPool().query(
      `${groupedSql}
      SELECT
        COALESCE(SUM(opening_qty), 0)::float AS opening_qty,
        COALESCE(SUM(in_qty), 0)::float AS in_qty,
        COALESCE(SUM(out_qty), 0)::float AS out_qty,
        COALESCE(SUM(closing_qty), 0)::float AS closing_qty,
        COALESCE(SUM(opening_value), 0)::float AS opening_value,
        COALESCE(SUM(value_change), 0)::float AS value_change,
        COALESCE(SUM(closing_value), 0)::float AS closing_value
      FROM grouped`,
      params,
    ),
  ]);
  const pageParams = [...params, pagination.limit, pagination.offset];
  const { rows } = await getPostgresPool().query(
    `
    WITH movement AS (
      SELECT *
      FROM app_stock_ledger
      ${whereSql}
    )
    SELECT
      item_code,
      item_name,
      warehouse,
      COALESCE(SUM(CASE WHEN ${fromSql} IS NOT NULL AND posting_date < ${fromSql} THEN qty_change ELSE 0 END), 0)::float AS opening_qty,
      COALESCE(SUM(CASE WHEN ${fromSql} IS NOT NULL AND posting_date < ${fromSql} THEN stock_value_change ELSE 0 END), 0)::float AS opening_value,
      COALESCE(SUM(CASE WHEN (${fromSql} IS NULL OR posting_date >= ${fromSql}) AND (${toSql} IS NULL OR posting_date <= ${toSql}) AND qty_change > 0 THEN qty_change ELSE 0 END), 0)::float AS in_qty,
      COALESCE(SUM(CASE WHEN (${fromSql} IS NULL OR posting_date >= ${fromSql}) AND (${toSql} IS NULL OR posting_date <= ${toSql}) AND qty_change < 0 THEN ABS(qty_change) ELSE 0 END), 0)::float AS out_qty,
      COALESCE(SUM(CASE WHEN (${fromSql} IS NULL OR posting_date >= ${fromSql}) AND (${toSql} IS NULL OR posting_date <= ${toSql}) THEN stock_value_change ELSE 0 END), 0)::float AS value_change,
      COALESCE(SUM(CASE WHEN ${toSql} IS NULL OR posting_date <= ${toSql} THEN qty_change ELSE 0 END), 0)::float AS closing_qty,
      COALESCE(SUM(CASE WHEN ${toSql} IS NULL OR posting_date <= ${toSql} THEN stock_value_change ELSE 0 END), 0)::float AS closing_value
    FROM movement
    GROUP BY item_code, item_name, warehouse
    ORDER BY item_name, warehouse
    LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}
    `,
    pageParams,
  );
  return {
    filters: reportFilterValues(filters),
    rows,
    summary: summaryResult.rows[0] || {},
    pagination: paginationResult(Number(countResult.rows[0].total || 0), pagination),
  };
}

async function stockMovementDetails(filters = {}) {
  const itemCode = String(filters.item_code || '').trim();
  const warehouse = String(filters.warehouse || '').trim();
  const direction = String(filters.direction || '').trim();
  if (!itemCode || !warehouse || !['in', 'out'].includes(direction)) {
    const err = new Error('Item, warehouse, and direction are required.');
    err.status = 400;
    throw err;
  }
  const params = [itemCode, warehouse];
  const where = ['item_code = $1', 'warehouse = $2'];
  addStockLedgerOwnerFilter(where, params, 'app_stock_ledger', filters.ownerId, filters.ownerEmployeeId);
  const from = String(filters.from || '').trim();
  const to = String(filters.to || '').trim();
  if (from) {
    params.push(from);
    where.push(`posting_date >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    where.push(`posting_date <= $${params.length}`);
  }
  where.push(direction === 'in' ? 'qty_change > 0' : 'qty_change < 0');
  const { rows } = await getPostgresPool().query(
    `
    SELECT
      posting_date::text,
      voucher_type,
      voucher_id,
      voucher_no,
      CASE
        WHEN voucher_type LIKE 'stock_%' THEN replace(voucher_type, 'stock_', '')
        WHEN voucher_type = 'purchase' THEN 'purchase'
        ELSE ''
      END AS stock_entry_type,
      ${direction === 'in' ? 'qty_change' : 'ABS(qty_change)'}::float AS qty,
      ${direction === 'in' ? 'incoming_rate' : 'outgoing_rate'}::float AS rate,
      ABS(stock_value_change)::float AS value,
      qty_after_transaction::float AS balance_qty,
      stock_value_after_transaction::float AS balance_value,
      remarks
    FROM app_stock_ledger
    WHERE ${where.join(' AND ')}
    ORDER BY posting_date DESC, id DESC
    LIMIT 200
    `,
    params,
  );
  return {
    item_code: itemCode,
    warehouse,
    direction,
    rows,
    summary: {
      qty: rows.reduce((sum, row) => sum + Number(row.qty || 0), 0),
      value: rows.reduce((sum, row) => sum + Number(row.value || 0), 0),
    },
  };
}

async function grossProfitReport(filters = {}) {
  const pagination = paginationOptions(filters, 50, 200);
  const params = [];
  const where = ["invoice.docstatus = 'submitted'"];
  addVoucherOwnerFilter(where, params, 'invoice', filters.ownerId, filters.ownerEmployeeId);
  const from = String(filters.from || '').trim();
  const to = String(filters.to || '').trim();
  const search = String(filters.search || '').trim().toLowerCase();
  if (from) {
    params.push(from);
    where.push(`invoice.invoice_date >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    where.push(`invoice.invoice_date <= $${params.length}`);
  }
  if (search) {
    params.push(sqlLikePattern(search));
    where.push(`(
      invoice.invoice_date::text LIKE $${params.length}
      OR LOWER(invoice.invoice_no) LIKE $${params.length}
      OR LOWER(invoice.customer_name) LIKE $${params.length}
      OR LOWER(item.item_code) LIKE $${params.length}
      OR LOWER(item.item_name) LIKE $${params.length}
      OR LOWER(COALESCE(item.warehouse, '')) LIKE $${params.length}
      OR item.quantity::text LIKE $${params.length}
      OR item.line_total::text LIKE $${params.length}
      OR item.cost_amount::text LIKE $${params.length}
      OR item.gross_profit::text LIKE $${params.length}
    )`);
  }
  const whereSql = where.join(' AND ');
  const [countResult, summaryResult] = await Promise.all([
    getPostgresPool().query(
      `
      SELECT COUNT(*)::int AS total
      FROM app_invoice_items item
      INNER JOIN app_invoices invoice ON invoice.id = item.invoice_pk
      WHERE ${whereSql}
      `,
      params,
    ),
    getPostgresPool().query(
      `
      SELECT
        COALESCE(SUM(item.line_total), 0)::float AS sales_amount,
        COALESCE(SUM(item.cost_amount), 0)::float AS cost_amount,
        COALESCE(SUM(item.gross_profit), 0)::float AS gross_profit
      FROM app_invoice_items item
      INNER JOIN app_invoices invoice ON invoice.id = item.invoice_pk
      WHERE ${whereSql}
      `,
      params,
    ),
  ]);
  const pageParams = [...params, pagination.limit, pagination.offset];
  const { rows } = await getPostgresPool().query(
    `
    SELECT
      invoice.invoice_date::text,
      invoice.invoice_no,
      invoice.id AS invoice_id,
      invoice.customer_name,
      item.item_code,
      item.item_name,
      item.warehouse,
      item.quantity::float,
      item.line_total::float AS sales_amount,
      item.cost_amount::float,
      item.gross_profit::float
    FROM app_invoice_items item
    INNER JOIN app_invoices invoice ON invoice.id = item.invoice_pk
    WHERE ${whereSql}
    ORDER BY invoice.invoice_date DESC, invoice.id DESC, item.line_no
    LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}
    `,
    pageParams,
  );
  return {
    filters: reportFilterValues(filters),
    rows,
    summary: roundReportMoney(summaryResult.rows[0] || { sales_amount: 0, cost_amount: 0, gross_profit: 0 }),
    pagination: paginationResult(Number(countResult.rows[0].total || 0), pagination),
  };
}
module.exports = {
  stockSummary,
  stockBalances,
  listStockEntries,
  localStockQuantity,
  createStockEntry,
  loadStockEntry,
  stockEntryCancelTemplate,
  searchStockEntriesForCancel,
  updateStockEntry,
  updateStockEntrySupplierInfo,
  cancelStockEntry,
  validateStockEntryCancellation,
  stockLedgerReport,
  stockLedgerVoucherDetails,
  stockEntryDraftReport,
  stockMovementReport,
  stockMovementDetails,
  grossProfitReport,
};

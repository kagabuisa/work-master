'use strict';

const { warehouseAllowed, allowedNamedListValues, deniedNamedListValues } = require('../access');

const PAGE_SIZE = 50;
const MESSAGE = 'ERPNext Stock Balance is unavailable. Ask an administrator to check the ERPNext connection and read access to Warehouses, Bins, and Items, then try again.';
function unavailable(cause) {
  return Object.assign(new Error(MESSAGE, { cause }), { status: 503, code: 'ERPNEXT_STOCK_UNAVAILABLE' });
}

function normalizeFilters(query = {}) {
  const values = query.warehouse == null ? [] : Array.isArray(query.warehouse) ? query.warehouse : [query.warehouse];
  if (values.length > 100 || values.some(value => typeof value !== 'string' || value.length > 140)) {
    throw Object.assign(new Error('Choose up to 100 warehouses.'), { status: 400 });
  }
  return {
    warehouses: [...new Set(values.map(value => value.trim()).filter(Boolean))],
    search: typeof query.q === 'string' ? query.q.trim().slice(0, 140) : '',
    page: Math.max(1, Math.min(10000, Number.parseInt(query.page, 10) || 1)),
  };
}

async function resourceReader() {
  const base = process.env.ERPNEXT_URL?.trim().replace(/\/$/, '');
  const usr = process.env.ERPNEXT_USERNAME;
  const pwd = process.env.ERPNEXT_PASSWORD;
  if (!base || !usr || !pwd) throw unavailable();
  try {
    const response = await fetch(`${base}/api/method/login`, {
      method: 'POST', body: new URLSearchParams({ usr, pwd }),
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000), redirect: 'error',
    });
    if (!response.ok) throw new Error('ERPNext login failed');
    const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    if (!cookie.includes('sid=')) throw new Error('ERPNext session missing');
    return async (doctype, params) => {
      try {
        const response = await fetch(`${base}/api/resource/${doctype}?${new URLSearchParams(params)}`, {
          headers: { cookie, Accept: 'application/json' }, signal: AbortSignal.timeout(20000), redirect: 'error',
        });
        if (!response.ok) throw new Error('ERPNext stock read failed');
        const { data } = await response.json();
        if (!Array.isArray(data)) throw new Error('Invalid ERPNext stock response');
        return data;
      } catch (cause) { throw unavailable(cause); }
    };
  } catch (cause) { throw unavailable(cause); }
}

async function warehouseOptions(read, user) {
  const allowed = allowedNamedListValues(user, 'warehouses');
  if (allowed?.length === 0) return [];
  const filters = [['disabled', '=', 0]];
  if (allowed) filters.push(['name', 'in', allowed]);
  const denied = deniedNamedListValues(user, 'warehouses');
  if (denied.length) filters.push(['name', 'not in', denied]);
  const warehouses = [];
  for (let start = 0; ; start += 500) {
    const rows = await read('Warehouse', { fields: '["name"]', filters: JSON.stringify(filters),
      order_by: 'name asc', limit_page_length: '500', limit_start: String(start) });
    warehouses.push(...rows.map(row => row.name).filter(name => typeof name === 'string' && warehouseAllowed(user, name)));
    if (rows.length < 500) return warehouses;
  }
}

function numeric(value) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) throw unavailable();
  return number;
}

async function erpnextStockBalance(query, user, { allRows = false } = {}) {
  const filters = normalizeFilters(query);
  if (allRows && !filters.warehouses.length) {
    throw Object.assign(new Error('Choose one or more warehouses before downloading stock balances.'), { status: 400 });
  }
  if (filters.warehouses.some(name => !warehouseAllowed(user, name))) {
    throw Object.assign(new Error('Choose permitted warehouses.'), { status: 403 });
  }
  const read = await resourceReader();
  const warehouses = await warehouseOptions(read, user);
  if (filters.warehouses.some(name => !warehouses.includes(name))) {
    throw Object.assign(new Error('Choose available ERPNext warehouses.'), { status: 400 });
  }
  const report = { filters, warehouses, rows: [], summary: { total: 0, quantity: 0, stock_value: 0 } };
  if (filters.warehouses.length) {
    const where = [['warehouse', 'in', filters.warehouses], ['actual_qty', '!=', 0]];
    if (filters.search) where.push(['item_code', 'like', `%${filters.search}%`]);
    const params = { filters: JSON.stringify(where) };
    // This ERPNext version ignores group_by on both resource and get_list APIs.
    // Read every matching Bin page and combine locally to avoid reporting an
    // arbitrary item against aggregate totals for the entire selection.
    const combined = new Map();
    for (let start = 0; ; start += 500) {
      const bins = await read('Bin', { ...params,
        fields: '["name","item_code","actual_qty","stock_value"]',
        order_by: 'name asc', limit_page_length: '500', limit_start: String(start) });
      for (const bin of bins) {
        if (typeof bin.item_code !== 'string' || !bin.item_code) throw unavailable();
        const row = combined.get(bin.item_code) || { item_code: bin.item_code, quantity: 0, stock_value: 0 };
        row.quantity += numeric(bin.actual_qty);
        row.stock_value += numeric(bin.stock_value);
        combined.set(bin.item_code, row);
      }
      if (bins.length < 500) break;
    }
    const groupedRows = [...combined.values()].sort((a, b) => a.item_code.localeCompare(b.item_code));
    report.summary = groupedRows.reduce((summary, row) => ({ total: summary.total + 1,
      quantity: summary.quantity + row.quantity, stock_value: summary.stock_value + row.stock_value }),
    { total: 0, quantity: 0, stock_value: 0 });
    filters.page = Math.min(filters.page, Math.max(1, Math.ceil(report.summary.total / PAGE_SIZE)));
    const rows = allRows ? groupedRows : groupedRows.slice((filters.page - 1) * PAGE_SIZE, filters.page * PAGE_SIZE);
    const costs = new Map();
    for (let start = 0; start < rows.length; start += PAGE_SIZE) {
      const items = await read('Item', { fields: '["name","cost","last_purchase_rate"]',
        filters: JSON.stringify([['name', 'in', rows.slice(start, start + PAGE_SIZE).map(row => row.item_code)]]),
        limit_page_length: String(PAGE_SIZE) });
      for (const item of items) {
        const cost = item.cost ?? item.last_purchase_rate;
        costs.set(item.name, cost == null ? null : numeric(cost));
      }
    }
    report.rows = rows.map(row => {
      const quantity = numeric(row.quantity);
      const stock_value = numeric(row.stock_value);
      return { item_code: row.item_code, quantity, stock_value, cost: costs.get(row.item_code) ?? null,
        valuation_rate: quantity ? stock_value / quantity : null };
    });
  }
  const total = report.summary.total;
  const offset = (filters.page - 1) * PAGE_SIZE;
  report.pagination = { page: filters.page, limit: PAGE_SIZE, total,
    total_pages: Math.max(1, Math.ceil(total / PAGE_SIZE)), offset,
    start: total ? offset + 1 : 0, end: Math.min(offset + PAGE_SIZE, total) };
  // Repeated parameters preserve the complete warehouse selection on page links.
  report.query = [['q', filters.search], ...filters.warehouses.map(name => ['warehouse', name])];
  return report;
}

module.exports = { erpnextStockBalance, normalizeFilters };

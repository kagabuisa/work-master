'use strict';

const MESSAGE = 'Daily Activity is unavailable because the ERPNext connection is not configured or cannot be reached. Ask an administrator to check the ERPNext connection, then try again.';
function unavailable(cause) {
  return Object.assign(new Error(MESSAGE, { cause }), { status: 503, code: 'DAILY_ACTIVITY_SOURCE_UNAVAILABLE' });
}
function apiConfigured() { return Boolean(process.env.ERPNEXT_URL?.trim()); }

async function apiSession() {
  const base = process.env.ERPNEXT_URL?.replace(/\/$/, '');
  const usr = process.env.ERPNEXT_USERNAME;
  const pwd = process.env.ERPNEXT_PASSWORD;
  if (!base || !usr || !pwd) throw unavailable();
  try {
    const response = await fetch(`${base}/api/method/login`, {
      method: 'POST', body: new URLSearchParams({ usr, pwd }),
      signal: AbortSignal.timeout(20000), redirect: 'error',
    });
    if (!response.ok) throw Object.assign(new Error('ERPNext login failed'), { code: `HTTP_${response.status}` });
    const cookie = response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
    if (!cookie.includes('sid=')) throw new Error('ERPNext session missing');
    return async (suffix = '', params = {}, allowMissing = false) => {
      try {
        const query = new URLSearchParams(params);
        const result = await fetch(`${base}/api/resource/Daily%20Activity%20Report${suffix}?${query}`, {
          headers: { cookie, Accept: 'application/json' }, signal: AbortSignal.timeout(20000), redirect: 'error',
        });
        if (allowMissing && result.status === 404) return null;
        if (!result.ok) throw Object.assign(new Error('ERPNext read failed'), { code: `HTTP_${result.status}` });
        const data = (await result.json()).data;
        if (!data || typeof data !== 'object') throw new Error('Invalid ERPNext response');
        return data;
      } catch (cause) { throw unavailable(cause); }
    };
  } catch (cause) { throw unavailable(cause); }
}

function mappedRow(row) {
  return { ...row, shop: row['cost center'], expense_details: row['expense details'],
    delivery_differences: row.do_you_have_any_delivery_differences,
    item_differences: row.item_not_received_or_excess_items_received };
}

async function apiReport(filters) {
  const read = await apiSession();
  const where = [['date', '>=', filters.from], ['date', '<=', filters.to]];
  if (filters.status) where.push(['docstatus', '=', Number(filters.status)]);
  if (filters.shop) where.push(['`cost center`', 'like', `%${filters.shop}%`]);
  const params = { filters: JSON.stringify(where) };
  const fields = JSON.stringify(['name', 'date', '`cost center`', 'unit_type', 'sales', 'expense', 'banked',
    '`expense details`', 'stock_entry_number', 'packages_received',
    'do_you_have_any_delivery_differences', 'remarks', 'comments_or_remarks', 'docstatus']);
  const order_by = 'date desc, modified desc, name desc';
  // The resource API ignores or_filters. Match text across the date/shop/status
  // result set so totals and pagination use exactly the same matching vouchers.
  if (filters.search) {
    const matching = [];
    const needle = filters.search.toLocaleLowerCase();
    for (let start = 0; ; start += 500) {
      const page = await read('', { ...params, fields, order_by,
        limit_page_length: '500', limit_start: String(start) });
      if (!Array.isArray(page)) throw unavailable();
      matching.push(...page.filter((row) => ['name', 'cost center', 'expense details', 'remarks', 'comments_or_remarks']
        .some((field) => String(row[field] || '').toLocaleLowerCase().includes(needle))));
      if (page.length < 500) break;
    }
    const summary = matching.reduce((total, row) => ({ total: total.total + 1,
      sales: total.sales + Number(row.sales || 0), expense: total.expense + Number(row.expense || 0),
      banked: total.banked + Number(row.banked || 0) }), { total: 0, sales: 0, expense: 0, banked: 0 });
    const start = (filters.page - 1) * 50;
    return { summary, rows: matching.slice(start, start + 50).map(mappedRow) };
  }
  const summary = await read('', { ...params, fields: JSON.stringify([
    'count(name) as total', 'sum(sales) as sales', 'sum(expense) as expense', 'sum(banked) as banked',
  ]), limit_page_length: '1' });
  const rows = await read('', { ...params, fields, order_by, limit_page_length: '50',
    limit_start: String((filters.page - 1) * 50) });
  if (!Array.isArray(summary) || !summary[0] || !Array.isArray(rows)) throw unavailable();
  return { summary: summary[0], rows: rows.map(mappedRow) };
}

async function apiVoucher(name) {
  const read = await apiSession();
  const row = await read(`/${encodeURIComponent(name)}`, {}, true);
  return row ? mappedRow(row) : null;
}

module.exports = { apiConfigured, apiReport, apiVoucher };

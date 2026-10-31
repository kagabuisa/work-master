(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SalesControls = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  function dateError(date, today, { director = false, accountant = false } = {}, allow = '', pending = false) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !Number.isFinite(Date.parse(date + 'T00:00:00Z'))) return 'Choose a valid posting date.';
    if (date > today) return 'Future-dated Sales Invoices are not allowed.';
    if (director) return '';
    const days = (Date.parse(today + 'T00:00:00Z') - Date.parse(date + 'T00:00:00Z')) / 86400000;
    const limit = accountant ? (allow === 'Backdate' || pending ? 12 : 10) : 2;
    return days > limit ? `Posting date exceeds your ${limit}-calendar-day backdating limit.` : '';
  }
  function scaledRate(value) {
    const [whole,decimal=''] = String(value).split('.');
    return BigInt(whole || '0')*1000000n+BigInt(decimal.padEnd(6,'0').slice(0,6));
  }
  const positive = v => Number.isFinite(Number(v)) && Number(v) > 0;
  function minimumRate(context, item, discounts) {
    const { today, price_list, customer_id, customer_name, warehouse_type } = context;
    if (customer_name === 'Damaged Items CST') return { rate: 0, reason: 'Damaged item' };
    const active = (discounts || []).filter(d => d.status === 'Approved' && d.item_code === item.item_code
      && d.start_date <= today && (!d.expiry_date || d.expiry_date >= today)
      && (!d.warehouse || d.warehouse === item.warehouse)
      && (!d.warehouse_type || d.warehouse_type === warehouse_type)
      && (!d.price_list || d.price_list === price_list)
      && positive(d.min_qty) && Number(item.quantity) >= Number(d.min_qty) && positive(d.discount_rate));
    const specificity = d => [d.warehouse, d.warehouse_type, d.price_list].filter(Boolean).length;
    active.sort((a,b) => specificity(b)-specificity(a) || Number(b.min_qty)-Number(a.min_qty)
      || String(b.start_date).localeCompare(String(a.start_date)) || Number(b.id)-Number(a.id));
    if (active[0]) return { rate: active[0].discount_rate, reason: 'Approved discount', discount_id: String(active[0].id) };
    const p = item.pricing || {};
    if (positive(p.promo_rate) && positive(p.promo_qty) && Number(item.quantity) >= Number(p.promo_qty)
      && (!p.promo_start_date || p.promo_start_date <= today) && (!p.promo_expiry_date || p.promo_expiry_date >= today)
      && (!p.promo_warehouse || p.promo_warehouse === item.warehouse)
      && (!p.warehouse_type || p.warehouse_type === warehouse_type)
      && (!p.promo_customer || p.promo_customer === customer_id || p.promo_customer === customer_name)) {
      return { rate: p.promo_rate, reason: 'Promotion price' };
    }
    if (positive(p.carton_price) && positive(p.qty_per_carton) && Number(item.quantity) >= Number(p.qty_per_carton)) return { rate: p.carton_price, reason: 'Carton price' };
    if (positive(p.price_list_rate)) return { rate: p.price_list_rate, reason: 'Normal price' };
    if (positive(p.unit_cost)) {
      const value=(scaledRate(p.unit_cost)*13n+9n)/10n;
      const rate=String(value/1000000n)+'.'+String(value%1000000n).padStart(6,'0');
      return {rate:typeof p.unit_cost==='number'?Number(rate):rate,reason:'Cost plus 30%'};
    }
    return { rate: null, reason: 'No selling price or cost available; ask an authorized pricing manager.' };
  }
  return { dateError, minimumRate, scaledRate };
});

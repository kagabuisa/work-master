// Rebuild the editor from the attempted values, not the last saved invoice.
function invoiceFormState(body, savedInvoice = null) {
  let items = [];
  try {
    const parsed = JSON.parse(body.items_json || '[]');
    if (Array.isArray(parsed)) items = parsed.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
  } catch {
    // A malformed request still gets an editable form and a useful error.
  }
  const invoice = { id: savedInvoice?.id, invoice_no: savedInvoice?.invoice_no, payments: [] };
  for (const key of ['invoice_date', 'posting_time', 'due_date', 'non_system_invoice', 'customer_id', 'customer_name', 'customer_phone', 'price_list', 'cost_center', 'invoicer_id', 'invoicer', 'warehouse', 'notes', 'discount_amount', 'tax_amount']) {
    invoice[key] = typeof body[key] === 'string' ? body[key] : '';
  }
  return { invoice, items, today: invoice.invoice_date };
}

function duplicateInvoiceFormState(source, { invoiceDate, postingTime }) {
  const invoice = {
    invoice_date: invoiceDate,
    posting_time: postingTime,
    due_date: '',
    non_system_invoice: '',
    customer_id: source.customer_id,
    customer_name: source.customer_name,
    customer_phone: source.customer_phone,
    price_list: source.price_list,
    cost_center: source.cost_center,
    invoicer_id: source.invoicer_id,
    invoicer: source.invoicer,
    warehouse: source.warehouse || source.items?.[0]?.warehouse || '',
    discount_amount: source.discount_amount,
    tax_amount: source.tax_amount,
    notes: source.notes,
    amount_paid: 0,
    payments: [],
  };
  const items = (source.items || []).map((item) => ({
    item_code: item.item_code,
    item_name: item.item_name,
    warehouse: item.warehouse,
    quantity: item.quantity,
    unit_price: item.unit_price,
    stock_at_sale: null,
  }));
  return { invoice, items, today: invoiceDate };
}

module.exports = { invoiceFormState, duplicateInvoiceFormState };

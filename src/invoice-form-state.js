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
  for (const key of ['invoice_date', 'due_date', 'customer_id', 'customer_name', 'customer_phone', 'price_list', 'warehouse', 'notes', 'discount_amount', 'tax_amount']) {
    invoice[key] = typeof body[key] === 'string' ? body[key] : '';
  }
  return { invoice, items, today: invoice.invoice_date };
}

module.exports = { invoiceFormState };

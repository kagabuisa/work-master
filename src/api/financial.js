'use strict';
const express = require('express');
const { bodyFields } = require('./errors');
const { readQuery } = require('./query');
const { invoiceCreate, paymentCreate, idempotencyKey } = require('./financial-input');
const { executeInvoiceOperation } = require('../services/sales');
const router = express.Router();

function operation(name, parse) {
  return (req, res, next) => Promise.resolve().then(async () => {
    readQuery(req.query, [], { paged: false });
    const key = idempotencyKey(req);
    const payload = parse(req.body);
    const result = await executeInvoiceOperation(req.apiActor, name, req.params.id || null, key, payload);
    req.apiMutationOutcome = result.replayed ? 'replayed' : result.referenceReplayed ? 'reference_replayed' : 'committed';
    res.status(result.status).json(result.body);
  }).catch(next);
}

router.post('/invoices', operation('invoice.create', invoiceCreate));
router.post('/invoices/:id/submit', operation('invoice.submit', body => { bodyFields(body, []); return {}; }));
router.post('/invoices/:id/payments', operation('payment.record', paymentCreate));
module.exports = router;

'use strict';
const controls = require('../../src/voucher-controls');
const { runWithAuditUser } = require('../../src/audit');
const { withPostgresTransaction } = require('../../src/core');

async function requestApproval(pool, kind, id, action, actor, reason = 'Fixture approval') {
  const current = await controls.view(pool, kind, id);
  await runWithAuditUser(actor, () => withPostgresTransaction(client => controls.act(client, kind, id, {
    control_revision: current.revision,
    action_request: action,
    why_cancel: reason,
  }, false)));
}

async function approveRequest(pool, kind, id, action, actor) {
  const current = await controls.view(pool, kind, id);
  await runWithAuditUser(actor, () => withPostgresTransaction(client => controls.act(client, kind, id, {
    control_revision: current.revision,
    allow: action,
  }, true)));
}

async function approveVoucher(pool, kind, id, action, requester, approver) {
  await requestApproval(pool, kind, id, action, requester);
  await approveRequest(pool, kind, id, action, approver);
}

module.exports = { requestApproval, approveRequest, approveVoucher };

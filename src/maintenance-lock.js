'use strict';

// Shared across app processes and CLI tasks using AuditPool. A reset or backup
// upgrades its own checkout to an exclusive lock; other checkouts fail closed.
const MAINTENANCE_LOCK = 1776342160;
const { AsyncLocalStorage } = require('node:async_hooks');
const epochs = new AsyncLocalStorage();

function maintenanceBusy() {
  const error = new Error('Maintenance is in progress. Please try again shortly.');
  error.status = 503;
  return error;
}

function withResetEpoch(epoch, callback) { return epochs.run(String(epoch),callback); }
function resetEpoch() { return epochs.getStore(); }
function staleResetRequest() {
  const error=new Error('Transactions were reset while this request was pending. Reload the app and sign in again.');
  error.status=503;
  return error;
}

async function captureResetEpoch(req,res,next) {
  if (req.method!=='POST') return next();
  try {
    const {rows}=await require('./core').getPostgresPool().query('SELECT COALESCE(MAX(id),0)::text AS epoch FROM wm_transaction_resets');
    withResetEpoch(rows[0].epoch,next);
  } catch(error) { next(error); }
}

module.exports = { MAINTENANCE_LOCK, maintenanceBusy, withResetEpoch, resetEpoch, staleResetRequest, captureResetEpoch };

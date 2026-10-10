'use strict';
// /accounts and /journals routes. Mounted at the app root.
const express = require('express');
const { money, todayString } = require('../format');
const { currentPostingDate, currentPostingTime } = require('../../posting-time');
const { ACCOUNT_DETAIL_TYPES } = require('../../account-detail-types');
const { accountAccessOptions } = require('../helpers');
const { arrayField } = require('../parsers');
const { voucherOwnerId, voucherEmployeeId } = require('../../voucher-ownership');
const { allowedNamedListValues, deniedNamedListValues } = require('../../access');
const {
  accountingAccounts,
  createAccountingAccount,
  findAccountingAccount,
  updateAccountingAccount,
  journalEntries,
  postableAccountingAccounts,
  createJournalEntry,
  updateJournalEntry,
  submitJournalEntry,
  findJournalEntry,
  journalReferenceOptions,
  cancelJournalEntry,
  updateVoucherPostingTime,
  deleteDraftVoucher,
} = require('../../store');
const { findDbCustomer, findDbSupplier, findDbEmployee } = require('../parties');
const { registerVoucherReportRoutes } = require('./voucher-report-routes');

const router = express.Router();

function parseJournalEntryPayload(body) {
  const ids = arrayField(body.line_id);
  const accountIds = arrayField(body.account_id);
  const debits = arrayField(body.debit);
  const credits = arrayField(body.credit);
  const remarks = arrayField(body.line_remarks);
  const references = arrayField(body.line_reference_no);
  return {
    journal_type: body.journal_type,
    posting_date: body.posting_date,
    posting_time: body.posting_time,
    cost_center: body.cost_center,
    party_type: body.party_type,
    party_id: body.party_id,
    party_name: body.party_name,
    reference_no: body.reference_no,
    remarks: body.remarks,
    lines: accountIds.map((accountId, index) => ({
      id: ids[index],
      account_id: accountId,
      debit: debits[index],
      credit: credits[index],
      remarks: remarks[index],
      reference_no: references[index],
    })),
  };
}

async function validateJournalReferencesForUser(user, journal) {
  const references = [...new Set((journal.lines || []).map((line) => line.reference_no).filter(Boolean))];
  for (const reference of references) {
    const available = await journalReferenceOptions({
      ownerId: voucherOwnerId(user), ownerEmployeeId: voucherEmployeeId(user),
      party_type: journal.party_type, party_id: journal.party_id,
      party_name: journal.party_name, search: reference, purchaseInvoicesOnly: journal.party_type === 'supplier',
    });
    if (!available.some((row) => row.reference === reference && (journal.party_type !== 'customer' || row.type === 'Invoice'))) {
      const error = new Error(`Reference ${reference} is not available for the selected party.`);
      error.status = 403;
      throw error;
    }
  }
}

async function validateJournalParty(payload) {
  const partyType = String(payload.party_type || '').trim();
  const partyId = String(payload.party_id || '').trim();
  if (!partyType) {
    payload.party_id = '';
    payload.party_name = '';
    return;
  }
  if (!['customer', 'supplier', 'employee'].includes(partyType)) {
    const err = new Error('Choose a valid party type.');
    err.status = 400;
    throw err;
  }
  if (!partyId) {
    const err = new Error('Select a party from the database.');
    err.status = 400;
    throw err;
  }

  let party;
  if (partyType === 'customer') {
    party = await findDbCustomer(partyId);
    payload.party_name = party ? party.customer_name : '';
  } else if (partyType === 'supplier') {
    party = await findDbSupplier(partyId);
    payload.party_name = party ? party.supplier_name : '';
  } else {
    party = await findDbEmployee(partyId);
    payload.party_name = party ? party.employee_name : '';
  }
  if (!party) {
    const err = new Error(`Select a valid ${partyType} from the database.`);
    err.status = 400;
    throw err;
  }
  payload.party_id = partyId;
}

function journalPayloadForRender(body) {
  const payload = parseJournalEntryPayload(body);
  return {
    ...payload,
    lines: payload.lines.map((line, index) => ({
      ...line,
      line_no: index + 1,
      debit: Number(line.debit || 0),
      credit: Number(line.credit || 0),
    })),
  };
}

function journalTypeLabel(type) {
  if (type === 'cash_receipt') {
    return 'Cash Receipt';
  }
  if (type === 'payment_journal') {
    return 'Payment Journal';
  }
  return 'Journal Entry';
}

router.get('/accounts', async (req, res, next) => {
  try {
    const accounts = await accountingAccounts(accountAccessOptions(req.currentUser));
    const queryText = (key) => typeof req.query[key] === 'string' ? req.query[key].trim() : '';
    const filters = {
      q: queryText('q'),
      root_type: queryText('root_type'),
      detail_type: queryText('detail_type'),
      status: queryText('status'),
      kind: queryText('kind'),
    };
    const detailTypes = [...new Set(accounts.map((account) => account.account_detail_type).filter(Boolean))].sort();
    const search = filters.q.toLowerCase();
    const filteredAccounts = accounts.filter((account) =>
      (!search || [account.account_code, account.account_name].some((value) => String(value || '').toLowerCase().includes(search)))
      && (!filters.root_type || account.account_type === filters.root_type)
      && (!filters.detail_type || account.account_detail_type === filters.detail_type)
      && (!filters.status || (filters.status === 'active' ? account.is_active : filters.status === 'inactive' && !account.is_active))
      && (!filters.kind || (filters.kind === 'group' ? account.is_group : filters.kind === 'posting' && !account.is_group))
    );
    res.render('accounts', { accounts: filteredAccounts, filters, detailTypes, totalAccounts: accounts.length });
  } catch (err) {
    next(err);
  }
});

router.get('/accounts/new', (_req, res) => {
  res.render('account-form', {
    editing: false,
    accountDetailTypes: ACCOUNT_DETAIL_TYPES,
    account: {
      account_type: 'expense',
      normal_balance: 'debit',
    },
    error: null,
  });
});

router.post('/accounts', async (req, res, next) => {
  try {
    await createAccountingAccount({
      account_code: req.body.account_code,
      account_name: req.body.account_name,
      account_type: req.body.account_type,
      account_detail_type: req.body.account_detail_type,
      normal_balance: req.body.normal_balance,
    });
    res.redirect('/accounts');
  } catch (err) {
    if (err.code === '23505') {
      err.message = 'An account with that code already exists.';
      err.status = 400;
    }
    res.status(err.status || 500).render('account-form', {
      editing: false,
      accountDetailTypes: ACCOUNT_DETAIL_TYPES,
      account: {
        account_code: req.body.account_code,
        account_name: req.body.account_name,
        account_type: req.body.account_type,
        account_detail_type: req.body.account_detail_type,
        normal_balance: req.body.normal_balance,
      },
      error: err.message || 'Could not create account.',
    });
  }
});

router.get('/accounts/:id/edit', async (req, res, next) => {
  try {
    const account = await findAccountingAccount(req.params.id);
    res.render('account-form', { editing: true, accountDetailTypes: ACCOUNT_DETAIL_TYPES, account, error: null });
  } catch (err) { next(err); }
});

router.post('/accounts/:id', async (req, res, next) => {
  try {
    await updateAccountingAccount(req.params.id, req.body);
    res.redirect('/accounts');
  } catch (err) {
    if (err.code === '23505') {
      err.message = 'An account with that code already exists.';
      err.status = 400;
    }
    if (err.status === 404) return next(err);
    res.status(err.status || 500).render('account-form', {
      editing: true,
      accountDetailTypes: ACCOUNT_DETAIL_TYPES,
      account: { id: req.params.id, ...req.body },
      error: err.message || 'Could not update account.',
    });
  }
});

router.get('/journals', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    const journals = await journalEntries({
      search,
      journal_type: req.query.journal_type,
      status: req.query.status,
      page: req.query.page,
      page_size: req.query.page_size,
      ownerId: voucherOwnerId(req.currentUser),
      allowedAccounts: allowedNamedListValues(req.currentUser, 'accounts'),
      deniedAccounts: deniedNamedListValues(req.currentUser, 'accounts'),
    });
    res.render('journals', { journals, pagination: journals.pagination, query: req.query, search, money, journalTypeLabel });
  } catch (err) {
    next(err);
  }
});

registerVoucherReportRoutes(router, 'journals');

router.get('/journals/new', async (req, res, next) => {
  try {
    const accounts = await postableAccountingAccounts(accountAccessOptions(req.currentUser));
    res.render('journal-entry', {
      accounts,
      journal: {
        journal_type: req.query.type || 'cash_receipt',
        posting_date: currentPostingDate(),
        posting_time: currentPostingTime(),
        lines: [],
      },
      today: todayString(),
      error: null,
      readOnly: false,
      money,
      journalTypeLabel,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/journals', async (req, res, next) => {
  try {
    const payload = parseJournalEntryPayload(req.body);
    await validateJournalParty(payload);
    await validateJournalReferencesForUser(req.currentUser, payload);
    const id = await createJournalEntry(payload, { submit: req.body.action !== 'save_draft' });
    res.redirect(`/journals/${id}`);
  } catch (err) {
    try {
      const accounts = await postableAccountingAccounts(accountAccessOptions(req.currentUser));
      res.status(err.status || 500).render('journal-entry', {
        accounts,
        journal: journalPayloadForRender(req.body),
        today: todayString(),
        error: err.message || 'Could not save journal entry.',
        readOnly: false,
        money,
        journalTypeLabel,
      });
    } catch (loadErr) {
      next(loadErr);
    }
  }
});

router.get('/journals/:id/edit', async (req, res, next) => {
  try {
    const [accounts, journal] = await Promise.all([
      postableAccountingAccounts(accountAccessOptions(req.currentUser)), findJournalEntry(req.params.id)]);
    if (!journal) { const error = new Error('Journal entry not found.'); error.status = 404; throw error; }
    if (journal.docstatus !== 'draft') { const error = new Error('Only draft journals can be edited.'); error.status = 400; throw error; }
    res.render('journal-entry', { accounts, journal, today: todayString(), error: null, readOnly: false, money, journalTypeLabel });
  } catch (err) { next(err); }
});

router.post('/journals/:id', async (req, res, next) => {
  try {
    const payload = parseJournalEntryPayload(req.body);
    await validateJournalParty(payload);
    await validateJournalReferencesForUser(req.currentUser, payload);
    await updateJournalEntry(req.params.id, payload);
    res.redirect(`/journals/${req.params.id}`);
  } catch (err) { next(err); }
});

router.post('/journals/:id/submit', async (req, res, next) => {
  try {
    const journal = await findJournalEntry(req.params.id);
    if (!journal) { const error = new Error('Journal entry not found.'); error.status = 404; throw error; }
    await validateJournalReferencesForUser(req.currentUser, journal);
    await submitJournalEntry(req.params.id);
    res.redirect(`/journals/${req.params.id}`);
  } catch (err) { next(err); }
});

router.get('/journals/:id', async (req, res, next) => {
  try {
    const [accounts, journal] = await Promise.all([
      postableAccountingAccounts(accountAccessOptions(req.currentUser)),
      findJournalEntry(req.params.id),
    ]);
    if (!journal) {
      const err = new Error('Journal entry not found.');
      err.status = 404;
      throw err;
    }
    let selectedReference = null;
    if (journal.reference_no && journal.party_type && (journal.party_id || journal.party_name)) {
      const references = await journalReferenceOptions({
        ownerId: voucherOwnerId(req.currentUser),
        ownerEmployeeId: voucherEmployeeId(req.currentUser),
        party_type: journal.party_type,
        party_id: journal.party_id,
        party_name: journal.party_name,
        search: journal.reference_no,
        limit: 50,
      });
      selectedReference = references.find((reference) => reference.reference === journal.reference_no) || null;
    }
    res.render('journal-entry', {
      accounts,
      journal,
      selectedReference,
      today: todayString(),
      error: req.query.error || null,
      readOnly: true,
      money,
      journalTypeLabel,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/journals/:id/posting-time', async (req, res, next) => {
  try {
    await updateVoucherPostingTime('journals', req.params.id, req.body.posting_time);
    res.redirect(303, `/journals/${req.params.id}`);
  } catch (err) {
    if (err.status === 400) return res.redirect(303, `/journals/${req.params.id}?error=${encodeURIComponent(err.message)}`);
    next(err);
  }
});

router.post('/journals/:id/delete', async (req, res, next) => {
  try { await deleteDraftVoucher('journals', req.params.id, { allowCancelled: req.currentUser.role === 'admin' }); res.redirect(303, '/journals'); }
  catch (error) { next(error); }
});

router.get('/journals/:id/drawer', async (req, res, next) => {
  try {
    const journal = await findJournalEntry(req.params.id);
    if (!journal) {
      const err = new Error('Journal entry not found.');
      err.status = 404;
      throw err;
    }
    res.set('Cache-Control', 'private, max-age=10');
    res.render('journal-drawer', { journal, money, journalTypeLabel });
  } catch (err) {
    next(err);
  }
});

router.post('/journals/:id/cancel', async (req, res, next) => {
  try {
    const id = await cancelJournalEntry(req.params.id);
    res.redirect(`/journals/${id}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

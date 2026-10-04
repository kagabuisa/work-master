'use strict';
// Shared domain constants.

const STOCK_ENTRY_TYPES = ['opening', 'purchase', 'transfer', 'adjustment', 'reconciliation', 'cancel'];
const JOURNAL_TYPES = ['cash_receipt', 'payment_journal', 'journal_entry', 'sales_invoice'];
const PAYMENT_METHODS = new Set(['cash', 'bank', 'mobile_money', 'card', 'other']);

const DEFAULT_ACCOUNTS = [
  { code: '1100', name: 'Accounts Receivable', type: 'asset', normal: 'debit', key: 'accounts_receivable', detailType: 'Receivable' },
  { code: '1110', name: 'Cash', type: 'asset', normal: 'debit', key: 'cash', detailType: 'Cash' },
  { code: '1120', name: 'Bank', type: 'asset', normal: 'debit', key: 'bank', detailType: 'Bank' },
  { code: '1130', name: 'Mobile Money', type: 'asset', normal: 'debit', key: 'mobile_money', detailType: 'Bank' },
  { code: '1140', name: 'Card Clearing', type: 'asset', normal: 'debit', key: 'card_clearing', detailType: 'Temporary' },
  { code: '1200', name: 'Inventory', type: 'asset', normal: 'debit', key: 'inventory', detailType: 'Stock' },
  { code: '2100', name: 'Accounts Payable', type: 'liability', normal: 'credit', key: 'accounts_payable', detailType: 'Payable' },
  { code: '2200', name: 'Tax Payable', type: 'liability', normal: 'credit', key: 'tax_payable', detailType: 'Tax' },
  { code: '3000', name: 'Opening Equity', type: 'equity', normal: 'credit', key: 'opening_equity', detailType: 'Equity' },
  { code: '4000', name: 'Sales Income', type: 'income', normal: 'credit', key: 'sales_income', detailType: 'Income Account' },
  { code: '5000', name: 'Cost of Goods Sold', type: 'expense', normal: 'debit', key: 'cost_of_goods_sold', detailType: 'Cost of Goods Sold' },
  { code: '5100', name: 'Stock Adjustment Loss', type: 'expense', normal: 'debit', key: 'stock_adjustment_loss', detailType: 'Stock Adjustment' },
  { code: '4100', name: 'Stock Adjustment Gain', type: 'income', normal: 'credit', key: 'stock_adjustment_gain', detailType: 'Stock Adjustment' },
];

module.exports = { STOCK_ENTRY_TYPES, JOURNAL_TYPES, PAYMENT_METHODS, DEFAULT_ACCOUNTS };

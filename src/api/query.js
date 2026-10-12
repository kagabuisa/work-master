'use strict';
const { apiError } = require('./errors');
const { isValidIsoDate } = require('../lib/dates');

function readQuery(query, optional = [], { paged = true } = {}) {
  const allowed = [...(paged ? ['page', 'page_size', 'q'] : []), ...optional];
  if (Object.keys(query).some(key => !allowed.includes(key))
    || Object.values(query).some(value => typeof value !== 'string' || value.length > 200)) {
    throw apiError(400, 'invalid_query', 'Use documented scalar query parameters only (maximum 200 characters each).');
  }
  const page = query.page === undefined ? 1 : integer(query.page, 'page', 1000000);
  const pageSize = query.page_size === undefined ? 50 : integer(query.page_size, 'page_size', 200);
  return { ...query, page, page_size: pageSize, search: String(query.q || '').trim() };
}

function integer(value, label, max) {
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > max) {
    throw apiError(400, 'invalid_query', `${label} must be an integer between 1 and ${max}.`);
  }
  return Number(value);
}

function dates(query) {
  for (const field of ['from', 'to']) {
    if (query[field] !== undefined && !isValidIsoDate(query[field])) {
      throw apiError(400, 'invalid_query', `${field} must be a valid YYYY-MM-DD date.`);
    }
  }
  if (query.from && query.to && query.from > query.to) throw apiError(400, 'invalid_query', 'from must not follow to.');
}

function envelope(rows, pagination) {
  return { data: rows, meta: { page: pagination.page, page_size: pagination.limit, total: pagination.total } };
}
module.exports = { readQuery, dates, envelope };

'use strict';
// Pagination helpers.

function paginationOptions(options = {}, defaultLimit = 50, maxLimit = 200) {
  const requestedPage = Number(options.page || 1);
  const requestedLimit = Number(options.page_size || options.pageSize || options.limit || defaultLimit);
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? Math.floor(requestedPage) : 1;
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.floor(requestedLimit), 1), maxLimit)
    : defaultLimit;
  return {
    page,
    limit,
    offset: (page - 1) * limit,
  };
}

function paginationResult(total, pagination) {
  const normalizedTotal = Number(total || 0);
  const totalPages = Math.max(1, Math.ceil(normalizedTotal / pagination.limit));
  const start = normalizedTotal ? pagination.offset + 1 : 0;
  const end = Math.min(pagination.offset + pagination.limit, normalizedTotal);
  return {
    page: pagination.page,
    limit: pagination.limit,
    offset: pagination.offset,
    total: normalizedTotal,
    total_pages: totalPages,
    start,
    end,
  };
}

module.exports = { paginationOptions, paginationResult };

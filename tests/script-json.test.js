'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { renderView } = require('./helpers/render-view');
const { scriptJson } = require('../src/web/script-json');

test('stock entry remarks cannot close their embedded script', async () => {
  const remarks = '</script><script>window.injected=true</script>';
  const html = await renderView(path.join(__dirname, '..', 'views', 'stock-entry.ejs'), {
    assetVersion: 'test', currentUser: { role: 'admin', scopes: {} },
    can: () => true, availableReports: [], currentPostingTime: () => '12:00',
    scriptJson, today: '2026-10-04', error: null,
    entry: { entry_type: 'opening', posting_date: '2026-10-04', remarks }, items: [],
  });
  const match = html.match(/window\.STOCK_ENTRY_INITIAL = ([^\n]*);/);
  assert(match, 'stock entry initial data is embedded');
  assert.doesNotMatch(match[1], /</);
  assert.equal(JSON.parse(match[1]).entry.remarks, remarks);
  assert.doesNotMatch(html, /<script>window\.injected=true<\/script>/i);
});

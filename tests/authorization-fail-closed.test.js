const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { permissionCheck } = require('../src/authorize');

// This file guards the fail-closed authorization contract.
//
// Background: permissionCheck used to end in `return true`, so any path it did not
// recognise was permitted. Every route the app registered happened to be handled,
// so there was no live hole — but adding a route silently granted it to every
// authenticated user. These tests pin the fail-closed behaviour down.

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// Every route the app actually registers, as { method, route }.
// Routes may live inline in server.js (app.<verb>) or in a mounted router
// (src/web/routes/*.js, router.<verb>) — both are included so the classifier is
// checked against the full route table.
function registeredRoutes() {
  const routes = [];
  const appPattern = /^app\.(get|post|put|patch|delete)\('([^']+)'/gm;
  for (const match of serverSource.matchAll(appPattern)) {
    routes.push({ method: match[1].toUpperCase(), route: match[2] });
  }
  const routerMounts = { 'api.js': '/api', 'reports.js': '/reports', 'stock.js': '/stock', 'ledger.js': '', 'purchasing.js': '', 'settings.js': '', 'sales.js': '', 'hr.js': '/hr' };
  const routersDir = path.join(__dirname, '..', 'src', 'web', 'routes');
  for (const [file, prefix] of Object.entries(routerMounts)) {
    const routerPath = path.join(routersDir, file);
    if (!fs.existsSync(routerPath)) continue;
    const source = fs.readFileSync(routerPath, 'utf8');
    const routerPattern = /^router\.(get|post|put|patch|delete)\('([^']+)'/gm;
    for (const match of source.matchAll(routerPattern)) {
      routes.push({ method: match[1].toUpperCase(), route: prefix + match[2] });
    }
  }
  return routes;
}

function requestFor(route, method, user) {
  return { currentUser: user, path: route, method, body: {} };
}

const ADMIN = { role: 'admin', permissions: [] };
const STANDARD = { role: 'standard', permissions: [] };

test('authorization denies unknown and unclassified paths instead of allowing them', () => {
  // Paths with no route and no permission branch. Under the old `return true`
  // fallthrough every one of these was allowed.
  for (const route of [
    '/payroll',
    '/payroll/run',
    '/admin/backdoor',
    '/internal/debug',
    '/anything-at-all',
  ]) {
    for (const method of ['GET', 'POST']) {
      assert.equal(permissionCheck(requestFor(route, method, ADMIN)), false,
        `${method} ${route} must be denied even for an admin`);
      assert.equal(permissionCheck(requestFor(route, method, STANDARD)), false,
        `${method} ${route} must be denied for a standard user`);
    }
  }
});

test('a noisy path cannot be smuggled past a handled prefix', () => {
  // These sit under prefixes the app registers but match no explicit branch, so
  // they exercise the fallthrough rather than a prefix branch.
  const standard = { role: 'standard', permissions: ['masters.customers.view'] };
  for (const [route, method] of [
    ['/invoices/1/totally-made-up-action', 'POST'],
    ['/stock/bogus-section', 'GET'],
    ['/settings/not-a-master-list', 'GET'],
    ['/reports/not-a-report', 'GET'],
    ['/api/not-an-endpoint', 'GET'],
    ['/journals/1/bogus', 'POST'],
  ]) {
    assert.equal(permissionCheck(requestFor(route, method, standard)), false,
      `${method} ${route} must be denied`);
  }
});

test('every registered route has an explicit authorization decision', () => {
  const routes = registeredRoutes();
  assert(routes.length > 100, `expected the app's route table, found ${routes.length} routes`);

  // A route whose permissionCheck result is not a boolean means the classifier
  // returned something other than true/false; the gate would treat that as denial,
  // but it signals an unhandled branch. Fail loudly instead.
  const nonBoolean = [];
  for (const { method, route } of routes) {
    const decision = permissionCheck(requestFor(route, method, ADMIN));
    if (typeof decision !== 'boolean') nonBoolean.push(`${method} ${route} -> ${decision}`);
  }
  assert.deepEqual(nonBoolean, [], `routes without a boolean decision:\n${nonBoolean.join('\n')}`);
});

test('every registered top-level prefix is classified by the permission checker', () => {
  // The guard that prevents the original bug from coming back: if someone adds a
  // route under a new top-level prefix without adding an authorization branch, its
  // decision silently depends on the fallthrough. Detect that here.
  const prefixes = new Set();
  for (const { route } of registeredRoutes()) {
    const segment = route.split('/').filter(Boolean)[0];
    if (segment) prefixes.add(segment);
  }
  assert(prefixes.size >= 9, `expected the app's top-level prefixes, found ${prefixes.size}`);

  const authorizeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'authorize.js'), 'utf8');
  const unclassified = [...prefixes].filter((prefix) => !authorizeSource.includes(`parts[0] === '${prefix}'`));
  assert.deepEqual(unclassified, [],
    `top-level prefixes with no authorization branch: ${unclassified.join(', ')}. `
    + 'Add a branch to permissionCheck in src/authorize.js.');
});

test('admin-only areas stay admin-only and are not reachable by the fallthrough', () => {
  // Regression cover for the paths most worth protecting.
  for (const [route, method] of [
    ['/settings/users', 'GET'],
    ['/settings/roles', 'GET'],
    ['/settings/company-information', 'POST'],
    ['/settings/files', 'GET'],
  ]) {
    assert.equal(permissionCheck(requestFor(route, method, ADMIN)), true, `${method} ${route} admin allowed`);
    assert.equal(permissionCheck(requestFor(route, method, STANDARD)), false, `${method} ${route} standard denied`);
  }
});

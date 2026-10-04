'use strict';
// HTTP golden-master harness.
//
// Captures the app's route table and the response of every GET route (status,
// content-type, byte length, and a body hash with the per-boot assetVersion
// timestamp normalised away) into tests/fixtures/http-golden.json. Re-run it
// after any HTTP/router refactor and diff against the committed snapshot to prove
// route registration and responses are unchanged.
//
// Usage (the app must be running):  node scripts/http-golden.mjs

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require2 = createRequire(import.meta.url);
const fs = require2('node:fs');
const crypto = require2('node:crypto');

process.env.POSTGRES_HOST = process.env.POSTGRES_HOST || '127.0.0.1';
process.env.POSTGRES_PORT = process.env.POSTGRES_PORT || '55432';
process.env.POSTGRES_DB = process.env.POSTGRES_DB || 'work_master_golden';
process.env.POSTGRES_USER = process.env.POSTGRES_USER || 'postgres';
process.env.POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || '';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.HTTP_GOLDEN_PORT || 3099);

const store = require2('../src/store');
const auth = require2('../src/auth');

const PARAM_VALUES = {
  id: '1', list: 'items', type: 'opening', slug: 'admin', paymentId: '1',
  paymentNo: '1', value: '1', kind: 'sales',
};

function substituteParams(route) {
  return route.replace(/:([A-Za-z]+)/g, (match, name) => (name in PARAM_VALUES ? PARAM_VALUES[name] : '1'));
}

function enumerateRoutes() {
  const routes = [];
  const appPattern = /^app\.(get|post|put|patch|delete)\('([^']+)'/gm;
  const serverSource = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
  for (const match of serverSource.matchAll(appPattern)) {
    routes.push({ method: match[1].toUpperCase(), route: substituteParams(match[2]) });
  }
  const routerMounts = { 'api.js': '/api', 'reports.js': '/reports', 'stock.js': '/stock', 'ledger.js': '', 'purchasing.js': '', 'settings.js': '', 'sales.js': '' };
  const routersDir = path.join(REPO, 'src', 'web', 'routes');
  for (const [file, prefix] of Object.entries(routerMounts)) {
    const routerPath = path.join(routersDir, file);
    if (!fs.existsSync(routerPath)) continue;
    const source = fs.readFileSync(routerPath, 'utf8');
    const routerPattern = /^router\.(get|post|put|patch|delete)\('([^']+)'/gm;
    for (const match of source.matchAll(routerPattern)) {
      routes.push({ method: match[1].toUpperCase(), route: prefix + substituteParams(match[2]) });
    }
  }
  return routes;
}

function normalizeBody(body) {
  // assetVersion is Date.now() at boot, so it changes every restart. Normalise it
  // so the snapshot is stable across app restarts.
  return body
    .replace(/\?v=\d+/g, '?v=V')
    .replace(/assetVersion\s*[:=]\s*\d+/g, 'assetVersion=V')
    // currentPostingTime()/currentPostingDate() render the wall-clock into form
    // inputs AND into the window.invoiceInitial JSON blob; stored values are
    // pinned by the accounting golden master.
    .replace(/value="\d{2}:\d{2}"/g, 'value="TIME"')
    .replace(/value="\d{4}-\d{2}-\d{2}"/g, 'value="DATE"')
    .replace(/"posting_time":"\d{2}:\d{2}"/g, '"posting_time":"TIME"')
    .replace(/"invoice_date":"\d{4}-\d{2}-\d{2}"/g, '"invoice_date":"DATE"')
    // Audit timestamps (formatTimestamp(value, 'UTC')) render "YYYY-MM-DD HH:MM UTC";
    // a startup migration refreshes updated_at to now(), so it drifts across boots.
    .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/g, 'AUDIT_TIME UTC');
}

async function main() {
  // NOTE: do NOT call store.initStore()/auth.initAuth() here. The app is already
  // running and owns the schema; re-running the startup migrations would set
  // now() on rows and make the snapshot non-deterministic. We only need the pool
  // and the auth tables, which the running app has created.
  const pool = store.getPostgresPool();
  const { rows } = await pool.query("SELECT id FROM app_users WHERE username = 'golden-admin'");
  let userId;
  if (rows.length) {
    userId = rows[0].id;
  } else {
    userId = (await auth.createUser('golden-admin', 'GoldenPass123', { role: 'admin', mustChangePassword: false })).id;
  }
  const token = await auth.createSession(userId);

  const routes = enumerateRoutes();
  const responses = [];

  for (const { method, route } of routes) {
    if (method !== 'GET') continue;
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}${route}`, {
        headers: { Cookie: `wm_session=${token}` },
      });
      const body = await res.text();
      responses.push({
        method,
        route,
        status: res.status,
        type: res.headers.get('content-type') || '',
        bytes: Buffer.byteLength(body),
        hash: crypto.createHash('sha256').update(normalizeBody(body)).digest('hex'),
      });
    } catch (err) {
      responses.push({ method, route, status: 0, type: '', bytes: 0, hash: '', error: err.message });
    }
  }

  const snapshot = { routes, responses };
  const outDir = path.join(REPO, 'tests', 'fixtures');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'http-golden.json'), JSON.stringify(snapshot, null, 2));
  console.log(`captured ${routes.length} routes, ${responses.length} GET responses`);
  await store.closeStore();
  process.exit(0);
}

main().catch((err) => { console.error(err.stack || err); process.exit(1); });

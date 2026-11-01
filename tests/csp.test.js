'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

test('CSP uses a per-response script nonce and does not permit inline script', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(server, /crypto\.randomBytes\(16\)\.toString\('base64'\)/);
  assert.match(server, /script-src 'self' 'nonce-\$\{cspNonce\}'/);
  assert.doesNotMatch(server, /script-src[^;]*'unsafe-inline'/);
  assert.doesNotMatch(server, /style-src[^;]*'unsafe-inline'/);
});

test('templates have no inline event handlers and every inline script is nonceable', () => {
  const directory = path.join(root, 'views');
  const files = fs.readdirSync(directory).filter((name) => name.endsWith('.ejs'));
  for (const name of files) {
    const source = fs.readFileSync(path.join(directory, name), 'utf8');
    assert.doesNotMatch(source, /\son[a-z]+\s*=/i, `${name} contains an inline event handler`);
    for (const section of source.split(/(?=<script\b)/i).slice(1)) {
      const opening = section.slice(0, section.search(/<\/script>|\n/i));
      if (/\bsrc\s*=/.test(opening)) continue;
      assert.match(section, /\bnonce=/, `${name} contains an inline script without a nonce`);
    }
  }
});

test('shared page actions replace print, history and auto-submit handlers', () => {
  const script = fs.readFileSync(path.join(root, 'public', 'page-actions.js'), 'utf8');
  assert.match(script, /data-print-page/);
  assert.match(script, /data-history-back/);
  assert.match(script, /data-auto-submit/);
  const head = fs.readFileSync(path.join(root, 'views', 'partials-head.ejs'), 'utf8');
  assert.match(head, /src="\/page-actions\.js/);
});

test('shared page actions implement print, history and auto-submit behavior', () => {
  const source = fs.readFileSync(path.join(root, 'public', 'page-actions.js'), 'utf8');
  const listeners = {};
  let printed = 0;
  let wentBack = 0;
  let submitted = 0;
  const document = { addEventListener: (type, listener) => { listeners[type] = listener; } };
  const window = { history: { length: 2, back: () => { wentBack += 1; } }, print: () => { printed += 1; } };
  vm.runInNewContext(source, { document, window });

  let printPrevented = false;
  listeners.click({
    target: { closest: (selector) => selector === '[data-print-page]' ? {} : null },
    preventDefault: () => { printPrevented = true; },
  });
  assert.equal(printPrevented, true);
  assert.equal(printed, 1);

  let backPrevented = false;
  listeners.click({
    target: { closest: (selector) => selector === '[data-history-back]' ? {} : null },
    preventDefault: () => { backPrevented = true; },
  });
  assert.equal(backPrevented, true);
  assert.equal(wentBack, 1);

  listeners.change({
    target: {
      matches: (selector) => selector === '[data-auto-submit]',
      form: { requestSubmit: () => { submitted += 1; } },
    },
  });
  assert.equal(submitted, 1);
});

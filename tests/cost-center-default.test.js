const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'cost-center-field.js'), 'utf8');

async function form({ choices, preferred = '', existing = '' }) {
  const listeners = new Map();
  const input = {
    value: existing,
    dataset: { defaultCostCenter: preferred },
    readOnly: false,
    disabled: false,
    getAttribute: () => 'voucher-cost-centers',
    addEventListener: (name, listener) => listeners.set(name, listener),
    dispatchEvent: () => {},
  };
  const options = [];
  const list = {
    replaceChildren: () => { options.length = 0; },
    appendChild: (option) => options.push(option),
  };
  vm.runInNewContext(script, {
    document: {
      querySelector: () => input,
      getElementById: () => list,
      createElement: () => ({}),
    },
    fetch: async () => ({ ok: true, json: async () => choices }),
    Event: class {},
    setTimeout,
    clearTimeout,
    encodeURIComponent,
  });
  await new Promise(setImmediate);
  return { input, options, listeners };
}

test('voucher cost center defaults to the assigned permitted choice', async () => {
  const page = await form({ preferred: 'Warehouse', choices: [
    { cost_center: 'Office', cost_center_name: 'Office' },
    { cost_center: 'Warehouse', cost_center_name: 'Warehouse' },
  ] });
  assert.equal(page.input.value, 'Warehouse');
  assert.deepEqual(page.options.map((option) => option.value), ['Office', 'Warehouse']);
});

test('voucher cost center defaults when exactly one permitted choice exists', async () => {
  const page = await form({ choices: [{ cost_center: 'Main', cost_center_name: 'Main' }] });
  assert.equal(page.input.value, 'Main');
});

test('voucher cost center preserves saved and manually entered values', async () => {
  const saved = await form({ existing: 'Saved', choices: [{ cost_center: 'Main' }] });
  assert.equal(saved.input.value, 'Saved');
  const edited = await form({ choices: [{ cost_center: 'Main' }] });
  edited.input.value = 'Manual';
  edited.listeners.get('input')();
  await new Promise(setImmediate);
  assert.equal(edited.input.value, 'Manual');
});

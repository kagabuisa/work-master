const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'voucher-shortcut.js'), 'utf8');

function shortcutPage({ externalSave = false, disabled = false, secondForm = false, preventEnter = false } = {}) {
  let handler;
  const submissions = [];
  const form = {
    inert: false,
    hasAttribute: (name) => name === 'data-prevent-enter-submit' && preventEnter,
    closest: (selector) => selector === '[inert]' && form.inert ? form : null,
    requestSubmit: (button) => submissions.push(button),
  };
  const save = { form, disabled, value: 'save_draft' };
  const submit = { form, disabled: false, value: 'submit' };
  const forms = secondForm ? [form, {}] : [form];
  class Element {
    constructor({ insideForm = !externalSave, dialog = false, tag = 'input' } = {}) {
      this.insideForm = insideForm;
      this.dialog = dialog;
      this.tag = tag;
    }
    matches(selector) { return selector === this.tag; }
    closest(selector) {
      if (selector === 'form[data-voucher-form]') return this.insideForm ? form : null;
      if (selector.includes('dialog')) return this.dialog ? this : null;
      return null;
    }
  }
  const document = {
    addEventListener: (name, callback) => { if (name === 'keydown') handler = callback; },
    querySelectorAll: (selector) => selector === 'form[data-voucher-form]' ? forms
      : selector === '[data-voucher-save]' ? [save] : [],
  };
  vm.runInNewContext(script, { document, Element });
  return {
    form, save, submit, submissions, Element,
    press: (options = {}) => {
      let prevented = false;
      handler({ key: 's', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false,
        repeat: false, target: new Element(), preventDefault: () => { prevented = true; }, ...options });
      return prevented;
    },
  };
}

test('Ctrl+S and Command+S use the voucher Save action, including an external Save button', () => {
  for (const externalSave of [false, true]) {
    const page = shortcutPage({ externalSave });
    assert.equal(page.press(), true);
    assert.equal(page.press({ ctrlKey: false, metaKey: true }), true);
    assert.deepEqual(page.submissions, [page.save, page.save]);
  }
});

test('shortcut leaves read-only, dialog, repeated, and unrelated keys alone', () => {
  const page = shortcutPage({ disabled: true });
  assert.equal(page.press(), false);
  page.save.disabled = false;
  assert.equal(page.press({ target: new page.Element({ dialog: true }) }), false);
  assert.equal(page.press({ repeat: true }), false);
  assert.equal(page.press({ key: 'p' }), false);
  page.form.inert = true;
  assert.equal(page.press(), false);
  assert.equal(page.submissions.length, 0);
});

test('shortcut does not choose between multiple voucher forms without a focused form', () => {
  const page = shortcutPage({ externalSave: true, secondForm: true });
  assert.equal(page.press(), false);
  assert.equal(page.submissions.length, 0);
});


test('purchase order Enter cannot save from inputs while Ctrl+S still saves', () => {
  const page = shortcutPage({ preventEnter: true });
  assert.equal(page.press({ key: 'Enter', ctrlKey: false }), true);
  assert.equal(page.press({ key: 'Enter', ctrlKey: true }), true);
  assert.equal(page.submissions.length, 0);
  assert.equal(page.press(), true);
  assert.deepEqual(page.submissions, [page.save]);
});

test('Enter guard preserves remarks, button activation, composition and other voucher forms', () => {
  const page = shortcutPage({ preventEnter: true });
  for (const tag of ['textarea', 'button', 'select']) {
    assert.equal(page.press({ key: 'Enter', ctrlKey: false, target: new page.Element({ tag }) }), false);
  }
  assert.equal(page.press({ key: 'Enter', ctrlKey: false, isComposing: true }), false);
  assert.equal(shortcutPage().press({ key: 'Enter', ctrlKey: false }), false);
  assert.equal(page.submissions.length, 0);
});

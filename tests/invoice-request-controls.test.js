'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function browser(state='draft') {
 const events={},nodes={},dialogEvents={};let dialog;
 const node=(value='')=>({value,checked:false,disabled:false,hidden:false,attrs:{},listeners:{},setAttribute(k,v){this.attrs[k]=v;},hasAttribute(k){return k in this.attrs;},addEventListener(k,f){this.listeners[k]=f;},dispatchEvent(){},focus(){},setCustomValidity(v){this.error=v;},reportValidity(){return true;}});
 for(const selector of ['[name="action_request"]','[name="why_cancel"]','[name="requested_posting_date"]','[data-request-backdate]','[data-request-cancel]','[data-request-clear]','[data-request-summary]','[data-request-save]'])nodes[selector]=node();
 nodes['[name="requested_posting_date"]'].value='2026-10-30';
 const invoiceDate=node('2026-10-30');
 const form={querySelector:selector=>selector==='[name="invoice_date"]'?invoiceDate:selector==='[data-request-save]'?nodes[selector]:null};
 const root={dataset:{documentState:state,today:'2026-10-30',dateEditable:'1'},querySelector:s=>nodes[s],closest:()=>form};
 for(const selector of ['[data-request-backdate]','[data-request-cancel]','[data-request-clear]']) {
  const control=nodes[selector];control.attrs[selector.slice(1,-1)]='';control.closest=s=>s==='[data-invoice-request-controls]'?root:control;control.matches=s=>s.split(',').includes(selector);
 }
 const document={addEventListener:(type,fn)=>events[type]=fn,body:{appendChild(){}},createElement:()=>{
  const fields={};for(const s of ['form','[data-request-date-label]','[data-request-date]','[data-request-reason]','[data-request-reason-label]','#invoice-request-dialog-title'])fields[s]=node();
  dialog={open:false,setAttribute(){},querySelector:s=>fields[s],querySelectorAll:()=>[],addEventListener:(k,f)=>dialogEvents[k]=f,showModal(){this.open=true;},close(){this.open=false;},fields};return dialog;
 }};
 vm.runInNewContext(fs.readFileSync('public/invoice-request-controls.js','utf8'),{document,Event:class{constructor(type){this.type=type;}}});
 return {nodes,invoiceDate,dialog:()=>dialog,click:s=>events.click({target:nodes[s]}),check(value,selector='[data-request-cancel]'){nodes[selector].checked=value;events.change({target:nodes[selector]});},apply(){dialog.fields.form.listeners.submit({preventDefault(){}});},escape(){dialogEvents.cancel({preventDefault(){}});}};
}
test('Backdate opens date popup and applies date/request/reason while disabling Cancel',()=>{
 const b=browser();b.check(true,'[data-request-backdate]');assert.equal(b.dialog().open,true);assert.equal(b.nodes['[data-request-cancel]'].disabled,true);
 b.dialog().fields['[data-request-date]'].value='2026-10-20';b.dialog().fields['[data-request-reason]'].value='Late documents';b.apply();
 assert.equal(b.invoiceDate.value,'2026-10-20');assert.equal(b.nodes['[name="action_request"]'].value,'Backdate');assert.equal(b.nodes['[name="why_cancel"]'].value,'Late documents');assert.equal(b.nodes['[data-request-save]'].disabled,false);assert.equal(b.dialog().open,false);
 b.check(false,'[data-request-backdate]');assert.equal(b.nodes['[name="action_request"]'].value,'');assert.equal(b.nodes['[data-request-save]'].disabled,true);
});
test('Cancel requires a reason, disables Backdate, and unchecking clears the request',()=>{
 const b=browser('submitted');b.check(true);assert.equal(b.dialog().open,true);assert.equal(b.nodes['[data-request-backdate]'].disabled,true);assert.equal(b.dialog().fields['[data-request-date]'].disabled,true);
 b.dialog().fields['[data-request-reason]'].value='  ';b.apply();assert.equal(b.dialog().open,true);assert.equal(b.nodes['[name="action_request"]'].value,'');
 b.dialog().fields['[data-request-reason]'].value='Wrong customer';b.apply();assert.equal(b.nodes['[name="action_request"]'].value,'Cancel');assert.equal(b.nodes['[data-request-cancel]'].checked,true);
 b.check(false);assert.equal(b.nodes['[name="action_request"]'].value,'');assert.equal(b.nodes['[name="why_cancel"]'].value,'');
});
test('dismissing a cancellation popup restores selection without changing saved values',()=>{
 const b=browser('submitted');b.check(true);b.dialog().fields['[data-request-reason]'].value='Not applied';b.escape();
 assert.equal(b.nodes['[data-request-cancel]'].checked,false);assert.equal(b.nodes['[name="why_cancel"]'].value,'');assert.equal(b.dialog().open,false);
});
test('dismissing the Backdate checkbox popup restores the date and unchecked state',()=>{
 const b=browser();b.check(true,'[data-request-backdate]');assert.equal(b.nodes['[data-request-backdate]'].checked,true);
 b.dialog().fields['[data-request-date]'].value='2026-10-20';b.escape();
 assert.equal(b.nodes['[data-request-backdate]'].checked,false);assert.equal(b.invoiceDate.value,'2026-10-30');assert.equal(b.nodes['[name="action_request"]'].value,'');
});

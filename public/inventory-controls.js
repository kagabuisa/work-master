(() => {
  const forms=[...document.querySelectorAll('#invoice-form, #stock-entry-form, #purchase-form, #reconciliation-form')];
  if(!forms.length)return;
  async function refresh(){
    try{
      const response=await fetch('/api/inventory-controls',{cache:'no-store'});
      if(!response.ok)throw new Error('Inventory controls unavailable');
      const state=await response.json();window.inventoryControlState=state;
      if(!state.enabled)return;
      for(const form of forms){
        let note=form.querySelector('[data-inventory-control-note]');
        if(!note){note=document.createElement('p');note.className='field-hint';note.dataset.inventoryControlNote='';note.setAttribute('role','status');form.prepend(note);}
        const names=[...form.querySelectorAll('[name="warehouse"], [name="target_warehouse"]')].map(input=>input.value.trim()).filter(Boolean);
        const warehouses=state.warehouses.filter(w=>names.includes(w.warehouse));
        const frozen=warehouses.filter(w=>w.active_count);
        note.textContent=`Inventory movements receive server date/time on submission. ${form.id==='invoice-form'?'The selected posting date applies to invoice accounting; physical inventory uses its separate server timestamp.':'Entered dates are document dates.'} Stock previews show the current posted balance. Submission also checks selected-date availability and warehouse reconciliation cut-offs. ${frozen.length?`Posting is frozen: ${frozen.map(w=>`${w.warehouse} (count ${w.active_count})`).join(', ')}.`:warehouses.filter(w=>w.closed_through).map(w=>`${w.warehouse} is closed through ${new Date(w.closed_through).toLocaleString('en-GB',{timeZone:'Africa/Kampala'})} Kampala.`).join(' ')}`;
        const heading=form.querySelector('#invoice-items thead th:nth-child(3)');
        if(heading){if(heading.firstChild?.nodeType===3)heading.firstChild.textContent='Current stock preview ';const help=heading.querySelector('.ui-help p');if(help)help.textContent='Current posted warehouse stock. Final inventory time is assigned by the server at submission; document dates do not backdate stock.';}
        for(const input of form.querySelectorAll('[name="invoice_date"],[name="posting_date"],[name="posting_time"]')){
          const label=input.closest('label');const text=label&&[...label.childNodes].find(node=>node.nodeType===3&&node.textContent.trim());if(text)text.textContent=form.id==='invoice-form'?(input.name==='posting_time'?'Posting Time':'Posting Date'):(input.name==='posting_time'?'Document time (inventory time is assigned on submission)':'Document date');
        }
      }
      document.dispatchEvent(new Event('inventory-control-ready'));
    }catch{
      // Submission remains protected by the database even if preview metadata cannot load.
      for(const form of forms){let note=form.querySelector('[data-inventory-control-note]');if(!note){note=document.createElement('p');note.className='field-hint';note.dataset.inventoryControlNote='';form.prepend(note);}note.textContent='Inventory control status is unavailable. Submission will recheck warehouse restrictions.';}
    }
  }
  for(const form of forms)form.addEventListener('change',event=>{if(event.target.matches('[name="warehouse"], [name="target_warehouse"]'))refresh();});
  window.addEventListener('focus',refresh);refresh();
})();

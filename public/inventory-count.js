(() => {
  const form = document.querySelector('#inventory-count-form');
  if(!form)return;
  const dashboard=document.querySelector('#count-effect-dashboard');
  function refreshEffects(){
    const lines=[...form.querySelectorAll('#count-item-rows tr')].map(row=>{
      const line={book_qty:row.dataset.bookQty,book_rate:row.dataset.bookRate,counted_qty:row.querySelector('[name="counted_qty"]').value,valuation_rate:row.querySelector('[name="valuation_rate"]').value};
      const effect=CountEffects.lineEffect(line);
      const qty=row.querySelector('[data-line-effect="quantity"]'),value=row.querySelector('[data-line-effect="value"]');
      if(qty)qty.textContent=effect.counted?CountEffects.formatQuantity(effect.quantity):'Not counted';
      if(value)value.textContent=!effect.counted?'Not counted':effect.value===null?'Rate required':CountEffects.formatAmount(effect.value);
      return line;
    });
    const summary=CountEffects.summarize(lines);
    dashboard.querySelectorAll('[data-count-effect]').forEach(element=>{
      const key=element.dataset.countEffect;
      element.textContent=key.startsWith('qty')?CountEffects.formatQuantity(summary[key]):CountEffects.formatAmount(summary[key]);
    });
    dashboard.querySelector('[data-count-progress]').textContent=`${summary.counted} / ${summary.total} counted${summary.pending?` · ${summary.pending} pending`:''}${summary.valuationPending?` · ${summary.valuationPending} rates needed`:''} · ${summary.pending||summary.valuationPending?'Partial preview':'Preview'}`;
  }
  form.addEventListener('input',event=>{if(['counted_qty','valuation_rate'].includes(event.target.name))refreshEffects();});
  refreshEffects();
  const foundForm = document.querySelector('#found-item-form');
  const input = foundForm?.querySelector('[name="found_item"]');
  if (!input) return;
  const options = foundForm.querySelector('#found-item-options');
  const rate = foundForm.querySelector('[name="found_rate"]');
  const status = foundForm.querySelector('#found-item-status');
  let items = new Map();
  let controller;
  let timer;
  let version = 0;
  function selectKnown() {
    const item = items.get(input.value.trim());
    if (!item) return false;
    rate.value = Number(item.valuation_rate) > 0 ? String(Math.round(Number(item.valuation_rate))) : '';
    status.textContent = Number(item.valuation_rate) > 0
      ? 'System valuation rate loaded. Review before saving.'
      : 'No positive system valuation rate is available. Enter the reviewed valuation rate.';
    return true;
  }
  async function lookup(query, token) {
    controller = new AbortController();
    try {
      const response = await fetch(`${form.dataset.itemLookup}?q=${encodeURIComponent(query)}`, {signal: controller.signal, cache:'no-store'});
      if (!response.ok) throw new Error('lookup');
      const rows = await response.json();
      if (token !== version) return;
      items = new Map(rows.map(item => [item.item_code,item]));
      options.replaceChildren(...rows.map(item => {
        const option = document.createElement('option');
        option.value = item.item_code;
        option.label = item.item_name || item.item_code;
        return option;
      }));
      if (!selectKnown()) status.textContent = rows.length ? 'Choose an item code from the suggestions.' : 'No matching active item found.';
    } catch (error) {
      if (error.name !== 'AbortError' && token === version) status.textContent = 'Could not load items or valuation rates. Search again.';
    }
  }
  input.addEventListener('input', () => {
    clearTimeout(timer);
    controller?.abort();
    const token = ++version;
    rate.value = '';
    status.textContent = '';
    if (selectKnown()) return;
    const query = input.value.trim();
    if (!query) { items.clear(); options.replaceChildren(); return; }
    timer = setTimeout(() => lookup(query,token),200);
  });
  input.addEventListener('change',selectKnown);
  let adding = false;
  foundForm.addEventListener('keydown',event=>{
    if(event.key==='Enter' && event.target.matches('input') && !event.isComposing) event.preventDefault();
  });
  form.addEventListener('submit',event=>{if(adding)event.preventDefault();});
  foundForm.addEventListener('submit',async event=>{
    event.preventDefault();
    if(adding)return;
    const body = new URLSearchParams(new FormData(foundForm));
    if(!body.get('found_item')?.trim() || !(Number(body.get('found_quantity'))>0) || !(Number(body.get('found_rate'))>0) || (body.get('found_reason')||'').trim().length<3){
      status.textContent='Choose an item, enter a positive quantity and valuation rate, and explain the found stock.';
      return;
    }
    clearTimeout(timer);controller?.abort();++version;
    adding=true;
    const buttons=[...document.querySelectorAll('main button[type="submit"]')].filter(button=>!button.disabled);
    buttons.forEach(button=>{button.disabled=true;});
    const fields=[...foundForm.querySelectorAll('input')].filter(field=>!field.disabled);
    fields.forEach(field=>{field.disabled=true;});
    status.textContent='Adding found item…';
    try{
      const response=await fetch(foundForm.action,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body});
      const data=await response.json();
      if(!response.ok)throw new Error(data.error||'Could not add the item.');
      const line=data.line;
      const row=document.createElement('tr');
      row.dataset.bookQty=line.book_qty;row.dataset.bookRate=line.book_rate;
      const cell=text=>{const td=document.createElement('td');td.textContent=String(text);row.appendChild(td);return td;};
      const field=(td,name,value,type,label)=>{const element=document.createElement('input');element.name=name;element.value=value;element.type=type;if(type!=='hidden'){element.setAttribute('aria-label',`${label} for ${line.item_code}`);if(type==='number'){element.min='0';element.step=name==='counted_qty'?'0.001':'1';}}td.appendChild(element);};
      field(cell(line.item_code),'item_code',line.item_code,'hidden');
      cell(line.book_qty);cell(line.book_value);
      field(cell(''),'counted_qty',line.counted_qty,'number','Physical quantity');
      field(cell(''),'valuation_rate',line.valuation_rate,'number','Gain valuation rate');
      const difference=Number(line.counted_qty)-Number(line.book_qty);
      cell(difference).dataset.lineEffect='quantity';cell(Math.round(difference*Number(line.valuation_rate))).dataset.lineEffect='value';
      field(cell(''),'explanation',line.explanation,'text','Explanation');
      form.querySelector('#count-item-rows').appendChild(row);
      refreshEffects();
      document.querySelectorAll('input[name="revision"]').forEach(element=>{element.value=data.revision;});
      document.querySelectorAll('[data-count-revision]').forEach(element=>{element.textContent=data.revision;});
      foundForm.reset();
      foundForm.querySelector('[name="revision"]').value=data.revision;
      items.clear();options.replaceChildren();
      status.textContent='Found item added. Other count edits remain unsaved; use Save count revision or Ctrl+S to save them.';
      input.focus();
    }catch(error){status.textContent=error.message||'Could not add the item. Your entries have been kept.';}
    finally{adding=false;buttons.forEach(button=>{button.disabled=false;});fields.forEach(field=>{field.disabled=false;});input.focus();}
  });
})();

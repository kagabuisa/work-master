(() => {
  let busy=false,stop=false,progress=null,activePhoto=null;
  const report=()=>document.querySelector('[data-photo-count-report]');
  function status(text,tone='info'){
    const panel=report().querySelector('[data-photo-feedback]');panel.hidden=false;panel.dataset.tone=tone;
    panel.querySelector('[data-photo-bulk-status]').textContent=text;
  }
  function summary(){
    let unsaved=0;
    report().querySelectorAll('[data-verified-form]').forEach(form=>{
      const input=form.elements.namedItem('verified_qty');
      const changed=input.value!==input.dataset.savedValue||form.dataset.reviewRequired==='true';
      if(changed)unsaved++;
      form.querySelector('[data-row-save-status]').textContent=changed?'Review & save':input.value===''?'Not saved':'Saved';
    });
    const counter=report().querySelector('[data-photo-unsaved]');if(counter)counter.textContent=unsaved;
    const save=report().querySelector('[data-save-all]');if(save&&!busy)save.disabled=unsaved===0;
  }
  function lock(){
    const root=report();root.setAttribute('aria-busy',String(busy));
    root.querySelectorAll('button,input,textarea').forEach(control=>{
      if(control.matches('[data-stop-counting]'))return;
      if(busy){if(!control.hasAttribute('data-bulk-disabled'))control.dataset.bulkDisabled=String(control.disabled);control.disabled=true;}
      else if(control.hasAttribute('data-bulk-disabled')){control.disabled=control.dataset.bulkDisabled==='true';delete control.dataset.bulkDisabled;}
    });
    root.querySelector('[data-stop-counting]')?.toggleAttribute('hidden',!busy||!root.dataset.counting);
    const meter=root.querySelector('[data-photo-progress]');meter.hidden=!progress;
    if(progress){meter.max=progress.total;meter.value=progress.done;}
    root.querySelectorAll('[data-photo-row]').forEach(row=>row.toggleAttribute('data-counting',busy&&row.dataset.photoId===activePhoto));
    const count=root.querySelector('[data-count-all]');if(count)count.textContent=busy&&root.dataset.counting?'Counting…':'Count all photos';
    summary();
  }
  async function post(body){
    const response=await fetch(report().dataset.endpoint,{method:'POST',body,headers:{Accept:'application/json'}});
    if(!response.headers.get('content-type')?.includes('application/json'))throw new Error('Your session may have expired. Reload the report before continuing.');
    const data=await response.json();
    if(!response.ok)throw Object.assign(new Error(data.error||'The request could not complete.'),{status:response.status,retryAfter:data.retryAfter});
    return data;
  }
  async function refresh(revision,preserveEdits=true){
    const edits=new Map();const scroll={x:window.scrollX,y:window.scrollY,table:report().querySelector('.ui-table-scroll').scrollLeft};
    if(preserveEdits)report().querySelectorAll('[data-verified-form]').forEach(form=>{
      const input=form.elements.namedItem('verified_qty');if(input.dataset.edited)edits.set(form.elements.namedItem('photo_id').value,input.value);
    });
    const response=await fetch(report().dataset.endpoint,{headers:{Accept:'text/html'},cache:'no-store'});
    if(!response.ok)throw new Error('Could not reload the report. Reload before continuing.');
    const next=new DOMParser().parseFromString(await response.text(),'text/html').querySelector('[data-photo-count-report]');
    if(!next)throw new Error('Your session may have expired. Reload the report before continuing.');
    if(String(revision??'')!==next.dataset.revision)throw new Error('This count has changed in another session. Reload before continuing.');
    next.dataset.counting=report().dataset.counting||'';
    next.querySelectorAll('[data-verified-form]').forEach(form=>{
      const id=form.elements.namedItem('photo_id').value;
      if(edits.has(id)){const input=form.elements.namedItem('verified_qty');input.value=edits.get(id);input.dataset.edited='true';}
    });
    report().replaceWith(next);initialise(next);lock();next.querySelector('.ui-table-scroll').scrollLeft=scroll.table;window.scrollTo(scroll.x,scroll.y);
  }
  async function runForm(form){
    if(busy||!form.reportValidity())return;
    const body=new FormData(form),action=body.get('action')||'save';
    const photo=body.get('photo_id');busy=true;progress=null;activePhoto=photo;lock();
    status(action==='upload_photo'?`Uploading ${photo}…`:action==='remove_photo'?`Removing photo for ${photo}…`:action==='save'?`Saving ${photo}…`:`Counting ${photo}…`);
    try{
      const result=await post(body);
      report().dataset.revision=String(result.revision??'');
      report().querySelectorAll('input[name="revision"]').forEach(input=>{input.value=result.revision??'';});
      if(action==='save')delete form.elements.namedItem('verified_qty').dataset.edited;
      await refresh(result.revision);
      status(action==='upload_photo'?'Photo uploaded.':action==='remove_photo'?'Photo removed.':action==='save'?'Quantity saved.':'Photo analysed. Review the quantity or answer the question shown.','success');
    }catch(error){status(error.message+(error.retryAfter?` Retry in ${error.retryAfter}s.`:''),'error');}
    finally{
      busy=false;activePhoto=null;lock();
      const row=Array.from(report().querySelectorAll('[data-photo-row]')).find(row=>row.dataset.photoId===photo);
      const selector=action==='save'?'[data-verified-form] input[name="verified_qty"]':action==='upload_photo'||action==='remove_photo'?'[data-photo-upload-form] input[type="file"]':'[data-ai-clarify-form] textarea, [data-ai-count-form]:not([hidden]) button';
      row?.querySelector(selector)?.focus({preventScroll:true});
    }
  }
  function initialise(root){
    root.querySelectorAll('[data-count-all],[data-save-all]').forEach(button=>{button.hidden=false;});
    root.querySelectorAll('[data-photo-upload-form]').forEach(form=>{
      const input=form.elements.namedItem('photos');
      input.addEventListener('change',()=>{
        input.setCustomValidity('');if(input.files?.length!==1)return;
        const file=input.files[0];
        if(file.size>10*1024*1024)input.setCustomValidity('Choose one photo no larger than 10 MB.');
        else if(!/\.(jpe?g|png)$/i.test(file.name))input.setCustomValidity('Choose a JPG or PNG photo.');
        if(form.reportValidity())form.requestSubmit();
      });
    });
    root.querySelectorAll('[data-photo-upload-form],[data-photo-remove-form],[data-ai-count-form],[data-ai-clarify-form],[data-verified-form]').forEach(form=>{
      form.addEventListener('submit',event=>{event.preventDefault();runForm(form);});
    });
    summary();
  }
  document.addEventListener('input',event=>{
    if(event.target.matches('[data-verified-form] input[name="verified_qty"]')){event.target.dataset.edited='true';summary();}
  });
  document.addEventListener('submit',event=>{if(busy)event.preventDefault();},true);
  window.addEventListener('beforeunload',event=>{if(busy){event.preventDefault();event.returnValue='';}});
  document.addEventListener('click',async event=>{
    const button=event.target.closest('[data-count-all],[data-save-all],[data-stop-counting]');if(!button)return;
    if(button.matches('[data-stop-counting]')){stop=true;status('Stopping after the current photo…');return;}
    if(busy)return;
    if(button.matches('[data-save-all]')){
      const forms=Array.from(report().querySelectorAll('[data-verified-form]'));if(forms.some(form=>!form.reportValidity()))return;
      const rows=forms.map(form=>({photo_id:form.elements.namedItem('photo_id').value,verified_qty:form.elements.namedItem('verified_qty').value,
        ...(form.elements.namedItem('review_ai_id')?{review_ai_id:form.elements.namedItem('review_ai_id').value}:{})}));
      busy=true;progress=null;lock();status('Saving all quantities…');
      try{
        const body=new FormData();body.set('action','save_all');body.set('rows',JSON.stringify(rows));body.set('revision',report().dataset.revision);
        const result=await post(body);report().dataset.revision=String(result.revision??'');
        report().querySelectorAll('input[name="revision"]').forEach(input=>{input.value=result.revision??'';});
        report().querySelectorAll('[data-edited]').forEach(input=>{delete input.dataset.edited;});
        await refresh(result.revision,false);status(`Saved all ${result.saved} verified quantity rows.`,'success');
      }catch(error){status(error.message,'error');}
      finally{busy=false;lock();}
      return;
    }
    const photos=Array.from(report().querySelectorAll('[data-ai-count-form]')).map(form=>({photo_id:form.elements.namedItem('photo_id').value,photo_ids:form.elements.namedItem('photo_ids').value})).filter(row=>row.photo_ids);
    if(!photos.length){status('Upload a photo before counting.');return;}
    busy=true;stop=false;progress={done:0,total:photos.length};report().dataset.counting='true';lock();
    let completed=0;const failures=[];
    try{
      for(const photo of photos){
        if(stop)break;
        activePhoto=photo.photo_id;lock();let retries=0;
        while(!stop){
          status(`Counting ${completed+failures.length+1} of ${photos.length} · ${photo.photo_id}`);
          const body=new FormData();body.set('action','ai_count');body.set('photo_id',photo.photo_id);body.set('photo_ids',photo.photo_ids);body.set('revision',report().dataset.revision);
          let result;
          try{result=await post(body);}catch(error){
            if(error.status===429&&retries++<3){
              const seconds=Math.max(1,Number(error.retryAfter)||Math.min(30,2**retries));
              for(let remaining=seconds;remaining>0&&!stop;remaining--){status(`Rate limited · retrying ${photo.photo_id} in ${remaining}s. ${completed} of ${photos.length} analysed.`);await new Promise(resolve=>setTimeout(resolve,1000));}
              continue;
            }
            if(!error.status||[401,403,409,503].includes(error.status))throw error;
            failures.push(`${photo.photo_id}: ${error.message}`);progress.done++;lock();break;
          }
          completed++;progress.done++;await refresh(result.revision);break;
        }
      }
      status(`${stop?'Stopped. ':''}Counted ${completed} of ${photos.length} photos. Review quantities and any questions, then Save all.${failures.length?' Failed: '+failures.join(' · '):''}`,failures.length?'error':'success');
    }catch(error){status(`Counted ${completed} of ${photos.length} photos. ${error.message}`,'error');}
    finally{busy=false;activePhoto=null;delete report().dataset.counting;lock();}
  });
  initialise(document);
})();

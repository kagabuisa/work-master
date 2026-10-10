'use strict';
for(const button of document.querySelectorAll('[data-hr-add]')) {
  button.addEventListener('click',()=>{
    const body=button.previousElementSibling.querySelector('tbody');
    const row=body.querySelector('tr').cloneNode(true);
    const index=Number(body.dataset.nextIndex||body.children.length);body.dataset.nextIndex=String(index+1);
    for(const input of row.querySelectorAll('input,select')) {
      input.name=input.name.replace(/components\[\d+\]/,`components[${index}]`);
      if(input.type==='checkbox')input.checked=false;
      else if(input.tagName==='SELECT')input.selectedIndex=0;
      else input.value=input.type==='number'?'0':'';
    }
    body.appendChild(row);row.querySelector('input').focus();
  });
}
document.addEventListener('click',event=>{
  const button=event.target.closest('[data-hr-remove]');
  if(button){const body=button.closest('tbody');if(body.children.length>1){body.dataset.nextIndex||=String(body.children.length);button.closest('tr').remove();}}
  if(event.target.closest('[data-hr-print]'))window.print();
});
for(const search of document.querySelectorAll('[data-hr-search]'))search.addEventListener('input',()=>{
  const query=search.value.trim().toLowerCase();
  for(const row of document.querySelectorAll('[data-hr-filter] tbody tr'))row.hidden=!row.textContent.toLowerCase().includes(query);
});

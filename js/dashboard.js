'use strict';
// Intentionally synthetic samples. No visitor data, remote requests or real outcomes.
const demoPeriods={q1:[['Jan',110,92],['Fev',120,108],['Mar',130,118]],q2:[['Abr',140,128],['Mai',155,139],['Jun',160,151]],q3:[['Jul',170,158],['Ago',165,155],['Set',180,172]]};
const demoSelect=document.getElementById('dashboard-period');
const demoBars=document.getElementById('demo-bars');
function updateDashboard(){
 const rows=demoPeriods[demoSelect.value];
 const received=rows.reduce((n,r)=>n+r[1],0),completed=rows.reduce((n,r)=>n+r[2],0);
 document.getElementById('metric-received').textContent=received.toLocaleString('pt-BR');
 document.getElementById('metric-completed').textContent=completed.toLocaleString('pt-BR');
 document.getElementById('metric-rate').textContent=(completed/received*100).toLocaleString('pt-BR',{minimumFractionDigits:1,maximumFractionDigits:1})+'%';
 document.getElementById('insight-title').textContent=(received-completed)+' demandas de diferença.';
 const max=200;
 if(!demoBars.children.length)rows.forEach(()=>{const group=document.createElement('div');group.className='bar-group';for(let i=0;i<2;i++){const bar=document.createElement('div');bar.className='demo-bar'+(i?' completed':'');bar.append(document.createElement('span'));group.append(bar);}group.append(document.createElement('small'));demoBars.append(group);});
 [...demoBars.children].forEach((group,i)=>{[...group.querySelectorAll('.demo-bar')].forEach((bar,j)=>{bar.style.setProperty('--h',rows[i][j+1]/max*90+'%');bar.firstChild.textContent=rows[i][j+1];});group.querySelector('small').textContent=rows[i][0];});
 document.getElementById('demo-table').replaceChildren(...rows.map(row=>{const tr=document.createElement('tr');row.forEach((value,i)=>{const cell=document.createElement(i?'td':'th');if(!i)cell.scope='row';cell.textContent=value;tr.append(cell);});return tr;}));
}
demoSelect.addEventListener('change',updateDashboard);updateDashboard();
const mockupDialog=document.getElementById('mockup-dialog');let mockupOpener;
function openMockup(card){mockupOpener=card;document.getElementById('mockup-title').textContent=card.dataset.title;const img=document.getElementById('mockup-image');img.src=card.getAttribute('href');img.alt=card.querySelector('img').alt;mockupDialog.showModal();}
document.getElementById('mockup-close').addEventListener('click',()=>mockupDialog.close());
mockupDialog.addEventListener('close',()=>mockupOpener?.focus({preventScroll:true}));
mockupDialog.addEventListener('click',event=>{if(event.target===mockupDialog){const b=mockupDialog.getBoundingClientRect();if(event.clientX<b.left||event.clientX>b.right||event.clientY<b.top||event.clientY>b.bottom)mockupDialog.close();}});

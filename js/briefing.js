'use strict';
const briefingReview=document.getElementById('briefing-review');
const briefingSummary=document.getElementById('briefing-summary');
const briefingActionStatus=document.getElementById('briefing-action-status');
let currentBriefingText='';
function resetBriefing(){
 briefingReview.hidden=true;currentBriefingText='';
 document.getElementById('brief-step-2').classList.remove('is-current');
 document.getElementById('form-status').replaceChildren();
 briefingActionStatus.textContent='';
 if(briefingUrl){URL.revokeObjectURL(briefingUrl);briefingUrl=undefined;}
 document.getElementById('briefing-download').removeAttribute('href');
 document.getElementById('briefing-whatsapp').removeAttribute('href');
}
form.addEventListener('input',resetBriefing);
form.addEventListener('change',resetBriefing);
document.querySelectorAll('[data-interest]').forEach(link=>link.addEventListener('click',resetBriefing));
form.addEventListener('submit',event=>{
 event.preventDefault();
 if(!form.reportValidity())return;
 const values=Object.fromEntries([...new FormData(form)].map(([k,v])=>[k,String(v).trim()]));
 if(!values.nome||!values.empresa||values.desafio.length<20){document.getElementById('form-status').textContent='Preencha nome, empresa e um desafio com pelo menos 20 caracteres, além dos espaços.';return;}
 const fields=[['Nome',values.nome],['E-mail',values.email],['Empresa',values.empresa],['Área de interesse',values.interesse],['Desafio e cenário atual',values.desafio],['Resultado esperado',values.objetivo||'A alinhar na conversa'],['Momento',values.momento||'A alinhar na conversa'],['Prazo desejado',values.prazo||'Ainda não definido']];
 if(values.cargo)fields.splice(3,0,['Função',values.cargo]);
 briefingSummary.replaceChildren(...fields.map(([label,value])=>{const row=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;row.append(dt,dd);return row;}));
 currentBriefingText=['DECET — BRIEFING INICIAL','Tecnologia • Consultoria • Inteligência de Dados','',...fields.map(([label,value])=>label+': '+value),'','PRÓXIMO PASSO','Alinhar o contexto, as prioridades e as informações necessárias para definir o escopo.','Documento preparado pelo visitante. Não constitui proposta comercial ou diagnóstico.','Nenhuma informação foi enviada automaticamente à DECET.'].join('\n');
 if(briefingUrl)URL.revokeObjectURL(briefingUrl);
 briefingUrl=URL.createObjectURL(new Blob(['\ufeff'+currentBriefingText],{type:'text/plain;charset=utf-8'}));
 document.getElementById('briefing-download').href=briefingUrl;
 document.getElementById('briefing-whatsapp').href='https://wa.me/5511914758842?text='+encodeURIComponent(currentBriefingText);
 briefingReview.hidden=false;
 document.getElementById('brief-step-2').classList.add('is-current');
 document.getElementById('briefing-review-title').focus({preventScroll:true});
 briefingReview.scrollIntoView({behavior:reducedMotion.matches?'instant':'smooth',block:'start'});
 document.getElementById('form-status').textContent='Resumo preparado para revisão. Nenhuma informação foi enviada.';
});
document.getElementById('briefing-edit').addEventListener('click',()=>{resetBriefing();form.elements.nome.focus();});
document.getElementById('briefing-copy').addEventListener('click',async()=>{
 if(!currentBriefingText)return;
 try{await navigator.clipboard.writeText(currentBriefingText);briefingActionStatus.textContent='Resumo copiado. Você pode colá-lo na mensagem que escolher enviar.';}
 catch{briefingActionStatus.textContent='Não foi possível copiar automaticamente. Use a versão em texto para baixar o resumo.';}
});
document.getElementById('briefing-print').addEventListener('click',()=>{if(currentBriefingText)window.print();});
window.addEventListener('pagehide',()=>{if(briefingUrl){URL.revokeObjectURL(briefingUrl);briefingUrl=undefined;}});

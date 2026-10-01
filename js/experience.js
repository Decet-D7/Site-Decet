'use strict';
// Capability carousel shares the same accessible tab state, without autoplay.
const capabilityNames = ['Tecnologia','Consultoria','Inteligência de Dados','Processos','Riscos','Inovação'];
function carouselMove(delta) {
  const index = tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true');
  selectCapability((index + delta + tabs.length) % tabs.length);
}
document.querySelector('.cap-prev').addEventListener('click', () => carouselMove(-1));
document.querySelector('.cap-next').addEventListener('click', () => carouselMove(1));
document.querySelectorAll('[data-cap-index]').forEach(button => button.addEventListener('click', () => selectCapability(Number(button.dataset.capIndex))));
let pointerStart;
document.querySelector('.cap-panels').addEventListener('pointerdown', event => { if (event.pointerType !== 'mouse') pointerStart = {x:event.clientX,y:event.clientY}; });
document.querySelector('.cap-panels').addEventListener('pointerup', event => {
  if (!pointerStart) return;
  const dx = event.clientX-pointerStart.x, dy=event.clientY-pointerStart.y;
  if (Math.abs(dx)>65 && Math.abs(dx)>Math.abs(dy)*1.5) carouselMove(dx<0 ? 1 : -1);
  pointerStart=undefined;
});
document.querySelector('.cap-panels').addEventListener('pointercancel',()=>pointerStart=undefined);

// Second carousel: scroll snapping and real links preserve the no-JS journey.
const gallery = document.querySelector('.gallery-track');
const galleryCards = [...gallery.querySelectorAll('.gallery-card')];
let galleryIndex = 0;
function galleryPosition() {
  let nearest=0, distance=Infinity;
  galleryCards.forEach((card,i)=>{const d=Math.abs(card.getBoundingClientRect().left-gallery.getBoundingClientRect().left);if(d<distance){distance=d;nearest=i;}});
  if(gallery.scrollLeft>3 && gallery.scrollLeft+gallery.clientWidth>=gallery.scrollWidth-3) nearest=galleryCards.length-1;
  galleryIndex=nearest;
  document.getElementById('gallery-page').textContent=String(nearest+1).padStart(2,'0')+' / 06';
  document.getElementById('gallery-prev').disabled=gallery.scrollLeft<3;
  document.getElementById('gallery-next').disabled=gallery.scrollLeft+gallery.clientWidth>=gallery.scrollWidth-3;
}
function galleryMove(delta) {
  const index=Math.max(0,Math.min(galleryCards.length-1,galleryIndex+delta));
  const left=galleryCards[index].getBoundingClientRect().left-gallery.getBoundingClientRect().left+gallery.scrollLeft;
  gallery.scrollTo({left,behavior:reducedMotion.matches?'instant':'smooth'});
}
document.getElementById('gallery-prev').addEventListener('click',()=>galleryMove(-1));
document.getElementById('gallery-next').addEventListener('click',()=>galleryMove(1));
gallery.addEventListener('scroll',galleryPosition,{passive:true});
window.addEventListener('resize',galleryPosition);
galleryCards.forEach((card,i)=>{
  card.addEventListener('click',event=>{event.preventDefault();openMockup(card);});
  card.addEventListener('keydown',event=>{if(event.key==='ArrowRight'||event.key==='ArrowLeft'){event.preventDefault();const next=Math.max(0,Math.min(galleryCards.length-1,i+(event.key==='ArrowRight'?1:-1)));galleryCards[next].focus({preventScroll:true});const left=galleryCards[next].getBoundingClientRect().left-gallery.getBoundingClientRect().left+gallery.scrollLeft;gallery.scrollTo({left,behavior:reducedMotion.matches?'instant':'smooth'});}});
});
galleryPosition();

// Method stages disclose details and update the illustrative image.
const stageButtons=[...document.querySelectorAll('.method-choice')];
const stageImages=['method-diagnosis','method-priorities','method-model','method-delivery'];
const stageCaptions=['Compreender o fluxo.','Enxergar as vulnerabilidades.','Conectar informação e contexto.','Construir e evoluir.'];
function activateStage(index){
  stageButtons.forEach((button,i)=>{button.setAttribute('aria-expanded',String(i===index));button.closest('article').classList.toggle('is-active',i===index);const body=document.getElementById(button.getAttribute('aria-controls'));body.inert=i!==index;body.setAttribute('aria-hidden',String(i!==index));});
  const visual=document.querySelector('.method-visual');
  visual.querySelector('img').src='assets/'+stageImages[index]+'.svg';
  visual.querySelector('img').alt='Exemplo de entregável da etapa '+(index+1)+': '+stageCaptions[index];
  visual.querySelector('figcaption>span').textContent='ETAPA 0'+(index+1)+' / MÉTODO DECET';
  visual.querySelector('figcaption strong').textContent=stageCaptions[index];
  visual.classList.remove('is-changing');requestAnimationFrame(()=>visual.classList.add('is-changing'));
}
stageButtons.forEach((button,i)=>button.addEventListener('click',()=>activateStage(i)));
activateStage(0);

// Context explorer: deterministic, editorial suggestions; no invented diagnosis.
const challengeMap={
  efficiency:{heading:'Do retrabalho à fluidez.',image:'process',interest:'Processos',tags:['Processos','Tecnologia','Consultoria'],challenge:'Operação com muito atrito',descriptions:{discover:'Começar por um diagnóstico do fluxo de trabalho, das tarefas repetitivas e dos pontos de espera.',plan:'Priorizar os gargalos conhecidos e desenhar um plano de simplificação, integração e automação.',build:'Traduzir as prioridades em um primeiro fluxo melhorado, com validação junto às pessoas que executam o processo.'},deliverables:{discover:'Mapa do processo atual e prioridades de melhoria.',plan:'Fluxo futuro e plano de implementação por etapas.',build:'Piloto de melhoria e critérios de acompanhamento.'}},
  data:{heading:'De dados dispersos a uma visão comum.',image:'intelligence',interest:'Inteligência de Dados',tags:['Inteligência de Dados','Tecnologia','Processos'],challenge:'Informação sem clareza',descriptions:{discover:'Identificar as decisões prioritárias, as fontes disponíveis e as lacunas de qualidade da informação.',plan:'Definir os indicadores relevantes e a arquitetura necessária para conectar as fontes já identificadas.',build:'Construir uma primeira visão de indicadores, validar sua consistência e organizar o uso no dia a dia.'},deliverables:{discover:'Inventário de fontes e perguntas prioritárias do negócio.',plan:'Modelo de indicadores e plano de integração de dados.',build:'Painel inicial validado com regras de atualização.'}},
  risk:{heading:'Da incerteza à visibilidade.',image:'risk',interest:'Riscos',tags:['Riscos','Processos','Consultoria'],challenge:'Riscos pouco visíveis',descriptions:{discover:'Mapear dependências, vulnerabilidades e controles existentes nos processos mais relevantes.',plan:'Classificar os riscos conhecidos e priorizar ações de tratamento com responsáveis definidos.',build:'Implementar e acompanhar os controles priorizados, reunindo evidências de execução.'},deliverables:{discover:'Mapa inicial de riscos e controles existentes.',plan:'Matriz de criticidade e plano de tratamento.',build:'Rotina de acompanhamento e evidências dos controles.'}},
  innovation:{heading:'Da possibilidade à primeira aplicação.',image:'innovation',interest:'Inovação',tags:['Inovação','Tecnologia','Consultoria'],challenge:'Uma nova solução para criar',descriptions:{discover:'Compreender a necessidade, formular hipóteses e identificar o que precisa ser validado antes de investir.',plan:'Desenhar a experiência e definir um experimento com critérios claros de aprendizado.',build:'Construir um protótipo ou piloto, observar seu uso e decidir os próximos passos a partir das evidências.'},deliverables:{discover:'Hipóteses de valor e roteiro de descoberta.',plan:'Conceito de solução e plano de experimento.',build:'Protótipo ou piloto com critérios de validação.'}}
};
const maturity=document.getElementById('maturity');
function selectedChallenge(){return challengeMap[document.querySelector('[name="challenge"]:checked').value];}
function updateExplorer(){
  const selected=selectedChallenge();
  document.getElementById('explorer-heading').textContent=selected.heading;
  document.getElementById('explorer-description').textContent=selected.descriptions[maturity.value];
  document.getElementById('explorer-deliverable').textContent=selected.deliverables[maturity.value];
  document.getElementById('explorer-tags').replaceChildren(...selected.tags.map(text=>{const tag=document.createElement('span');tag.textContent=text;return tag;}));
  const result=document.querySelector('.explorer-result');result.classList.remove('is-changing');requestAnimationFrame(()=>result.classList.add('is-changing'));
}
document.querySelectorAll('[name="challenge"]').forEach(input=>input.addEventListener('change',updateExplorer));
maturity.addEventListener('change',updateExplorer);
let lastSuggestedBriefing='';
document.getElementById('explorer-cta').addEventListener('click',()=>{
  const selected=selectedChallenge();
  form.elements.interesse.value=selected.interest;
  const briefing='Desafio: '+selected.challenge+'. Momento: '+maturity.options[maturity.selectedIndex].text+'. Gostaria de conversar sobre: '+selected.deliverables[maturity.value];
  if(!form.elements.desafio.value.trim() || form.elements.desafio.value===lastSuggestedBriefing){form.elements.desafio.value=briefing;lastSuggestedBriefing=briefing;}
  if(briefingUrl){URL.revokeObjectURL(briefingUrl);briefingUrl=undefined;}
  const stageMap={discover:'Estamos explorando possibilidades',plan:'Precisamos de diagnóstico e plano',build:'Temos prioridades para executar'};
  form.elements.momento.value=stageMap[maturity.value];
  form.dispatchEvent(new Event('input',{bubbles:true}));
  document.getElementById('form-status').replaceChildren();
});
updateExplorer();
if('IntersectionObserver' in window){const observer=new IntersectionObserver(entries=>entries.forEach(entry=>entry.target.classList.toggle('motion-offscreen',!entry.isIntersecting)));document.querySelectorAll('.hero,.essence,.image-interlude,.intro').forEach(el=>observer.observe(el));}

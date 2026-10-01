'use strict';
document.getElementById('year').textContent = new Date().getFullYear();

// Progressive enhancement: all capability content remains readable without JS.
const tablist = document.querySelector('.cap-tabs');
const tabs = [...tablist.querySelectorAll('a')];
const panels = [...document.querySelectorAll('.cap-panel')];
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
document.documentElement.classList.add('enhanced');
tablist.setAttribute('role', 'tablist');
const tabOrientation = window.matchMedia('(max-width: 700px)');
function setOrientation() { tablist.setAttribute('aria-orientation', tabOrientation.matches ? 'horizontal' : 'vertical'); }
setOrientation();
tabOrientation.addEventListener('change', setOrientation);
tabs.forEach((tab, i) => {
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-controls', panels[i].id);
  panels[i].setAttribute('role', 'tabpanel');
  panels[i].setAttribute('aria-labelledby', tab.id);
  panels[i].tabIndex = 0;
});
function selectCapability(index, focus = false) {
  tabs.forEach((tab, i) => {
    const active = index === i;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    tab.classList.toggle('selected', active);
    panels[i].hidden = !active;
  });
  const carouselStatus = document.querySelector('.carousel-status');
  if (carouselStatus) carouselStatus.textContent = String(index + 1).padStart(2, '0') + ' / 06 — ' + tabs[index].textContent.replace(/^\d+/, '').replace('↗','').trim();
  document.querySelectorAll('[data-cap-index]').forEach((button,i) => button.setAttribute('aria-pressed', String(i === index)));
  if (focus) tabs[index].focus({preventScroll:true});
  if (tabOrientation.matches) {
    const left = tabs[index].getBoundingClientRect().left - tablist.getBoundingClientRect().left + tablist.scrollLeft;
    tablist.scrollTo({left: Math.max(0, left - 12), behavior: reducedMotion.matches ? 'instant' : 'smooth'});
  }
}
selectCapability(Math.max(0, panels.findIndex(panel => '#' + panel.id === location.hash)));
tabs.forEach((tab, i) => {
  tab.addEventListener('click', event => {
    event.preventDefault(); selectCapability(i);
    history.replaceState(null, '', '#' + panels[i].id);
  });
  tab.addEventListener('keydown', event => {
    let next = i;
    const forward = tabOrientation.matches ? 'ArrowRight' : 'ArrowDown';
    const backward = tabOrientation.matches ? 'ArrowLeft' : 'ArrowUp';
    if (event.key === forward) next = (i + 1) % tabs.length;
    else if (event.key === backward) next = (i - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else if (event.key === ' ') { event.preventDefault(); selectCapability(i); return; }
    else return;
    event.preventDefault(); selectCapability(next, true);
  });
});
window.addEventListener('hashchange', () => {
  const index = panels.findIndex(panel => '#' + panel.id === location.hash);
  if (index >= 0) selectCapability(index);
});

// Active chapter follows the reading position. Native links preserve history.
const chapterLinks = [...document.querySelectorAll('.chapter-list a')];
const chapterSections = chapterLinks.map(link => document.querySelector(link.hash));
let ticking = false;
function updateChapter() {
  let index = 0;
  chapterSections.forEach((section, i) => { if (section.getBoundingClientRect().top <= 150) index = i; });
  chapterLinks.forEach((link, i) => {
    link.classList.toggle('active', i === index);
    if (i === index) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current');
  });
  ticking = false;
}
window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(updateChapter); } }, {passive:true});
updateChapter();
chapterLinks.forEach(link => link.addEventListener('click', () => {
  const nav = document.querySelector('.chapter-list');
  nav.scrollTo({left: Math.max(0, link.offsetLeft - nav.offsetLeft - 24), behavior: reducedMotion.matches ? 'instant' : 'smooth'});
}));

if ('IntersectionObserver' in window && !reducedMotion.matches) {
  const observer = new IntersectionObserver(entries => entries.forEach(entry => {
    if (entry.isIntersecting) { entry.target.classList.add('revealed'); observer.unobserve(entry.target); }
  }), {threshold:0.08});
  document.querySelectorAll('.section-heading, .intro-grid, .method-track article, .pillars article, .case').forEach(el => {
    if (el.getBoundingClientRect().top > innerHeight) { el.classList.add('reveal-ready'); observer.observe(el); }
  });
}

const form = document.getElementById('contact-form');
form.querySelector('[type="submit"]').disabled = false;
document.querySelectorAll('[data-interest]').forEach(link => link.addEventListener('click', () => { form.elements.interesse.value = link.dataset.interest; }));
let briefingUrl;
const privacyDialog = document.getElementById('privacy-dialog');
let privacyOpener;
document.querySelectorAll('.privacy-open').forEach(button => button.addEventListener('click', () => { privacyOpener = button; privacyDialog.showModal(); }));
document.querySelectorAll('.dialog-close').forEach(button => button.addEventListener('click', () => privacyDialog.close()));
privacyDialog.addEventListener('click', event => { if (event.target === privacyDialog) { const rect = privacyDialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) privacyDialog.close(); } });
privacyDialog.addEventListener('close', () => privacyOpener?.focus());

// Editorial motion: continuous effects have an explicit pause control.
const motionToggle = document.querySelector('.motion-toggle');
let motionPaused = false;
motionToggle.addEventListener('click', () => {
  motionPaused = !motionPaused;
  document.body.classList.toggle('motion-paused', motionPaused);
  motionToggle.setAttribute('aria-pressed', String(motionPaused));
  motionToggle.setAttribute('aria-label', motionPaused ? 'Retomar animações contínuas' : 'Pausar animações contínuas');
  motionToggle.querySelector('.motion-label').textContent = motionPaused ? 'Retomar movimento' : 'Pausar movimento';
  motionToggle.firstElementChild.textContent = motionPaused ? '▷' : 'Ⅱ';
});
const motionTargets = document.querySelectorAll('.motion-target');
if ('IntersectionObserver' in window) {
  const motionObserver = new IntersectionObserver(entries => entries.forEach(entry => {
    if (entry.isIntersecting) { entry.target.classList.add('in-view'); motionObserver.unobserve(entry.target); }
  }), {threshold:.12});
  motionTargets.forEach(el => motionObserver.observe(el));
} else motionTargets.forEach(el => el.classList.add('in-view'));
const interlude = document.querySelector('.image-interlude');
let motionTick = false;
function updateEditorialMotion() {
  const range = document.documentElement.scrollHeight - innerHeight;
  document.documentElement.style.setProperty('--read', range > 0 ? Math.min(1,scrollY/range) : 0);
  if (interlude && !motionPaused && !reducedMotion.matches) {
    const box = interlude.getBoundingClientRect();
    if (box.top < innerHeight && box.bottom > 0) {
      interlude.style.setProperty('--parallax', Math.max(-45,Math.min(45,(innerHeight/2-box.top-box.height/2)*.09))+'px');
    }
  }
  motionTick = false;
}
window.addEventListener('scroll', () => { if (!motionTick) { motionTick = true; requestAnimationFrame(updateEditorialMotion); } }, {passive:true});
updateEditorialMotion();

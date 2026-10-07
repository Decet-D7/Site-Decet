'use strict';
// Página de projetos: só o necessário (app.js depende de elementos da home).
document.getElementById('year').textContent = new Date().getFullYear();
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const privacyDialog = document.getElementById('privacy-dialog');
let privacyOpener;
document.querySelectorAll('.privacy-open').forEach(button => button.addEventListener('click', () => { privacyOpener = button; privacyDialog.showModal(); }));
document.querySelectorAll('.dialog-close').forEach(button => button.addEventListener('click', () => privacyDialog.close()));
privacyDialog.addEventListener('click', event => { if (event.target === privacyDialog) privacyDialog.close(); });
privacyDialog.addEventListener('close', () => privacyOpener?.focus());

if ('IntersectionObserver' in window && !reducedMotion.matches) {
  const observer = new IntersectionObserver(entries => entries.forEach(entry => {
    if (entry.isIntersecting) { entry.target.classList.add('revealed'); observer.unobserve(entry.target); }
  }), {threshold:0.08});
  document.querySelectorAll('.section-heading, .project, .more-list li').forEach(el => {
    if (el.getBoundingClientRect().top > innerHeight) { el.classList.add('reveal-ready'); observer.observe(el); }
  });
}

let ticking = false;
function updateProgress() {
  const range = document.documentElement.scrollHeight - innerHeight;
  document.documentElement.style.setProperty('--read', range > 0 ? Math.min(1, scrollY / range) : 0);
  ticking = false;
}
window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(updateProgress); } }, {passive:true});
updateProgress();

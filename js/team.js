'use strict';
// Espaço do time: login (Supabase Auth), perfil, navegação entre as abas e utilidades comuns.
// As regras de acesso ficam no banco (RLS): o site só mostra o que o banco libera.

const SUPABASE_URL = 'https://smafjcovbzptttqimmxx.supabase.co';
const SUPABASE_KEY = 'sb_publishable_8MZ7wNYCt1tGLtJqi-R5sw_ibMikSxb';
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const team = {
  user: null, member: null,
  members: [],            // [{email, name, role, active, user_id}]
  byUser: new Map(),      // user_id -> membro
  ready: [],              // (member) login confirmado
  changed: [],            // () lista da equipe mudou
  client: null,           // {id, name} quando quem entrou é cliente (só vê as reuniões da empresa)
  get isAdmin() { return this.member?.role === 'admin'; },
  get isClient() { return !!this.client; },
  nameOf(userId) { return this.byUser.get(userId)?.name || 'Ex-integrante'; },
};

// ---------- Utilidades de interface ----------
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter(c => c !== null && c !== undefined && c !== false));
  return node;
}
const initials = name => (name || '?').trim().split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
function avatar(name, cls = 'avatar') { return h('span', {class: cls, 'aria-hidden': 'true', text: initials(name)}); }
let toastTimer;
function toast(text, error = false) {
  const box = document.getElementById('toast');
  box.textContent = text;
  box.classList.toggle('error', error);
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 4500);
}
function friendlyError(error) {
  const msg = String(error?.message || error || '');
  if (/JWT|session|not authenticated/i.test(msg)) return 'Sua sessão expirou. Entre de novo.';
  if (/row-level security|permission denied/i.test(msg)) return 'Você não tem permissão para isso.';
  if (/Failed to fetch|NetworkError/i.test(msg)) return 'Sem conexão com o servidor. Verifique a internet.';
  return msg || 'Algo deu errado.';
}
// Diálogos de formulário: botões .dialog-x fecham.
document.querySelectorAll('dialog').forEach(dialog => {
  dialog.querySelectorAll('.dialog-x').forEach(b => b.addEventListener('click', () => dialog.close()));
});

// ---------- Navegação ----------
const VIEWS = ['meet', 'agenda', 'kanban', 'clients', 'team'];
function showView(view) {
  if (!VIEWS.includes(view) || (view === 'team' && !team.isAdmin) || team.isClient) view = 'meet';
  document.querySelectorAll('[data-view-panel]').forEach(panel => { panel.hidden = panel.dataset.viewPanel !== view; });
  document.querySelectorAll('.nav-item').forEach(item => {
    const active = item.dataset.view === view;
    item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
  });
  document.body.dataset.view = view;
  const inRoom = typeof state !== 'undefined' && state.joined;
  if (!(view === 'meet' && inRoom)) history.replaceState(null, '', '#' + view);
  else history.replaceState(null, '', '#sala=' + state.room);
  document.getElementById('call-pill').hidden = !(inRoom && view !== 'meet');
}
document.querySelectorAll('[data-view]').forEach(link => link.addEventListener('click', event => {
  event.preventDefault();
  showView(link.dataset.view);
}));

// ---------- Equipe ----------
async function loadMembers() {
  if (team.isClient) { team.changed.forEach(fn => fn()); return; }   // cliente não vê a equipe
  const {data, error} = await sb.from('team_members').select('email, name, role, active, user_id, created_at').order('name');
  if (error) { toast(friendlyError(error), true); return; }
  team.members = data;
  team.byUser = new Map(data.filter(m => m.user_id).map(m => [m.user_id, m]));
  const me = team.user && team.byUser.get(team.user.id);
  if (team.member && (!me || !me.active)) { await sb.auth.signOut(); return; }
  if (me) { team.member = me; renderMe(); }
  team.changed.forEach(fn => fn());
}
function renderMe() {
  document.getElementById('me-name').textContent = team.member.name;
  document.getElementById('me-role').textContent = team.isClient ? 'Cliente · ' + team.client.name : team.isAdmin ? 'Administrador' : 'Membro';
  document.getElementById('me-avatar').textContent = initials(team.member.name);
  document.querySelector('.nav-item[data-view="team"]').hidden = !team.isAdmin;
  document.body.classList.toggle('client-mode', team.isClient);
}

// ---------- Login ----------
const authEl = document.getElementById('auth'), appEl = document.getElementById('app');
const authForm = document.getElementById('auth-form'), authStatus = document.getElementById('auth-status');
const AUTH_COPY = {
  login: {submit: 'Entrar', hint: 'Use o e-mail cadastrado pelo administrador do time.', password: 'current-password'},
  signup: {submit: 'Criar minha senha', hint: 'Digite o e-mail cadastrado, o código de convite que o administrador enviou e crie uma senha (mínimo de 8 caracteres).', password: 'new-password', code: 'de convite'},
  reset: {submit: 'Trocar a senha', hint: 'Peça ao administrador um código de nova senha (vale 24 h) e crie a senha nova.', password: 'new-password', code: 'de nova senha'},
};
function setAuthMode(mode) {
  authForm.dataset.mode = mode;
  authEl.querySelectorAll('[data-auth]').forEach(tab => tab.setAttribute('aria-selected', String(tab.dataset.auth === mode)));
  const copy = AUTH_COPY[mode];
  document.getElementById('auth-submit').textContent = copy.submit;
  document.getElementById('auth-hint').textContent = copy.hint;
  authForm.elements.password.autocomplete = copy.password;
  if (copy.code) authForm.querySelector('.code-kind').textContent = copy.code;
  setAuthStatus('');
}
authEl.querySelectorAll('[data-auth]').forEach(tab => tab.addEventListener('click', () => setAuthMode(tab.dataset.auth)));
function setAuthStatus(text, error = false) {
  authStatus.textContent = text;
  authStatus.classList.toggle('error', error);
}
function showAuth(message, error) {
  appEl.hidden = true;
  authEl.hidden = false;
  if (message) setAuthStatus(message, error);
}
authForm.addEventListener('submit', async event => {
  event.preventDefault();
  const mode = authForm.dataset.mode;
  const email = authForm.elements.email.value.trim().toLowerCase();
  const password = authForm.elements.password.value;
  const code = authForm.elements.code.value.trim().toUpperCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return setAuthStatus('Digite um e-mail válido.', true);
  if (mode !== 'login') {
    if (code.length < 6) return setAuthStatus('Digite o código recebido do administrador.', true);
    if (password.length < 8) return setAuthStatus('A senha precisa ter pelo menos 8 caracteres.', true);
    if (password !== authForm.elements.password2.value) return setAuthStatus('As senhas não conferem.', true);
  } else if (!password) return setAuthStatus('Digite sua senha.', true);
  const submit = document.getElementById('auth-submit');
  submit.disabled = true;
  setAuthStatus(mode === 'login' ? 'Entrando…' : 'Salvando…');
  try {
    if (mode === 'signup') {
      const {data, error} = await sb.auth.signUp({email, password, options: {data: {invite_code: code}}});
      if (error) {
        if (/already registered|already exists/i.test(error.message)) throw new Error('Esse e-mail já tem conta. Use "Entrar" ou "Esqueci a senha".');
        if (/Database error|convite/i.test(error.message)) throw new Error('E-mail não cadastrado no time ou código de convite inválido/expirado.');
        throw error;
      }
      if (!data.session) throw new Error('Conta criada, mas o projeto ainda exige confirmação por e-mail. Avise um administrador para desligar essa opção no Supabase.');
    } else if (mode === 'reset') {
      const {data, error} = await sb.rpc('redeem_password_reset', {p_email: email, p_code: code, p_password: password});
      if (error) throw error;
      if (!data) throw new Error('Código inválido, expirado ou bloqueado por tentativas erradas. Peça um novo ao administrador.');
    }
    if (mode !== 'signup') {
      const {error} = await sb.auth.signInWithPassword({email, password});
      if (error) throw new Error(/Invalid login/i.test(error.message) ? 'E-mail ou senha incorretos.' : friendlyError(error));
    }
    const {data: {user}} = await sb.auth.getUser();
    authForm.reset();
    await enterApp(user);
  } catch (error) {
    setAuthStatus(friendlyError(error), true);
  } finally {
    submit.disabled = false;
  }
});

// Cliente que abre o link de uma reunião entra só na sala (as regras do banco limitam às reuniões da empresa).
async function clientLogin(user) {
  const {data} = await sb.from('client_users').select('email, name, active, user_id, client_id, clients(name, active)').eq('user_id', user.id).maybeSingle();
  if (!data || !data.active || !data.clients?.active) return null;
  team.client = {id: data.client_id, name: data.clients.name};
  return {email: data.email, name: data.name, role: 'cliente', active: true, user_id: data.user_id};
}
async function enterApp(user) {
  team.user = user;
  let {data, error} = await sb.from('team_members').select('email, name, role, active, user_id').eq('user_id', user.id).maybeSingle();
  if (!error && !data) data = await clientLogin(user);
  if (error || !data || !data.active) {
    team.user = null;
    await sb.auth.signOut({scope: 'local'});
    showAuth(error ? friendlyError(error) : 'Seu acesso ao time está desativado. Fale com um administrador.', true);
    return;
  }
  team.member = data;
  renderMe();
  authEl.hidden = true;
  appEl.hidden = false;
  await loadMembers();
  if (!team.isClient) sb.channel('team-members').on('postgres_changes', {event: '*', schema: 'public', table: 'team_members'}, () => loadMembers()).subscribe();
  // Quem é desativado deixa de receber eventos da tabela (RLS): confere o acesso de tempos em tempos.
  setInterval(checkAccess, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkAccess(); });
  team.ready.forEach(fn => fn(team.member));
  const hash = location.hash.slice(1);
  showView(hash.startsWith('sala=') ? 'meet' : hash);
}
async function checkAccess() {
  if (!team.member) return;
  const {data, error} = await sb.rpc(team.isClient ? 'is_client_user' : 'is_team_member');
  if (!error && data === false) await sb.auth.signOut();
}
document.getElementById('logout').addEventListener('click', async () => {
  if (typeof state !== 'undefined' && state.joined && !confirm('Sair da conta também encerra a chamada. Continuar?')) return;
  await sb.auth.signOut();
});
sb.auth.onAuthStateChange(event => {
  if (event === 'SIGNED_OUT' && team.member) { history.replaceState(null, '', location.pathname); location.reload(); }
});

// Começa depois de todos os módulos (defer) registrarem seus callbacks em team.ready.
document.addEventListener('DOMContentLoaded', async () => {
  const {data: {session}} = await sb.auth.getSession();
  if (session) await enterApp(session.user); else showAuth();
});

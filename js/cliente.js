'use strict';
// Área do cliente: login (convite por código, como o time) e painel da empresa com serviços e prazos,
// reuniões, chamados, relatórios e documentos e financeiro. O banco (RLS) só entrega ao cliente o que
// é da empresa dele. Quem é da equipe entra em modo "ver como cliente", sem poder pedir nada aqui.

const SUPABASE_URL = 'https://smafjcovbzptttqimmxx.supabase.co';
const SUPABASE_KEY = 'sb_publishable_8MZ7wNYCt1tGLtJqi-R5sw_ibMikSxb';
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = selector => document.querySelector(selector);

const portal = {
  user: null, me: null, client: null, viewAs: false, clients: [],
  tab: 'resumo', fileFilter: 'todos', reloadTimer: null, ticket: null,
  data: {services: [], milestones: [], meetings: [], tickets: [], files: [], invoices: []},
};
const TABS = [['resumo', 'Resumo'], ['servicos', 'Serviços e prazos'], ['reunioes', 'Reuniões'], ['chamados', 'Chamados'], ['arquivos', 'Relatórios e documentos'], ['financeiro', 'Financeiro']];
const statusForClient = s => (s === 'aguardando_cliente' ? 'Aguardando você' : TICKET_STATUS[s]);
const meetingFormat = new Intl.DateTimeFormat('pt-BR', {weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'});
const meetLink = code => 'meet.html#sala=' + code;
document.getElementById('year').textContent = new Date().getFullYear();

// ---------- Utilidades ----------
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter(c => c !== null && c !== undefined && c !== false));
  return node;
}
let toastTimer;
function toast(text, error = false) {
  const box = $('#toast');
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
const chip = (label, cls) => h('span', {class: 'status ' + cls, text: label});
document.querySelectorAll('dialog').forEach(d => d.querySelectorAll('.dialog-x').forEach(b => b.addEventListener('click', () => d.close())));

// ---------- Login ----------
const authEl = $('#portal-auth'), appEl = $('#portal-app'), authForm = $('#auth-form'), authStatus = $('#auth-status');
const AUTH_COPY = {
  login: {submit: 'Entrar', hint: 'Use o e-mail cadastrado pela DECET.', password: 'current-password'},
  signup: {submit: 'Criar minha senha', hint: 'Digite o e-mail cadastrado, o código de convite que a DECET enviou e crie uma senha (mínimo de 8 caracteres).', password: 'new-password', code: 'de convite'},
  reset: {submit: 'Trocar a senha', hint: 'Peça à DECET um código de nova senha (vale 24 h) e crie a senha nova.', password: 'new-password', code: 'de nova senha'},
};
function setAuthStatus(text, error = false) { authStatus.textContent = text; authStatus.classList.toggle('error', error); }
function setAuthMode(mode) {
  authForm.dataset.mode = mode;
  authEl.querySelectorAll('[data-auth]').forEach(tab => tab.setAttribute('aria-selected', String(tab.dataset.auth === mode)));
  const copy = AUTH_COPY[mode];
  $('#auth-submit').textContent = copy.submit;
  $('#auth-hint').textContent = copy.hint;
  authForm.elements.password.autocomplete = copy.password;
  if (copy.code) authForm.querySelector('.code-kind').textContent = copy.code;
  setAuthStatus('');
}
authEl.querySelectorAll('[data-auth]').forEach(tab => tab.addEventListener('click', () => setAuthMode(tab.dataset.auth)));
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
    if (code.length < 6) return setAuthStatus('Digite o código recebido da DECET.', true);
    if (password.length < 8) return setAuthStatus('A senha precisa ter pelo menos 8 caracteres.', true);
    if (password !== authForm.elements.password2.value) return setAuthStatus('As senhas não conferem.', true);
  } else if (!password) return setAuthStatus('Digite sua senha.', true);
  const submit = $('#auth-submit');
  submit.disabled = true;
  setAuthStatus(mode === 'login' ? 'Entrando…' : 'Salvando…');
  try {
    if (mode === 'signup') {
      const {data, error} = await sb.auth.signUp({email, password, options: {data: {invite_code: code}}});
      if (error) {
        if (/already registered|already exists/i.test(error.message)) throw new Error('Esse e-mail já tem conta. Use "Entrar" ou "Esqueci a senha".');
        if (/Database error|convite/i.test(error.message)) throw new Error('E-mail não cadastrado ou código de convite inválido/expirado. Confira com a DECET.');
        throw error;
      }
      if (!data.session) throw new Error('Conta criada, mas ainda falta uma configuração do lado da DECET. Avise a equipe.');
    } else if (mode === 'reset') {
      const {data, error} = await sb.rpc('redeem_password_reset', {p_email: email, p_code: code, p_password: password});
      if (error) throw error;
      if (!data) throw new Error('Código inválido, expirado ou bloqueado por tentativas erradas. Peça um novo à DECET.');
    }
    if (mode !== 'signup') {
      const {error} = await sb.auth.signInWithPassword({email, password});
      if (error) throw new Error(/Invalid login/i.test(error.message) ? 'E-mail ou senha incorretos.' : friendlyError(error));
    }
    const {data: {user}} = await sb.auth.getUser();
    authForm.reset();
    await enterPortal(user);
  } catch (error) {
    setAuthStatus(friendlyError(error), true);
  } finally {
    submit.disabled = false;
  }
});

async function enterPortal(user) {
  portal.user = user;
  const {data: cu} = await sb.from('client_users').select('email, name, active, client_id, clients(name, active)').eq('user_id', user.id).maybeSingle();
  if (cu && cu.active && cu.clients?.active) {
    portal.me = {name: cu.name, email: cu.email};
    portal.client = {id: cu.client_id, name: cu.clients.name};
  } else {
    const {data: tm} = await sb.from('team_members').select('name, email, active').eq('user_id', user.id).maybeSingle();
    if (!tm || !tm.active) {
      await sb.auth.signOut({scope: 'local'});
      return showAuth('Seu acesso à área do cliente está desativado ou não foi encontrado. Fale com a DECET.', true);
    }
    // Equipe DECET: escolhe a empresa para ver a área como o cliente vê.
    portal.viewAs = true;
    portal.me = {name: tm.name, email: tm.email};
    const {data: clients} = await sb.from('clients').select('id, name, active').order('name');
    portal.clients = clients || [];
    if (!portal.clients.length) {
      authEl.hidden = true; appEl.hidden = false;
      $('#portal-client').textContent = 'Nenhuma empresa cadastrada';
      $('#portal-user').textContent = 'Cadastre empresas na aba Clientes do espaço do time (meet.html).';
      return;
    }
    const select = $('#portal-client-select');
    select.replaceChildren(...portal.clients.map(c => h('option', {value: c.id, text: c.name + (c.active ? '' : ' (desativada)')})));
    select.addEventListener('change', () => { portal.client = portal.clients.find(c => c.id === select.value); loadPortal(); });
    portal.client = portal.clients[0];
    $('#portal-viewas').hidden = false;
    $('#portal-viewas-note').hidden = false;
  }
  authEl.hidden = true;
  appEl.hidden = false;
  const channel = sb.channel('area-do-cliente');
  ['client_services', 'client_milestones', 'meetings', 'client_tickets', 'client_ticket_messages', 'client_files', 'client_invoices', 'clients']
    .forEach(table => channel.on('postgres_changes', {event: '*', schema: 'public', table}, scheduleReload));
  channel.subscribe();
  setInterval(checkAccess, 60000);
  await loadPortal();
}
async function checkAccess() {
  if (portal.viewAs || !portal.client) return;
  const {data, error} = await sb.rpc('is_client_user');
  if (!error && data === false) await sb.auth.signOut();
}
$('#portal-logout').addEventListener('click', () => sb.auth.signOut());
sb.auth.onAuthStateChange(event => { if (event === 'SIGNED_OUT' && portal.user) location.reload(); });

// ---------- Dados ----------
const scheduleReload = () => { clearTimeout(portal.reloadTimer); portal.reloadTimer = setTimeout(loadPortal, 250); };
async function loadPortal() {
  const id = portal.client?.id;
  if (!id) return;
  const by = (table, cols = '*') => sb.from(table).select(cols).eq('client_id', id);
  const since = new Date(Date.now() - 180 * 86400000).toISOString();
  const [services, milestones, meetings, tickets, files, invoices] = await Promise.all([
    by('client_services').order('created_at'), by('client_milestones').order('position').order('due_date'),
    by('meetings', 'id, title, description, starts_at, duration_min, room_code, ticket_id').gte('starts_at', since).order('starts_at'),
    by('client_tickets').order('updated_at', {ascending: false}), by('client_files').order('created_at', {ascending: false}),
    by('client_invoices').order('due_date', {ascending: false}),
  ]);
  const failed = [services, milestones, meetings, tickets, files, invoices].find(r => r.error);
  if (failed) return toast(friendlyError(failed.error), true);
  if (id !== portal.client?.id) return;
  portal.data = {
    services: services.data, milestones: milestones.data, tickets: tickets.data, files: files.data, invoices: invoices.data,
    meetings: meetings.data.map(m => { const start = new Date(m.starts_at); return {...m, start, end: new Date(start.getTime() + m.duration_min * 60000)}; }),
  };
  render();
  if (portal.ticket) loadThread(portal.ticket.id);
}

// ---------- Interface ----------
function render() {
  $('#portal-client').textContent = portal.client.name;
  $('#portal-user').textContent = portal.viewAs ? 'Equipe DECET · ' + portal.me.name : 'Olá, ' + portal.me.name + '.';
  const d = portal.data;
  const badge = {chamados: d.tickets.filter(t => t.status === 'aguardando_cliente').length, financeiro: d.invoices.filter(i => invoiceState(i)[0] === 'Vencida').length};
  $('#portal-tabs').replaceChildren(...TABS.map(([key, label]) => h('button', {type: 'button', role: 'tab', 'aria-selected': String(portal.tab === key),
    onclick: () => { portal.tab = key; render(); }}, label, badge[key] ? h('span', {class: 'count', text: String(badge[key])}) : null)));
  const panels = {resumo: renderSummary, servicos: renderServices, reunioes: renderMeetings, chamados: renderTickets, arquivos: renderFiles, financeiro: renderInvoices};
  $('#portal-body').replaceChildren(panels[portal.tab]());
}
const go = tab => () => { portal.tab = tab; render(); window.scrollTo({top: appEl.offsetTop - 20, behavior: 'smooth'}); };
const upcomingMeetings = () => portal.data.meetings.filter(m => m.end.getTime() >= Date.now());
const isLive = m => m.start.getTime() - 10 * 60000 <= Date.now() && Date.now() <= m.end.getTime();
const joinButton = m => h('a', {class: isLive(m) ? 'button gold' : 'chip', href: meetLink(m.room_code), target: '_blank', rel: 'noopener', text: isLive(m) ? 'Entrar agora' : 'Entrar'});
const actionsLocked = () => portal.viewAs;

function renderSummary() {
  const d = portal.data;
  const active = d.services.filter(s => s.status !== 'concluido');
  const avg = active.length ? Math.round(active.reduce((sum, s) => sum + s.progress, 0) / active.length) : 100;
  const pending = d.milestones.filter(m => !m.done && m.due_date).sort((a, b) => a.due_date.localeCompare(b.due_date));
  const next = pending[0];
  const nextMeeting = upcomingMeetings()[0];
  const openTickets = d.tickets.filter(t => OPEN_TICKET.has(t.status));
  const waiting = d.tickets.filter(t => t.status === 'aguardando_cliente').length;
  const openInvoices = d.invoices.filter(i => i.status === 'aberta');
  const overdue = openInvoices.filter(i => invoiceState(i)[0] === 'Vencida').length;
  const card = (title, body, tab) => h('article', {class: 'summary-card'}, h('p', {class: 'eyebrow', text: title}), body, h('button', {class: 'text-link', type: 'button', onclick: go(tab)}, 'Ver detalhes ', h('span', {'aria-hidden': 'true', text: '↗'})));
  return h('div', {class: 'portal-panel'},
    h('div', {class: 'quick-actions'},
      h('button', {class: 'button gold', type: 'button', disabled: actionsLocked(), onclick: () => openRequest('reuniao')}, 'Pedir reunião'),
      h('button', {class: 'chip', type: 'button', disabled: actionsLocked(), onclick: () => openRequest('suporte')}, 'Abrir chamado')),
    h('div', {class: 'summary-grid'},
      card('SERVIÇOS', h('div', {}, h('strong', {text: active.length ? active.length + (active.length === 1 ? ' em andamento' : ' em andamento') : 'Tudo concluído'}),
        h('div', {class: 'progress'}, h('i', {style: 'width:' + avg + '%'})), h('small', {text: 'Progresso médio: ' + avg + '%'})), 'servicos'),
      card('PRÓXIMO PRAZO', next ? h('div', {}, h('strong', {class: 'deadline ' + deadlineClass(next.due_date), text: dateBR(next.due_date)}),
        h('small', {text: next.title + ' · ' + (d.services.find(s => s.id === next.service_id)?.title || '')})) : h('div', {}, h('strong', {text: 'Sem prazos pendentes'})), 'servicos'),
      card('PRÓXIMA REUNIÃO', nextMeeting ? h('div', {}, h('strong', {text: meetingFormat.format(nextMeeting.start)}), h('small', {text: nextMeeting.title}), joinButton(nextMeeting))
        : h('div', {}, h('strong', {text: 'Nenhuma marcada'}), h('small', {text: 'Use "Pedir reunião" quando precisar.'})), 'reunioes'),
      card('CHAMADOS', h('div', {}, h('strong', {text: openTickets.length ? openTickets.length + ' em aberto' : 'Nenhum em aberto'}),
        waiting ? h('small', {class: 'attention', text: waiting + ' aguardando sua resposta'}) : h('small', {text: 'Abra um chamado para dúvidas e ajustes.'})), 'chamados'),
      card('FINANCEIRO', h('div', {}, h('strong', {text: money.format(openInvoices.reduce((s, i) => s + Number(i.amount), 0))}),
        h('small', {class: overdue ? 'attention' : '', text: overdue ? overdue + ' fatura(s) vencida(s)' : openInvoices.length ? openInvoices.length + ' fatura(s) em aberto' : 'Nenhuma fatura em aberto'})), 'financeiro')));
}

function renderServices() {
  const d = portal.data;
  if (!d.services.length) return h('div', {class: 'portal-panel'}, h('p', {class: 'empty', text: 'Nenhum serviço cadastrado ainda.'}));
  return h('div', {class: 'portal-panel'}, d.services.map(s => {
    const marks = d.milestones.filter(m => m.service_id === s.id);
    return h('article', {class: 'service-card'},
      h('div', {class: 'service-top'}, h('h3', {text: s.title}), chip(SERVICE_STATUS[s.status], 'svc-' + s.status)),
      s.description ? h('p', {class: 'service-desc', text: s.description}) : null,
      h('div', {class: 'progress', role: 'progressbar', 'aria-valuenow': String(s.progress), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': 'Progresso de ' + s.title}, h('i', {style: 'width:' + s.progress + '%'})),
      h('p', {class: 'service-meta', text: s.progress + '% concluído · início ' + dateBR(s.start_date) + ' · prazo final ' + dateBR(s.due_date)}),
      marks.length ? h('ul', {class: 'milestones readonly'}, marks.map(m => h('li', {class: deadlineClass(m.due_date, m.done) + (m.done ? ' done' : '')},
        h('span', {class: 'mark', 'aria-hidden': 'true', text: m.done ? '✓' : '○'}), h('span', {class: 'mark-title', text: m.title}),
        h('span', {class: 'due', text: m.done ? 'entregue em ' + dateBR(m.done_at.slice(0, 10)) : m.due_date ? 'prazo ' + dateBR(m.due_date) : 'sem prazo'})))) : null);
  }));
}

function renderMeetings() {
  const d = portal.data;
  const upcoming = upcomingMeetings(), past = d.meetings.filter(m => m.end.getTime() < Date.now()).reverse();
  const waiting = d.tickets.filter(t => t.kind === 'reuniao' && !t.meeting_id && OPEN_TICKET.has(t.status));
  const row = (m, live) => h('article', {class: 'meeting' + (live && isLive(m) ? ' live' : '')},
    h('div', {class: 'meeting-time'}, h('b', {text: m.start.toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'})}), h('small', {text: m.start.toLocaleDateString('pt-BR', {weekday: 'short', day: '2-digit', month: '2-digit'})})),
    h('div', {class: 'meeting-body'}, h('h3', {text: m.title}), m.description ? h('p', {class: 'meeting-desc', text: m.description}) : null, h('small', {text: m.duration_min + ' min'})),
    live ? h('div', {class: 'meeting-actions'}, joinButton(m)) : null);
  return h('div', {class: 'portal-panel'},
    h('div', {class: 'quick-actions'}, h('button', {class: 'button gold', type: 'button', disabled: actionsLocked(), onclick: () => openRequest('reuniao')}, 'Pedir reunião')),
    waiting.length ? h('div', {class: 'notice'}, h('b', {text: 'Pedidos aguardando agendamento: '}), waiting.map(t => t.subject + (t.priority === 'urgente' ? ' (emergencial)' : '')).join(' · ')) : null,
    h('h2', {class: 'portal-sub', text: 'Próximas reuniões'}),
    upcoming.length ? upcoming.map(m => row(m, true)) : h('p', {class: 'empty', text: 'Nenhuma reunião marcada.'}),
    past.length ? h('details', {class: 'agenda-past'}, h('summary', {text: 'Reuniões anteriores'}), h('div', {class: 'agenda-list'}, past.map(m => row(m, false)))) : null);
}

function renderTickets() {
  const list = portal.data.tickets;
  return h('div', {class: 'portal-panel'},
    h('div', {class: 'quick-actions'}, h('button', {class: 'button gold', type: 'button', disabled: actionsLocked(), onclick: () => openRequest('suporte')}, 'Abrir chamado'),
      h('button', {class: 'chip', type: 'button', disabled: actionsLocked(), onclick: () => openRequest('reuniao')}, 'Pedir reunião')),
    list.length ? h('ul', {class: 'ticket-list'}, list.map(t => h('li', {},
      h('button', {type: 'button', class: 'ticket-row' + (t.status === 'aguardando_cliente' ? ' fresh' : ''), onclick: () => openThread(t.id)},
        h('span', {class: 'ticket-kind', text: TICKET_KIND[t.kind]}), h('b', {text: t.subject}),
        h('span', {class: 'prio prio-' + t.priority, text: PRIORITY[t.priority]}), chip(statusForClient(t.status), 'tk-' + t.status),
        h('small', {text: 'Atualizado em ' + dateTimeBR(t.updated_at)}))))) : h('p', {class: 'empty', text: 'Nenhum chamado aberto até agora.'}));
}

function renderFiles() {
  const filters = [['todos', 'Todos'], ['relatorio', 'Relatórios'], ['documento', 'Documentos'], ['contrato', 'Contratos']];
  const list = portal.data.files.filter(f => portal.fileFilter === 'todos' || f.category === portal.fileFilter);
  return h('div', {class: 'portal-panel'},
    h('div', {class: 'filter-chips', role: 'group', 'aria-label': 'Filtrar por tipo'}, filters.map(([key, label]) =>
      h('button', {type: 'button', class: 'chip', 'aria-pressed': String(portal.fileFilter === key), onclick: () => { portal.fileFilter = key; render(); }}, label))),
    list.length ? h('ul', {class: 'file-list'}, list.map(f => h('li', {},
      h('span', {class: 'file-cat', text: FILE_CATEGORY[f.category]}),
      h('div', {}, h('b', {text: f.title}), h('small', {text: dateBR(f.created_at.slice(0, 10)) + (f.file_name ? ' · ' + f.file_name + ' · ' + sizeLabel(f.size_bytes) : '')}), f.description ? h('p', {text: f.description}) : null),
      f.storage_path ? h('button', {class: 'chip', type: 'button', text: 'Baixar', onclick: () => openStoredFile(f.storage_path, f.file_name).catch(err => toast(friendlyError(err), true))})
        : h('a', {class: 'chip', href: f.link_url, target: '_blank', rel: 'noopener noreferrer', text: 'Abrir'})))) : h('p', {class: 'empty', text: 'Nada por aqui ainda.'}));
}

function renderInvoices() {
  const list = portal.data.invoices;
  const open = list.filter(i => i.status === 'aberta');
  const download = (path, name, label) => h('button', {class: 'chip', type: 'button', text: label, onclick: () => openStoredFile(path, name).catch(err => toast(friendlyError(err), true))});
  return h('div', {class: 'portal-panel'},
    h('div', {class: 'finance-summary'},
      h('div', {}, h('small', {text: 'Em aberto'}), h('strong', {text: money.format(open.reduce((s, i) => s + Number(i.amount), 0))})),
      h('div', {}, h('small', {text: 'Vencidas'}), h('strong', {text: String(open.filter(i => invoiceState(i)[0] === 'Vencida').length)})),
      h('div', {}, h('small', {text: 'Pagas (total)'}), h('strong', {text: money.format(list.filter(i => i.status === 'paga').reduce((s, i) => s + Number(i.amount), 0))}))),
    list.length ? h('div', {class: 'table-wrap'}, h('table', {class: 'team-table invoice-table'},
      h('thead', {}, h('tr', {}, ['Fatura', 'Valor', 'Vencimento', 'Situação', ''].map(t => h('th', {scope: 'col', text: t})))),
      h('tbody', {}, list.map(i => { const [label, cls] = invoiceState(i); return h('tr', {},
        h('td', {}, h('b', {text: i.description}), i.number ? h('small', {class: 'mono', text: ' nº ' + i.number}) : null),
        h('td', {class: 'mono', text: money.format(Number(i.amount))}),
        h('td', {text: dateBR(i.due_date) + (i.status === 'paga' && i.paid_at ? ' · paga em ' + dateBR(i.paid_at) : '')}),
        h('td', {}, chip(label, cls)),
        h('td', {class: 'row-actions'},
          i.payment_url && i.status === 'aberta' ? h('a', {class: 'button gold small', href: i.payment_url, target: '_blank', rel: 'noopener noreferrer', text: 'Pagar'}) : null,
          i.boleto_path ? download(i.boleto_path, i.boleto_name, 'Boleto') : null,
          i.nota_path ? download(i.nota_path, i.nota_name, 'Nota fiscal') : null)); })))) : h('p', {class: 'empty', text: 'Nenhuma fatura cadastrada.'}));
}

// ---------- Pedidos (reunião e chamado) ----------
const requestDialog = $('#request-dialog'), requestForm = $('#request-form');
function openRequest(kind) {
  if (actionsLocked()) return;
  requestForm.reset();
  requestForm.dataset.kind = kind;
  $('#request-kind').textContent = kind === 'reuniao' ? 'PEDIDO DE REUNIÃO' : 'CHAMADO';
  $('#request-title').textContent = kind === 'reuniao' ? 'Pedir uma reunião' : 'Abrir um chamado';
  requestForm.querySelectorAll('.only-meeting').forEach(el => { el.hidden = kind !== 'reuniao'; });
  requestForm.querySelectorAll('.only-support').forEach(el => { el.hidden = kind === 'reuniao'; });
  $('#request-status').textContent = '';
  requestDialog.showModal();
  requestForm.elements.subject.focus();
}
requestForm.addEventListener('submit', async event => {
  event.preventDefault();
  const f = requestForm.elements, kind = requestForm.dataset.kind;
  const subject = f.subject.value.trim();
  if (!subject) { $('#request-status').textContent = 'Escreva o assunto.'; return; }
  const row = {kind, subject, description: f.description.value.trim(),
    priority: kind === 'reuniao' ? (f.urgency.value === 'urgente' ? 'urgente' : 'normal') : f.priority.value,
    preferred_times: kind === 'reuniao' ? f.preferred_times.value.trim() : ''};
  const {error} = await sb.from('client_tickets').insert(row);
  if (error) { $('#request-status').textContent = friendlyError(error); return; }
  requestDialog.close();
  toast(kind === 'reuniao' ? 'Pedido de reunião enviado. A equipe DECET vai marcar o horário e ele aparece em "Reuniões".' : 'Chamado aberto. A equipe DECET responde por aqui.');
  portal.tab = kind === 'reuniao' ? 'reunioes' : 'chamados';
  loadPortal();
});

// ---------- Conversa do chamado ----------
const threadDialog = $('#ticket-view-dialog'), threadForm = $('#ticket-view-form');
async function openThread(id) {
  const t = portal.data.tickets.find(x => x.id === id);
  if (!t) return;
  portal.ticket = t;
  $('#ticket-view-kind').textContent = TICKET_KIND[t.kind].toUpperCase();
  $('#ticket-view-title').textContent = t.subject;
  const meeting = t.meeting_id && portal.data.meetings.find(m => m.id === t.meeting_id);
  $('#ticket-view-meta').textContent = statusForClient(t.status) + ' · prioridade ' + PRIORITY[t.priority].toLowerCase() + ' · aberto em ' + dateTimeBR(t.created_at)
    + (meeting ? ' · reunião marcada para ' + meetingFormat.format(meeting.start) : '');
  $('#ticket-view-desc').textContent = t.description || '';
  const closed = t.status === 'resolvido' || t.status === 'cancelado';
  $('#ticket-view-reply').hidden = actionsLocked() || closed;
  $('#ticket-view-send').hidden = actionsLocked() || closed;
  threadForm.elements.body.value = '';
  if (!threadDialog.open) threadDialog.showModal();
  await loadThread(id);
}
async function loadThread(id) {
  const {data, error} = await sb.from('client_ticket_messages').select('id, body, author_name, author_kind, created_at').eq('ticket_id', id).order('created_at');
  if (error || portal.ticket?.id !== id) return;
  $('#ticket-view-thread').replaceChildren(...(data.length ? data.map(m => h('li', {class: 'msg-' + (m.author_kind === 'cliente' ? 'equipe' : 'cliente')},
    h('header', {}, h('b', {text: m.author_kind === 'equipe' ? (m.author_name || 'Equipe') + ' · DECET' : (m.author_name || 'Você')}), h('time', {text: dateTimeBR(m.created_at)})),
    h('p', {text: m.body}))) : [h('li', {class: 'empty', text: 'Ainda sem respostas. A equipe DECET responde por aqui.'})]));
}
threadForm.addEventListener('submit', async event => {
  event.preventDefault();
  const body = threadForm.elements.body.value.trim();
  if (!body || !portal.ticket || actionsLocked()) return;
  const {error} = await sb.from('client_ticket_messages').insert({ticket_id: portal.ticket.id, body});
  if (error) return toast(friendlyError(error), true);
  threadForm.elements.body.value = '';
  loadThread(portal.ticket.id);
});
threadDialog.addEventListener('close', () => { portal.ticket = null; });

document.addEventListener('DOMContentLoaded', async () => {
  const {data: {session}} = await sb.auth.getSession();
  if (session) await enterPortal(session.user); else showAuth();
});

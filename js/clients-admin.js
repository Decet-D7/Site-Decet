'use strict';
// Aba "Clientes" do espaço do time: empresas, acessos dos clientes (só admins), serviços e marcos,
// reuniões, chamados (com conversa e "agendar reunião"), arquivos e financeiro. Tudo em tempo real.

const cx = {
  clients: [], selected: null, tab: 'servicos', search: '',
  openTickets: [],                       // chamados em aberto de todas as empresas (alertas e contadores)
  data: {services: [], milestones: [], tickets: [], files: [], invoices: [], users: []},
  ticket: null, messages: [], reloadTimer: null, seenTickets: null,
};
const cxDetail = $('#client-detail'), cxList = $('#clients-ul'), cxAlert = $('#client-alert');
const CX_TABS = [['servicos', 'Serviços e prazos'], ['reunioes', 'Reuniões'], ['chamados', 'Chamados'], ['arquivos', 'Arquivos'], ['financeiro', 'Financeiro'], ['acessos', 'Acessos']];
const cxStatusChip = (label, cls) => h('span', {class: 'status ' + cls, text: label});

// ---------- Carregar ----------
async function cxLoadClients() {
  const [clients, tickets] = await Promise.all([
    sb.from('clients').select('id, name, notes, active, created_at').order('name'),
    sb.from('client_tickets').select('id, client_id, kind, priority, status, subject, created_at, created_by_name').in('status', [...OPEN_TICKET]).order('created_at', {ascending: false}),
  ]);
  if (clients.error) return toast(friendlyError(clients.error), true);
  cx.clients = clients.data;
  clientDirectory.clear();
  cx.clients.forEach(c => clientDirectory.set(c.id, c));
  cx.openTickets = tickets.data || [];
  cxAlertNew();
  if (cx.selected && !clientDirectory.has(cx.selected)) cx.selected = null;
  if (!cx.selected && cx.clients.length) cx.selected = cx.clients[0].id;
  cxRenderList();
  if (agenda.loaded) renderAgenda();
  await cxLoadDetail();
}
async function cxLoadDetail() {
  const id = cx.selected;
  if (!id) { cxRenderDetail(); return; }
  const by = table => sb.from(table).select('*').eq('client_id', id);
  const [services, milestones, tickets, files, invoices, users] = await Promise.all([
    by('client_services').order('created_at'), by('client_milestones').order('position').order('due_date'),
    by('client_tickets').order('updated_at', {ascending: false}), by('client_files').order('created_at', {ascending: false}),
    by('client_invoices').order('due_date', {ascending: false}),
    sb.from('client_users').select('email, client_id, name, active, user_id, created_at').eq('client_id', id).order('name'),
  ]);
  const failed = [services, milestones, tickets, files, invoices, users].find(r => r.error);
  if (failed) return toast(friendlyError(failed.error), true);
  if (id !== cx.selected) return;
  cx.data = {services: services.data, milestones: milestones.data, tickets: tickets.data, files: files.data, invoices: invoices.data, users: users.data};
  cxRenderDetail();
  if (cx.ticket) cxLoadMessages(cx.ticket.id);
}
const cxReload = () => { clearTimeout(cx.reloadTimer); cx.reloadTimer = setTimeout(cxLoadClients, 250); };

// Alerta para pedido novo de cliente (chamado ou reunião), com destaque para o urgente.
function cxAlertNew() {
  const ids = new Set(cx.openTickets.map(t => t.id));
  const fresh = cx.seenTickets ? cx.openTickets.filter(t => !cx.seenTickets.has(t.id) && t.status === 'aberto') : [];
  cx.seenTickets = ids;
  const waiting = cx.openTickets.filter(t => t.status === 'aberto').length;
  const nav = document.querySelector('.nav-item[data-view="clients"]');
  nav.classList.toggle('has-badge', waiting > 0);
  nav.querySelector('.nav-badge').title = waiting ? waiting + ' pedido(s) de clientes aguardando' : '';
  const urgent = cx.openTickets.find(t => t.status === 'aberto' && t.priority === 'urgente');
  cxAlert.hidden = !urgent;
  if (urgent) {
    cxAlert.replaceChildren(h('span', {class: 'dot', 'aria-hidden': 'true'}),
      h('span', {text: (urgent.kind === 'reuniao' ? 'Pedido de reunião URGENTE' : 'Chamado URGENTE') + ' de ' + (clientDirectory.get(urgent.client_id)?.name || 'cliente') + ': ' + urgent.subject}),
      h('button', {class: 'chip', type: 'button', text: 'Ver', onclick: () => { cx.selected = urgent.client_id; cx.tab = 'chamados'; showView('clients'); cxLoadDetail().then(() => cxOpenTicket(urgent.id)); }}));
  }
  fresh.forEach(t => toast((t.kind === 'reuniao' ? 'Pedido de reunião' : 'Novo chamado') + ' de ' + (clientDirectory.get(t.client_id)?.name || 'cliente') + ': ' + t.subject));
}

// ---------- Lista de empresas ----------
function cxRenderList() {
  const q = cx.search;
  const items = cx.clients.filter(c => !q || c.name.toLowerCase().includes(q));
  cxList.replaceChildren(...(items.length ? items.map(c => {
    const open = cx.openTickets.filter(t => t.client_id === c.id && t.status === 'aberto').length;
    return h('li', {}, h('button', {type: 'button', class: 'client-item' + (c.id === cx.selected ? ' active' : '') + (c.active ? '' : ' inactive'),
      onclick: () => { cx.selected = c.id; cx.ticket = null; cxRenderList(); cxLoadDetail(); }},
      h('span', {class: 'client-name', text: c.name}), c.active ? null : h('small', {text: 'desativada'}),
      open ? h('span', {class: 'count', text: String(open), title: open + ' pedido(s) aguardando'}) : null));
  }) : [h('li', {class: 'empty', text: cx.clients.length ? 'Nenhuma empresa encontrada.' : 'Nenhuma empresa cadastrada.'})]));
}
$('#clients-search').addEventListener('input', e => { cx.search = e.target.value.trim().toLowerCase(); cxRenderList(); });

// ---------- Detalhe da empresa ----------
function cxRenderDetail() {
  const c = clientDirectory.get(cx.selected);
  if (!c) { cxDetail.replaceChildren(h('p', {class: 'empty', text: team.isAdmin ? 'Cadastre a primeira empresa em "Nova empresa".' : 'Nenhuma empresa cadastrada ainda. Um administrador cadastra as empresas.'})); return; }
  const d = cx.data;
  const counts = {servicos: d.services.length, reunioes: agenda.items.filter(m => m.client_id === c.id && m.end.getTime() >= Date.now()).length,
    chamados: d.tickets.filter(t => OPEN_TICKET.has(t.status)).length, arquivos: d.files.length, financeiro: d.invoices.filter(i => i.status === 'aberta').length, acessos: d.users.length};
  const tabs = h('div', {class: 'sub-tabs', role: 'tablist'}, CX_TABS.filter(([k]) => k !== 'acessos' || team.isAdmin).map(([key, label]) =>
    h('button', {type: 'button', role: 'tab', 'aria-selected': String(cx.tab === key), onclick: () => { cx.tab = key; cxRenderDetail(); }}, label, counts[key] ? h('span', {class: 'count', text: String(counts[key])}) : null)));
  const panel = ({servicos: cxServices, reunioes: cxMeetings, chamados: cxTickets, arquivos: cxFiles, financeiro: cxInvoices, acessos: cxUsers}[cx.tab] || cxServices)(c);
  cxDetail.replaceChildren(
    h('header', {class: 'client-head'},
      h('div', {}, h('h2', {text: c.name}), c.notes ? h('p', {class: 'client-notes', text: c.notes}) : null),
      h('div', {class: 'head-actions'}, c.active ? null : cxStatusChip('Desativada', 'off'),
        team.isAdmin ? h('button', {class: 'chip', type: 'button', text: 'Editar empresa', onclick: () => cxOpenClient(c)}) : null)),
    tabs, panel);
}

// --- Serviços e marcos
function cxServices(c) {
  const list = cx.data.services;
  return h('div', {class: 'sub-panel'},
    h('div', {class: 'panel-actions'}, h('button', {class: 'button gold', type: 'button', text: 'Novo serviço', onclick: () => cxOpenService(null, c)})),
    list.length ? list.map(s => {
      const marks = cx.data.milestones.filter(m => m.service_id === s.id);
      const addForm = h('form', {class: 'milestone-add'},
        h('input', {name: 'title', maxlength: '160', placeholder: 'Novo marco ou entrega', 'aria-label': 'Novo marco'}),
        h('input', {name: 'due_date', type: 'date', 'aria-label': 'Prazo do marco'}), h('button', {class: 'chip', type: 'submit', text: 'Adicionar'}));
      addForm.addEventListener('submit', async e => {
        e.preventDefault();
        const title = addForm.elements.title.value.trim();
        if (!title) return;
        const last = marks[marks.length - 1];
        const {error} = await sb.from('client_milestones').insert({service_id: s.id, client_id: s.client_id, title, due_date: addForm.elements.due_date.value || null, position: last ? last.position + 1 : 1});
        if (error) return toast(friendlyError(error), true);
        cxLoadDetail();
      });
      return h('article', {class: 'service-card'},
        h('div', {class: 'service-top'}, h('h3', {text: s.title}), cxStatusChip(SERVICE_STATUS[s.status], 'svc-' + s.status),
          h('button', {class: 'chip', type: 'button', text: 'Editar', onclick: () => cxOpenService(s, c)})),
        s.description ? h('p', {class: 'service-desc', text: s.description}) : null,
        h('div', {class: 'progress', role: 'progressbar', 'aria-valuenow': String(s.progress), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': 'Progresso'}, h('i', {style: 'width:' + s.progress + '%'})),
        h('p', {class: 'service-meta', text: s.progress + '% · início ' + dateBR(s.start_date) + ' · prazo ' + dateBR(s.due_date)}),
        h('ul', {class: 'milestones'}, marks.map(m => h('li', {class: deadlineClass(m.due_date, m.done)},
          h('label', {class: 'check'}, h('input', {type: 'checkbox', checked: m.done, onchange: async e => { const {error} = await sb.from('client_milestones').update({done: e.target.checked}).eq('id', m.id); if (error) toast(friendlyError(error), true); cxLoadDetail(); }}), h('span', {text: m.title})),
          h('span', {class: 'due', text: m.due_date ? dateBR(m.due_date) : 'sem prazo'}),
          h('button', {class: 'icon-x', type: 'button', 'aria-label': 'Remover marco ' + m.title, text: '×', onclick: async () => { if (!confirm('Remover o marco "' + m.title + '"?')) return; await sb.from('client_milestones').delete().eq('id', m.id); cxLoadDetail(); }})))),
        addForm);
    }) : h('p', {class: 'empty', text: 'Nenhum serviço cadastrado para esta empresa.'}));
}
const cxServiceDialog = $('#service-dialog'), cxServiceForm = $('#service-form');
let cxEditingService = null;
function cxOpenService(s, c) {
  cxEditingService = s;
  cxServiceForm.reset();
  $('#service-dialog-title').textContent = s ? 'Editar serviço' : 'Novo serviço · ' + c.name;
  const f = cxServiceForm.elements;
  f.title.value = s?.title || ''; f.description.value = s?.description || ''; f.status.value = s?.status || 'planejamento';
  f.progress.value = s?.progress ?? 0; f.start_date.value = s?.start_date || ''; f.due_date.value = s?.due_date || '';
  $('#service-progress-out').textContent = f.progress.value + '%';
  $('#service-delete').hidden = !s;
  $('#service-status').textContent = '';
  cxServiceDialog.showModal();
}
cxServiceForm.elements.progress.addEventListener('input', e => { $('#service-progress-out').textContent = e.target.value + '%'; });
cxServiceForm.addEventListener('submit', async e => {
  e.preventDefault();
  const f = cxServiceForm.elements;
  const row = {title: f.title.value.trim(), description: f.description.value.trim(), status: f.status.value, progress: Number(f.progress.value),
    start_date: f.start_date.value || null, due_date: f.due_date.value || null};
  if (!row.title) { $('#service-status').textContent = 'Dê um nome ao serviço.'; return; }
  const {error} = cxEditingService ? await sb.from('client_services').update(row).eq('id', cxEditingService.id) : await sb.from('client_services').insert({...row, client_id: cx.selected});
  if (error) { $('#service-status').textContent = friendlyError(error); return; }
  cxServiceDialog.close();
  cxLoadDetail();
});
$('#service-delete').addEventListener('click', async () => {
  if (!cxEditingService || !confirm('Excluir o serviço "' + cxEditingService.title + '" e os marcos dele?')) return;
  const {error} = await sb.from('client_services').delete().eq('id', cxEditingService.id);
  if (error) { $('#service-status').textContent = friendlyError(error); return; }
  cxServiceDialog.close();
  cxLoadDetail();
});

// --- Reuniões (da agenda, filtradas pela empresa)
function cxMeetings(c) {
  const mine = agenda.items.filter(m => m.client_id === c.id);
  const upcoming = mine.filter(m => m.end.getTime() >= Date.now()), past = mine.filter(m => m.end.getTime() < Date.now()).reverse();
  return h('div', {class: 'sub-panel'},
    h('div', {class: 'panel-actions'}, h('button', {class: 'button gold', type: 'button', text: 'Agendar reunião', onclick: () => openMeeting(null, {client_id: c.id})})),
    upcoming.length ? upcoming.map(m => { const item = meetingItem(m); item.querySelector('.meeting-time').prepend(h('small', {text: shortDay.format(m.start)})); return item; })
      : h('p', {class: 'empty', text: 'Nenhuma reunião marcada com esta empresa.'}),
    past.length ? h('details', {class: 'agenda-past'}, h('summary', {text: 'Reuniões anteriores'}), h('div', {class: 'agenda-list'}, past.map(m => { const item = meetingItem(m); item.querySelector('.meeting-time').prepend(h('small', {text: shortDay.format(m.start)})); return item; }))) : null);
}

// --- Chamados
function cxTickets(c) {
  const list = cx.data.tickets;
  return h('div', {class: 'sub-panel'},
    h('div', {class: 'panel-actions'}, h('p', {class: 'view-note', text: 'Chamados e pedidos de reunião abertos pelo cliente na área dele. Clique para responder, mudar a situação ou agendar.'})),
    list.length ? h('ul', {class: 'ticket-list'}, list.map(t => h('li', {},
      h('button', {type: 'button', class: 'ticket-row' + (t.status === 'aberto' ? ' fresh' : ''), onclick: () => cxOpenTicket(t.id)},
        h('span', {class: 'ticket-kind', text: TICKET_KIND[t.kind]}), h('b', {text: t.subject}),
        h('span', {class: 'prio prio-' + t.priority, text: PRIORITY[t.priority]}), cxStatusChip(TICKET_STATUS[t.status], 'tk-' + t.status),
        h('small', {text: (t.created_by_name || '—') + ' · ' + dateTimeBR(t.updated_at)}))))) : h('p', {class: 'empty', text: 'Nenhum chamado desta empresa.'}));
}
const cxTicketDialog = $('#team-ticket-dialog');
async function cxOpenTicket(id) {
  const t = cx.data.tickets.find(x => x.id === id);
  if (!t) return;
  cx.ticket = t;
  const f = $('#team-ticket-form').elements;
  $('#team-ticket-title').textContent = t.subject;
  $('#team-ticket-meta').textContent = TICKET_KIND[t.kind] + ' · prioridade ' + PRIORITY[t.priority].toLowerCase() + ' · aberto por ' + (t.created_by_name || '—') + ' em ' + dateTimeBR(t.created_at);
  $('#team-ticket-desc').textContent = t.description || '(sem descrição)';
  $('#team-ticket-times').hidden = !(t.kind === 'reuniao' && t.preferred_times);
  $('#team-ticket-times').textContent = 'Horários de preferência: ' + t.preferred_times;
  f.status.value = t.status;
  const meeting = t.meeting_id && agenda.items.find(m => m.id === t.meeting_id);
  $('#team-ticket-meeting').textContent = meeting ? 'Reunião marcada: ' + meeting.title + ', ' + shortDay.format(meeting.start) + ' às ' + hourFormat.format(meeting.start) : '';
  $('#team-ticket-schedule').hidden = t.kind !== 'reuniao' || !!t.meeting_id;
  f.body.value = '';
  if (!cxTicketDialog.open) cxTicketDialog.showModal();
  await cxLoadMessages(id);
}
async function cxLoadMessages(id) {
  const {data, error} = await sb.from('client_ticket_messages').select('id, body, author_name, author_kind, created_at').eq('ticket_id', id).order('created_at');
  if (error || cx.ticket?.id !== id) return;
  $('#team-ticket-thread').replaceChildren(...(data.length ? data.map(m => h('li', {class: 'msg-' + m.author_kind},
    h('header', {}, h('b', {text: (m.author_name || '—') + (m.author_kind === 'cliente' ? ' (cliente)' : ' (DECET)')}), h('time', {text: dateTimeBR(m.created_at)})),
    h('p', {text: m.body}))) : [h('li', {class: 'empty', text: 'Sem mensagens ainda.'})]));
}
$('#team-ticket-form').elements.status.addEventListener('change', async e => {
  if (!cx.ticket) return;
  const {error} = await sb.from('client_tickets').update({status: e.target.value}).eq('id', cx.ticket.id);
  if (error) return toast(friendlyError(error), true);
  toast('Situação do chamado: ' + TICKET_STATUS[e.target.value] + '.');
  cxReload();
});
$('#team-ticket-form').addEventListener('submit', async e => {
  e.preventDefault();
  const body = e.target.elements.body.value.trim();
  if (!body || !cx.ticket) return;
  const {error} = await sb.from('client_ticket_messages').insert({ticket_id: cx.ticket.id, body});
  if (error) return toast(friendlyError(error), true);
  e.target.elements.body.value = '';
  cxLoadMessages(cx.ticket.id);
});
$('#team-ticket-schedule').addEventListener('click', () => {
  const t = cx.ticket;
  if (!t) return;
  cxTicketDialog.close();
  openMeeting(null, {client_id: t.client_id, ticket_id: t.id, title: t.subject, description: [t.description, t.preferred_times && 'Horários de preferência: ' + t.preferred_times].filter(Boolean).join('\n\n')});
});
cxTicketDialog.addEventListener('close', () => { cx.ticket = null; });

// --- Arquivos (relatórios, documentos, contratos)
function cxFiles(c) {
  const list = cx.data.files;
  return h('div', {class: 'sub-panel'},
    h('div', {class: 'panel-actions'}, h('button', {class: 'button gold', type: 'button', text: 'Adicionar arquivo ou link', onclick: () => cxOpenFile(c)})),
    list.length ? h('ul', {class: 'file-list'}, list.map(f => h('li', {},
      h('span', {class: 'file-cat', text: FILE_CATEGORY[f.category]}),
      h('div', {}, h('b', {text: f.title}), h('small', {text: dateBR(f.created_at.slice(0, 10)) + (f.file_name ? ' · ' + f.file_name + ' · ' + sizeLabel(f.size_bytes) : ' · link')}), f.description ? h('p', {text: f.description}) : null),
      f.storage_path ? h('button', {class: 'chip', type: 'button', text: 'Baixar', onclick: () => openStoredFile(f.storage_path, f.file_name).catch(err => toast(friendlyError(err), true))})
        : h('a', {class: 'chip', href: f.link_url, target: '_blank', rel: 'noopener noreferrer', text: 'Abrir link'}),
      h('button', {class: 'chip danger', type: 'button', text: 'Remover', onclick: async () => {
        if (!confirm('Remover "' + f.title + '"? O cliente deixa de ver.')) return;
        if (f.storage_path) await sb.storage.from(CLIENT_BUCKET).remove([f.storage_path]);
        const {error} = await sb.from('client_files').delete().eq('id', f.id);
        if (error) return toast(friendlyError(error), true);
        cxLoadDetail();
      }})))) : h('p', {class: 'empty', text: 'Nenhum relatório, documento ou contrato enviado.'}));
}
const cxFileDialog = $('#file-dialog'), cxFileForm = $('#file-form');
function cxOpenFile(c) {
  cxFileForm.reset();
  $('#file-dialog-title').textContent = 'Adicionar para ' + c.name;
  cxFileForm.elements.service_id.replaceChildren(h('option', {value: '', text: 'Nenhum serviço específico'}), ...cx.data.services.map(s => h('option', {value: s.id, text: s.title})));
  cxFileMode();
  $('#file-status').textContent = '';
  cxFileDialog.showModal();
}
function cxFileMode() {
  const link = cxFileForm.elements.mode.value === 'link';
  $('#file-pick').hidden = link;
  $('#file-link').hidden = !link;
}
cxFileForm.querySelectorAll('input[name="mode"]').forEach(r => r.addEventListener('change', cxFileMode));
cxFileForm.addEventListener('submit', async e => {
  e.preventDefault();
  const f = cxFileForm.elements, status = $('#file-status');
  const row = {client_id: cx.selected, category: f.category.value, title: f.title.value.trim(), description: f.description.value.trim(), service_id: f.service_id.value || null};
  if (!row.title) { status.textContent = 'Dê um título.'; return; }
  try {
    if (f.mode.value === 'link') {
      const url = f.link_url.value.trim();
      if (!/^https?:\/\//i.test(url)) { status.textContent = 'O link precisa começar com https://'; return; }
      row.link_url = url;
    } else {
      const file = f.file.files[0];
      if (!file) { status.textContent = 'Escolha um arquivo.'; return; }
      status.textContent = 'Enviando…';
      const up = await uploadClientFile(cx.selected, file);
      Object.assign(row, {storage_path: up.path, file_name: up.name, size_bytes: up.size, mime_type: up.mime});
    }
    const {error} = await sb.from('client_files').insert(row);
    if (error) {
      if (row.storage_path) await sb.storage.from(CLIENT_BUCKET).remove([row.storage_path]);
      throw error;
    }
    cxFileDialog.close();
    toast('Enviado. O cliente já vê na área dele.');
    cxLoadDetail();
  } catch (err) { status.textContent = friendlyError(err); }
});

// --- Financeiro
function cxInvoices(c) {
  const list = cx.data.invoices;
  const open = list.filter(i => i.status === 'aberta').reduce((sum, i) => sum + Number(i.amount), 0);
  return h('div', {class: 'sub-panel'},
    h('div', {class: 'panel-actions'}, h('p', {class: 'view-note', text: 'Em aberto: ' + money.format(open)}), h('button', {class: 'button gold', type: 'button', text: 'Nova fatura', onclick: () => cxOpenInvoice(null, c)})),
    list.length ? h('div', {class: 'table-wrap'}, h('table', {class: 'team-table invoice-table'},
      h('thead', {}, h('tr', {}, ['Fatura', 'Valor', 'Vencimento', 'Situação', 'Anexos', ''].map(t => h('th', {scope: 'col', text: t})))),
      h('tbody', {}, list.map(i => { const [label, cls] = invoiceState(i); return h('tr', {},
        h('td', {}, h('b', {text: i.description}), i.number ? h('small', {class: 'mono', text: ' nº ' + i.number}) : null),
        h('td', {class: 'mono', text: money.format(Number(i.amount))}), h('td', {text: dateBR(i.due_date)}), h('td', {}, cxStatusChip(label, cls)),
        h('td', {class: 'row-actions'}, i.boleto_path ? h('button', {class: 'chip', type: 'button', text: 'Boleto', onclick: () => openStoredFile(i.boleto_path, i.boleto_name)}) : null,
          i.nota_path ? h('button', {class: 'chip', type: 'button', text: 'Nota', onclick: () => openStoredFile(i.nota_path, i.nota_name)}) : null,
          i.payment_url ? h('a', {class: 'chip', href: i.payment_url, target: '_blank', rel: 'noopener noreferrer', text: 'Link'}) : null),
        h('td', {}, h('button', {class: 'chip', type: 'button', text: 'Editar', onclick: () => cxOpenInvoice(i, c)}))); })))) : h('p', {class: 'empty', text: 'Nenhuma fatura cadastrada.'}));
}
const cxInvoiceDialog = $('#invoice-dialog'), cxInvoiceForm = $('#invoice-form');
let cxEditingInvoice = null;
function cxOpenInvoice(i, c) {
  cxEditingInvoice = i;
  cxInvoiceForm.reset();
  $('#invoice-dialog-title').textContent = i ? 'Editar fatura' : 'Nova fatura · ' + c.name;
  const f = cxInvoiceForm.elements;
  f.number.value = i?.number || ''; f.description.value = i?.description || ''; f.amount.value = i ? String(i.amount).replace('.', ',') : '';
  f.due_date.value = i?.due_date || ''; f.status.value = i?.status || 'aberta'; f.paid_at.value = i?.paid_at || ''; f.payment_url.value = i?.payment_url || '';
  $('#invoice-boleto-now').textContent = i?.boleto_name ? 'Atual: ' + i.boleto_name : '';
  $('#invoice-nota-now').textContent = i?.nota_name ? 'Atual: ' + i.nota_name : '';
  $('#invoice-delete').hidden = !i;
  $('#invoice-status').textContent = '';
  cxInvoiceDialog.showModal();
}
cxInvoiceForm.addEventListener('submit', async e => {
  e.preventDefault();
  const f = cxInvoiceForm.elements, status = $('#invoice-status');
  const rawAmount = f.amount.value.replace(/R\$|\s/g, '');
  const amount = Number(rawAmount.includes(',') ? rawAmount.replace(/\./g, '').replace(',', '.') : rawAmount);
  const row = {number: f.number.value.trim(), description: f.description.value.trim(), amount, due_date: f.due_date.value, status: f.status.value,
    paid_at: f.paid_at.value || (f.status.value === 'paga' ? todayISO() : null), payment_url: f.payment_url.value.trim() || null};
  if (!row.description || !Number.isFinite(amount) || amount < 0 || !row.due_date) { status.textContent = 'Preencha descrição, valor e vencimento.'; return; }
  if (row.payment_url && !/^https?:\/\//i.test(row.payment_url)) { status.textContent = 'O link de pagamento precisa começar com https://'; return; }
  try {
    status.textContent = 'Salvando…';
    const uploaded = [];
    for (const kind of ['boleto', 'nota']) {
      const file = f[kind].files[0];
      if (!file) continue;
      const up = await uploadClientFile(cx.selected, file);
      uploaded.push(up.path);
      row[kind + '_path'] = up.path; row[kind + '_name'] = up.name;
    }
    const {error} = cxEditingInvoice ? await sb.from('client_invoices').update(row).eq('id', cxEditingInvoice.id) : await sb.from('client_invoices').insert({...row, client_id: cx.selected});
    if (error) { if (uploaded.length) await sb.storage.from(CLIENT_BUCKET).remove(uploaded); throw error; }
    // Anexo substituído: apaga o arquivo antigo.
    const old = cxEditingInvoice ? ['boleto', 'nota'].filter(k => row[k + '_path'] && cxEditingInvoice[k + '_path']).map(k => cxEditingInvoice[k + '_path']) : [];
    if (old.length) await sb.storage.from(CLIENT_BUCKET).remove(old);
    cxInvoiceDialog.close();
    cxLoadDetail();
  } catch (err) { status.textContent = friendlyError(err); }
});
$('#invoice-delete').addEventListener('click', async () => {
  const i = cxEditingInvoice;
  if (!i || !confirm('Excluir a fatura "' + i.description + '"?')) return;
  const paths = [i.boleto_path, i.nota_path].filter(Boolean);
  if (paths.length) await sb.storage.from(CLIENT_BUCKET).remove(paths);
  const {error} = await sb.from('client_invoices').delete().eq('id', i.id);
  if (error) { $('#invoice-status').textContent = friendlyError(error); return; }
  cxInvoiceDialog.close();
  cxLoadDetail();
});

// --- Acessos (só administradores)
function cxUsers(c) {
  const list = cx.data.users;
  return h('div', {class: 'sub-panel'},
    h('div', {class: 'panel-actions'}, h('p', {class: 'view-note', text: 'Quem é cadastrado aqui recebe um código de convite e cria a senha em "Primeiro acesso", na área do cliente.'}),
      h('button', {class: 'button gold', type: 'button', text: 'Cadastrar acesso', onclick: () => cxOpenUser(c)})),
    list.length ? h('div', {class: 'table-wrap'}, h('table', {class: 'team-table'},
      h('thead', {}, h('tr', {}, ['Nome', 'E-mail', 'Situação', ''].map(t => h('th', {scope: 'col', text: t})))),
      h('tbody', {}, list.map(u => {
        const [label, cls] = !u.active ? ['Desativado', 'off'] : u.user_id ? ['Ativo', 'on'] : ['Aguardando primeiro acesso', 'wait'];
        return h('tr', {class: u.active ? '' : 'inactive'}, h('td', {}, h('span', {class: 'who'}, avatar(u.name, 'avatar mini'), h('b', {text: u.name}))),
          h('td', {class: 'mono', text: u.email}), h('td', {}, cxStatusChip(label, cls)),
          h('td', {class: 'row-actions'},
            u.active ? h('button', {class: 'chip', type: 'button', text: u.user_id ? 'Código de nova senha' : 'Código de convite', onclick: () => cxIssueCode(u, u.user_id ? 'reset' : 'invite', c)}) : null,
            h('button', {class: 'chip', type: 'button', text: u.active ? 'Desativar' : 'Reativar', onclick: async () => {
              if (u.active && !confirm('Desativar o acesso de ' + u.name + '? A pessoa perde o acesso na hora.')) return;
              const {error} = await sb.from('client_users').update({active: !u.active}).eq('email', u.email);
              if (error) return toast(friendlyError(error), true);
              cxLoadDetail();
            }}),
            h('button', {class: 'chip danger', type: 'button', text: 'Remover', onclick: async () => {
              if (!confirm('Remover o acesso de ' + u.name + '?')) return;
              const {error} = await sb.from('client_users').delete().eq('email', u.email);
              if (error) return toast(friendlyError(error), true);
              cxLoadDetail();
            }})));
      })))) : h('p', {class: 'empty', text: 'Nenhum acesso cadastrado para esta empresa.'}));
}
const cxUserDialog = $('#client-user-dialog'), cxUserForm = $('#client-user-form');
function cxOpenUser(c) {
  cxUserForm.reset();
  $('#client-user-title').textContent = 'Novo acesso · ' + c.name;
  $('#client-user-status').textContent = '';
  cxUserDialog.showModal();
  cxUserForm.elements.name.focus();
}
cxUserForm.addEventListener('submit', async e => {
  e.preventDefault();
  const f = cxUserForm.elements, status = $('#client-user-status');
  const name = f.name.value.trim(), email = f.email.value.trim().toLowerCase();
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { status.textContent = 'Informe nome e e-mail válidos.'; return; }
  const {error} = await sb.from('client_users').insert({name, email, client_id: cx.selected});
  if (error) { status.textContent = /duplicate key/i.test(error.message) ? 'Esse e-mail já tem acesso cadastrado.' : friendlyError(error); return; }
  cxUserDialog.close();
  await cxLoadDetail();
  cxIssueCode({name, email, user_id: null}, 'invite', clientDirectory.get(cx.selected));
});
async function cxIssueCode(u, kind, c) {
  const {data: code, error} = await sb.rpc('admin_issue_client_code', {p_email: u.email, p_kind: kind});
  if (error) return toast(friendlyError(error), true);
  const site = location.origin + location.pathname.replace(/[^/]*$/, '') + 'cliente.html';
  const invite = kind === 'invite';
  $('#code-dialog-kind').textContent = invite ? 'CÓDIGO DE CONVITE · CLIENTE' : 'CÓDIGO DE NOVA SENHA · CLIENTE';
  $('#code-value').textContent = code;
  $('#code-help').textContent = invite ? 'Vale por 7 dias e só pode ser usado uma vez. Gerar outro invalida este.' : 'Vale por 24 horas. Cinco tentativas erradas invalidam o código.';
  $('#code-message').value = invite
    ? `Olá, ${u.name}! A área do cliente ${c.name} na DECET está pronta. Lá você acompanha serviços, prazos, reuniões, chamados, relatórios e financeiro.\n1. Acesse ${site}\n2. Clique em "Primeiro acesso"\n3. Use o e-mail ${u.email} e o código ${code}\n4. Crie sua senha (mínimo de 8 caracteres).\nO código vale por 7 dias e só pode ser usado uma vez.`
    : `Olá, ${u.name}! Para criar uma senha nova na área do cliente DECET:\n1. Acesse ${site}\n2. Clique em "Esqueci a senha"\n3. Use o e-mail ${u.email} e o código ${code}\n4. Crie a senha nova (mínimo de 8 caracteres).\nO código vale por 24 horas.`;
  codeDialog.showModal();
}

// --- Empresa (só administradores)
const cxClientDialog = $('#client-dialog'), cxClientForm = $('#client-form');
let cxEditingClient = null;
function cxOpenClient(c = null) {
  cxEditingClient = c;
  cxClientForm.reset();
  $('#client-dialog-title').textContent = c ? 'Editar empresa' : 'Nova empresa';
  cxClientForm.elements.name.value = c?.name || '';
  cxClientForm.elements.notes.value = c?.notes || '';
  cxClientForm.elements.active.checked = c ? c.active : true;
  $('#client-active-row').hidden = !c;
  $('#client-delete').hidden = !c;
  $('#client-status').textContent = '';
  cxClientDialog.showModal();
  cxClientForm.elements.name.focus();
}
$('#client-new').addEventListener('click', () => cxOpenClient());
cxClientForm.addEventListener('submit', async e => {
  e.preventDefault();
  const f = cxClientForm.elements;
  const row = {name: f.name.value.trim(), notes: f.notes.value.trim(), active: f.active.checked};
  if (!row.name) { $('#client-status').textContent = 'Informe o nome da empresa.'; return; }
  const res = cxEditingClient ? await sb.from('clients').update(row).eq('id', cxEditingClient.id).select('id').single() : await sb.from('clients').insert(row).select('id').single();
  if (res.error) { $('#client-status').textContent = friendlyError(res.error); return; }
  cxClientDialog.close();
  cx.selected = res.data.id;
  if (!cxEditingClient) cx.tab = 'acessos';
  cxLoadClients();
});
$('#client-delete').addEventListener('click', async () => {
  const c = cxEditingClient;
  if (!c || !confirm('Excluir a empresa "' + c.name + '" com serviços, chamados, arquivos, faturas e acessos? Isso não pode ser desfeito. Para só bloquear o acesso, desmarque "Empresa ativa".')) return;
  const {data: objects} = await sb.storage.from(CLIENT_BUCKET).list(c.id, {limit: 1000});
  if (objects?.length) await sb.storage.from(CLIENT_BUCKET).remove(objects.map(o => c.id + '/' + o.name));
  const {error} = await sb.from('clients').delete().eq('id', c.id);
  if (error) { $('#client-status').textContent = friendlyError(error); return; }
  cxClientDialog.close();
  cx.selected = null;
  cxLoadClients();
});

// A agenda avisa quando muda: a aba Reuniões e os contadores da empresa aberta acompanham.
function cxAfterAgenda() { if (cx.selected && document.body.dataset.view === 'clients') cxRenderDetail(); }

team.ready.push(() => {
  if (team.isClient) return;
  document.querySelectorAll('.admin-only').forEach(el => { el.hidden = !team.isAdmin; });
  cxLoadClients();
  const channel = sb.channel('clientes');
  ['clients', 'client_users', 'client_services', 'client_milestones', 'client_tickets', 'client_ticket_messages', 'client_files', 'client_invoices']
    .forEach(table => channel.on('postgres_changes', {event: '*', schema: 'public', table}, cxReload));
  channel.subscribe();
});
team.changed.push(() => { document.querySelectorAll('.admin-only').forEach(el => { el.hidden = !team.isAdmin; }); });

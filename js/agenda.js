'use strict';
// Agenda do time: reuniões visíveis para todos os membros, atualizadas em tempo real.
// Cada reunião tem uma sala própria (room_code): quem clicar primeiro em "Entrar" vira o anfitrião.

const agenda = {items: [], loaded: false, reloadTimer: null, editing: null};
const dayFormat = new Intl.DateTimeFormat('pt-BR', {weekday: 'long', day: '2-digit', month: 'long'});
const shortDay = new Intl.DateTimeFormat('pt-BR', {weekday: 'short', day: '2-digit', month: '2-digit'});
const hourFormat = new Intl.DateTimeFormat('pt-BR', {hour: '2-digit', minute: '2-digit'});
const meetingDialog = $('#meeting-dialog'), meetingForm = $('#meeting-form');
const roomLink = code => location.origin + location.pathname + '#sala=' + code;
const pad = n => String(n).padStart(2, '0');
const localDate = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const localTime = d => pad(d.getHours()) + ':' + pad(d.getMinutes());

async function loadMeetings() {
  const since = new Date(Date.now() - 60 * 86400000).toISOString();
  const {data, error} = await sb.from('meetings').select('id, title, description, starts_at, duration_min, room_code, created_by').gte('starts_at', since).order('starts_at');
  if (error) return toast(friendlyError(error), true);
  agenda.items = data.map(m => {
    const start = new Date(m.starts_at);
    return {...m, start, end: new Date(start.getTime() + m.duration_min * 60000)};
  });
  agenda.loaded = true;
  renderAgenda();
}
const scheduleReload = () => { clearTimeout(agenda.reloadTimer); agenda.reloadTimer = setTimeout(loadMeetings, 200); };
const isLive = (m, now = Date.now()) => m.start.getTime() - 5 * 60000 <= now && now <= m.end.getTime();
const canEdit = m => m.created_by === team.user.id || team.isAdmin;

function meetingItem(m) {
  const live = isLive(m);
  return h('article', {class: 'meeting' + (live ? ' live' : '')},
    h('div', {class: 'meeting-time'}, h('b', {text: hourFormat.format(m.start)}), h('small', {text: 'até ' + hourFormat.format(m.end)})),
    h('div', {class: 'meeting-body'},
      h('h3', {}, m.title, live ? h('span', {class: 'live-badge', text: 'Acontecendo agora'}) : null),
      m.description ? h('p', {class: 'meeting-desc', text: m.description}) : null,
      h('small', {text: 'Marcada por ' + team.nameOf(m.created_by) + ' · sala ' + m.room_code})),
    h('div', {class: 'meeting-actions'},
      h('button', {class: live ? 'button gold' : 'chip', type: 'button', 'data-join-room': m.room_code, text: 'Entrar', onclick: () => startCall('auto', m.room_code)}),
      h('button', {class: 'chip', type: 'button', text: 'Copiar link', onclick: () => copyText(roomLink(m.room_code), 'Link da reunião copiado.')}),
      h('button', {class: 'chip', type: 'button', text: 'Calendário (.ics)', title: 'Adicionar ao Google Agenda, Outlook ou Calendário', onclick: () => downloadIcs(m)}),
      canEdit(m) ? h('button', {class: 'chip', type: 'button', text: 'Editar', onclick: () => openMeeting(m)}) : null));
}
function renderAgenda() {
  const now = Date.now();
  const upcoming = agenda.items.filter(m => m.end.getTime() >= now);
  const past = agenda.items.filter(m => m.end.getTime() < now).reverse();
  const list = $('#agenda-list');
  list.replaceChildren();
  if (!upcoming.length) list.append(h('p', {class: 'empty', text: 'Nenhuma reunião marcada. Use "Nova reunião" para agendar.'}));
  let day = '';
  for (const m of upcoming) {
    const key = localDate(m.start);
    if (key !== day) {
      day = key;
      const today = key === localDate(new Date()), tomorrow = key === localDate(new Date(now + 86400000));
      list.append(h('h2', {class: 'agenda-day', text: today ? 'Hoje' : tomorrow ? 'Amanhã' : dayFormat.format(m.start)}));
    }
    list.append(meetingItem(m));
  }
  $('#agenda-past').replaceChildren(...(past.length ? past.map(m => {
    const item = meetingItem(m);
    item.querySelector('.meeting-time').prepend(h('small', {text: shortDay.format(m.start)}));
    return item;
  }) : [h('p', {class: 'empty', text: 'Nenhuma reunião nos últimos 60 dias.'})]));
  renderLobbyUpcoming(upcoming);
  renderBanner(upcoming);
}
function renderLobbyUpcoming(upcoming) {
  const box = $('#lobby-upcoming');
  const next = upcoming.slice(0, 4);
  box.replaceChildren(...(next.length ? next.map(m => h('li', {},
    h('span', {class: 'when', text: (localDate(m.start) === localDate(new Date()) ? 'Hoje' : shortDay.format(m.start)) + ' · ' + hourFormat.format(m.start)}),
    h('span', {class: 'what', text: m.title}),
    h('button', {class: isLive(m) ? 'button gold' : 'chip', type: 'button', 'data-join-room': m.room_code, text: 'Entrar', onclick: () => startCall('auto', m.room_code)})))
    : [h('li', {class: 'empty', text: 'Nenhuma reunião marcada.'})]));
}
// Aviso no topo quando uma reunião está para começar (10 min) ou acontecendo.
function renderBanner(upcoming = agenda.items.filter(m => m.end.getTime() >= Date.now())) {
  const banner = $('#upcoming-banner');
  const now = Date.now();
  const soon = upcoming.find(m => m.start.getTime() - 10 * 60000 <= now && now <= m.end.getTime() && !(state.joined && state.room === m.room_code));
  banner.hidden = !soon;
  if (!soon) return;
  const minutes = Math.round((soon.start.getTime() - now) / 60000);
  banner.replaceChildren(
    h('span', {class: 'dot', 'aria-hidden': 'true'}),
    h('span', {text: '“' + soon.title + '” ' + (minutes > 0 ? 'começa em ' + minutes + ' min' : 'está acontecendo agora') + ' (' + hourFormat.format(soon.start) + ')'}),
    h('button', {class: 'chip', type: 'button', 'data-join-room': soon.room_code, text: 'Entrar', onclick: () => startCall('auto', soon.room_code)}));
}
setInterval(() => { if (agenda.loaded) renderAgenda(); }, 30000);

// ---------- Criar e editar ----------
function openMeeting(m = null) {
  agenda.editing = m;
  meetingForm.reset();
  $('#meeting-dialog-title').textContent = m ? 'Editar reunião' : 'Nova reunião';
  $('#meeting-delete').hidden = !m;
  $('#meeting-status').textContent = '';
  let start = m ? m.start : new Date(Math.ceil(Date.now() / 1800000) * 1800000);
  meetingForm.elements.title.value = m?.title || '';
  meetingForm.elements.description.value = m?.description || '';
  meetingForm.elements.date.value = localDate(start);
  meetingForm.elements.time.value = localTime(start);
  const duration = String(m?.duration_min || 30);
  if (![...meetingForm.elements.duration.options].some(o => o.value === duration)) meetingForm.elements.duration.append(h('option', {value: duration, text: duration + ' min'}));
  meetingForm.elements.duration.value = duration;
  meetingDialog.showModal();
  meetingForm.elements.title.focus();
}
$('#meeting-new').addEventListener('click', () => openMeeting());
meetingForm.addEventListener('submit', async event => {
  event.preventDefault();
  const f = meetingForm.elements, status = $('#meeting-status');
  const title = f.title.value.trim();
  const start = new Date(f.date.value + 'T' + f.time.value);
  if (!title) { status.textContent = 'Dê um título para a reunião.'; return; }
  if (Number.isNaN(start.getTime())) { status.textContent = 'Escolha data e horário.'; return; }
  const row = {title, description: f.description.value.trim(), starts_at: start.toISOString(), duration_min: Number(f.duration.value)};
  const {error} = agenda.editing
    ? await sb.from('meetings').update(row).eq('id', agenda.editing.id)
    : await sb.from('meetings').insert(row);
  if (error) { status.textContent = friendlyError(error); return; }
  meetingDialog.close();
  toast(agenda.editing ? 'Reunião atualizada.' : 'Reunião marcada. Todo o time já vê na agenda.');
  loadMeetings();
});
$('#meeting-delete').addEventListener('click', async () => {
  const m = agenda.editing;
  if (!m || !confirm('Excluir a reunião “' + m.title + '”?')) return;
  const {error} = await sb.from('meetings').delete().eq('id', m.id);
  if (error) { $('#meeting-status').textContent = friendlyError(error); return; }
  meetingDialog.close();
  toast('Reunião excluída.');
  loadMeetings();
});

// ---------- Compartilhar ----------
async function copyText(text, done) {
  try { await navigator.clipboard.writeText(text); toast(done); }
  catch { window.prompt('Copie:', text); }
}
function downloadIcs(m) {
  const stamp = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, c => '\\' + c);
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//DECET//Agenda do time//PT-BR', 'BEGIN:VEVENT',
    'UID:' + m.id + '@decet.com.br', 'DTSTAMP:' + stamp(new Date()), 'DTSTART:' + stamp(m.start), 'DTEND:' + stamp(m.end),
    'SUMMARY:' + esc(m.title), 'DESCRIPTION:' + esc((m.description ? m.description + '\n\n' : '') + 'Entrar: ' + roomLink(m.room_code)),
    'URL:' + roomLink(m.room_code), 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const a = h('a', {href: URL.createObjectURL(new Blob([ics], {type: 'text/calendar'})), download: 'reuniao-' + localDate(m.start) + '.ics'});
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

team.ready.push(() => {
  loadMeetings();
  sb.channel('meetings').on('postgres_changes', {event: '*', schema: 'public', table: 'meetings'}, scheduleReload).subscribe();
});
team.changed.push(() => { if (agenda.loaded) renderAgenda(); });
hooks.entered.push(() => renderBanner());

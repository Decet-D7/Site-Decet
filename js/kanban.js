'use strict';
// Kanban do time (estilo Trello): colunas e cartões salvos no Supabase, em tempo real para todos.
// Ordem por "position" (número real): soltar um cartão entre dois usa a média das posições vizinhas.

const LABELS = [
  ['bug', 'Bug', '#c0392b'], ['funcionalidade', 'Funcionalidade', '#2563a8'], ['melhoria', 'Melhoria', '#2e7d4f'],
  ['urgente', 'Urgente', '#e0533d'], ['dados', 'Dados', '#a8873f'], ['design', 'Design', '#8e44ad'],
];
const labelInfo = Object.fromEntries(LABELS.map(([key, name, color]) => [key, {name, color}]));
const kb = {columns: [], cards: [], loaded: false, dragging: null, editing: null, reloadTimer: null, search: '', mine: false};
const boardColumns = $('#kanban-board'), cardDialog = $('#card-dialog'), cardForm = $('#card-form');
const dueFormat = new Intl.DateTimeFormat('pt-BR', {day: '2-digit', month: 'short'});
const stampFormat = new Intl.DateTimeFormat('pt-BR', {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'});

async function loadKanban() {
  const [cols, cards] = await Promise.all([
    sb.from('kanban_columns').select('id, title, position').order('position'),
    sb.from('kanban_cards').select('id, column_id, title, description, assignee, due_date, labels, position, created_by, created_at, updated_at').order('position'),
  ]);
  if (cols.error || cards.error) return toast(friendlyError(cols.error || cards.error), true);
  kb.columns = cols.data;
  kb.cards = cards.data;
  kb.loaded = true;
  if (!kb.dragging) renderKanban();
}
const scheduleKanbanReload = () => { clearTimeout(kb.reloadTimer); kb.reloadTimer = setTimeout(loadKanban, 250); };
const cardsOf = columnId => kb.cards.filter(c => c.column_id === columnId).sort((a, b) => a.position - b.position);
const visible = card => (!kb.mine || card.assignee === team.user.id)
  && (!kb.search || (card.title + ' ' + card.description).toLowerCase().includes(kb.search));

function dueState(date) {
  if (!date) return '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(date + 'T00:00:00');
  return due < today ? 'overdue' : due.getTime() === today.getTime() ? 'today' : '';
}
function cardEl(card) {
  const due = dueState(card.due_date);
  const assignee = card.assignee ? team.byUser.get(card.assignee) : null;
  return h('li', {class: 'kcard', draggable: 'true', tabindex: '0', dataset: {id: card.id}, 'aria-label': card.title,
    onclick: () => openCard(card.id), onkeydown: e => { if (e.key === 'Enter') openCard(card.id); },
    ondragstart: e => { kb.dragging = card.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', card.id); e.currentTarget.classList.add('dragging'); },
    ondragend: e => { e.currentTarget.classList.remove('dragging'); kb.dragging = null; clearDropMarks(); }},
    card.labels.length ? h('div', {class: 'kcard-labels'}, card.labels.filter(l => labelInfo[l]).map(l => h('span', {class: 'klabel', style: '--label:' + labelInfo[l].color, text: labelInfo[l].name}))) : null,
    h('p', {class: 'kcard-title', text: card.title}),
    h('div', {class: 'kcard-meta'},
      card.due_date ? h('span', {class: 'kdue ' + due, text: (due === 'overdue' ? 'Atrasado · ' : due === 'today' ? 'Hoje · ' : '') + dueFormat.format(new Date(card.due_date + 'T00:00:00'))}) : null,
      card.description ? h('span', {class: 'kdesc', title: 'Tem descrição', text: '≡'}) : null,
      assignee ? avatar(assignee.name, 'avatar mini') : null));
}
function columnEl(col, index) {
  const cards = cardsOf(col.id);
  const shown = cards.filter(visible);
  const list = h('ul', {class: 'kcards', dataset: {column: col.id}, 'aria-label': 'Cartões de ' + col.title}, shown.map(cardEl));
  list.addEventListener('dragover', e => { if (!kb.dragging) return; e.preventDefault(); markDrop(list, e.clientY); });
  list.addEventListener('dragleave', e => { if (!list.contains(e.relatedTarget)) clearDropMarks(); });
  list.addEventListener('drop', e => { e.preventDefault(); dropCard(col.id, list, e.clientY); });
  const addForm = h('form', {class: 'kadd', hidden: true},
    h('textarea', {name: 'title', rows: '2', maxlength: '200', placeholder: 'Título do cartão', 'aria-label': 'Título do novo cartão'}),
    h('div', {}, h('button', {class: 'button gold', type: 'submit', text: 'Adicionar'}), h('button', {class: 'chip', type: 'button', text: 'Cancelar', onclick: () => { addForm.hidden = true; addBtn.hidden = false; }})));
  const addBtn = h('button', {class: 'kadd-open', type: 'button', text: '+ Adicionar cartão', onclick: () => { addForm.hidden = false; addBtn.hidden = true; addForm.elements.title.focus(); }});
  addForm.elements.title.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addForm.requestSubmit(); } if (e.key === 'Escape') { addForm.hidden = true; addBtn.hidden = false; } });
  addForm.addEventListener('submit', async e => {
    e.preventDefault();
    const title = addForm.elements.title.value.trim();
    if (!title) return;
    const last = cards[cards.length - 1];
    const {error} = await sb.from('kanban_cards').insert({column_id: col.id, title, position: last ? last.position + 1 : 1});
    if (error) return toast(friendlyError(error), true);
    addForm.elements.title.value = '';
    await loadKanban();
    const again = boardColumns.querySelector(`[data-column="${col.id}"]`)?.closest('.kcol');
    again?.querySelector('.kadd-open')?.click();
  });
  return h('section', {class: 'kcol', dataset: {id: col.id}, 'aria-label': col.title},
    h('header', {class: 'kcol-head'},
      h('h2', {text: col.title, title: 'Clique duas vezes para renomear', ondblclick: () => renameColumn(col)}),
      h('span', {class: 'kcount', text: String(cards.length)}),
      h('details', {class: 'kmenu'}, h('summary', {'aria-label': 'Opções da coluna ' + col.title, text: '⋯'}),
        h('div', {class: 'kmenu-list'},
          h('button', {type: 'button', text: 'Renomear', onclick: () => renameColumn(col)}),
          index > 0 ? h('button', {type: 'button', text: '← Mover para a esquerda', onclick: () => moveColumn(index, -1)}) : null,
          index < kb.columns.length - 1 ? h('button', {type: 'button', text: 'Mover para a direita →', onclick: () => moveColumn(index, 1)}) : null,
          h('button', {class: 'danger', type: 'button', text: 'Excluir coluna', onclick: () => deleteColumn(col, cards.length)})))),
    list, addBtn, addForm);
}
function renderKanban() {
  const newCol = h('form', {class: 'kcol knew'},
    h('input', {name: 'title', maxlength: '60', placeholder: '+ Nova coluna', 'aria-label': 'Nome da nova coluna'}));
  newCol.addEventListener('submit', async e => {
    e.preventDefault();
    const title = newCol.elements.title.value.trim();
    if (!title) return;
    const last = kb.columns[kb.columns.length - 1];
    const {error} = await sb.from('kanban_columns').insert({title, position: last ? last.position + 1 : 1});
    if (error) return toast(friendlyError(error), true);
    loadKanban();
  });
  boardColumns.replaceChildren(...kb.columns.map(columnEl), newCol);
}

// ---------- Arrastar e soltar ----------
function dropIndex(list, y) {
  const items = [...list.querySelectorAll('.kcard:not(.dragging)')];
  const index = items.findIndex(item => { const r = item.getBoundingClientRect(); return y < r.top + r.height / 2; });
  return {items, index: index < 0 ? items.length : index};
}
function markDrop(list, y) {
  clearDropMarks();
  list.classList.add('drop-target');
  const {items, index} = dropIndex(list, y);
  if (items[index]) items[index].classList.add('drop-before'); else list.classList.add('drop-end');
}
function clearDropMarks() {
  boardColumns.querySelectorAll('.drop-before').forEach(el => el.classList.remove('drop-before'));
  boardColumns.querySelectorAll('.drop-target, .drop-end').forEach(el => el.classList.remove('drop-target', 'drop-end'));
}
async function dropCard(columnId, list, y) {
  const id = kb.dragging;
  clearDropMarks();
  if (!id) return;
  const {items, index} = dropIndex(list, y);
  const byId = cid => kb.cards.find(c => c.id === cid);
  const before = items[index - 1] ? byId(items[index - 1].dataset.id) : null;
  const after = items[index] ? byId(items[index].dataset.id) : null;
  await moveCard(id, columnId, before, after);
}
async function moveCard(id, columnId, before, after) {
  const card = kb.cards.find(c => c.id === id);
  if (!card) return;
  let position = before && after ? (before.position + after.position) / 2 : before ? before.position + 1 : after ? after.position - 1 : 1;
  if (before && after && after.position - before.position < 1e-6) {
    // Sem espaço entre os vizinhos: renumera a coluna antes de inserir.
    const ordered = cardsOf(columnId).filter(c => c.id !== id);
    await Promise.all(ordered.map((c, i) => sb.from('kanban_cards').update({position: i + 1}).eq('id', c.id)));
    ordered.forEach((c, i) => { c.position = i + 1; });
    position = before.position + 0.5;
  }
  const previous = {column_id: card.column_id, position: card.position};
  Object.assign(card, {column_id: columnId, position});
  kb.dragging = null;
  renderKanban();
  const {error} = await sb.from('kanban_cards').update({column_id: columnId, position}).eq('id', id);
  if (error) { Object.assign(card, previous); renderKanban(); toast(friendlyError(error), true); }
}

// ---------- Colunas ----------
async function renameColumn(col) {
  const title = prompt('Nome da coluna:', col.title);
  if (!title || !title.trim() || title.trim() === col.title) return;
  const {error} = await sb.from('kanban_columns').update({title: title.trim().slice(0, 60)}).eq('id', col.id);
  if (error) return toast(friendlyError(error), true);
  loadKanban();
}
async function moveColumn(index, step) {
  const a = kb.columns[index], b = kb.columns[index + step];
  if (!a || !b) return;
  const results = await Promise.all([
    sb.from('kanban_columns').update({position: b.position}).eq('id', a.id),
    sb.from('kanban_columns').update({position: a.position}).eq('id', b.id),
  ]);
  const failed = results.find(r => r.error);
  if (failed) toast(friendlyError(failed.error), true);
  loadKanban();
}
async function deleteColumn(col, count) {
  if (!confirm('Excluir a coluna “' + col.title + '”' + (count ? ' e os ' + count + ' cartões dela' : '') + '?')) return;
  const {error} = await sb.from('kanban_columns').delete().eq('id', col.id);
  if (error) return toast(friendlyError(error), true);
  loadKanban();
}

// ---------- Cartão (detalhes) ----------
function openCard(id) {
  const card = kb.cards.find(c => c.id === id);
  if (!card) return;
  kb.editing = card;
  const f = cardForm.elements;
  f.title.value = card.title;
  f.description.value = card.description;
  f.due_date.value = card.due_date || '';
  f.column_id.replaceChildren(...kb.columns.map(c => h('option', {value: c.id, text: c.title})));
  f.column_id.value = card.column_id;
  const people = team.members.filter(m => m.user_id && (m.active || m.user_id === card.assignee));
  f.assignee.replaceChildren(h('option', {value: '', text: 'Ninguém'}), ...people.map(m => h('option', {value: m.user_id, text: m.name + (m.active ? '' : ' (desativado)')})));
  f.assignee.value = card.assignee || '';
  $('#card-labels').replaceChildren(...LABELS.map(([key, name, color]) => h('label', {class: 'label-option', style: '--label:' + color},
    h('input', {type: 'checkbox', name: 'labels', value: key, checked: card.labels.includes(key)}), h('span', {text: name}))));
  $('#card-meta').textContent = 'Criado por ' + (card.created_by ? team.nameOf(card.created_by) : '—') + ' em ' + stampFormat.format(new Date(card.created_at))
    + (card.updated_at !== card.created_at ? ' · atualizado em ' + stampFormat.format(new Date(card.updated_at)) : '');
  $('#card-status').textContent = '';
  cardDialog.showModal();
}
cardForm.addEventListener('submit', async e => {
  e.preventDefault();
  const card = kb.editing, f = cardForm.elements;
  if (!card) return;
  const title = f.title.value.trim();
  if (!title) { $('#card-status').textContent = 'O cartão precisa de um título.'; return; }
  const row = {title, description: f.description.value.trim(), due_date: f.due_date.value || null, assignee: f.assignee.value || null,
    labels: [...cardForm.querySelectorAll('input[name="labels"]:checked')].map(i => i.value)};
  if (f.column_id.value !== card.column_id) {
    const target = cardsOf(f.column_id.value);
    row.column_id = f.column_id.value;
    row.position = target.length ? target[target.length - 1].position + 1 : 1;
  }
  const {error} = await sb.from('kanban_cards').update(row).eq('id', card.id);
  if (error) { $('#card-status').textContent = friendlyError(error); return; }
  cardDialog.close();
  loadKanban();
});
$('#card-delete').addEventListener('click', async () => {
  const card = kb.editing;
  if (!card || !confirm('Excluir o cartão “' + card.title + '”?')) return;
  const {error} = await sb.from('kanban_cards').delete().eq('id', card.id);
  if (error) { $('#card-status').textContent = friendlyError(error); return; }
  cardDialog.close();
  loadKanban();
});

$('#kanban-search').addEventListener('input', e => { kb.search = e.target.value.trim().toLowerCase(); renderKanban(); });
$('#kanban-mine').addEventListener('change', e => { kb.mine = e.target.checked; renderKanban(); });

team.ready.push(() => {
  loadKanban();
  sb.channel('kanban')
    .on('postgres_changes', {event: '*', schema: 'public', table: 'kanban_cards'}, scheduleKanbanReload)
    .on('postgres_changes', {event: '*', schema: 'public', table: 'kanban_columns'}, scheduleKanbanReload)
    .subscribe();
});
team.changed.push(() => { if (kb.loaded && !kb.dragging) renderKanban(); });

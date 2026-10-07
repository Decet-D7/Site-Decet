'use strict';
// Lousa da sala: Excalidraw (MIT) carregado sob demanda, sincronizado pelo canal de dados da sala.
// Cada elemento do Excalidraw tem version/versionNonce; vale a versão mais nova (regra do
// reconcileElements do Excalidraw), com um ajuste: em empate de versão, apagar vence, para uma exclusão
// não se perder quando outra pessoa mexe no mesmo elemento ao mesmo tempo. Apagar é uma versão nova
// com isDeleted, então chega a todos.
// Imagens (files) vão uma vez por id. Quem entra recebe a lousa atual do anfitrião no welcome.

const BOARD_DIR = new URL('js/vendor/excalidraw/', location.href).href;
const SEND_INTERVAL = 60;               // ms entre envios enquanto alguém desenha ou digita
const POINTER_INTERVAL = 80;            // ms entre envios do cursor
const MAX_FILE_CHARS = 8 * 1024 * 1024; // dataURL de uma imagem (~6 MB)
const MAX_ELEMENTS = 8000;
const ELEMENT_TYPES = new Set(['rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw', 'text', 'image', 'frame']);
const FILE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml', 'image/avif', 'image/bmp']);
const CURSOR_COLORS = ['#e0533d', '#2563a8', '#2e7d4f', '#a8873f', '#8e44ad', '#16a085', '#d35400', '#c2185b'];

const boardEl = $('#board'), boardHost = $('#board-host'), boardBtn = $('#board-btn'), boardStatus = $('#board-status');
const board = {
  open: false, lib: null, api: null, loading: null, unmount: null,
  store: new Map(),     // id -> elemento mais novo conhecido (inclusive apagados)
  files: new Map(),     // fileId -> {id, mimeType, dataURL, created}
  outbox: new Map(), timer: null, pointerAt: 0,
  wanted: new Set(),    // imagens já pedidas a alguém
  cursors: new Map(),   // peer -> colaborador (cursor na lousa)
  noticed: new Set(),
};
// Hooks para os módulos de ajuste de formas e contas (meet-board-smart.js).
const boardHooks = {ready: [], change: []};

// ---------- Carregar o Excalidraw ----------
function loadBoardLib() {
  if (!board.loading) {
    window.EXCALIDRAW_ASSET_PATH = BOARD_DIR;
    if (!document.querySelector('link[data-board-css]')) {
      document.head.append(h('link', {rel: 'stylesheet', href: BOARD_DIR + 'board.css', 'data-board-css': ''}));
    }
    board.loading = import(BOARD_DIR + 'board.js').then(lib => { board.lib = lib; return lib; })
      .catch(error => { board.loading = null; throw error; });
  }
  return board.loading;
}
async function mountBoard() {
  if (board.api || board.unmount) return;
  boardStatus.textContent = 'Carregando a lousa…';
  boardStatus.hidden = false;
  let lib;
  try { lib = await loadBoardLib(); }
  catch { boardStatus.textContent = 'Não foi possível carregar a lousa. Verifique a conexão e tente de novo.'; return; }
  if (!board.open || board.unmount) return;
  boardStatus.hidden = true;
  board.unmount = lib.mountBoard(boardHost, {
    elements: [...board.store.values()].filter(el => !el.isDeleted),
    files: [...board.files.values()],
    onReady: api => {
      board.api = api;
      api.updateScene({collaborators: new Map(board.cursors)});
      boardHooks.ready.forEach(fn => fn(api, lib));
    },
    onChange: onLocalChange,
    onPointerUpdate: onPointer,
    onClearAll: clearForEveryone,
  });
}

// ---------- Mudanças locais -> sala ----------
function onLocalChange(elements, appState, files) {
  for (const el of elements) {
    const known = board.store.get(el.id);
    if (known && known.version >= el.version) continue;   // inclui o que acabou de chegar de fora
    const copy = {...el};
    board.store.set(el.id, copy);
    board.outbox.set(el.id, copy);
  }
  for (const [id, file] of Object.entries(files || {})) {
    if (board.files.has(id) || !file?.dataURL) continue;
    const clean = {id, mimeType: file.mimeType, dataURL: file.dataURL, created: file.created || Date.now()};
    board.files.set(id, clean);
    if (clean.dataURL.length <= MAX_FILE_CHARS) broadcast({type: 'xb', op: 'file', file: clean});
    else systemMessage('Imagem grande demais para mandar para a sala (máximo de ~6 MB).');
  }
  boardHooks.change.forEach(fn => fn(elements, appState));
  if (board.outbox.size && !board.timer) board.timer = setTimeout(flushBoard, SEND_INTERVAL);
}
function flushBoard() {
  board.timer = null;
  const list = [...board.outbox.values()];
  board.outbox.clear();
  for (let i = 0; i < list.length; i += 150) broadcast({type: 'xb', op: 'els', els: list.slice(i, i + 150)});
}
function onPointer({pointer, button}) {
  const now = Date.now();
  if (now - board.pointerAt < POINTER_INTERVAL) return;
  board.pointerAt = now;
  broadcast({type: 'xb', op: 'ptr', x: pointer.x, y: pointer.y, tool: pointer.tool === 'laser' ? 'laser' : 'pointer', button: button === 'down' ? 'down' : 'up'});
}

// ---------- Sala -> lousa ----------
function cleanElement(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || raw.id.length > 80) return null;
  if (!ELEMENT_TYPES.has(raw.type) || !Number.isInteger(raw.version) || raw.version < 1 || !Number.isFinite(raw.versionNonce)) return null;
  if (!Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return null;
  if (Array.isArray(raw.points) && raw.points.length > 20000) return null;
  if (typeof raw.text === 'string' && raw.text.length > 20000) return null;
  const el = {...raw};
  if (el.link && !/^https?:\/\//i.test(String(el.link))) el.link = null;  // só links web
  return el;
}
// `el` substitui `known`?
function isNewer(el, known) {
  if (!known) return true;
  if (el.version !== known.version) return el.version > known.version;
  if (!!el.isDeleted !== !!known.isDeleted) return !!el.isDeleted;
  return el.versionNonce < known.versionNonce;
}
const byIndex = (a, b) => (a.index && b.index ? (a.index < b.index ? -1 : a.index > b.index ? 1 : 0) : 0);
// Mescla na cena aberta, sem mexer no que a pessoa está editando agora (texto, redimensionar, desenhar).
function mergeIntoScene(remote) {
  const api = board.api, appState = api.getAppState();
  const busy = new Set([appState.editingTextElement?.id, appState.resizingElement?.id, appState.newElement?.id].filter(Boolean));
  const byId = new Map(api.getSceneElementsIncludingDeleted().map(el => [el.id, el]));
  let changed = false;
  for (const el of remote) {
    const local = byId.get(el.id);
    if (local && (busy.has(el.id) || !isNewer(el, local))) continue;
    byId.set(el.id, el);
    changed = true;
  }
  if (changed) api.updateScene({elements: [...byId.values()].sort(byIndex), captureUpdate: board.lib.CaptureUpdateAction.NEVER});
}
function applyRemote(fromId, list) {
  if (!Array.isArray(list)) return;
  const fresh = [], missingFiles = [];
  for (const raw of list) {
    const el = cleanElement(raw);
    if (!el || !isNewer(el, board.store.get(el.id))) continue;
    if (!board.store.has(el.id) && board.store.size >= MAX_ELEMENTS) continue;
    board.store.set(el.id, el);
    fresh.push(el);
    if (el.type === 'image' && el.fileId && !board.files.has(el.fileId) && !board.wanted.has(el.fileId)) missingFiles.push(el.fileId);
  }
  if (missingFiles.length) requestFiles(fromId, missingFiles);
  if (!fresh.length) return;
  if (board.api) mergeIntoScene(fresh);
  if (fresh.some(el => !el.isDeleted)) noticeActivity(fromId);
}
function applyRemoteFile(file) {
  if (!file || typeof file.id !== 'string' || file.id.length > 80 || board.files.has(file.id)) return;
  if (!FILE_TYPES.has(file.mimeType) || typeof file.dataURL !== 'string' || !file.dataURL.startsWith('data:image/') || file.dataURL.length > MAX_FILE_CHARS) return;
  const clean = {id: file.id, mimeType: file.mimeType, dataURL: file.dataURL, created: Number(file.created) || Date.now()};
  board.files.set(clean.id, clean);
  board.api?.addFiles([clean]);
}
function colorFor(id) {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return CURSOR_COLORS[hash % CURSOR_COLORS.length];
}
function applyPointer(id, msg) {
  if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return;
  const color = colorFor(id);
  board.cursors.set(id, {
    pointer: {x: msg.x, y: msg.y, tool: msg.tool === 'laser' ? 'laser' : 'pointer'},
    button: msg.button === 'down' ? 'down' : 'up',
    username: nameOf(id), color: {background: color, stroke: color},
  });
  if (board.open && board.api) board.api.updateScene({collaborators: new Map(board.cursors)});
}
// Quem recebe um elemento de imagem sem o arquivo pede a quem mandou.
function requestFiles(peerId, ids) {
  ids.forEach(fileId => board.wanted.add(fileId));
  sendTo(peerId, {type: 'xb', op: 'want', ids});
  setTimeout(() => ids.forEach(fileId => { if (!board.files.has(fileId)) board.wanted.delete(fileId); }), 15000);
}
function sendTo(peerId, msg) {
  const conn = state.members.get(peerId)?.conn;
  if (conn?.open) conn.send(msg);
}
// Ao abrir o canal com alguém, manda a lousa inteira (inclusive o que foi apagado): cobre o que a
// pessoa perdeu enquanto as conexões da sala ainda estavam se formando.
hooks.connected.push(peerId => {
  const list = board.api ? board.api.getSceneElementsIncludingDeleted() : [...board.store.values()];
  for (let i = 0; i < list.length; i += 150) sendTo(peerId, {type: 'xb', op: 'els', els: list.slice(i, i + 150)});
});

hooks.data.xb = (id, msg) => {
  if (msg.op === 'els') applyRemote(id, msg.els);
  else if (msg.op === 'file') applyRemoteFile(msg.file);
  else if (msg.op === 'want' && Array.isArray(msg.ids)) msg.ids.slice(0, 50).forEach(fileId => { const file = board.files.get(fileId); if (file) sendTo(id, {type: 'xb', op: 'file', file}); });
  else if (msg.op === 'ptr') applyPointer(id, msg);
  else if (msg.op === 'cleared') systemMessage(nameOf(id) + ' limpou a lousa.');
};
hooks.left.push(id => {
  if (board.cursors.delete(id) && board.api) board.api.updateScene({collaborators: new Map(board.cursors)});
});
function noticeActivity(id) {
  if (board.open) return;
  boardBtn.classList.add('has-activity');
  if (!board.noticed.has(id)) { board.noticed.add(id); systemMessage(nameOf(id) + ' está usando a lousa.'); }
}

// Quem entra recebe a lousa atual (só o que não foi apagado) e as imagens usadas nela.
function currentElements() {
  const list = board.api ? board.api.getSceneElementsIncludingDeleted() : [...board.store.values()];
  return list.filter(el => !el.isDeleted);
}
hooks.welcome.push(() => {
  const elements = currentElements();
  const used = new Set(elements.filter(el => el.type === 'image' && el.fileId).map(el => el.fileId));
  return {xboard: {elements, files: [...board.files.values()].filter(file => used.has(file.id))}};
});
hooks.welcomed.push(msg => {
  const data = msg.xboard;
  if (!data || typeof data !== 'object') return;
  (Array.isArray(data.files) ? data.files : []).forEach(applyRemoteFile);
  applyRemote(state.hostId, data.elements);
});
// Baixa o Excalidraw em segundo plano depois de entrar: a lousa abre na hora quando alguém precisar.
hooks.entered.push(() => {
  const idle = window.requestIdleCallback || (fn => setTimeout(fn, 1500));
  idle(() => loadBoardLib().catch(() => {}));
});

// ---------- Abrir, fechar e limpar ----------
function setBoardOpen(open) {
  board.open = open;
  boardEl.hidden = !open;
  stage.classList.toggle('board-open', open);
  boardBtn.setAttribute('aria-pressed', String(open));
  boardBtn.querySelector('span').textContent = open ? 'Fechar lousa' : 'Lousa';
  if (open) {
    boardBtn.classList.remove('has-activity');
    mountBoard();
    board.api?.updateScene({collaborators: new Map(board.cursors)});
  }
}
boardBtn.addEventListener('click', () => setBoardOpen(!board.open));
function clearForEveryone() {
  const api = board.api, lib = board.lib;
  if (!api) return;
  const alive = api.getSceneElementsIncludingDeleted().filter(el => !el.isDeleted);
  if (!alive.length || !confirm('Limpar a lousa para todos na sala?')) return;
  const elements = api.getSceneElementsIncludingDeleted().map(el => (el.isDeleted ? el : lib.newElementWith(el, {isDeleted: true})));
  api.updateScene({elements, captureUpdate: lib.CaptureUpdateAction.IMMEDIATELY});
  broadcast({type: 'xb', op: 'cleared'});
  systemMessage('Você limpou a lousa.');
}

'use strict';
// Lousa digital: traços sincronizados pelo canal de dados da sala.
// Cada traço tem id "<peer>-<n>" e só quem o criou pode estendê-lo ou desfazê-lo.

const BOARD_W = 1600, BOARD_H = 900, BOARD_BG = '#f6f4ed';
const BOARD_COLORS = [['#1b1b18', 'Preto'], ['#a8873f', 'Dourado'], ['#c0392b', 'Vermelho'], ['#2563a8', 'Azul'], ['#2e7d4f', 'Verde']];
const BOARD_WIDTHS = [[3, 'Fina'], [8, 'Média'], [22, 'Grossa']];
const MAX_BOARD_POINTS = 400000;

const boardEl = $('#board'), boardCanvas = $('#board-canvas'), boardBtn = $('#board-btn');
const boardCtx = boardCanvas.getContext('2d');
boardCanvas.width = BOARD_W;
boardCanvas.height = BOARD_H;

const board = {
  open: false, color: 0, width: 0, eraser: false,
  strokes: new Map(),   // id -> {id, by, c, w, e, p: [x, y, x, y, ...]}
  points: 0, seq: 0, mine: [], drawing: null, pending: [], flushQueued: false, noticed: new Set(),
};

// ---------- Desenho ----------
function paintBackground() {
  boardCtx.globalCompositeOperation = 'source-over';
  boardCtx.fillStyle = BOARD_BG;
  boardCtx.fillRect(0, 0, BOARD_W, BOARD_H);
}
function paintStroke(stroke, from = 0) {
  const p = stroke.p;
  if (p.length < 2) return;
  boardCtx.strokeStyle = stroke.e ? BOARD_BG : BOARD_COLORS[stroke.c][0];
  boardCtx.fillStyle = boardCtx.strokeStyle;
  boardCtx.lineWidth = stroke.e ? BOARD_WIDTHS[stroke.w][0] * 3 : BOARD_WIDTHS[stroke.w][0];
  boardCtx.lineCap = 'round';
  boardCtx.lineJoin = 'round';
  if (p.length === 2) {
    boardCtx.beginPath();
    boardCtx.arc(p[0], p[1], boardCtx.lineWidth / 2, 0, Math.PI * 2);
    boardCtx.fill();
    return;
  }
  const start = Math.max(0, from - 2);
  boardCtx.beginPath();
  boardCtx.moveTo(p[start], p[start + 1]);
  for (let i = start + 2; i < p.length; i += 2) boardCtx.lineTo(p[i], p[i + 1]);
  boardCtx.stroke();
}
function repaintBoard() {
  paintBackground();
  board.strokes.forEach(stroke => paintStroke(stroke));
}
paintBackground();

// ---------- Validação do que chega pela rede ----------
const validIndex = (value, list) => Number.isInteger(value) && value >= 0 && value < list.length;
function cleanPoints(list) {
  if (!Array.isArray(list) || list.length % 2 || list.length > 4000) return null;
  const out = [];
  for (let i = 0; i < list.length; i += 2) {
    const x = Number(list[i]), y = Number(list[i + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    out.push(Math.max(0, Math.min(BOARD_W, Math.round(x))), Math.max(0, Math.min(BOARD_H, Math.round(y))));
  }
  return out;
}
function addStroke(stroke) {
  if (board.points + stroke.p.length / 2 > MAX_BOARD_POINTS) return false;
  board.points += stroke.p.length / 2;
  board.strokes.set(stroke.id, stroke);
  paintStroke(stroke);
  return true;
}
function receiveStroke(by, msg) {
  if (typeof msg.id !== 'string' || msg.id.length > 120 || !msg.id.startsWith(by + '-')) return null;
  if (!validIndex(msg.c, BOARD_COLORS) || !validIndex(msg.w, BOARD_WIDTHS)) return null;
  const p = cleanPoints(msg.p);
  if (!p || !p.length) return null;
  return {id: msg.id, by, c: msg.c, w: msg.w, e: !!msg.e, p};
}

hooks.data.wb = (id, msg) => {
  if (msg.op === 'begin') {
    const stroke = receiveStroke(id, msg);
    if (stroke && !board.strokes.has(stroke.id)) addStroke(stroke);
    noticeActivity(id);
  } else if (msg.op === 'pts') {
    const stroke = board.strokes.get(msg.id);
    const p = cleanPoints(msg.p);
    if (!stroke || stroke.by !== id || !p || board.points + p.length / 2 > MAX_BOARD_POINTS) return;
    const from = stroke.p.length;
    stroke.p.push(...p);
    board.points += p.length / 2;
    paintStroke(stroke, from);
  } else if (msg.op === 'undo') {
    const stroke = board.strokes.get(msg.id);
    if (stroke && stroke.by === id) { removeStroke(stroke); repaintBoard(); }
  } else if (msg.op === 'clear') {
    clearBoard();
    systemMessage(nameOf(id) + ' limpou a lousa.');
  }
};
function removeStroke(stroke) {
  board.strokes.delete(stroke.id);
  board.points -= stroke.p.length / 2;
}
function clearBoard() {
  board.strokes.clear();
  board.points = 0;
  board.mine = [];
  repaintBoard();
}
function noticeActivity(id) {
  if (board.open) return;
  boardBtn.classList.add('has-activity');
  if (!board.noticed.has(id)) { board.noticed.add(id); systemMessage(nameOf(id) + ' está usando a lousa.'); }
}

// Quem entra recebe a lousa atual do anfitrião.
hooks.welcome.push(() => ({board: [...board.strokes.values()].map(({id, by, c, w, e, p}) => ({id, by, c, w, e, p}))}));
hooks.welcomed.push(msg => {
  if (!Array.isArray(msg.board)) return;
  for (const item of msg.board) {
    if (!item || typeof item.by !== 'string') continue;
    const p = cleanLong(item.p);
    const stroke = p && p.length && receiveStroke(item.by, {...item, p: p.slice(0, 2)});
    if (!stroke) continue;
    stroke.p = p;
    if (!addStroke(stroke)) break;
  }
  if (board.strokes.size) boardBtn.classList.add('has-activity');
});
function cleanLong(list) {
  if (!Array.isArray(list) || list.length % 2 || list.length > MAX_BOARD_POINTS * 2) return null;
  const out = [];
  for (let i = 0; i < list.length; i += 4000) {
    const part = cleanPoints(list.slice(i, i + 4000));
    if (!part) return null;
    out.push(...part);
  }
  return out;
}

// ---------- Interação ----------
function boardPoint(event) {
  const rect = boardCanvas.getBoundingClientRect();
  return [Math.round((event.clientX - rect.left) * BOARD_W / rect.width), Math.round((event.clientY - rect.top) * BOARD_H / rect.height)];
}
function flushPoints() {
  board.flushQueued = false;
  if (!board.drawing || !board.pending.length) return;
  for (let i = 0; i < board.pending.length; i += 4000) broadcast({type: 'wb', op: 'pts', id: board.drawing.id, p: board.pending.slice(i, i + 4000)});
  board.pending = [];
}
boardCanvas.addEventListener('pointerdown', event => {
  if (event.button !== 0 && event.pointerType === 'mouse') return;
  event.preventDefault();
  boardCanvas.setPointerCapture(event.pointerId);
  const stroke = {id: state.me.id + '-' + (++board.seq), by: state.me.id, c: board.color, w: board.width, e: board.eraser, p: boardPoint(event)};
  if (!addStroke(stroke)) { systemMessage('A lousa está cheia. Limpe para continuar desenhando.'); return; }
  board.drawing = stroke;
  board.mine.push(stroke.id);
  broadcast({type: 'wb', op: 'begin', id: stroke.id, c: stroke.c, w: stroke.w, e: stroke.e, p: stroke.p});
});
boardCanvas.addEventListener('pointermove', event => {
  if (!board.drawing) return;
  const events = event.getCoalescedEvents ? event.getCoalescedEvents() : [event];
  const from = board.drawing.p.length;
  for (const e of events) {
    const [x, y] = boardPoint(e);
    const p = board.drawing.p;
    if (Math.abs(p[p.length - 2] - x) + Math.abs(p[p.length - 1] - y) < 2) continue;
    if (board.points + 1 > MAX_BOARD_POINTS) break;
    p.push(x, y);
    board.pending.push(x, y);
    board.points += 1;
  }
  paintStroke(board.drawing, from);
  if (!board.flushQueued) { board.flushQueued = true; requestAnimationFrame(flushPoints); }
});
const endStroke = () => { flushPoints(); board.drawing = null; };
boardCanvas.addEventListener('pointerup', endStroke);
boardCanvas.addEventListener('pointercancel', endStroke);

function setBoardOpen(open) {
  board.open = open;
  boardEl.hidden = !open;
  stage.classList.toggle('board-open', open);
  boardBtn.setAttribute('aria-pressed', String(open));
  boardBtn.querySelector('span').textContent = open ? 'Fechar lousa' : 'Lousa';
  if (open) boardBtn.classList.remove('has-activity');
}
boardBtn.addEventListener('click', () => setBoardOpen(!board.open));

function buildTools() {
  const colors = $('#board-colors'), widths = $('#board-widths');
  BOARD_COLORS.forEach(([hex, label], i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'swatch'; b.style.setProperty('--swatch', hex);
    b.setAttribute('aria-label', label); b.setAttribute('aria-pressed', String(i === board.color));
    b.addEventListener('click', () => {
      board.color = i; board.eraser = false;
      colors.querySelectorAll('button').forEach((x, j) => x.setAttribute('aria-pressed', String(j === i)));
      $('#board-eraser').setAttribute('aria-pressed', 'false');
    });
    colors.append(b);
  });
  BOARD_WIDTHS.forEach(([px, label], i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'width'; b.style.setProperty('--w', Math.min(px, 14) + 'px');
    b.setAttribute('aria-label', 'Espessura ' + label.toLowerCase()); b.setAttribute('aria-pressed', String(i === board.width));
    b.addEventListener('click', () => {
      board.width = i;
      widths.querySelectorAll('button').forEach((x, j) => x.setAttribute('aria-pressed', String(j === i)));
    });
    widths.append(b);
  });
}
buildTools();
$('#board-eraser').addEventListener('click', event => {
  board.eraser = !board.eraser;
  event.currentTarget.setAttribute('aria-pressed', String(board.eraser));
});
$('#board-undo').addEventListener('click', () => {
  while (board.mine.length) {
    const stroke = board.strokes.get(board.mine.pop());
    if (!stroke) continue;
    removeStroke(stroke);
    repaintBoard();
    broadcast({type: 'wb', op: 'undo', id: stroke.id});
    return;
  }
});
$('#board-clear').addEventListener('click', () => {
  if (!board.strokes.size || !confirm('Limpar a lousa para todos na sala?')) return;
  clearBoard();
  broadcast({type: 'wb', op: 'clear'});
  systemMessage('Você limpou a lousa.');
});
$('#board-download').addEventListener('click', () => {
  boardCanvas.toBlob(blob => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'lousa-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, 'image/png');
});
document.addEventListener('keydown', event => {
  if (board.open && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.target.closest('textarea, input')) {
    event.preventDefault();
    $('#board-undo').click();
  }
});

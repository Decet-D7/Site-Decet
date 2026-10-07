'use strict';
// Lousa "inteligente", por cima do Excalidraw (meet-board.js):
// 1. Traço à mão + segurar parado no fim: vira reta, seta, retângulo, círculo, triângulo ou losango
//    (Ctrl+Z volta para o traço). Com "Ajustar todo traço", vale para todo traço reconhecível.
// 2. Contas em caixas de texto: linha terminada em "=" ganha o resultado (math.js restrito). Numa caixa
//    que já tem contas, os resultados se refazem quando o texto muda. Variáveis: "preço = 120".
// 3. Gráficos extras (pizza, rosca, barras, linhas) a partir de uma tabela colada, com Chart.js,
//    inseridos na lousa como imagem.
// Tudo vira elementos normais do Excalidraw, então chega aos outros pela sincronização de sempre.

const HOLD_MS = 450;
const smart = {always: false, track: null, drawingId: null, pending: null, editingText: null, math: null, chartLib: null, chart: null};
const snapToggle = $('#snap-always');
try { smart.always = localStorage.getItem('decet.board.snapAlways') === '1'; } catch { /* sem armazenamento */ }
snapToggle.checked = smart.always;
snapToggle.addEventListener('change', () => {
  smart.always = snapToggle.checked;
  try { localStorage.setItem('decet.board.snapAlways', smart.always ? '1' : '0'); } catch { /* sem armazenamento */ }
});

// ---------- 1. Traço à mão -> forma ----------
// O tempo parado no fim do traço é medido no próprio contêiner (fase de captura, antes do Excalidraw).
boardHost.addEventListener('pointerdown', event => {
  smart.track = {x: event.clientX, y: event.clientY, still: performance.now()};
}, true);
boardHost.addEventListener('pointermove', event => {
  const track = smart.track;
  if (!track || Math.hypot(event.clientX - track.x, event.clientY - track.y) <= 3) return;
  track.x = event.clientX; track.y = event.clientY; track.still = performance.now();
}, true);
boardHost.addEventListener('pointerup', () => {
  const track = smart.track;
  smart.track = null;
  if (!track || !board.api || !smart.drawingId) return;
  const held = performance.now() - track.still >= HOLD_MS;
  if (board.api.getAppState().activeTool.type === 'freedraw' && (held || smart.always)) smart.pending = {id: smart.drawingId, held};
  smart.drawingId = null;
}, true);

boardHooks.change.push((elements, appState) => {
  const drawing = appState.newElement;
  if (drawing?.type === 'freedraw') smart.drawingId = drawing.id;
  if (smart.pending && !drawing) {
    const pending = smart.pending;
    smart.pending = null;
    setTimeout(() => snapFreedraw(pending), 0);
  }
  const editing = appState.editingTextElement?.id || null;
  if (smart.editingText && smart.editingText !== editing) {
    const id = smart.editingText;
    setTimeout(() => calcText(id), 0);
  }
  smart.editingText = editing;
});

function shapeSkeleton(shape, style) {
  const rel = (p, origin) => [p[0] - origin[0], p[1] - origin[1]];
  if (shape.kind === 'line' || shape.kind === 'arrow') {
    const end = rel(shape.b, shape.a);
    return {type: shape.kind, x: shape.a[0], y: shape.a[1], width: Math.abs(end[0]), height: Math.abs(end[1]), points: [[0, 0], end],
      ...(shape.kind === 'arrow' ? {startArrowhead: null, endArrowhead: 'arrow'} : {}), ...style};
  }
  if (shape.kind === 'triangle') {
    const [a, b, c] = shape.points;
    return {type: 'line', x: a[0], y: a[1], points: [[0, 0], rel(b, a), rel(c, a), [0, 0]], ...style};
  }
  return {type: shape.kind, x: shape.x, y: shape.y, width: shape.width, height: shape.height, ...style};
}
function snapFreedraw({id, held}) {
  const api = board.api, lib = board.lib;
  if (!api) return;
  const stroke = api.getSceneElements().find(el => el.id === id && el.type === 'freedraw');
  if (!stroke) return;
  const shape = BoardShapes.recognize(stroke.points.map(([x, y]) => [stroke.x + x, stroke.y + y]));
  if (!shape) {
    if (held) api.setToast({message: 'Não reconheci uma forma nesse traço.', duration: 1800});
    return;
  }
  const app = api.getAppState();
  const style = {strokeColor: stroke.strokeColor, strokeWidth: stroke.strokeWidth, strokeStyle: stroke.strokeStyle, opacity: stroke.opacity,
    roughness: app.currentItemRoughness, fillStyle: app.currentItemFillStyle, backgroundColor: 'transparent'};
  const [created] = lib.convertToExcalidrawElements([shapeSkeleton(shape, style)]);
  const elements = api.getSceneElementsIncludingDeleted().map(el => (el.id === stroke.id ? lib.newElementWith(el, {isDeleted: true}) : el));
  // Um passo só no histórico: Ctrl+Z traz o traço à mão de volta.
  api.updateScene({elements: [...elements, created], captureUpdate: lib.CaptureUpdateAction.IMMEDIATELY});
}

// ---------- 2. Contas nas caixas de texto ----------
const ASSIGNMENT = /^\s*([A-Za-zÀ-ÿ_][\wÀ-ÿ]*)\s*=\s*(\S.*)$/;
const PREVIOUS_RESULT = /^-?∞$|^-?[\d.,]+(?:e[+-]?\d+)?(?:\s\S+)?$/i;
const loadMath = () => (smart.math ||= board.lib.loadMath());
// Escrita de conta em português -> sintaxe do math.js.
function prepare(expression) {
  return expression
    .replace(/[×·]/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/²/g, '^2').replace(/³/g, '^3')
    .replace(/(\d)\s*[xX]\s*(?=[\d(])/g, '$1*')      // 3x4, 3 x 4
    .replace(/%\s*de\s+/gi, '% * ')                    // 15% de 200
    .replace(/(\d),(\d)/g, '$1.$2')                    // 1,5 -> 1.5
    .replace(/;/g, ',');                               // max(1; 5) -> max(1, 5)
}
const numberFormat = new Intl.NumberFormat('pt-BR', {maximumFractionDigits: 8, useGrouping: false});
function formatResult(value, math) {
  const type = math.typeOf(value);
  if (type === 'number') {
    if (Number.isNaN(value)) return null;
    if (!Number.isFinite(value)) return value > 0 ? '∞' : '-∞';
    const abs = Math.abs(value);
    if (abs !== 0 && (abs >= 1e15 || abs < 1e-6)) return value.toExponential(6).replace('.', ',');
    return numberFormat.format(value);
  }
  if (type === 'Unit' || type === 'BigNumber' || type === 'Fraction') return math.format(value, {precision: 10}).replace(/(\d)\.(\d)/g, '$1,$2');
  return null;  // matriz, número complexo, função: não mostra
}
function calcLine(line, scope, math, recompute) {
  let body = null;
  const open = line.match(/^(.*\S)\s*=\s*$/);                  // "12*3+4 ="
  if (open) body = open[1];
  else if (recompute) {
    const done = line.match(/^(.*\S)\s+=\s+(\S.*)$/);          // "12*3+4 = 40" (resultado de antes)
    if (done && PREVIOUS_RESULT.test(done[2].trim()) && /[-+*/^%()]/.test(done[1])) body = done[1];
  }
  if (body === null) {
    const assignment = line.match(ASSIGNMENT);                 // "preço = 120": guarda a variável
    if (assignment) { try { math.evaluate(assignment[1] + ' = ' + prepare(assignment[2]), scope); } catch { /* não é conta */ } }
    return line;
  }
  try {
    const shown = formatResult(math.evaluate(prepare(body), scope), math);
    return shown === null ? line : body + ' = ' + shown;
  } catch { return line; }
}
async function calcText(id) {
  const api = board.api;
  if (!api) return;
  const text = api.getSceneElements().find(el => el.id === id && el.type === 'text');
  if (!text) return;
  const source = text.originalText ?? text.text;
  const recompute = !!text.customData?.calc;
  if (!recompute && !/=[ \t]*$/m.test(source)) return;
  let math;
  try { math = await loadMath(); } catch { return; }
  const current = api.getSceneElements().find(el => el.id === id);
  if (!current || (current.originalText ?? current.text) !== source) return;   // mudou enquanto carregava
  const scope = new Map();
  const result = source.split('\n').map(line => calcLine(line, scope, math, recompute)).join('\n');
  if (result === source) return;
  const updated = board.lib.newElementWith(current, {text: result, originalText: result, customData: {...(current.customData || {}), calc: true}});
  const [measured] = board.lib.restoreElements([updated], null, {refreshDimensions: true});
  api.updateScene({elements: api.getSceneElementsIncludingDeleted().map(el => (el.id === id ? measured : el)), captureUpdate: board.lib.CaptureUpdateAction.IMMEDIATELY});
}

// ---------- 3. Gráficos extras ----------
const chartDialog = $('#chart-dialog'), chartForm = $('#chart-form'), chartCanvas = $('#chart-canvas'), chartStatus = $('#chart-status');
const CHART_COLORS = ['#2563a8', '#c9a96a', '#2e7d4f', '#c0392b', '#8e44ad', '#16a085', '#d35400', '#7f8c8d'];
function parseNumber(cell) {
  let t = String(cell ?? '').replace(/R\$|\s|%/g, '');
  if (!t) return NaN;
  if (t.includes(',') && t.includes('.')) t = t.replace(/\./g, '').replace(',', '.');
  else if (t.includes(',')) t = t.replace(',', '.');
  return Number(t);
}
// Tabela colada do Excel/Sheets (tabulação), com ; ou com vírgula. 1ª coluna = rótulos.
function parseTable(raw) {
  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) return null;
  const sep = lines.some(line => line.includes('\t')) ? '\t' : lines.some(line => line.includes(';')) ? ';' : ',';
  const rows = lines.map(line => line.split(sep).map(cell => cell.trim()));
  const width = Math.max(...rows.map(row => row.length));
  if (width < 2) return null;
  const header = rows[0].slice(1).every(cell => Number.isNaN(parseNumber(cell))) ? rows.shift() : null;
  if (!rows.length) return null;
  const series = [];
  for (let col = 1; col < width; col++) {
    const values = rows.map(row => parseNumber(row[col]));
    if (values.some(v => !Number.isNaN(v))) series.push({name: header?.[col] || 'Série ' + col, values: values.map(v => (Number.isNaN(v) ? 0 : v))});
  }
  return series.length ? {labels: rows.map(row => row[0]), series} : null;
}
function chartConfig(type, title, table) {
  const round = type === 'pie' || type === 'doughnut';
  const datasets = (round ? table.series.slice(0, 1) : table.series).map((s, i) => ({
    label: s.name, data: s.values,
    backgroundColor: round ? table.labels.map((_, j) => CHART_COLORS[j % CHART_COLORS.length]) : CHART_COLORS[i % CHART_COLORS.length],
    borderColor: round ? '#ffffff' : CHART_COLORS[i % CHART_COLORS.length], borderWidth: round ? 3 : 3, tension: 0.25, pointRadius: 5,
  }));
  return {
    type: type === 'barh' ? 'bar' : type,
    data: {labels: table.labels, datasets},
    options: {
      indexAxis: type === 'barh' ? 'y' : 'x', responsive: false, animation: false, devicePixelRatio: 1,
      plugins: {title: {display: !!title, text: title, font: {size: 30, weight: 'bold'}, color: '#1b1b18', padding: {bottom: 16}},
        legend: {display: round || datasets.length > 1, position: round ? 'right' : 'top', labels: {font: {size: 22}, color: '#1b1b18'}}},
      scales: round ? {} : {x: {ticks: {font: {size: 20}, color: '#1b1b18'}}, y: {ticks: {font: {size: 20}, color: '#1b1b18'}, beginAtZero: true}},
      layout: {padding: 24},
    },
    plugins: [{id: 'fundo', beforeDraw: chart => { const c = chart.ctx; c.save(); c.fillStyle = '#ffffff'; c.fillRect(0, 0, chart.width, chart.height); c.restore(); }}],
  };
}
async function drawPreview() {
  const table = parseTable(chartForm.elements.data.value);
  if (!table) { chartStatus.textContent = 'Cole uma tabela com rótulos na 1ª coluna e números nas outras.'; smart.chart?.destroy(); smart.chart = null; return null; }
  let Chart;
  try { Chart = await (smart.chartLib ||= board.lib.loadChart()); }
  catch { chartStatus.textContent = 'Não foi possível carregar os gráficos.'; return null; }
  smart.chart?.destroy();
  smart.chart = new Chart(chartCanvas, chartConfig(chartForm.elements.type.value, chartForm.elements.title.value.trim(), table));
  chartStatus.textContent = table.labels.length + ' itens' + (table.series.length > 1 ? ' · ' + table.series.length + ' séries' : '');
  return table;
}
let previewTimer;
chartForm.addEventListener('input', () => { clearTimeout(previewTimer); previewTimer = setTimeout(drawPreview, 200); });
$('#chart-btn').addEventListener('click', async () => {
  if (!board.api) return;
  chartDialog.showModal();
  chartForm.elements.data.focus();
  await drawPreview();
});
chartForm.addEventListener('submit', async event => {
  event.preventDefault();
  const api = board.api, lib = board.lib;
  if (!api || !await drawPreview()) return;
  const dataURL = chartCanvas.toDataURL('image/png');
  const fileId = 'grafico-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  api.addFiles([{id: fileId, mimeType: 'image/png', dataURL, created: Date.now()}]);
  const st = api.getAppState(), zoom = st.zoom.value, width = 480, height = 300;
  const cx = -st.scrollX + st.width / 2 / zoom, cy = -st.scrollY + st.height / 2 / zoom;
  const [image] = lib.convertToExcalidrawElements([{type: 'image', x: cx - width / 2, y: cy - height / 2, width, height, fileId, status: 'saved'}]);
  api.updateScene({elements: [...api.getSceneElementsIncludingDeleted(), image], captureUpdate: lib.CaptureUpdateAction.IMMEDIATELY});
  chartDialog.close();
});

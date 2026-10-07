'use strict';
// Reconhece um traço à mão (lista de pontos [x, y]) como reta, seta, retângulo, círculo/elipse,
// triângulo ou losango. Devolve a forma "limpa" ou null quando não há confiança.
// Sem dependências: usado pela lousa (meet-board-smart.js) e testável no Node.
(function (root) {
  const N = 64;                 // pontos depois de reamostrar
  const CLOSED_GAP = 0.2;       // fim perto do começo (fração do comprimento) = traço fechado
  const LINE_DEVIATION = 0.09;  // desvio máximo da reta (fração do comprimento)
  const SHAPE_ERROR = 0.07;     // erro médio máximo até o contorno (fração do tamanho)
  const SNAP_ANGLE = 7;         // graus: perto de 0/45/90... endireita
  const SQUARE_RATIO = 0.1;     // largura e altura quase iguais = quadrado/círculo

  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  function pathLength(points) {
    let total = 0;
    for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
    return total;
  }
  // Reamostragem em passos iguais (algoritmo do reconhecedor $1, BSD).
  function resample(points, n) {
    const step = pathLength(points) / (n - 1);
    const pts = points.map(p => [p[0], p[1]]);
    const out = [pts[0]];
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = dist(pts[i - 1], pts[i]);
      if (d > 0 && acc + d >= step) {
        const t = (step - acc) / d;
        const q = [pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1])];
        out.push(q);
        pts.splice(i, 0, q);
        acc = 0;
      } else acc += d;
    }
    while (out.length < n) out.push(pts[pts.length - 1]);
    return out.slice(0, n);
  }
  function toSegment(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    if (!len2) return dist(p, a);
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  }
  const toPolygon = (p, vertices) => Math.min(...vertices.map((v, i) => toSegment(p, v, vertices[(i + 1) % vertices.length])));
  const mean = values => values.reduce((s, v) => s + v, 0) / values.length;
  function bounds(points) {
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    return {minX, maxX, minY, maxY, w: maxX - minX, h: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2};
  }

  // Endireita ângulos perto de múltiplos de 45°, mantendo começo e comprimento.
  function snapEnd(a, b) {
    const len = dist(a, b);
    const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const step = Math.PI / 4;
    const snapped = Math.round(angle / step) * step;
    if (Math.abs(angle - snapped) > SNAP_ANGLE * Math.PI / 180) return b;
    return [a[0] + len * Math.cos(snapped), a[1] + len * Math.sin(snapped)];
  }

  function recognizeOpen(pts, length) {
    const start = pts[0], end = pts[pts.length - 1];
    const span = dist(start, end);
    // Reta: todos os pontos perto do segmento começo-fim.
    if (span > 0 && Math.max(...pts.map(p => toSegment(p, start, end))) / span < LINE_DEVIATION && span / length > 0.85) {
      return {kind: 'line', a: start, b: snapEnd(start, end)};
    }
    // Seta num traço só: haste reta até a ponta e depois as "farpas", que voltam para trás perto
    // da ponta. A ponta é a primeira chegada ao ponto mais distante do começo (o traço volta a
    // passar por ela entre uma farpa e outra).
    const far = Math.max(...pts.map(p => dist(start, p)));
    let k = pts.findIndex(p => dist(start, p) >= 0.96 * far);
    for (let i = k; i < Math.min(pts.length, k + 6); i++) if (dist(start, pts[i]) > dist(start, pts[k])) k = i;
    const tip = pts[k], shaft = dist(start, tip);
    if (k < 8 || k > pts.length - 4 || shaft < 30) return null;
    const shaftPts = pts.slice(0, k + 1), tail = pts.slice(k);
    if (Math.max(...shaftPts.map(p => toSegment(p, start, tip))) / shaft > LINE_DEVIATION) return null;
    const tailLength = pathLength(tail);
    if (tailLength < 0.12 * shaft || tailLength > 1.6 * shaft) return null;
    const dir = [(tip[0] - start[0]) / shaft, (tip[1] - start[1]) / shaft];
    const near = tail.every(p => dist(p, tip) < 0.5 * shaft);
    const behind = tail.every(p => ((p[0] - start[0]) * dir[0] + (p[1] - start[1]) * dir[1]) / shaft < 1.05);
    const spread = Math.max(...tail.map(p => Math.abs((p[0] - start[0]) * dir[1] - (p[1] - start[1]) * dir[0])));
    if (!near || !behind || spread < 0.06 * shaft) return null;
    return {kind: 'arrow', a: start, b: snapEnd(start, tip)};
  }

  function recognizeClosed(pts) {
    const box = bounds(pts);
    if (box.w < 12 || box.h < 12) return null;
    const size = (box.w + box.h) / 2;
    const rx = box.w / 2, ry = box.h / 2;
    const ellipse = mean(pts.map(([x, y]) => Math.abs(Math.hypot((x - box.cx) / rx, (y - box.cy) / ry) - 1) * (rx + ry) / 2)) / size;
    const rectangle = mean(pts.map(([x, y]) => {
      const dx = Math.max(box.minX - x, 0, x - box.maxX), dy = Math.max(box.minY - y, 0, y - box.maxY);
      return dx || dy ? Math.hypot(dx, dy) : Math.min(x - box.minX, box.maxX - x, y - box.minY, box.maxY - y);
    })) / size;
    const diamondVertices = [[box.cx, box.minY], [box.maxX, box.cy], [box.cx, box.maxY], [box.minX, box.cy]];
    const diamond = mean(pts.map(p => toPolygon(p, diamondVertices))) / size;
    // Triângulo: ponto mais longe do centro, o mais longe dele, e o mais longe da reta entre os dois.
    const centroid = [mean(pts.map(p => p[0])), mean(pts.map(p => p[1]))];
    const v0 = pts.reduce((best, p) => (dist(p, centroid) > dist(best, centroid) ? p : best));
    const v1 = pts.reduce((best, p) => (dist(p, v0) > dist(best, v0) ? p : best));
    const v2 = pts.reduce((best, p) => (toSegment(p, v0, v1) > toSegment(best, v0, v1) ? p : best));
    const triangleVertices = [v0, v1, v2];
    const triangle = mean(pts.map(p => toPolygon(p, triangleVertices))) / size;

    const scores = {rectangle, ellipse, diamond, triangle};
    const [kind, error] = Object.entries(scores).sort((a, b) => a[1] - b[1])[0];
    if (error > SHAPE_ERROR) return null;
    if (kind === 'triangle') return {kind, points: triangleVertices};
    let {minX: x, minY: y, w: width, h: height} = box;
    if (Math.abs(width - height) / Math.max(width, height) < SQUARE_RATIO) {
      const side = (width + height) / 2;
      x = box.cx - side / 2; y = box.cy - side / 2; width = height = side;
    }
    return {kind, x, y, width, height};
  }

  function recognize(rawPoints) {
    const points = (rawPoints || []).filter((p, i, all) => i === 0 || p[0] !== all[i - 1][0] || p[1] !== all[i - 1][1]);
    if (points.length < 6) return null;
    const length = pathLength(points);
    if (length < 24) return null;
    const pts = resample(points, N);
    const closed = dist(pts[0], pts[pts.length - 1]) < CLOSED_GAP * length;
    return closed ? recognizeClosed(pts) : recognizeOpen(pts, length);
  }

  const api = {recognize};
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BoardShapes = api;
})(typeof window !== 'undefined' ? window : globalThis);

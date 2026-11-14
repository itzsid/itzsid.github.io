// Grid A* per scene (walls + object footprints inflated by the robot radius).
import { CATS } from './scenes.js';
const RES = 0.2, INFLATE = 0.35;

function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function makeNav(scene) {
  const W = Math.round(scene.w / RES), H = Math.round(scene.h / RES), occ = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const x = (i + 0.5) * RES, y = (j + 0.5) * RES; let b = false;
    for (const w of scene.walls) if (segDist(x, y, ...w) < INFLATE) { b = true; break; }
    if (!b) for (const o of scene.objects) {
      if (o.cat === 'door') continue;
      if (o.cat === 'rack') { if (Math.abs(x - o.x) < 0.5 + INFLATE && Math.abs(y - o.y) < 2.2 + INFLATE) { b = true; break; } continue; }
      if (Math.hypot(x - o.x, y - o.y) < (CATS[o.cat]?.r ?? 0.4) + 0.25) { b = true; break; }
    }
    occ[j * W + i] = b ? 1 : 0;
  }
  const cell = (p) => [Math.min(W - 1, Math.max(0, Math.floor(p.x / RES))), Math.min(H - 1, Math.max(0, Math.floor(p.y / RES)))];
  const nearestFree = ([i, j]) => {
    if (!occ[j * W + i]) return [i, j];
    for (let r = 1; r < 25; r++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      const a = i + di, b = j + dj; if (a >= 0 && b >= 0 && a < W && b < H && !occ[b * W + a]) return [a, b];
    }
    return [i, j];
  };
  // binary heap for A*
  function plan(from, to) {
    const [si, sj] = nearestFree(cell(from)), [gi, gj] = nearestFree(cell(to));
    const N = W * H, g = new Float32Array(N).fill(Infinity), came = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
    const heap = []; const push = (f, id) => { heap.push([f, id]); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
    const s = sj * W + si, goal = gj * W + gi; g[s] = 0; push(0, s);
    while (heap.length) {
      const [, id] = pop(); if (closed[id]) continue; closed[id] = 1; if (id === goal) break;
      const i = id % W, j = (id / W) | 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue; const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= W || b >= H) continue;
        const nid = b * W + a; if (occ[nid] || closed[nid]) continue;
        if (di && dj && (occ[j * W + a] || occ[b * W + i])) continue;
        const ng = g[id] + (di && dj ? Math.SQRT2 : 1);
        if (ng < g[nid]) { g[nid] = ng; came[nid] = id; push(ng + Math.hypot(a - gi, b - gj), nid); }
      }
    }
    if (came[goal] < 0 && goal !== s) return null;
    const pts = []; for (let cur = goal; cur >= 0; cur = came[cur]) pts.push({ x: ((cur % W) + 0.5) * RES, y: (((cur / W) | 0) + 0.5) * RES });
    pts.reverse();
    const out = [pts[0]];
    const clear = (a, b) => { const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (RES / 2)); for (let k = 1; k < n; k++) { const [ci, cj] = cell({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n }); if (occ[cj * W + ci]) return false; } return true; };
    for (let k = 1; k < pts.length - 1; k++) if (!clear(out[out.length - 1], pts[k + 1])) out.push(pts[k]);
    if (pts.length > 1) out.push(pts[pts.length - 1]);
    let len = 0; for (let k = 1; k < out.length; k++) len += Math.hypot(out[k].x - out[k - 1].x, out[k].y - out[k - 1].y);
    return { points: out, length: len };
  }
  return { plan, isFree: (p) => { const [i, j] = cell(p); return !occ[j * W + i]; } };
}

// Grid A* per scene (walls + object footprints inflated by the robot radius).
// plan(from, to, { block }) also accepts temporary disc obstacles (other robots).
import { occupancyGrid } from './scenes.js';
import { segIntersect } from './geom.js';

export function makeNav(scene) {
  const { W, H, RES, occ } = occupancyGrid(scene);
  const N = W * H, dyn = new Uint8Array(N);
  const cell = (p) => [Math.min(W - 1, Math.max(0, Math.floor(p.x / RES))), Math.min(H - 1, Math.max(0, Math.floor(p.y / RES)))];
  const centre = (i, j) => ({ x: (i + 0.5) * RES, y: (j + 0.5) * RES });
  const blocked = (id) => occ[id] || dyn[id];
  const losWalls = (a, b) => !scene.walls.some((w) => segIntersect(a, b, { x: w[0], y: w[1] }, { x: w[2], y: w[3] }));
  // nearest free cell (Euclidean), preferring cells that see p (not behind a wall)
  const nearestFree = ([i, j], p, useDyn = true) => {
    const bad = (id) => occ[id] || (useDyn && dyn[id]);
    if (!bad(j * W + i)) return [i, j];
    let best = null;
    for (let r = 1; r < 30; r++) {
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= W || b >= H || bad(b * W + a)) continue;
        const c = centre(a, b), d = Math.hypot(c.x - p.x, c.y - p.y) + (losWalls(c, p) ? 0 : 3);
        if (!best || d < best.d) best = { d, a, b };
      }
      if (best && best.d < (r + 1) * RES) break;
    }
    return best ? [best.a, best.b] : [i, j];
  };
  const stampBlocks = (block, on) => {
    for (const b of block) {
      const i0 = Math.max(0, Math.floor((b.x - b.r) / RES)), i1 = Math.min(W - 1, Math.floor((b.x + b.r) / RES));
      const j0 = Math.max(0, Math.floor((b.y - b.r) / RES)), j1 = Math.min(H - 1, Math.floor((b.y + b.r) / RES));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const c = centre(i, j); if (Math.hypot(c.x - b.x, c.y - b.y) < b.r) dyn[j * W + i] = on; }
    }
  };
  const lineFree = (a, b) => {
    const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (RES / 2));
    for (let k = 1; k < n; k++) { const [ci, cj] = cell({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n }); if (blocked(cj * W + ci)) return false; }
    return true;
  };
  function plan(from, to, { block = [] } = {}) {
    stampBlocks(block, 1);
    try {
      // never let a temporary obstacle swallow the start cell
      const [fi, fj] = cell(from); for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const a = fi + di, b = fj + dj; if (a >= 0 && b >= 0 && a < W && b < H) dyn[b * W + a] = 0; }
      const [si, sj] = nearestFree(cell(from), from), [gi, gj] = nearestFree(cell(to), to, false);
      const s = sj * W + si, goal = gj * W + gi;
      if (dyn[goal]) return null;
      const g = new Float32Array(N).fill(Infinity), came = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
      const heap = []; const push = (f, id) => { heap.push([f, id]); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
      const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
      g[s] = 0; push(0, s);
      while (heap.length) {
        const [, id] = pop(); if (closed[id]) continue; closed[id] = 1; if (id === goal) break;
        const i = id % W, j = (id / W) | 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue; const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= W || b >= H) continue;
          const nid = b * W + a; if (blocked(nid) || closed[nid]) continue;
          if (di && dj && (blocked(j * W + a) || blocked(b * W + i))) continue;
          const ng = g[id] + (di && dj ? Math.SQRT2 : 1);
          if (ng < g[nid]) { g[nid] = ng; came[nid] = id; push(ng + Math.hypot(a - gi, b - gj), nid); }
        }
      }
      if (came[goal] < 0 && goal !== s) return null;
      const pts = []; for (let cur = goal; cur >= 0; cur = came[cur]) pts.push(centre(cur % W, (cur / W) | 0));
      pts.reverse();
      // string-pull: keep only the corners needed to stay in free space
      const out = [pts[0]];
      for (let k = 1; k < pts.length - 1; k++) if (!lineFree(out[out.length - 1], pts[k + 1])) out.push(pts[k]);
      if (pts.length > 1) out.push(pts[pts.length - 1]);
      let len = 0; for (let k = 1; k < out.length; k++) len += Math.hypot(out[k].x - out[k - 1].x, out[k].y - out[k - 1].y);
      return { points: out, length: len };
    } finally { stampBlocks(block, 0); }
  }
  const isFree = (p) => { const [i, j] = cell(p); return !occ[j * W + i]; };
  // all points of a polyline / sample list in free space (static map only)
  const pathFree = (samples) => samples.every(isFree);
  return { plan, isFree, pathFree, lineFree: (a, b) => { const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (RES / 2)); for (let k = 0; k <= n; k++) if (!isFree({ x: a.x + ((b.x - a.x) * k) / Math.max(1, n), y: a.y + ((b.y - a.y) * k) / Math.max(1, n) })) return false; return true; },
    grid: { W, H, RES, occ }, nearestFreePoint: (p) => { const [i, j] = nearestFree(cell(p), p, false); return centre(i, j); } };
}

// Cross-robot object association: embedding similarity proposes candidate
// matches; 2-point RANSAC on object positions keeps the geometrically
// consistent ones and estimates the transform between the robots' frames.
import { cosine } from './embed.js';
import { rng } from './geom.js';

function rigidFit(pairs) {   // least-squares 2D rigid transform mapping b -> a
  const n = pairs.length;
  let ax = 0, ay = 0, bx = 0, by = 0;
  for (const [a, b] of pairs) { ax += a.x; ay += a.y; bx += b.x; by += b.y; }
  ax /= n; ay /= n; bx /= n; by /= n;
  let sxx = 0, sxy = 0;
  for (const [a, b] of pairs) {
    const ux = b.x - bx, uy = b.y - by, vx = a.x - ax, vy = a.y - ay;
    sxx += ux * vx + uy * vy; sxy += ux * vy - uy * vx;
  }
  const th = Math.atan2(sxy, sxx), c = Math.cos(th), s = Math.sin(th);
  return { x: ax - (c * bx - s * by), y: ay - (s * bx + c * by), th };
}
const apply = (T, p) => ({ x: T.x + Math.cos(T.th) * p.x - Math.sin(T.th) * p.y, y: T.y + Math.sin(T.th) * p.x + Math.cos(T.th) * p.y });

// A, B: arrays of { key, emb, x, y } (each in its own robot's frame).
export function associate(A, B, { simThresh = 0.8, inlierDist = 1.0, iters = 400, seed = 3 } = {}) {
  const cands = [];
  for (const a of A) for (const b of B) {
    const s = cosine(a.emb, b.emb);
    if (s > simThresh) cands.push({ a, b, sim: s });
  }
  const R = rng(seed);
  let best = { inl: [], T: null };
  for (let it = 0; it < iters && cands.length >= 2; it++) {
    const p = cands[Math.floor(R.next() * cands.length)], q = cands[Math.floor(R.next() * cands.length)];
    if (p === q || p.a === q.a || p.b === q.b) continue;
    const da = Math.hypot(p.a.x - q.a.x, p.a.y - q.a.y), db = Math.hypot(p.b.x - q.b.x, p.b.y - q.b.y);
    if (Math.abs(da - db) > inlierDist || da < 1.0) continue;
    const T = rigidFit([[p.a, p.b], [q.a, q.b]]);
    const inl = cands.filter((c) => { const t = apply(T, c.b); return Math.hypot(t.x - c.a.x, t.y - c.a.y) < inlierDist; });
    if (inl.length > best.inl.length) best = { inl, T };
  }
  if (best.inl.length < 3) return { candidates: cands, inliers: [], outliers: cands, T: null };
  // refine, then enforce one-to-one by similarity
  let T = rigidFit(best.inl.map((c) => [c.a, c.b]));
  let inl = cands.filter((c) => { const t = apply(T, c.b); return Math.hypot(t.x - c.a.x, t.y - c.a.y) < inlierDist; })
    .sort((x, y) => y.sim - x.sim);
  const usedA = new Set(), usedB = new Set(), one = [];
  for (const c of inl) { if (usedA.has(c.a.key) || usedB.has(c.b.key)) continue; usedA.add(c.a.key); usedB.add(c.b.key); one.push(c); }
  T = rigidFit(one.map((c) => [c.a, c.b]));
  const outliers = cands.filter((c) => !one.includes(c));
  return { candidates: cands, inliers: one, outliers, T };
}
export { apply as applyT };

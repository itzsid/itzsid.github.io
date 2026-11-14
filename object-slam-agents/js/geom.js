// Small SE(2) + RNG helpers shared by the simulator and the solver.
export const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export function compose(a, b) {
  const c = Math.cos(a.th), s = Math.sin(a.th);
  return { x: a.x + c * b.x - s * b.y, y: a.y + s * b.x + c * b.y, th: wrap(a.th + b.th) };
}
export function between(a, b) {
  const c = Math.cos(a.th), s = Math.sin(a.th);
  const dx = b.x - a.x, dy = b.y - a.y;
  return { x: c * dx + s * dy, y: -s * dx + c * dy, th: wrap(b.th - a.th) };
}
export function inverse(a) {
  const c = Math.cos(a.th), s = Math.sin(a.th);
  return { x: -(c * a.x + s * a.y), y: s * a.x - c * a.y, th: wrap(-a.th) };
}

// Deterministic RNG (mulberry32) + Gaussian
export function rng(seed) {
  let t = seed >>> 0;
  const next = () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => {
    let u = 0, v = 0;
    while (u === 0) u = next();
    while (v === 0) v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return { next, gauss };
}

// Segment intersection (proper), used for line-of-sight against walls.
export function segIntersect(p1, p2, p3, p4) {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-12) return false;
  const u = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const v = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  return u > 1e-6 && u < 1 - 1e-6 && v > 1e-6 && v < 1 - 1e-6;
}

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

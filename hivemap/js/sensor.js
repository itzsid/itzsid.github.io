// Sensor + motion noise model.
// - detection probability falls off with range; small objects need to be close
// - walls and large objects (racks, wardrobes...) occlude the line of sight
// - occasional false detections (filtered later by requiring repeat sightings)
// - per-robot gyro bias, odometry noise and rare wheel-slip events
import { segIntersect, wrap } from './geom.js';
import { CATS, footprint } from './scenes.js';

export const SENSOR = { range: 5.0, fov: (90 * Math.PI) / 180 };
export const NOISE = { odoTrans: 0.035, odoRot: 0.015, slipProb: 0.01, slipScale: 0.25, obsPos: 0.06, obsRot: 0.06, falseRate: 0.02 };

export function maxRange(cat) { const c = CATS[cat] || {}; return c.small ? 2.6 : c.big ? 6.0 : SENSOR.range; }

function segRectHit(p, q, r) {   // segment p->q vs axis-aligned rect [x0,y0,x1,y1]
  const [x0, y0, x1, y1] = r;
  const edges = [[x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]];
  return edges.some((e) => segIntersect(p, q, { x: e[0], y: e[1] }, { x: e[2], y: e[3] }));
}
function segCircleHit(p, q, c, r) {
  const dx = q.x - p.x, dy = q.y - p.y, L2 = dx * dx + dy * dy;
  const t = Math.max(0, Math.min(1, ((c.x - p.x) * dx + (c.y - p.y) * dy) / L2));
  return t > 0.05 && t < 0.95 && Math.hypot(p.x + t * dx - c.x, p.y + t * dy - c.y) < r;
}

// Low furniture (below the camera) does not block the view.
const LOW = new Set(['sofa', 'bed', 'hospital bed', 'pallet', 'dining table', 'table', 'workbench', 'checkout counter', 'forklift']);
function segOBBHit(p, q, b, f, shrink = 1) {   // segment p->q vs object b's oriented footprint
  const c = Math.cos(b.th), s = Math.sin(b.th);
  const loc = (u) => ({ x: (u.x - b.x) * c + (u.y - b.y) * s, y: -(u.x - b.x) * s + (u.y - b.y) * c });
  const hw = f.hw * shrink, hl = f.hl * shrink;
  return segRectHit(loc(p), loc(q), [-hw, -hl, hw, hl]);
}

export function makeSensor(scene) {
  const occluders = scene.objects.filter((o) => o.cat !== 'door' && (CATS[o.cat]?.block || (CATS[o.cat]?.big && !LOW.has(o.cat))));
  // probability that object o is detected from pose p (0 if not visible)
  return function detectProb(p, o) {
    if (CATS[o.cat]?.block || o.hidden) return 0;
    const dx = o.x - p.x, dy = o.y - p.y, r = Math.hypot(dx, dy), R = maxRange(o.cat);
    if (r > R || r < 0.3) return 0;
    if (Math.abs(wrap(Math.atan2(dy, dx) - p.th)) > SENSOR.fov / 2) return 0;
    for (const w of scene.walls) if (segIntersect(p, o, { x: w[0], y: w[1] }, { x: w[2], y: w[3] })) return 0;
    for (const b of occluders) {
      if (b === o) continue;
      const f = footprint(b);
      if (f.r != null ? segCircleHit(p, o, b, f.r * 0.8) : segOBBHit(p, o, b, f, CATS[b.cat]?.block ? 1 : 0.8)) return 0;
    }
    return 0.97 * (1 - (r / R) ** 3);
  };
}

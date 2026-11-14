// Detailed procedural 3D models for every object category and the robots.
// Each model is built from many small primitives, then merged per material
// ("baked") so a whole object costs only a handful of draw calls.
// Local frame: y up, object front faces +z, footprint centred on the origin.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mats, tone, shade } from './materials.js';
import { SENSOR } from './sensor.js';

const PI = Math.PI, H = PI / 2;

// ---------- tiny deterministic RNG per object ----------
function rngFor(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
}

// ---------- geometry kit ----------
function boxGeo(w, h, d, r) {
  r = Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4);
  if (r <= 0.003) return new THREE.BoxGeometry(w, h, d);
  return new RoundedBoxGeometry(w, h, d, r >= 0.03 ? 2 : 1, r);
}
export class Kit {
  constructor() { this.parts = []; this.o = [0, 0, 0]; }
  add(geo, m, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, s = null) {
    const me = new THREE.Mesh(geo, m);
    me.position.set(x + this.o[0], y + this.o[1], z + this.o[2]); me.rotation.set(rx, ry, rz, 'YXZ');
    if (s) me.scale.set(...s);
    this.parts.push(me); return me;
  }
  box(w, h, d, m, x = 0, y = h / 2, z = 0, r = 0.012, rx = 0, ry = 0, rz = 0) { return this.add(boxGeo(w, h, d, r), m, x, y, z, rx, ry, rz); }
  cyl(rt, rb, h, m, x = 0, y = h / 2, z = 0, seg = 16, rx = 0, ry = 0, rz = 0, open = false) { return this.add(new THREE.CylinderGeometry(rt, rb, h, seg, 1, open), m, x, y, z, rx, ry, rz); }
  // cylinder lying along x / z axes
  cylX(r, len, m, x, y, z, seg = 16) { return this.cyl(r, r, len, m, x, y, z, seg, 0, 0, H); }
  cylZ(r, len, m, x, y, z, seg = 16) { return this.cyl(r, r, len, m, x, y, z, seg, H, 0, 0); }
  sph(r, m, x, y, z, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0, ws = 12, hs = 8) { return this.add(new THREE.SphereGeometry(r, ws, hs), m, x, y, z, rx, ry, rz, [sx, sy, sz]); }
  tor(R, r, m, x, y, z, rx = 0, ry = 0, rz = 0, arc = PI * 2, rs = 6, ts = 24) { return this.add(new THREE.TorusGeometry(R, r, rs, ts, arc), m, x, y, z, rx, ry, rz); }
  lathe(pts, m, x = 0, y = 0, z = 0, seg = 20) { return this.add(new THREE.LatheGeometry(pts.map(([a, b]) => new THREE.Vector2(a, b)), seg), m, x, y, z); }
  tube(pts, r, m, seg = 16, rs = 6) { const c = new THREE.CatmullRomCurve3(pts.map(([a, b, d]) => new THREE.Vector3(a + this.o[0], b + this.o[1], d + this.o[2]))); const me = new THREE.Mesh(new THREE.TubeGeometry(c, seg, r, rs, false), m); this.parts.push(me); return me; }
  // thin bar between two points (square section)
  bar(a, b, t, m) {
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), len = A.distanceTo(B);
    const me = new THREE.Mesh(new THREE.BoxGeometry(t, len, t), m);
    me.position.copy(A).add(B).multiplyScalar(0.5).add(new THREE.Vector3(...this.o));
    me.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
    this.parts.push(me); return me;
  }
  rod(a, b, r, m, seg = 8) {
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), len = A.distanceTo(B);
    const me = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg), m);
    me.position.copy(A).add(B).multiplyScalar(0.5).add(new THREE.Vector3(...this.o));
    me.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
    this.parts.push(me); return me;
  }
  // merge everything into one mesh per material
  bake(group = new THREE.Group()) {
    const byMat = new Map();
    for (const me of this.parts) {
      me.updateMatrix();
      let g = me.geometry.index ? me.geometry.toNonIndexed() : me.geometry.clone();
      for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
      if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
      g.applyMatrix4(me.matrix);
      if (!byMat.has(me.material)) byMat.set(me.material, []);
      byMat.get(me.material).push(g);
      me.geometry.dispose();
    }
    for (const [m, list] of byMat) {
      const merged = mergeGeometries(list, false); list.forEach((g) => g.dispose());
      const mesh = new THREE.Mesh(merged, m);
      mesh.castShadow = !m.transparent; mesh.receiveShadow = true;
      group.add(mesh);
    }
    this.parts = [];
    return group;
  }
}

// ---------- palette helpers ----------
const WOODS = { brown: '#a87a4e', black: '#4a3b30', white: '#efe9df', gray: '#a59e95' };
const woodOf = (c) => (c === 'white' ? mats.paint('#f2f0eb', 0.45) : c === 'gray' ? mats.paint('#9ca3af', 0.5) : mats.wood(WOODS[c] || '#a87a4e'));
const darkPlastic = () => mats.plastic('#2b2f36');
const offWhite = () => mats.paint('#eef0f2', 0.4);
const BOOKS = ['#8c2f39', '#2f4b7c', '#3f6e4a', '#c8a24a', '#e7e1d3', '#5b4b8a', '#b5562f', '#1f2937', '#6b8fa3'];

function star(k, y, r, m, casterM) {   // 5-spoke base with casters (office chair, IV stand)
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * PI * 2, s = Math.sin(a), c = Math.cos(a);
    k.box(0.035, 0.03, r, m, s * r / 2, y, c * r / 2, 0.008, 0, a, 0);
    k.sph(0.028, casterM, s * r, 0.028, c * r, 1, 1, 0.8, 0, a, 0, 8, 6);
  }
}
function casters(k, xs, zs, r = 0.05) {
  for (const x of xs) for (const z of zs) { k.box(0.03, 0.05, 0.03, mats.metal('#6b7280', 0.4), x, r * 2 + 0.02, z, 0.004); k.cylX(r, 0.03, mats.rubber(), x, r, z, 12); }
}
function legs4(k, w, d, h, m, inset = 0.05, t = 0.04, taper = false) {
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * (w / 2 - inset), z = sz * (d / 2 - inset);
    if (taper) k.cyl(t / 2, t / 2.8, h, m, x, h / 2, z, 10); else k.box(t, h, t, m, x, h / 2, z, 0.004);
  }
}
function cardboardStack(k, R, fx, fz, h0, maxH, dense = 0.8) {   // fill an fx x fz footprint with boxes
  const cb = mats.cardboard(); let y = h0;
  while (y < h0 + maxH - 0.2) {
    const bh = 0.22 + R() * 0.18; if (y + bh > h0 + maxH) break;
    const nx = R() < 0.5 ? 2 : 1, nz = 2;
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
      if (R() > dense) continue;
      const bw = fx / nx - 0.03 - R() * 0.05, bd = fz / nz - 0.03 - R() * 0.05;
      k.box(bw, bh, bd, cb, (i - (nx - 1) / 2) * (fx / nx), y + bh / 2, (j - (nz - 1) / 2) * (fz / nz), 0, 0, (R() - 0.5) * 0.08, 0);
    }
    y += bh;
  }
  return y;
}

// ---------- category builders ----------
const B = {};

B.chair = (k, c, R) => {
  if (c === 'brown') {   // wooden dining chair
    const w = mats.wood('#9b6b43');
    for (const sx of [-1, 1]) { k.box(0.035, 0.45, 0.035, w, sx * 0.19, 0.225, 0.18, 0.006); k.box(0.035, 0.95, 0.035, w, sx * 0.19, 0.475, -0.19, 0.006, -0.06); }
    k.box(0.44, 0.035, 0.42, w, 0, 0.46, 0, 0.01);
    k.box(0.4, 0.03, 0.38, mats.fabric('#d8cbb3'), 0, 0.49, 0.01, 0.012);
    k.box(0.4, 0.08, 0.025, w, 0, 0.86, -0.215, 0.008, -0.06); k.box(0.4, 0.05, 0.02, w, 0, 0.68, -0.205, 0.006, -0.06);
    k.box(0.36, 0.025, 0.025, w, 0, 0.16, 0.0, 0.004, 0, H, 0);
    return;
  }
  // task chair: 5-star base, gas lift, padded seat & back, arms
  const f = mats.fabric(tone(c)), dk = darkPlastic();
  star(k, 0.07, 0.28, dk, mats.rubber());
  k.cyl(0.03, 0.03, 0.06, dk, 0, 0.09, 0, 12);
  k.cyl(0.022, 0.022, 0.3, mats.chrome(), 0, 0.26, 0, 12);
  k.box(0.22, 0.04, 0.22, dk, 0, 0.42, 0, 0.01);
  k.box(0.5, 0.085, 0.48, f, 0, 0.48, 0.01, 0.035);
  k.box(0.06, 0.32, 0.025, dk, 0, 0.6, -0.24, 0.008, -0.12);
  k.box(0.46, 0.5, 0.075, f, 0, 0.88, -0.27, 0.035, -0.12);
  for (const sx of [-1, 1]) { k.box(0.03, 0.2, 0.03, dk, sx * 0.26, 0.6, -0.02, 0.006); k.box(0.06, 0.03, 0.24, dk, sx * 0.26, 0.71, 0.0, 0.012); }
};

B.desk = (k, c, R) => {
  const top = woodOf(c === 'black' ? 'brown' : c), frame = mats.paint('#2f3338', 0.45), al = mats.brushed();
  k.box(1.4, 0.035, 0.7, top, 0, 0.74, 0, 0.008);
  for (const sx of [-1, 1]) { for (const sz of [-1, 1]) k.box(0.04, 0.72, 0.04, frame, sx * 0.65, 0.36, sz * 0.29, 0.006); k.box(0.05, 0.03, 0.68, frame, sx * 0.65, 0.015, 0, 0.006); k.box(0.04, 0.04, 0.6, frame, sx * 0.65, 0.7, 0, 0.006); }
  k.box(1.24, 0.3, 0.015, top, 0, 0.52, -0.31, 0.004);
  // drawer pedestal
  const ped = c === 'white' ? top : mats.paint('#e5e7eb', 0.45);
  k.box(0.4, 0.6, 0.55, ped, 0.38, 0.32, 0.02, 0.01);
  for (let i = 0; i < 3; i++) { const y = 0.12 + i * 0.19; k.box(0.37, 0.17, 0.012, ped, 0.38, y, 0.3, 0.004); k.box(0.12, 0.012, 0.02, al, 0.38, y + 0.05, 0.31, 0.004); }
  // monitor, keyboard, mouse, papers, mug
  const dk = darkPlastic();
  k.box(0.22, 0.012, 0.16, dk, -0.05, 0.763, -0.2, 0.005);
  k.box(0.035, 0.24, 0.03, al, -0.05, 0.87, -0.23, 0.006);
  k.box(0.6, 0.36, 0.025, dk, -0.05, 1.0, -0.2, 0.008);
  k.box(0.57, 0.32, 0.004, mats.screen('pc'), -0.05, 1.005, -0.186, 0);
  k.box(0.42, 0.018, 0.13, mats.plastic('#3a3f47'), -0.05, 0.766, 0.08, 0.006);
  k.sph(0.03, dk, 0.27, 0.765, 0.1, 1, 0.5, 1.5);
  k.box(0.21, 0.004, 0.29, mats.paint('#fafafa', 0.8), -0.5, 0.76, 0.05, 0, 0, 0.25, 0);
  k.lathe([[0, 0], [0.04, 0], [0.042, 0.1], [0.038, 0.1], [0.036, 0.01], [0, 0.01]], mats.ceramic('#f5f5f4'), 0.52, 0.757, -0.15, 14);
};

B.workbench = (k, c, R) => {
  const steel = mats.paint('#4b5563', 0.45), top = mats.wood('#c9a06a');
  k.box(1.6, 0.05, 0.8, top, 0, 0.9, 0, 0.006);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box(0.05, 0.88, 0.05, steel, sx * 0.74, 0.44, sz * 0.34, 0.006);
  k.box(1.5, 0.03, 0.7, steel, 0, 0.2, 0, 0.006);
  for (const sx of [-1, 1]) k.box(0.04, 0.7, 0.04, steel, sx * 0.74, 1.27, -0.37, 0.006);
  k.box(1.52, 0.62, 0.02, mats.paint('#cdb892', 0.8), 0, 1.3, -0.38, 0.004);
  // tools on pegboard
  const tm = [mats.paint('#c62828', 0.4), mats.metal('#9ca3af'), mats.paint('#1f2937', 0.5), mats.paint('#e8b923', 0.4)];
  for (let i = 0; i < 7; i++) k.box(0.03 + R() * 0.04, 0.16 + R() * 0.12, 0.02, tm[i % 4], -0.6 + i * 0.2, 1.25 + R() * 0.15, -0.36, 0.006, 0, 0, (R() - 0.5) * 0.5);
  // vise + parts bins + a project box
  k.box(0.18, 0.1, 0.14, mats.paint('#334155', 0.4), 0.62, 0.975, 0.3, 0.01); k.box(0.16, 0.06, 0.04, mats.metal(), 0.62, 0.99, 0.39, 0.005);
  for (let i = 0; i < 4; i++) k.box(0.14, 0.08, 0.2, mats.plastic(['#2f5fb8', '#e8742a', '#2e7d32', '#e8b923'][i]), -0.6 + i * 0.16, 0.965, -0.22, 0.01);
  k.box(0.3, 0.12, 0.22, mats.paint('#e5e7eb', 0.4), 0.1, 0.985, 0.05, 0.01, 0, 0.2, 0);
  cardboardStack(k, R, 1.2, 0.6, 0.215, 0.5, 0.5);
};

B.toolbox = (k, c, R) => {   // rolling tool chest
  const p = mats.paint(tone(c), 0.3), ch = mats.chrome(), dk = mats.paint('#1f2328', 0.6);
  k.box(0.62, 0.66, 0.42, p, 0, 0.42, 0, 0.012);
  const ys = [0.18, 0.3, 0.42, 0.54, 0.66];
  ys.forEach((y, i) => { k.box(0.58, 0.004, 0.005, dk, 0, y + 0.055, 0.212, 0); k.box(0.46, 0.014, 0.02, ch, 0, y + 0.02, 0.225, 0.005); });
  k.box(0.64, 0.05, 0.44, p, 0, 0.775, 0, 0.012);
  k.box(0.6, 0.012, 0.4, mats.rubber(), 0, 0.806, 0, 0.004);
  k.rod([0.33, 0.6, -0.12], [0.33, 0.6, 0.12], 0.012, ch); k.box(0.03, 0.03, 0.02, ch, 0.32, 0.6, -0.12, 0.004); k.box(0.03, 0.03, 0.02, ch, 0.32, 0.6, 0.12, 0.004);
  casters(k, [-0.25, 0.25], [-0.16, 0.16], 0.035);
};

B['3d printer'] = (k, c, R) => {
  const body = c === 'white' ? mats.plastic('#eceff1') : mats.plastic(tone(c)), al = mats.brushed(), dk = darkPlastic();
  // printer stands on a small cabinet so it's at a sensible height
  k.box(0.6, 0.55, 0.5, mats.paint('#d4d4d8', 0.5), 0, 0.275, 0, 0.012);
  k.box(0.56, 0.006, 0.005, dk, 0, 0.3, 0.252, 0);
  const y0 = 0.55;
  k.box(0.5, 0.08, 0.46, body, 0, y0 + 0.04, 0, 0.012);
  for (const sx of [-1, 1]) k.box(0.03, 0.5, 0.03, al, sx * 0.22, y0 + 0.33, -0.05, 0.004);
  k.box(0.47, 0.035, 0.035, al, 0, y0 + 0.58, -0.05, 0.004);
  k.box(0.32, 0.012, 0.3, mats.metal('#30343b', 0.5), 0, y0 + 0.16, 0.02, 0.003);
  k.box(0.44, 0.025, 0.03, al, 0, y0 + 0.36, -0.03, 0.004);
  k.box(0.07, 0.08, 0.06, body, 0.05, y0 + 0.36, 0.0, 0.01);
  k.cyl(0.04, 0.05, 0.06, mats.plastic('#e8742a'), -0.02, y0 + 0.2, 0.04, 14);
  k.box(0.09, 0.05, 0.01, mats.screen('pc'), 0.15, y0 + 0.05, 0.235, 0.003, -0.4);
  k.cylX(0.1, 0.06, mats.plastic('#2e7d32'), 0, y0 + 0.7, -0.05, 20); k.cylX(0.03, 0.08, dk, 0, y0 + 0.7, -0.05, 10);
};

B['fire extinguisher'] = (k, c, R) => {
  const red = mats.paint(tone(c), 0.25);
  // wall bracket stand
  k.box(0.26, 0.02, 0.22, mats.paint('#374151', 0.5), 0, 0.01, 0, 0.006);
  k.lathe([[0, 0.02], [0.075, 0.02], [0.082, 0.04], [0.082, 0.42], [0.072, 0.47], [0.04, 0.5], [0.018, 0.51], [0, 0.51]], red, 0, 0, 0, 20);
  k.cyl(0.0825, 0.0825, 0.11, mats.paint('#f5f5f4', 0.6), 0, 0.24, 0, 20, 0, 0, 0, true);
  k.cyl(0.018, 0.02, 0.06, mats.chrome(), 0, 0.53, 0, 10);
  k.box(0.12, 0.014, 0.025, mats.paint('#111827', 0.5), 0.03, 0.57, 0, 0.004, 0, 0, -0.15);
  k.box(0.1, 0.014, 0.025, mats.paint('#111827', 0.5), 0.03, 0.545, 0, 0.004);
  k.tube([[-0.02, 0.53, 0], [-0.08, 0.5, 0.02], [-0.095, 0.35, 0.04], [-0.09, 0.2, 0.04]], 0.009, mats.rubber(), 12, 5);
};

B.bookshelf = (k, c, R) => {
  const w = woodOf(c), W = 1.2, Hh = 1.8, D = 0.35, t = 0.025;
  for (const sx of [-1, 1]) k.box(t, Hh, D, w, sx * (W / 2 - t / 2), Hh / 2, 0, 0.004);
  k.box(W, t, D, w, 0, Hh - t / 2, 0, 0.004);
  k.box(W - 2 * t, 0.07, 0.02, w, 0, 0.035, D / 2 - 0.02, 0.003);
  k.box(W - 2 * t, Hh - 0.02, 0.01, mats.paint(shade(WOODS[c] || '#a87a4e', -0.12), 0.7), 0, Hh / 2, -D / 2 + 0.006, 0);
  const shelves = [0.07, 0.42, 0.77, 1.12, 1.47];
  shelves.forEach((y) => k.box(W - 2 * t, 0.022, D - 0.02, w, 0, y, 0, 0.003));
  const bookM = BOOKS.map((h) => mats.paint(h, 0.7));
  shelves.forEach((y, si) => {
    let x = -W / 2 + t + 0.01; const end = W / 2 - t - 0.01; const base = y + 0.011;
    const deco = R() < 0.35 ? -W / 2 + 0.25 + R() * 0.6 : 99;
    while (x < end - 0.03) {
      if (Math.abs(x - deco) < 0.08) {   // decorative object: vase or small box
        if (R() < 0.5) k.lathe([[0, 0], [0.04, 0], [0.06, 0.06], [0.03, 0.16], [0.035, 0.18], [0, 0.18]], mats.ceramic(R() < 0.5 ? '#e2e8f0' : '#94a3b8'), x + 0.07, base, 0.02, 14);
        else k.box(0.12, 0.08, 0.12, mats.wood('#6b4a2f'), x + 0.07, base + 0.04, 0.02, 0.01);
        x += 0.17; continue;
      }
      const r = R();
      if (r < 0.06) {   // horizontal stack
        let yy = base; for (let i = 0; i < 3 + Math.floor(R() * 3); i++) { const bh = 0.03 + R() * 0.02; k.box(0.2 + R() * 0.04, bh, 0.15 + R() * 0.05, bookM[Math.floor(R() * bookM.length)], x + 0.12, yy + bh / 2, 0.02, 0); yy += bh; }
        x += 0.26; continue;
      }
      if (r < 0.1) { x += 0.04 + R() * 0.06; continue; }   // gap
      const bw = 0.022 + R() * 0.03, bh = 0.2 + R() * 0.1, bd = 0.17 + R() * 0.07;
      const lean = R() < 0.05 ? -0.25 : 0;
      k.box(bw, bh, bd, bookM[Math.floor(R() * bookM.length)], x + bw / 2 + (lean ? 0.03 : 0), base + bh / 2 - (lean ? 0.01 : 0), D / 2 - bd / 2 - 0.02, 0, 0, 0, lean);
      x += bw + 0.002 + (lean ? 0.05 : 0);
    }
  });
};

B.plant = (k, c, R) => {
  const potC = ['#b5653d', '#e7e5e4', '#374151', '#d6c7ae'][Math.floor(R() * 4)];
  k.lathe([[0, 0], [0.12, 0], [0.13, 0.02], [0.17, 0.33], [0.185, 0.35], [0.165, 0.35], [0.16, 0.31], [0, 0.31]], mats.ceramic(potC), 0, 0, 0, 22);
  k.cyl(0.158, 0.158, 0.01, mats.soil(), 0, 0.32, 0, 18);
  const l1 = mats.leaf(shade(tone(c === 'green' ? 'green' : c), -0.02)), l2 = mats.leaf(shade(tone(c === 'green' ? 'green' : c), 0.09)), stem = mats.paint('#4d5d2a', 0.8);
  const n = 26;
  for (let i = 0; i < n; i++) {
    const a = i * 2.39996 + R() * 0.4, f = i / n, hgt = 0.45 + f * 0.75 + R() * 0.08;
    const d = 0.08 + (1 - f) * 0.2 + R() * 0.05;
    const x = Math.sin(a) * d, z = Math.cos(a) * d, L = 0.13 + R() * 0.06;
    k.rod([x * 0.2, 0.32, z * 0.2], [x, hgt, z], 0.006, stem, 5);
    // leaf: flattened ellipsoid pointing outward, drooping more near the bottom
    k.sph(1, i % 2 ? l1 : l2, x + Math.sin(a) * L * 0.8, hgt - (0.5 - f * 0.6) * L * 0.6, z + Math.cos(a) * L * 0.8, L, 0.012, L * 0.45, 0, a - H, -(0.5 - f * 0.6) - R() * 0.2, 10, 6);
  }
};

B.bench = (k, c, R) => {
  const fr = mats.paint('#2f3338', 0.45), slat = c === 'brown' ? mats.wood('#a87a4e') : c === 'gray' ? mats.wood('#b9a68c') : mats.paint(tone(c), 0.5);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) k.box(0.04, 0.42, 0.04, fr, sx * 0.68, 0.21, sz * 0.16, 0.006);
    k.box(0.04, 0.04, 0.4, fr, sx * 0.68, 0.41, 0, 0.006); k.box(0.04, 0.03, 0.36, fr, sx * 0.68, 0.08, 0, 0.006);
  }
  k.box(1.36, 0.03, 0.03, fr, 0, 0.41, -0.15, 0.004);
  for (let i = 0; i < 4; i++) k.box(1.6, 0.03, 0.085, slat, 0, 0.445, -0.15 + i * 0.1, 0.008);
};

B['trash can'] = (k, c, R) => {
  const m = c === 'gray' ? mats.brushed('#b9bec5') : mats.paint(tone(c), 0.4);
  k.lathe([[0, 0], [0.18, 0], [0.19, 0.01], [0.21, 0.55], [0.215, 0.56], [0.215, 0.58], [0.2, 0.61], [0.13, 0.645], [0, 0.65]], m, 0, 0, 0, 24);
  k.tor(0.214, 0.006, mats.paint('#1f2328', 0.5), 0, 0.565, 0, H, 0, 0, PI * 2, 4, 32);
  k.box(0.12, 0.02, 0.08, mats.paint('#1f2328', 0.5), 0, 0.02, 0.2, 0.006);
};

B['vending machine'] = (k, c, R) => {
  const cab = mats.paint(tone(c), 0.35), dk = mats.paint('#0d1117', 0.5);
  k.box(0.9, 1.8, 0.75, cab, 0, 0.9, 0, 0.02);
  k.box(0.6, 1.3, 0.02, dk, -0.1, 1.08, 0.365, 0);
  const prod = ['#c62828', '#2f5fb8', '#e8b923', '#2e7d32', '#e8742a', '#f5f5f4'].map((h) => mats.plastic(h)), shelf = mats.metal('#9ca3af');
  for (let r = 0; r < 5; r++) {
    const y = 0.52 + r * 0.25; k.box(0.58, 0.012, 0.06, shelf, -0.1, y, 0.38, 0.003);
    for (let i = 0; i < 6; i++) {
      const m = prod[(r * 2 + i) % prod.length];
      if ((r + i) % 3) k.cyl(0.032, 0.032, 0.12, m, -0.36 + i * 0.105, y + 0.066, 0.385, 12);
      else k.box(0.07, 0.16, 0.03, m, -0.36 + i * 0.105, y + 0.086, 0.385, 0.005);
    }
  }
  k.box(0.62, 1.32, 0.008, mats.glass(), -0.1, 1.08, 0.41, 0);
  k.box(0.16, 0.36, 0.012, mats.paint('#1f2328', 0.4), 0.33, 1.12, 0.38, 0.004);
  for (let i = 0; i < 9; i++) k.box(0.03, 0.022, 0.01, mats.metal('#cbd5e1'), 0.29 + (i % 3) * 0.04, 1.2 - Math.floor(i / 3) * 0.04, 0.39, 0.003);
  k.box(0.09, 0.04, 0.01, mats.emissive('#22d3ee', 0.6), 0.33, 1.25, 0.388, 0.003);
  k.box(0.86, 0.12, 0.01, mats.emissive('#f8fafc', 0.6), 0, 1.68, 0.377, 0.003);
  k.box(0.55, 0.14, 0.03, dk, -0.1, 0.28, 0.37, 0.006);
  k.box(0.88, 0.06, 0.73, mats.paint('#111827', 0.6), 0, 0.03, 0, 0.004);
};

B.fridge = (k, c, R) => {
  const body = c === 'white' ? mats.paint('#eef0f1', 0.3) : c === 'gray' ? mats.brushed('#c3c8ce') : mats.paint(tone(c), 0.3), ch = mats.chrome();
  k.box(0.78, 1.82, 0.7, body, 0, 0.92, 0, 0.03);
  k.box(0.79, 0.008, 0.01, mats.paint('#9ca3af', 0.5), 0, 1.3, 0.35, 0);
  for (const [y, h] of [[1.52, 0.32], [0.95, 0.55]]) { k.box(0.025, h, 0.03, ch, 0.32, y, 0.385, 0.01); k.box(0.02, 0.03, 0.04, ch, 0.32, y + h / 2 - 0.02, 0.37, 0.005); k.box(0.02, 0.03, 0.04, ch, 0.32, y - h / 2 + 0.02, 0.37, 0.005); }
  k.box(0.72, 0.08, 0.02, mats.paint('#2b2f36', 0.6), 0, 0.045, 0.34, 0.004);
  k.box(0.12, 0.16, 0.008, mats.paint('#cbd5e1', 0.4), -0.2, 1.1, 0.352, 0.003);   // magnet note
};

B.table = (k, c, R) => {
  const w = woodOf(c);
  k.box(1.2, 0.04, 0.8, w, 0, 0.74, 0, 0.012);
  for (const [x, z, lx, lz] of [[0, 0.33, 1.0, 0.02], [0, -0.33, 1.0, 0.02], [0.53, 0, 0.02, 0.6], [-0.53, 0, 0.02, 0.6]]) k.box(lx, 0.08, lz, w, x, 0.68, z, 0.004);
  legs4(k, 1.2, 0.8, 0.72, w, 0.07, 0.05, true);
  k.lathe([[0, 0], [0.05, 0], [0.12, 0.05], [0.13, 0.06], [0.12, 0.06], [0.04, 0.012], [0, 0.012]], mats.ceramic('#e2e8f0'), 0.1, 0.76, 0, 18);
  for (const [x, z, h] of [[0.08, 0.02, '#e8742a'], [0.13, -0.03, '#c62828'], [0.12, 0.05, '#7cb342']]) k.sph(0.04, mats.plastic(h), x, 0.81, z, 1, 1, 1, 0, 0, 0, 10, 8);
};

B['dining table'] = (k, c, R) => {
  const w = woodOf(c);
  k.box(1.6, 0.045, 0.9, w, 0, 0.74, 0, 0.015);
  for (const [x, z, lx, lz] of [[0, 0.38, 1.36, 0.02], [0, -0.38, 1.36, 0.02], [0.7, 0, 0.02, 0.7], [-0.7, 0, 0.02, 0.7]]) k.box(lx, 0.09, lz, w, x, 0.67, z, 0.004);
  legs4(k, 1.6, 0.9, 0.72, w, 0.08, 0.07);
  k.box(1.25, 0.004, 0.32, mats.fabric('#d8cbb3'), 0, 0.764, 0, 0);
  for (const [x, z] of [[-0.45, 0.28], [0.45, 0.28], [-0.45, -0.28], [0.45, -0.28]]) k.cyl(0.11, 0.09, 0.015, mats.ceramic('#f8fafc'), x, 0.77, z, 20);
  k.lathe([[0, 0], [0.04, 0], [0.06, 0.08], [0.03, 0.2], [0.035, 0.22], [0, 0.22]], mats.ceramic('#94a3b8'), 0, 0.766, 0, 14);
  for (let i = 0; i < 5; i++) { const a = i * 1.26; k.rod([0, 0.95, 0], [Math.sin(a) * 0.06, 1.12, Math.cos(a) * 0.06], 0.004, mats.paint('#4d5d2a', 0.8), 4); k.sph(0.025, mats.plastic(['#f59e0b', '#f43f5e', '#fafafa'][i % 3]), Math.sin(a) * 0.06, 1.13, Math.cos(a) * 0.06, 1, 0.8, 1, 0, 0, 0, 8, 6); }
};

B['coffee machine'] = (k, c, R) => {
  // kitchenette cabinet with stone counter, espresso machine on top
  const cab = mats.paint('#e7e5e4', 0.45), ch = mats.chrome(), body = mats.paint(tone(c), 0.3);
  k.box(0.6, 0.84, 0.5, cab, 0, 0.44, 0, 0.008);
  k.box(0.004, 0.72, 0.004, mats.paint('#a8a29e', 0.6), 0, 0.46, 0.252, 0);
  for (const sx of [-1, 1]) k.box(0.012, 0.12, 0.02, ch, sx * 0.04, 0.7, 0.26, 0.004);
  k.box(0.56, 0.07, 0.46, mats.paint('#3f3f46', 0.6), 0, 0.035, -0.02, 0.003);
  k.box(0.64, 0.04, 0.54, mats.paint('#52525b', 0.3), 0, 0.88, 0, 0.006);
  const y0 = 0.9;
  k.box(0.32, 0.38, 0.32, body, 0, y0 + 0.19, -0.04, 0.03);
  k.box(0.3, 0.02, 0.28, ch, 0, y0 + 0.39, -0.04, 0.008);
  k.box(0.26, 0.025, 0.14, ch, 0, y0 + 0.014, 0.13, 0.006);
  k.cyl(0.035, 0.035, 0.04, ch, 0, y0 + 0.26, 0.13, 14);
  k.box(0.025, 0.02, 0.12, mats.paint('#111827', 0.5), 0, y0 + 0.23, 0.2, 0.006);
  k.box(0.12, 0.04, 0.005, mats.emissive('#7dd3fc', 0.5), 0, y0 + 0.33, 0.123, 0.002);
  for (const x of [-0.06, 0.06]) k.lathe([[0, 0], [0.025, 0], [0.032, 0.05], [0.028, 0.05], [0.022, 0.006], [0, 0.006]], mats.ceramic('#fafafa'), x, y0 + 0.03, 0.13, 12);
  k.box(0.12, 0.3, 0.2, mats.plastic('#1f2937'), 0.24, y0 + 0.15, -0.08, 0.02);
  k.lathe([[0, 0], [0.045, 0], [0.06, 0.1], [0, 0.1]], mats.glass(), 0.24, y0 + 0.3, -0.08, 12);
};

function upholstered(k, f, f2, accent, W, D, seats, legsM) {
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.cyl(0.02, 0.015, 0.08, legsM, sx * (W / 2 - 0.08), 0.04, sz * (D / 2 - 0.08), 8);
  k.box(W, 0.22, D, f, 0, 0.19, 0, 0.04);
  for (const sx of [-1, 1]) k.box(0.2, 0.36, D, f, sx * (W / 2 - 0.1), 0.44, 0, 0.07);
  k.box(W, 0.48, 0.2, f, 0, 0.53, -D / 2 + 0.1, 0.07);
  const inner = W - 0.4, sw = inner / seats;
  for (let i = 0; i < seats; i++) {
    const x = -inner / 2 + sw * (i + 0.5);
    k.box(sw - 0.01, 0.15, D - 0.26, f, x, 0.375, 0.08, 0.06);
    k.box(sw - 0.02, 0.4, 0.15, f2, x, 0.6, -D / 2 + 0.25, 0.07, -0.16);
  }
  if (accent) for (const sx of [-1, 1]) if (seats > 1) k.box(0.36, 0.34, 0.11, accent, sx * (inner / 2 - 0.2), 0.6, -D / 2 + 0.36, 0.06, -0.25, -sx * 0.35, 0);
}
B.sofa = (k, c, R) => upholstered(k, mats.fabric(tone(c)), mats.fabric(shade(tone(c), 0.03)), mats.fabric(c === 'yellow' ? '#e5e7eb' : '#d9b55a'), 2.0, 0.9, 2, mats.wood('#4a3b30'));
B.armchair = (k, c, R) => upholstered(k, mats.fabric(tone(c)), mats.fabric(shade(tone(c), 0.03)), null, 0.9, 0.88, 1, mats.wood('#4a3b30'));

B.tv = (k, c, R) => {
  const con = mats.wood('#6b4a2f'), dk = darkPlastic(), frame = mats.paint('#16181c', 0.35);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box(0.03, 0.1, 0.03, mats.paint('#1f2328', 0.5), sx * 0.66, 0.05, sz * 0.16, 0.004);
  k.box(1.45, 0.4, 0.42, con, 0, 0.3, 0, 0.01);
  for (let i = -1; i <= 1; i++) k.box(0.004, 0.34, 0.004, mats.paint('#3b2a1e', 0.7), i * 0.24 + 0.12, 0.3, 0.212, 0);
  k.box(0.6, 0.06, 0.08, dk, 0, 0.53, 0.12, 0.02);
  k.box(0.32, 0.015, 0.18, frame, 0, 0.508, -0.05, 0.005);
  k.box(0.06, 0.12, 0.03, frame, 0, 0.57, -0.08, 0.005);
  k.box(1.3, 0.76, 0.045, frame, 0, 0.95, -0.06, 0.012);
  k.box(1.26, 0.72, 0.004, mats.screen('tv'), 0, 0.955, -0.036, 0);
};

B.lamp = (k, c, R) => {
  const brass = mats.metal('#b08d57', 0.35);
  k.cyl(0.15, 0.16, 0.025, mats.paint('#2b2f36', 0.4), 0, 0.0125, 0, 24);
  k.cyl(0.012, 0.012, 1.42, brass, 0, 0.73, 0, 8);
  const shadeM = mats.sharedMat(`lampshade${c}`, () => new THREE.MeshStandardMaterial({ color: c === 'yellow' ? '#f3e6c8' : shade(tone(c), 0.25), emissive: '#ffcf7a', emissiveIntensity: 0.55, roughness: 0.9, side: THREE.DoubleSide }));
  k.cyl(0.19, 0.24, 0.3, shadeM, 0, 1.44, 0, 24, 0, 0, 0, true);
  k.sph(0.05, mats.emissive('#fff3c4', 1.2), 0, 1.38, 0);
  for (let i = 0; i < 3; i++) { const a = i * 2.094; k.rod([0, 1.45, 0], [Math.sin(a) * 0.185, 1.58, Math.cos(a) * 0.185], 0.003, brass, 4); }
};

B.rack = (k, c, R, o) => {
  const up = mats.paint('#1f4fa0', 0.45), beam = mats.paint('#e46f1f', 0.4), deck = mats.paint('#9aa3ad', 0.5), brace = mats.paint('#1f4fa0', 0.5);
  const L = o.l || 4.4, Ht = 2.3, levels = [0.14, 0.95, 1.75], nb = Math.max(1, Math.round(L / 2.2));
  for (let bi = 0; bi <= nb; bi++) { const z = -L / 2 + 0.04 + (bi * (L - 0.08)) / nb;
    for (const sx of [-1, 1]) { k.box(0.07, Ht, 0.07, up, sx * 0.45, Ht / 2, z, 0.004); k.box(0.14, 0.01, 0.12, mats.metal('#6b7280'), sx * 0.45, 0.005, z, 0); }
    for (let i = 0; i < 4; i++) { const y0 = 0.2 + i * 0.52; k.bar([-0.44, y0, z], [0.44, y0 + 0.5, z], 0.025, brace); k.box(0.86, 0.025, 0.025, brace, 0, y0, z, 0); }
  }
  for (const y of levels) {
    for (const sx of [-1, 1]) k.box(0.05, 0.11, L, beam, sx * 0.47, y, 0, 0.006);
    k.box(0.9, 0.02, L - 0.1, deck, 0, y + 0.06, 0, 0);
  }
  // stock: wrapped pallet loads, loose cartons and coloured totes per bay
  const bays = Array.from({ length: nb }, (_, i) => -L / 2 + (i + 0.5) * (L / nb)), toteM = ['#2f5fb8', '#2e7d32', '#e8742a', '#c62828'].map((h) => mats.plastic(h));
  const palletM = mats.wood('#c9a876');
  for (const y of levels) for (const bz of bays) {
    const r = R(), base = y + 0.07, maxH = 0.62;
    if (r < 0.45) {   // two pallet loads
      for (const dz of [-0.52, 0.52]) {
        if (R() < 0.15) continue;
        k.o = [0, 0, bz + dz];
        k.box(0.82, 0.12, 0.95, palletM, 0, base + 0.06, 0, 0);
        const top = cardboardStack(k, R, 0.8, 0.92, base + 0.12, maxH - 0.1, 0.95);
        if (R() < 0.7) k.box(0.84, top - base - 0.12 + 0.01, 0.96, mats.film(), 0, (top + base + 0.12) / 2, 0, 0.01);
        k.o = [0, 0, 0];
      }
    } else if (r < 0.8) {   // loose cartons
      let z = bz - 0.95;
      while (z < bz + 0.85) {
        const d = 0.3 + R() * 0.3, hh = 0.25 + R() * 0.3, w = 0.5 + R() * 0.35;
        if (R() < 0.85) { k.box(w, hh, d, mats.cardboard(), (R() - 0.5) * 0.1, base + hh / 2, z + d / 2, 0, 0, (R() - 0.5) * 0.1, 0); if (R() < 0.4 && hh < 0.4) k.box(w * 0.8, 0.2, d * 0.8, mats.cardboard(), 0, base + hh + 0.1, z + d / 2, 0, 0, (R() - 0.5) * 0.3, 0); }
        z += d + 0.05;
      }
    } else {   // rows of totes
      const m = toteM[Math.floor(R() * toteM.length)];
      for (let i = 0; i < 4; i++) for (let j = 0; j < (R() < 0.5 ? 2 : 1); j++) k.box(0.6, 0.25, 0.4, m, 0, base + 0.125 + j * 0.26, bz - 0.72 + i * 0.47, 0.02);
    }
  }
};

function palletBase(k, m) {
  for (const z of [-0.45, 0, 0.45]) { k.box(1.2, 0.02, 0.1, m, 0, 0.01, z, 0); k.box(1.2, 0.02, 0.1, m, 0, 0.12, z, 0); for (const x of [-0.55, 0, 0.55]) k.box(0.1, 0.09, 0.1, m, x, 0.065, z, 0); }
  for (let i = 0; i < 7; i++) k.box(0.12, 0.022, 1.0, m, -0.54 + i * 0.18, 0.141, 0, 0);
}
B.pallet = (k, c, R) => {
  const m = mats.wood(c === 'brown' ? '#c9a876' : shade(tone(c), 0.1));
  palletBase(k, m);
  if (R() < 0.85) {
    const top = cardboardStack(k, R, 1.15, 0.95, 0.152, 0.7 + R() * 0.5, 0.95);
    k.box(1.18, top - 0.152 + 0.01, 0.98, mats.film(), 0, (top + 0.152) / 2, 0, 0.012);
    k.box(0.03, 0.006, 1.0, mats.paint('#1f2937', 0.5), -0.3, top + 0.004, 0, 0); k.box(0.03, 0.006, 1.0, mats.paint('#1f2937', 0.5), 0.3, top + 0.004, 0, 0);
  }
};

B.forklift = (k, c, R) => {
  const body = mats.paint(tone(c), 0.35), dk = mats.paint('#2b2d31', 0.5), cw = mats.paint('#3a3d42', 0.5), rub = mats.rubber(), ch = mats.chrome();
  k.o = [0, 0, -0.3];
  k.box(0.95, 0.42, 1.25, body, 0, 0.43, -0.1, 0.05);
  k.box(0.97, 0.62, 0.38, cw, 0, 0.5, -0.78, 0.12);
  for (const sx of [-1, 1]) {
    k.cylX(0.23, 0.2, rub, sx * 0.42, 0.23, 0.35, 22); k.cylX(0.12, 0.21, mats.paint('#9ca3af', 0.4), sx * 0.42, 0.23, 0.35, 14);
    k.cylX(0.17, 0.17, rub, sx * 0.4, 0.17, -0.62, 20); k.cylX(0.09, 0.18, mats.paint('#9ca3af', 0.4), sx * 0.4, 0.17, -0.62, 12);
  }
  k.box(0.46, 0.09, 0.42, mats.leather('#1d2025'), 0, 0.7, -0.38, 0.03);
  k.box(0.44, 0.4, 0.09, mats.leather('#1d2025'), 0, 0.93, -0.58, 0.04, -0.15);
  k.rod([0, 0.64, 0.2], [0, 0.95, 0.06], 0.025, dk, 10);
  k.tor(0.13, 0.016, mats.rubber(), 0, 0.97, 0.05, -1.1, 0, 0, PI * 2, 6, 20);
  // overhead guard
  for (const sx of [-1, 1]) { k.box(0.05, 1.35, 0.05, dk, sx * 0.43, 1.3, 0.24, 0.008, 0.06); k.box(0.05, 1.35, 0.05, dk, sx * 0.43, 1.3, -0.68, 0.008); }
  k.box(0.95, 0.04, 0.05, dk, 0, 1.98, 0.27, 0.006); k.box(0.95, 0.04, 0.05, dk, 0, 1.98, -0.68, 0.006);
  for (const sx of [-1, 1]) k.box(0.05, 0.04, 1.0, dk, sx * 0.45, 1.98, -0.2, 0.006);
  for (let i = -1; i <= 1; i++) k.box(0.04, 0.03, 0.92, dk, i * 0.22, 1.99, -0.2, 0.004);
  k.cyl(0.05, 0.06, 0.08, mats.emissive('#f97316', 0.9), 0, 2.04, -0.6, 14);
  // mast, carriage, forks
  for (const sx of [-1, 1]) k.box(0.08, 2.0, 0.1, dk, sx * 0.3, 1.04, 0.58, 0.006);
  k.box(0.68, 0.07, 0.07, dk, 0, 0.4, 0.58, 0.004); k.box(0.68, 0.07, 0.07, dk, 0, 2.0, 0.58, 0.004);
  k.cyl(0.035, 0.035, 1.4, ch, 0, 1.1, 0.54, 12);
  k.box(0.82, 0.38, 0.05, dk, 0, 0.36, 0.67, 0.006);
  for (const sx of [-1, 1]) { k.box(0.1, 0.45, 0.04, cw, sx * 0.25, 0.3, 0.71, 0.004); k.box(0.1, 0.04, 1.05, cw, sx * 0.25, 0.06, 1.22, 0.004); }
  k.box(0.12, 0.08, 0.04, mats.emissive('#fefce8', 0.6), 0.38, 1.2, 0.27, 0.01);
  k.o = [0, 0, 0];
};

B.box = (k, c, R) => {
  if (c === 'orange' || c === 'brown') {   // cardboard cartons
    k.box(0.56, 0.42, 0.46, mats.cardboard(), 0, 0.21, 0, 0.004);
    if (R() < 0.6) k.box(0.4, 0.28, 0.34, mats.cardboard(), 0.02, 0.56, 0.01, 0.004, 0, 0.3, 0);
    k.box(0.15, 0.1, 0.002, mats.paint('#f8fafc', 0.8), 0.12, 0.28, 0.231, 0);
    return;
  }
  const m = mats.plastic(tone(c)), lid = mats.plastic(shade(tone(c), -0.06));
  const n = R() < 0.5 ? 2 : 1;
  for (let i = 0; i < n; i++) {
    const y = i * 0.33;
    k.box(0.58, 0.3, 0.4, m, 0, y + 0.15, 0, 0.02);
    k.box(0.6, 0.03, 0.42, lid, 0, y + 0.315, 0, 0.012);
    for (const sx of [-1, 1]) k.box(0.01, 0.04, 0.12, mats.paint('#111827', 0.6), sx * 0.291, y + 0.24, 0, 0.004);
  }
};

B.cart = (k, c, R) => {
  const m = mats.plastic(tone(c)), ch = mats.chrome();
  for (const y of [0.22, 0.78]) {
    k.box(0.6, 0.04, 0.9, m, 0, y, 0, 0.015);
    for (const sx of [-1, 1]) k.box(0.025, 0.05, 0.9, m, sx * 0.29, y + 0.04, 0, 0.008);
    for (const sz of [-1, 1]) k.box(0.6, 0.05, 0.025, m, 0, y + 0.04, sz * 0.44, 0.008);
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.cyl(0.016, 0.016, 0.72, ch, sx * 0.27, 0.48, sz * 0.42, 8);
  for (const sx of [-1, 1]) k.rod([sx * 0.27, 0.8, -0.42], [sx * 0.27, 1.0, -0.45], 0.016, ch, 8);
  k.cylX(0.02, 0.58, mats.rubber(), 0, 1.0, -0.45, 10);
  casters(k, [-0.24, 0.24], [-0.38, 0.38], 0.05);
  cardboardStack(k, R, 0.5, 0.7, 0.82, 0.45, 0.5);
};

B['safety cone'] = (k, c, R) => {
  const m = mats.plastic(tone(c));
  k.box(0.36, 0.03, 0.36, mats.rubber(), 0, 0.015, 0, 0.03);
  k.lathe([[0.13, 0.03], [0.025, 0.55], [0.018, 0.56], [0, 0.56]], m, 0, 0, 0, 20);
  k.cyl(0.069, 0.083, 0.07, mats.paint('#f8fafc', 0.3), 0, 0.31, 0, 20, 0, 0, 0, true);
  k.cyl(0.039, 0.05, 0.05, mats.paint('#f8fafc', 0.3), 0, 0.43, 0, 20, 0, 0, 0, true);
};

B['charging station'] = (k, c, R) => {
  const shell = mats.plastic('#e5e7eb');
  k.box(0.62, 0.02, 0.55, mats.paint('#2b2f36', 0.6), 0, 0.01, 0.05, 0.008);
  for (const sx of [-1, 1]) k.box(0.05, 0.008, 0.25, mats.metal('#d4a017', 0.3), sx * 0.12, 0.024, 0.1, 0);
  k.box(0.52, 0.5, 0.2, shell, 0, 0.27, -0.17, 0.05);
  k.box(0.42, 0.2, 0.01, mats.screenOff(), 0, 0.33, -0.065, 0.004);
  k.box(0.36, 0.025, 0.01, mats.emissive(tone(c), 1.0), 0, 0.46, -0.066, 0.006);
  k.box(0.12, 0.06, 0.012, mats.emissive(tone(c), 0.8), 0, 0.33, -0.058, 0.004);
  k.box(0.3, 0.06, 0.04, mats.paint('#2b2f36', 0.6), 0, 0.06, -0.06, 0.01);
};

B.bed = (k, c, R) => {
  const W = c === 'white' ? 1.45 : 1.05, L = 2.05, frame = mats.wood('#8a6342');
  const duv = c === 'white' ? mats.fabric('#f1f1ef') : mats.fabric(tone(c)), sheet = mats.fabric('#f7f7f5');
  k.box(W + 0.06, 0.25, L + 0.04, frame, 0, 0.18, 0, 0.02);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box(0.06, 0.08, 0.06, frame, sx * W / 2, 0.04, sz * L / 2, 0.004);
  k.box(W + 0.12, 0.95, 0.08, c === 'white' ? mats.fabric('#b8aa95') : frame, 0, 0.6, -L / 2 - 0.02, 0.035);
  k.box(W, 0.2, L - 0.04, sheet, 0, 0.4, 0, 0.05);
  k.box(W + 0.04, 0.12, L * 0.68, duv, 0, 0.52, L * 0.15, 0.05);
  k.box(W + 0.04, 0.06, 0.26, duv, 0, 0.57, -L * 0.2, 0.03);
  const pw = W > 1.2 ? 2 : 1;
  for (let i = 0; i < pw; i++) k.box(pw === 2 ? 0.6 : 0.65, 0.14, 0.38, sheet, pw === 2 ? (i ? 0.33 : -0.33) : 0, 0.58, -L / 2 + 0.28, 0.065, -0.18);
  k.box(W + 0.07, 0.03, 0.42, mats.fabric(c === 'white' ? '#7b8796' : '#e5e7eb'), 0, 0.595, L / 2 - 0.3, 0.012);
};

B['hospital bed'] = (k, c, R) => {
  const fr = mats.paint('#cbd5e1', 0.35), pl = mats.plastic('#e8edf2'), acc = mats.plastic(c === 'white' ? '#7aa7c7' : tone(c)), mat = mats.leather('#dbe7f0'), sheet = mats.fabric('#f8fafc');
  k.box(0.6, 0.12, 1.4, mats.paint('#4b5563', 0.5), 0, 0.2, 0, 0.02);
  k.box(0.88, 0.07, 1.95, fr, 0, 0.36, 0, 0.012);
  casters(k, [-0.36, 0.36], [-0.88, 0.88], 0.06);
  k.box(0.88, 0.14, 1.2, mat, 0, 0.47, 0.33, 0.05);
  k.box(0.88, 0.14, 0.72, mat, 0, 0.6, -0.62, 0.05, 0.35);
  k.box(0.9, 0.04, 1.0, sheet, 0, 0.55, 0.38, 0.02);
  k.box(0.6, 0.12, 0.34, sheet, 0, 0.78, -0.78, 0.055, 0.35);
  k.box(0.98, 0.6, 0.05, pl, 0, 0.65, -1.0, 0.025); k.box(0.7, 0.06, 0.052, acc, 0, 0.82, -1.0, 0.02);
  k.box(0.98, 0.5, 0.05, pl, 0, 0.6, 1.0, 0.025); k.box(0.7, 0.06, 0.052, acc, 0, 0.75, 1.0, 0.02);
  for (const sx of [-1, 1]) for (const [z, len] of [[-0.45, 0.6], [0.4, 0.75]]) {
    const x = sx * 0.47;
    k.box(0.03, 0.03, len, pl, x, 0.8, z, 0.012); k.box(0.03, 0.03, len, pl, x, 0.6, z, 0.012);
    for (let i = 0; i < 3; i++) k.box(0.025, 0.2, 0.025, pl, x, 0.7, z - len / 2 + 0.05 + i * (len - 0.1) / 2, 0.008);
  }
  k.box(0.06, 0.12, 0.03, mats.paint('#f8fafc', 0.4), 0.5, 0.68, 0.0, 0.01);
};

B.sink = (k, c, R) => {
  const cab = c === 'white' ? mats.paint('#f1f1ef', 0.45) : mats.paint(tone(c), 0.45), ch = mats.chrome();
  k.box(0.8, 0.76, 0.55, cab, 0, 0.46, 0, 0.008);
  k.box(0.76, 0.08, 0.5, mats.paint('#3f3f46', 0.6), 0, 0.04, -0.03, 0.003);
  k.box(0.004, 0.7, 0.004, mats.paint('#a8a29e', 0.6), 0, 0.46, 0.276, 0);
  for (const sx of [-1, 1]) k.box(0.012, 0.12, 0.02, ch, sx * 0.05, 0.7, 0.285, 0.004);
  k.box(0.84, 0.04, 0.6, mats.paint('#d6d3d1', 0.3), 0, 0.86, 0, 0.006);
  k.box(0.52, 0.006, 0.38, mats.brushed('#c3c8ce'), 0, 0.882, 0.03, 0.01);
  k.box(0.46, 0.006, 0.32, mats.metal('#6b7280', 0.3), 0, 0.884, 0.03, 0.01);
  k.cyl(0.022, 0.026, 0.05, ch, 0, 0.905, -0.2, 12);
  k.tube([[0, 0.9, -0.2], [0, 1.12, -0.2], [0, 1.15, -0.1], [0, 1.06, -0.02]], 0.012, ch, 16, 6);
  k.box(0.015, 0.012, 0.09, ch, 0.04, 0.95, -0.2, 0.004, 0, 0.6, 0);
};

B.wardrobe = (k, c, R) => {
  const w = woodOf(c), ch = mats.chrome();
  k.box(1.2, 2.0, 0.6, w, 0, 1.03, 0, 0.01);
  k.box(1.16, 0.06, 0.02, mats.paint('#2b2f36', 0.6), 0, 0.03, 0.27, 0);
  k.box(1.24, 0.04, 0.64, w, 0, 2.05, 0, 0.008);
  for (const sx of [-1, 1]) { k.box(0.585, 1.9, 0.022, w, sx * 0.297, 1.03, 0.31, 0.006); k.box(0.016, 0.45, 0.025, ch, sx * 0.04, 1.1, 0.335, 0.006); }
};

B.backpack = (k, c, R) => {
  const f = mats.fabric(tone(c)), f2 = mats.fabric(shade(tone(c), -0.07)), dk = mats.fabric('#1f2328');
  k.o = [0, 0, -0.02];
  k.box(0.32, 0.43, 0.18, f, 0, 0.225, 0, 0.075, -0.08);
  k.box(0.25, 0.2, 0.07, f2, 0, 0.15, 0.11, 0.03, -0.08);
  k.box(0.2, 0.006, 0.005, mats.metal('#9ca3af'), 0, 0.245, 0.145, 0, -0.08);
  k.box(0.07, 0.15, 0.05, f2, 0.18, 0.13, 0.0, 0.02);
  for (const sx of [-1, 1]) k.box(0.055, 0.38, 0.025, dk, sx * 0.08, 0.24, -0.1, 0.01, -0.12);
  k.tor(0.035, 0.009, dk, 0, 0.45, -0.02, 0, 0, 0, PI, 5, 10);
  k.o = [0, 0, 0];
};

B.laptop = (k, c, R) => {
  // small side table with an open laptop on it
  const w = mats.wood('#b48a5e'), leg = mats.paint('#1f2328', 0.4);
  k.box(0.5, 0.03, 0.42, w, 0, 0.55, 0, 0.008);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.rod([sx * 0.2, 0.535, sz * 0.16], [sx * 0.22, 0, sz * 0.18], 0.01, leg, 6);
  const sh = c === 'black' ? mats.metal('#30343b', 0.4) : mats.brushed('#b9bec5'), y = 0.565;
  k.box(0.33, 0.016, 0.23, sh, 0, y + 0.008, 0.02, 0.005);
  k.box(0.28, 0.003, 0.1, mats.paint('#16181c', 0.6), 0, y + 0.017, 0.0, 0);
  k.box(0.1, 0.002, 0.06, mats.paint('#3a3f47', 0.4), 0, y + 0.017, 0.09, 0);
  k.box(0.33, 0.22, 0.008, sh, 0, y + 0.118, -0.117, 0.004, -0.25);
  k.box(0.3, 0.19, 0.002, mats.screen('pc'), 0, y + 0.12, -0.112, 0, -0.25);
  k.lathe([[0, 0], [0.035, 0], [0.038, 0.085], [0.034, 0.085], [0.032, 0.008], [0, 0.008]], mats.ceramic('#f8fafc'), 0.19, y, 0.1, 12);
};

B.mug = (k, c, R) => {
  // small round café side table with the mug, a plate and a book
  const w = mats.wood('#a87a4e'), m = mats.paint('#2b2f36', 0.4);
  k.cyl(0.26, 0.26, 0.025, w, 0, 0.6, 0, 28);
  k.cyl(0.022, 0.022, 0.6, m, 0, 0.3, 0, 8);
  k.cyl(0.17, 0.19, 0.02, m, 0, 0.01, 0, 20);
  const y = 0.6125, mc = mats.ceramic(tone(c));
  k.lathe([[0, 0], [0.04, 0], [0.043, 0.095], [0.039, 0.095], [0.037, 0.01], [0, 0.01]], mc, 0, y, 0, 16);
  k.tor(0.026, 0.007, mc, 0.046, y + 0.048, 0, 0, 0, -H, PI, 5, 10);
  k.cyl(0.03, 0.03, 0.003, mats.paint('#5b3a1e', 0.2), 0, y + 0.085, 0, 12);
  k.cyl(0.09, 0.075, 0.012, mats.ceramic('#f8fafc'), 0.12, y + 0.006, 0.08, 18);
  k.box(0.16, 0.03, 0.22, mats.paint('#2f4b7c', 0.7), -0.1, y + 0.015, -0.08, 0.003, 0, 0.4, 0);
};

B['washing machine'] = (k, c, R) => {
  const b = c === 'white' ? mats.paint('#f3f4f6', 0.3) : mats.paint(tone(c), 0.3);
  k.box(0.6, 0.85, 0.6, b, 0, 0.425, 0, 0.03);
  k.box(0.56, 0.11, 0.01, mats.paint('#e5e7eb', 0.4), 0, 0.77, 0.301, 0.004);
  k.box(0.16, 0.07, 0.012, mats.paint('#d1d5db', 0.4), -0.17, 0.77, 0.304, 0.004);
  k.cylZ(0.035, 0.03, mats.chrome(), 0.15, 0.77, 0.31, 16);
  k.box(0.09, 0.035, 0.006, mats.emissive('#38bdf8', 0.7), 0.02, 0.775, 0.307, 0.002);
  k.cylZ(0.18, 0.01, mats.paint('#cbd5e1', 0.4), 0, 0.4, 0.302, 28);
  k.tor(0.165, 0.025, mats.paint('#9ca3af', 0.3), 0, 0.4, 0.315, 0, 0, 0, PI * 2, 8, 28);
  k.cylZ(0.145, 0.02, mats.metal('#374151', 0.25), 0, 0.4, 0.31, 28);
  k.cylZ(0.14, 0.01, mats.glass(), 0, 0.4, 0.325, 28);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.cyl(0.025, 0.025, 0.02, mats.rubber(), sx * 0.24, 0.01, sz * 0.24, 8);
};

B.wheelchair = (k, c, R) => {
  const fr = mats.metal('#9ca3af', 0.3), ch = mats.chrome(), seat = mats.fabric(c === 'black' ? '#23262b' : tone(c)), rub = mats.rubber(), dk = darkPlastic();
  for (const sx of [-1, 1]) {
    const x = sx * 0.31, cy = 0.3, cz = -0.08;
    k.tor(0.285, 0.02, rub, x, cy, cz, 0, H, 0, PI * 2, 8, 36);
    k.tor(0.265, 0.008, fr, x, cy, cz, 0, H, 0, PI * 2, 4, 36);
    k.tor(0.25, 0.007, ch, x + sx * 0.035, cy, cz, 0, H, 0, PI * 2, 5, 32);
    k.cylX(0.035, 0.07, dk, x, cy, cz, 12);
    for (let i = 0; i < 6; i++) { const a = (i / 6) * PI; k.rod([x, cy + Math.cos(a) * 0.26, cz + Math.sin(a) * 0.26], [x, cy - Math.cos(a) * 0.26, cz - Math.sin(a) * 0.26], 0.003, ch, 4); }
    // frame
    const fx = sx * 0.24;
    k.rod([fx, 0.5, -0.2], [fx, 0.5, 0.26], 0.012, fr);
    k.rod([fx, 0.3, -0.2], [fx, 0.98, -0.25], 0.012, fr);
    k.rod([fx, 0.98, -0.25], [fx, 0.98, -0.36], 0.016, rub);
    k.rod([fx, 0.5, 0.26], [fx * 0.9, 0.16, 0.36], 0.012, fr);
    k.rod([fx, 0.3, -0.2], [fx, 0.12, 0.3], 0.01, fr);
    k.rod([fx, 0.5, -0.12], [fx, 0.68, -0.12], 0.01, fr); k.rod([fx, 0.5, 0.15], [fx, 0.68, 0.15], 0.01, fr);
    k.box(0.05, 0.03, 0.32, dk, fx, 0.69, 0.02, 0.012);
    k.cylX(0.065, 0.03, rub, sx * 0.21, 0.065, 0.32, 14); k.box(0.012, 0.09, 0.03, fr, sx * 0.21, 0.12, 0.3, 0.003);
    k.box(0.14, 0.01, 0.1, dk, sx * 0.1, 0.14, 0.42, 0.004);
  }
  k.box(0.46, 0.04, 0.44, seat, 0, 0.51, 0.04, 0.015);
  k.box(0.46, 0.38, 0.02, seat, 0, 0.75, -0.215, 0.008, -0.06);
};

B['iv stand'] = (k, c, R) => {
  const ch = mats.chrome();
  star(k, 0.06, 0.26, mats.metal('#9ca3af', 0.3), mats.rubber());
  k.cyl(0.03, 0.03, 0.06, mats.metal('#9ca3af', 0.3), 0, 0.08, 0, 10);
  k.cyl(0.012, 0.012, 1.85, ch, 0, 1.0, 0, 8);
  for (let i = 0; i < 4; i++) { const a = i * H; k.rod([0, 1.88, 0], [Math.sin(a) * 0.12, 1.9, Math.cos(a) * 0.12], 0.005, ch, 4); k.tor(0.015, 0.003, ch, Math.sin(a) * 0.12, 1.885, Math.cos(a) * 0.12, 0, a, 0, PI, 4, 8); }
  k.box(0.12, 0.2, 0.035, mats.film(), 0.12, 1.74, 0, 0.015);
  k.box(0.1, 0.13, 0.025, mats.plastic('#e0f2fe'), 0.12, 1.71, 0, 0.012);
  k.tube([[0.12, 1.63, 0], [0.13, 1.4, 0.02], [0.1, 1.2, 0.06], [0.05, 1.12, 0.06]], 0.003, mats.plastic('#e5e7eb'), 14, 4);
  k.box(0.15, 0.18, 0.1, mats.plastic('#f1f5f9'), 0.07, 1.1, 0.0, 0.015);
  k.box(0.1, 0.06, 0.003, mats.screen('med'), 0.07, 1.14, 0.051, 0);
  k.box(0.03, 0.04, 0.05, mats.metal('#6b7280'), 0.0, 1.1, 0, 0.004);
};

B['medical cart'] = (k, c, R) => {
  const body = mats.plastic(tone(c)), fr = mats.plastic(shade(tone(c), 0.12)), top = mats.plastic('#f1f5f9'), dk = mats.paint('#1f2328', 0.5);
  k.box(0.62, 0.78, 0.46, body, 0, 0.5, 0, 0.02);
  const ys = [0.22, 0.38, 0.52, 0.64, 0.76];
  ys.forEach((y, i) => { const h = i < 2 ? 0.14 : 0.1; k.box(0.56, h, 0.012, fr, 0, y, 0.232, 0.006); k.box(0.2, 0.012, 0.012, dk, 0, y + h / 2 - 0.02, 0.24, 0.004); });
  k.box(0.68, 0.04, 0.52, top, 0, 0.91, 0, 0.012);
  k.box(0.68, 0.06, 0.02, top, 0, 0.95, -0.25, 0.008); for (const sx of [-1, 1]) k.box(0.02, 0.06, 0.52, top, sx * 0.33, 0.95, 0, 0.008);
  k.rod([0.35, 0.86, -0.15], [0.42, 0.86, -0.15], 0.012, mats.chrome()); k.rod([0.35, 0.86, 0.15], [0.42, 0.86, 0.15], 0.012, mats.chrome()); k.rod([0.42, 0.86, -0.16], [0.42, 0.86, 0.16], 0.014, mats.chrome());
  casters(k, [-0.25, 0.25], [-0.17, 0.17], 0.045);
  k.box(0.12, 0.16, 0.1, mats.plastic('#dc2626'), -0.2, 1.01, -0.1, 0.01);
  k.box(0.22, 0.08, 0.12, mats.paint('#f8fafc', 0.6), 0.1, 0.97, 0.05, 0.006);
};

B.defibrillator = (k, c, R) => {
  const st = mats.paint('#e5e7eb', 0.4), g = mats.plastic(tone(c));
  k.box(0.32, 0.02, 0.28, mats.paint('#374151', 0.5), 0, 0.01, 0, 0.006);
  k.box(0.08, 0.95, 0.06, st, 0, 0.49, -0.02, 0.01);
  k.box(0.36, 0.42, 0.16, st, 0, 1.16, 0, 0.02);
  k.box(0.26, 0.3, 0.1, g, 0, 1.15, 0.03, 0.025);
  k.box(0.12, 0.035, 0.012, mats.paint('#fafafa', 0.4), 0, 1.17, 0.085, 0.004); k.box(0.035, 0.12, 0.012, mats.paint('#fafafa', 0.4), 0, 1.17, 0.085, 0.004);
  k.box(0.32, 0.38, 0.006, mats.glass(), 0, 1.16, 0.083, 0);
  k.box(0.32, 0.09, 0.02, mats.emissive(tone(c), 0.5), 0, 1.45, 0, 0.008);
};

B['reception desk'] = (k, c, R) => {
  const front = c === 'white' ? mats.paint('#f3f4f6', 0.4) : mats.paint(tone(c), 0.4), top = mats.wood('#b88a5a'), acc = mats.paint('#7aa7c7', 0.4);
  k.box(2.4, 1.05, 0.06, front, 0, 0.525, 0.37, 0.01);
  for (const sx of [-1, 1]) k.box(0.06, 1.05, 0.8, front, sx * 1.17, 0.525, 0, 0.01);
  k.box(2.5, 0.04, 0.34, top, 0, 1.07, 0.3, 0.01);
  k.box(2.3, 0.03, 0.56, mats.paint('#f8fafc', 0.4), 0, 0.74, -0.08, 0.006);
  k.box(2.4, 0.07, 0.01, acc, 0, 0.32, 0.403, 0.003);
  k.box(2.3, 0.05, 0.02, mats.paint('#2b2f36', 0.6), 0, 0.025, 0.33, 0);
  const dk = darkPlastic();
  for (const x of [-0.5, 0.45]) {
    k.box(0.2, 0.012, 0.14, dk, x, 0.762, 0.05, 0.004); k.box(0.03, 0.2, 0.03, dk, x, 0.86, 0.06, 0.004);
    k.box(0.52, 0.32, 0.025, dk, x, 0.98, 0.05, 0.008, 0, PI, 0); k.box(0.49, 0.29, 0.004, mats.screen('pc'), x, 0.985, 0.036, 0, 0, PI, 0);
    k.box(0.4, 0.016, 0.12, mats.plastic('#3a3f47'), x, 0.763, -0.15, 0.005);
  }
  k.lathe([[0, 0], [0.06, 0], [0.07, 0.1], [0, 0.1]], mats.ceramic('#e7e5e4'), 0.95, 1.09, 0.3, 12);
  for (let i = 0; i < 7; i++) { const a = i * 0.9; k.sph(1, mats.leaf('#3f7d3a'), 0.95 + Math.sin(a) * 0.05, 1.24, 0.3 + Math.cos(a) * 0.05, 0.07, 0.01, 0.03, 0, a - H, -0.4, 8, 5); }
};


B.whiteboard = (k, c, R) => {
  const al = mats.brushed('#c9ced4'), dk = mats.paint('#2f3338', 0.5);
  for (const sx of [-1, 1]) { k.box(0.04, 1.75, 0.04, al, sx * 0.8, 0.9, 0, 0.008); k.box(0.06, 0.04, 0.55, dk, sx * 0.8, 0.07, 0, 0.01); for (const sz of [-1, 1]) k.cylX(0.03, 0.02, mats.rubber(), sx * 0.8, 0.03, sz * 0.24, 10); }
  k.box(1.6, 1.0, 0.04, al, 0, 1.25, 0, 0.012);
  k.box(1.54, 0.94, 0.006, mats.paint('#fbfbfb', 0.25), 0, 1.25, 0.022, 0);
  k.box(1.5, 0.025, 0.07, al, 0, 0.74, 0.04, 0.006);
  const ink = [mats.paint('#1d4ed8', 0.5), mats.paint('#b91c1c', 0.5), mats.paint('#111827', 0.5)];
  for (let i = 0; i < 9; i++) k.box(0.15 + R() * 0.45, 0.012, 0.002, ink[i % 3], -0.45 + R() * 0.6, 1.6 - i * 0.08, 0.026, 0, 0, 0, (R() - 0.5) * 0.15);
  k.box(0.32, 0.22, 0.002, ink[0], 0.45, 1.3, 0.026, 0); k.box(0.3, 0.2, 0.003, mats.paint('#fbfbfb', 0.25), 0.45, 1.3, 0.027, 0);
  for (let i = 0; i < 3; i++) k.cylX(0.008, 0.12, ink[i], -0.5 + i * 0.15, 0.765, 0.05, 6);
};

B.cabinet = (k, c, R) => {   // lateral filing cabinet
  const p = c === 'gray' || c === 'white' ? mats.paint(c === 'white' ? '#eef0f2' : '#9aa1a9', 0.4) : mats.paint(tone(c), 0.4), ch = mats.chrome();
  k.box(0.9, 1.1, 0.5, p, 0, 0.58, 0, 0.01);
  k.box(0.86, 0.05, 0.46, mats.paint('#2b2f36', 0.6), 0, 0.025, -0.01, 0.003);
  for (let i = 0; i < 3; i++) { const y = 0.25 + i * 0.35; k.box(0.86, 0.32, 0.015, p, 0, y, 0.252, 0.006); k.box(0.3, 0.02, 0.025, ch, 0, y + 0.1, 0.265, 0.006); k.box(0.1, 0.05, 0.004, mats.paint('#f8fafc', 0.6), 0, y + 0.03, 0.261, 0); }
  k.box(0.25, 0.3, 0.2, mats.cardboard(), -0.2, 1.28, 0, 0.003); k.lathe([[0, 0], [0.06, 0], [0.07, 0.12], [0, 0.12]], mats.ceramic('#cbd5e1'), 0.25, 1.13, 0, 12);
};

B.nightstand = (k, c, R) => {
  const w = woodOf(c), ch = mats.metal('#b08d57', 0.35);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box(0.035, 0.12, 0.035, w, sx * 0.19, 0.06, sz * 0.16, 0.004);
  k.box(0.45, 0.42, 0.4, w, 0, 0.33, 0, 0.012);
  for (const y of [0.24, 0.43]) { k.box(0.41, 0.17, 0.012, w, 0, y, 0.202, 0.005); k.sph(0.013, ch, 0, y, 0.215, 1, 1, 1); }
  k.cyl(0.06, 0.07, 0.03, mats.ceramic('#e7e5e4'), 0.08, 0.555, -0.05, 16); k.cyl(0.008, 0.008, 0.2, ch, 0.08, 0.66, -0.05, 6);
  k.cyl(0.08, 0.11, 0.14, mats.sharedMat('nsshade', () => new THREE.MeshStandardMaterial({ color: '#f3e6c8', emissive: '#ffcf7a', emissiveIntensity: 0.45, roughness: 0.9, side: THREE.DoubleSide })), 0.08, 0.8, -0.05, 18, 0, 0, 0, true);
  k.box(0.14, 0.03, 0.2, mats.paint('#8c2f39', 0.7), -0.1, 0.555, 0.04, 0.003, 0, 0.3, 0);
};

B['display shelf'] = (k, c, R, o) => {   // double-sided supermarket gondola along local z
  const L = o.l || 6.4, W = o.w || 0.9, body = mats.paint(c === 'white' ? '#eef0f2' : tone(c), 0.45), edge = mats.paint('#2f5fb8', 0.4);
  const prod = ['#c62828', '#2f5fb8', '#e8b923', '#2e7d32', '#e8742a', '#f5f5f4', '#7c3aed', '#0e7490', '#b45309'].map((h) => mats.plastic(h));
  k.box(W, 0.12, L, mats.paint('#3f444b', 0.6), 0, 0.06, 0, 0.01);
  k.box(0.06, 1.55, L, body, 0, 0.12 + 0.775, 0, 0.006);
  for (const z of [-L / 2, L / 2]) k.box(W, 1.6, 0.04, body, 0, 0.8, z, 0.008);
  const levels = [0.14, 0.5, 0.86, 1.22];
  for (const sx of [-1, 1]) for (const y of levels) {
    k.box(W / 2 - 0.05, 0.025, L - 0.06, body, sx * W / 4 + sx * 0.0, y, 0, 0.004);
    k.box(0.012, 0.04, L - 0.06, edge, sx * (W / 2 - 0.02), y + 0.005, 0, 0.003);
    let z = -L / 2 + 0.06;
    while (z < L / 2 - 0.12) {
      const run = 0.25 + R() * 0.45, m = prod[Math.floor(R() * prod.length)], kind = R(), h = 0.12 + R() * 0.16;
      const n = Math.max(1, Math.floor(run / 0.09)), wz = run / n;
      for (let i = 0; i < n; i++) {
        const zz = z + wz * (i + 0.5);
        if (kind < 0.35) k.cyl(wz * 0.4, wz * 0.4, h, m, sx * (W / 4 + 0.02), y + 0.0125 + h / 2, zz, 8);
        else k.box(W / 2 - 0.12, h, wz - 0.012, m, sx * (W / 4 + 0.02), y + 0.0125 + h / 2, zz, 0);
      }
      z += run + 0.02;
    }
  }
  k.box(0.02, 0.22, 0.9, mats.paint('#f8fafc', 0.5), 0, 1.85, 0, 0.004); k.box(0.024, 0.12, 0.84, edge, 0, 1.85, 0, 0.004);
};

B['checkout counter'] = (k, c, R) => {   // along local z
  const body = mats.paint(c === 'gray' ? '#9aa1a9' : tone(c), 0.45), top = mats.brushed('#c3c8ce'), dk = darkPlastic();
  k.box(0.8, 0.86, 1.8, body, 0, 0.43, 0, 0.012);
  k.box(0.82, 0.03, 1.82, top, 0, 0.875, 0, 0.006);
  k.box(0.42, 0.012, 1.1, mats.rubber(), -0.1, 0.896, -0.3, 0.004);
  k.box(0.02, 0.06, 1.1, mats.metal('#9ca3af'), 0.13, 0.92, -0.3, 0.003);
  k.box(0.36, 0.008, 0.3, mats.glass(), -0.1, 0.895, 0.42, 0.003);
  k.cyl(0.02, 0.02, 0.2, dk, 0.25, 0.99, 0.55, 8); k.box(0.3, 0.2, 0.03, dk, 0.25, 1.15, 0.55, 0.008, -0.2, -H, 0); k.box(0.27, 0.17, 0.003, mats.screen('pc'), 0.234, 1.15, 0.55, 0, -0.2, -H, 0);
  k.box(0.1, 0.04, 0.16, dk, 0.0, 0.91, 0.75, 0.008, 0.25, 0, 0);
  k.box(0.35, 0.12, 0.45, mats.paint('#2b2f36', 0.5), 0.15, 0.95, 0.2, 0.01);
  k.cyl(0.02, 0.02, 1.1, mats.metal('#9ca3af'), 0.36, 1.45, -0.85, 8);
  k.cyl(0.09, 0.09, 0.14, mats.emissive('#22c55e', 0.7), 0.36, 2.05, -0.85, 18);
};

B['shopping cart'] = (k, c, R) => {
  const wire = c === 'gray' ? mats.chrome() : mats.paint(tone(c), 0.35), red = mats.plastic('#c62828'), t = 0.006;
  const y0 = 0.42, y1 = 0.9, zf = 0.42, zb = -0.4, wf = 0.21, wb = 0.26;
  for (const sx of [-1, 1]) { k.rod([sx * wf, y0, zf], [sx * wb, y0, zb], 0.012, wire); k.rod([sx * wf, y1, zf + 0.06], [sx * wb, y1, zb], 0.01, wire); }
  k.rod([-wf, y1, zf + 0.06], [wf, y1, zf + 0.06], 0.01, wire); k.rod([-wb, y1, zb], [wb, y1, zb], 0.01, wire);
  for (let i = 0; i <= 12; i++) { const f = i / 12, z = zf + (zb - zf) * f, w = wf + (wb - wf) * f; for (const sx of [-1, 1]) k.rod([sx * w, y0, z], [sx * w, y1, z + 0.06 * (1 - f)], t, wire, 4); }
  for (let i = 0; i <= 7; i++) { const x = -wf + (2 * wf * i) / 7; k.rod([x, y0, zf], [x, y1, zf + 0.06], t, wire, 4); k.rod([x * wb / wf, y0, zb], [x * wb / wf, y1, zb], t, wire, 4); k.rod([x, y0, zf], [x * wb / wf, y0, zb], t, wire, 4); }
  k.rod([-0.27, 1.0, -0.5], [0.27, 1.0, -0.5], 0.018, red, 10);
  for (const sx of [-1, 1]) k.rod([sx * 0.26, y1, zb], [sx * 0.27, 1.0, -0.5], 0.01, wire);
  for (const sx of [-1, 1]) { k.rod([sx * 0.2, y0, zf - 0.02], [sx * 0.2, 0.1, zf], 0.012, wire); k.rod([sx * 0.24, y0, zb], [sx * 0.24, 0.1, zb], 0.012, wire); k.rod([sx * 0.2, 0.1, zf], [sx * 0.24, 0.1, zb], 0.012, wire); }
  casters(k, [-0.2, 0.2], [zf, zb], 0.045);
  k.box(0.44, 0.012, 0.75, wire, 0, 0.16, 0.0, 0.003);
  k.box(0.4, 0.05, 0.06, red, 0, 0.905, zb + 0.02, 0.01);
};

B.freezer = (k, c, R) => {   // supermarket chest freezer, long side along local x
  const body = c === 'white' ? mats.paint('#f1f3f5', 0.35) : mats.paint(tone(c), 0.35), dk = mats.paint('#2b2f36', 0.6);
  k.box(1.8, 0.82, 0.8, body, 0, 0.43, 0, 0.03);
  k.box(1.76, 0.08, 0.76, dk, 0, 0.04, 0, 0.004);
  k.box(1.72, 0.02, 0.72, mats.paint('#cfe7f5', 0.3), 0, 0.72, 0, 0.004);
  const prod = ['#2f5fb8', '#c62828', '#e8b923', '#f5f5f4', '#2e7d32', '#e8742a'].map((h) => mats.plastic(h));
  for (let i = 0; i < 26; i++) k.box(0.14 + R() * 0.08, 0.04, 0.12 + R() * 0.08, prod[Math.floor(R() * prod.length)], -0.78 + R() * 1.56, 0.75 + R() * 0.03, -0.28 + R() * 0.56, 0.006, 0, R() * PI, 0);
  k.box(1.76, 0.012, 0.76, mats.glass(), 0, 0.85, 0, 0.004);
  for (const x of [-0.88, 0, 0.88]) k.box(0.025, 0.04, 0.78, mats.metal('#9ca3af', 0.35), x, 0.85, 0, 0.004);
  k.box(1.8, 0.05, 0.02, mats.paint('#2f5fb8', 0.4), 0, 0.79, 0.405, 0.004);
};

B['fume hood'] = (k, c, R) => {
  const p = mats.paint(c === 'gray' ? '#c8ccd1' : tone(c), 0.4), wk = mats.paint('#2b2f36', 0.4), glass = mats.glass();
  k.box(1.5, 0.85, 0.75, p, 0, 0.425, 0, 0.008);
  for (const x of [-0.375, 0.375]) { k.box(0.004, 0.75, 0.004, mats.paint('#9ca3af', 0.5), x, 0.44, 0.377, 0); k.box(0.12, 0.015, 0.02, mats.chrome(), x - 0.1, 0.75, 0.385, 0.004); k.box(0.12, 0.015, 0.02, mats.chrome(), x + 0.1, 0.75, 0.385, 0.004); }
  k.box(1.52, 0.035, 0.78, wk, 0, 0.87, 0, 0.004);
  for (const sx of [-1, 1]) k.box(0.08, 1.2, 0.75, p, sx * 0.71, 1.49, 0, 0.008);
  k.box(1.5, 0.08, 0.75, p, 0, 2.13, 0, 0.008); k.box(1.42, 1.2, 0.03, p, 0, 1.49, -0.36, 0.004);
  k.box(1.36, 0.6, 0.012, glass, 0, 1.55, 0.33, 0); k.box(1.38, 0.04, 0.04, mats.brushed(), 0, 1.24, 0.34, 0.006);
  k.box(1.36, 0.25, 0.03, p, 0, 1.97, 0.34, 0.004);
  k.box(0.1, 0.05, 0.005, mats.emissive('#22c55e', 0.7), 0.55, 1.97, 0.357, 0.002);
  k.cyl(0.14, 0.14, 0.4, mats.brushed(), 0, 2.37, -0.1, 18);
  k.lathe([[0, 0], [0.04, 0], [0.045, 0.12], [0.015, 0.2], [0.015, 0.24], [0, 0.24]], glass, -0.3, 0.89, 0.0, 12);
  k.cyl(0.035, 0.035, 0.12, mats.plastic('#f5f5f4'), 0.2, 0.95, -0.1, 12); k.cyl(0.03, 0.03, 0.1, mats.plastic('#38bdf8'), 0.3, 0.94, 0.05, 12);
};

B.centrifuge = (k, c, R) => {
  const w = mats.plastic(c === 'white' ? '#f1f3f5' : tone(c));
  k.box(0.55, 0.7, 0.55, mats.paint('#d4d4d8', 0.5), 0, 0.35, 0, 0.01); casters(k, [-0.22, 0.22], [-0.22, 0.22], 0.03);
  k.box(0.5, 0.3, 0.5, w, 0, 0.85, 0, 0.06);
  k.cyl(0.18, 0.18, 0.03, mats.plastic('#cbd5e1'), 0, 1.0, -0.03, 24);
  k.box(0.3, 0.1, 0.03, mats.plastic('#2b2f36'), 0, 0.84, 0.25, 0.01, -0.3); k.box(0.12, 0.05, 0.005, mats.screen('med'), -0.05, 0.85, 0.268, 0, -0.3);
};

B['gas cylinder'] = (k, c, R) => {
  const m = mats.paint(tone(c), 0.3);
  k.box(0.32, 0.02, 0.32, mats.paint('#374151', 0.5), 0, 0.01, 0, 0.006);
  k.lathe([[0, 0.02], [0.1, 0.02], [0.11, 0.05], [0.11, 1.2], [0.09, 1.3], [0.04, 1.34], [0, 1.34]], m, 0, 0, 0, 20);
  k.cyl(0.111, 0.111, 0.12, mats.paint('#f5f5f4', 0.5), 0, 1.15, 0, 20, 0, 0, 0, true);
  k.cyl(0.025, 0.03, 0.08, mats.metal('#b08d57', 0.3), 0, 1.38, 0, 10); k.cylX(0.012, 0.08, mats.metal('#b08d57', 0.3), 0.03, 1.38, 0, 8);
  k.cyl(0.03, 0.03, 0.03, mats.paint('#111827', 0.5), 0, 1.43, 0, 12);
  k.tor(0.12, 0.006, mats.metal('#6b7280', 0.4), 0, 0.9, 0, H, 0, 0, PI * 2, 4, 24);
  k.box(0.03, 0.95, 0.03, mats.paint('#374151', 0.5), 0, 0.475, -0.14, 0.004);
};

B['eyewash station'] = (k, c, R) => {
  const g = mats.plastic(tone(c)), ch = mats.chrome();
  k.cyl(0.14, 0.15, 0.02, mats.paint('#374151', 0.5), 0, 0.01, 0, 18);
  k.cyl(0.025, 0.025, 0.95, mats.paint(tone(c), 0.4), 0, 0.48, 0, 10);
  k.lathe([[0, 0], [0.05, 0], [0.16, 0.08], [0.17, 0.1], [0.16, 0.1], [0.05, 0.015], [0, 0.015]], g, 0, 0.95, 0, 20);
  for (const sx of [-1, 1]) k.cyl(0.018, 0.022, 0.05, mats.plastic('#facc15'), sx * 0.05, 1.0, 0, 10);
  k.rod([0, 0.9, 0.05], [0, 0.95, 0.22], 0.008, ch); k.box(0.14, 0.012, 0.08, g, 0, 0.95, 0.25, 0.005);
  k.box(0.22, 0.16, 0.01, mats.paint('#16a34a', 0.5), 0, 1.4, 0, 0.006); k.cyl(0.012, 0.012, 0.35, mats.paint('#374151', 0.5), 0, 1.15, -0.02, 6);
};

B.default = (k, c) => k.box(0.4, 0.4, 0.4, mats.plastic(tone(c)), 0, 0.2, 0, 0.03);

export function objectMesh(o) {
  const g = new THREE.Group();
  if (o.cat !== 'door') {
    const k = new Kit(), R = rngFor(`${o.id}|${o.cat}|${o.x.toFixed(2)}`);
    (B[o.cat] || B.default)(k, o.color, R, o);
    k.bake(g);
  }
  g.position.set(o.x, 0, o.y);
  g.rotation.y = o.cat === 'rack' ? 0 : -o.th;
  g.userData = { object: o };
  return g;
}

// ---------- robot: compact indoor rover (local +x is forward) ----------
export function robotMesh(robot) {
  const hex = `#${new THREE.Color(robot.color).getHexString()}`;
  const k = new Kit(), body = mats.sharedMat(`robot${hex}`, () => new THREE.MeshStandardMaterial({ color: hex, roughness: 0.32, metalness: 0.05 }));
  const dk = mats.paint('#1d2127', 0.55), rub = mats.rubber(), ch = mats.brushed('#9aa1aa');
  k.box(0.56, 0.07, 0.44, mats.paint('#2a2e35', 0.8), 0, 0.105, 0, 0.03);          // bumper skirt
  k.box(0.52, 0.15, 0.4, body, 0, 0.19, 0, 0.06);                                    // shell
  k.box(0.38, 0.02, 0.3, dk, -0.02, 0.27, 0, 0.012);                                 // top deck
  k.box(0.035, 0.085, 0.42, rub, 0.27, 0.12, 0, 0.02);                               // front bumper
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) { k.cylZ(0.075, 0.055, rub, sx * 0.16, 0.075, sz * 0.215, 20); k.cylZ(0.035, 0.06, ch, sx * 0.16, 0.075, sz * 0.218, 12); }
  k.box(0.04, 0.05, 0.12, dk, 0.255, 0.215, 0, 0.012);                               // depth camera
  for (const sz of [-0.035, 0.035]) k.cylX(0.012, 0.01, mats.emissive('#0ea5e9', 0.5), 0.277, 0.215, sz, 10);
  k.cyl(0.016, 0.016, 0.2, ch, -0.08, 0.37, 0, 10);                                   // mast
  k.cyl(0.05, 0.058, 0.03, dk, -0.08, 0.48, 0, 20);                                   // lidar base
  k.cyl(0.05, 0.05, 0.045, mats.plastic('#111418'), -0.08, 0.517, 0, 20);             // lidar puck
  k.cyl(0.051, 0.051, 0.012, mats.metal('#3b4350', 0.2), -0.08, 0.51, 0, 20);
  k.cyl(0.044, 0.05, 0.012, dk, -0.08, 0.546, 0, 20);
  for (const sz of [-1, 1]) k.box(0.12, 0.004, 0.012, mats.paint('#f8fafc', 0.4), 0.06, 0.262, sz * 0.2, 0);   // accent stripes
  const g = k.bake();
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.016, 10, 8), new THREE.MeshBasicMaterial({ color: 0x22c55e }));
  led.position.set(0.12, 0.285, 0.1); g.add(led); g.userData.led = led;
  const fov = new THREE.Mesh(new THREE.CircleGeometry(SENSOR.range, 32, -SENSOR.fov / 2, SENSOR.fov),
    new THREE.MeshBasicMaterial({ color: robot.color, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide }));
  fov.rotation.x = -Math.PI / 2; fov.position.y = 0.02; fov.userData.noAO = true; g.add(fov);
  g.userData.fov = fov;
  return g;
}

// Pose-graph back end: two-stage estimation (rotation first, then
// translation) solved with Gauss-Seidel + successive over-relaxation (SOR),
// following Choudhary et al. (ICRA 2016, IJRR 2017). The same sweeps run
// either centrally or distributed, where each robot only updates its own
// variables and exchanges estimates of "separator" variables with peers.
import { compose, between, inverse, wrap } from './geom.js';

const W = {
  odoR: 3000, odoT: 2000,     // odometry
  obsR: 250, obsT: 220,       // object observations
  sepR: 250, sepT: 300,       // inter-robot "same object" constraints
};

export class PoseGraph {
  constructor() { this.vars = []; this.factors = []; this.adj = []; }
  addVar(v) {
    this.vars.push({ x: v.x, y: v.y, th: v.th, owner: v.owner, kind: v.kind, key: v.key, fixed: !!v.fixed });
    this.adj.push([]);
    return this.vars.length - 1;
  }
  addFactor(i, j, z, wR, wT, kind) {
    const f = { i, j, z, wR, wT, kind, c: Math.cos(z.th), s: Math.sin(z.th) };
    this.factors.push(f);
    this.adj[i].push(this.factors.length - 1);
    this.adj[j].push(this.factors.length - 1);
    return f;
  }
}

// Build one robot's local graph from its simulated data (local object
// tracking is assumed solved; cross-robot association is estimated).
export function buildLocal(sim, owner, initPoses) {
  const g = new PoseGraph();
  const poseIdx = initPoses.map((p, k) => g.addVar({ ...p, owner, kind: 'pose', key: `${owner}:p${k}`, fixed: k === 0 }));
  const lmIdx = {};
  for (const o of sim.obs) {
    if (!(o.obj in lmIdx)) {
      const guess = compose(initPoses[o.k], o.z);
      lmIdx[o.obj] = g.addVar({ ...guess, owner, kind: 'object', key: `${owner}:${o.obj}` });
    }
  }
  for (const f of sim.odom) g.addFactor(poseIdx[f.i], poseIdx[f.j], f.z, W.odoR, W.odoT, 'odom');
  for (const o of sim.obs) g.addFactor(poseIdx[o.k], lmIdx[o.obj], o.z, W.obsR, W.obsT, 'obs');
  return { g, poseIdx, lmIdx };
}

// ---- Stage 1: rotations as unit complex numbers, linear least squares.
function rotSweep(g, cr, ci, vars, omega, read) {
  let delta = 0;
  for (const v of vars) {
    if (g.vars[v].fixed) continue;
    let nr = 0, ni = 0, den = 0;
    for (const fi of g.adj[v]) {
      const f = g.factors[fi];
      if (f.i === v) {           // z_j ~ z_v * z_ij  =>  z_v = z_j * conj(z_ij)
        const [jr, ji] = read(f.j);
        nr += f.wR * (jr * f.c + ji * f.s); ni += f.wR * (ji * f.c - jr * f.s);
      } else {                   // z_v ~ z_i * z_iv
        const [ir, ii] = read(f.i);
        nr += f.wR * (ir * f.c - ii * f.s); ni += f.wR * (ir * f.s + ii * f.c);
      }
      den += f.wR;
    }
    const tr = nr / den, ti = ni / den;
    const ur = cr[v] + omega * (tr - cr[v]), ui = ci[v] + omega * (ti - ci[v]);
    delta = Math.max(delta, Math.hypot(ur - cr[v], ui - ci[v]));
    cr[v] = ur; ci[v] = ui;
  }
  return delta;
}

// ---- Stage 2: translations given rotations, linear least squares.
function transSweep(g, tx, ty, vars, omega, read, cosv, sinv) {
  let delta = 0;
  for (const v of vars) {
    if (g.vars[v].fixed) continue;
    let nx = 0, ny = 0, den = 0;
    for (const fi of g.adj[v]) {
      const f = g.factors[fi];
      if (f.i === v) {           // t_j = t_v + R_v z  =>  t_v = t_j - R_v z
        const [jx, jy] = read(f.j);
        nx += f.wT * (jx - (cosv[v] * f.z.x - sinv[v] * f.z.y));
        ny += f.wT * (jy - (sinv[v] * f.z.x + cosv[v] * f.z.y));
      } else {                   // t_v = t_i + R_i z
        const [ix, iy] = read(f.i);
        nx += f.wT * (ix + cosv[f.i] * f.z.x - sinv[f.i] * f.z.y);
        ny += f.wT * (iy + sinv[f.i] * f.z.x + cosv[f.i] * f.z.y);
      }
      den += f.wT;
    }
    const ux = tx[v] + omega * (nx / den - tx[v]), uy = ty[v] + omega * (ny / den - ty[v]);
    delta = Math.max(delta, Math.hypot(ux - tx[v], uy - ty[v]));
    tx[v] = ux; ty[v] = uy;
  }
  return delta;
}

// Iterative solver that can be stepped one "round" at a time for animation.
// owners: list of robot ids. In distributed mode each round, every robot runs
// `inner` sweeps over its own variables while reading peers' separator
// variables from the snapshot exchanged at the start of the round.
export class TwoStageSolver {
  constructor(g, { distributed = false, omega = 1.9, inner = 4, tolR = 2e-5, tolT = 2e-4 } = {}) {
    this.g = g; this.distributed = distributed; this.omega = omega; this.inner = inner;
    this.tolR = tolR; this.tolT = tolT;
    const n = g.vars.length;
    this.cr = new Float64Array(n); this.ci = new Float64Array(n);
    this.tx = new Float64Array(n); this.ty = new Float64Array(n);
    this.cosv = new Float64Array(n); this.sinv = new Float64Array(n);
    g.vars.forEach((v, i) => { this.cr[i] = Math.cos(v.th); this.ci[i] = Math.sin(v.th); this.tx[i] = v.x; this.ty[i] = v.y; });
    this.owners = [...new Set(g.vars.map((v) => v.owner))];
    this.byOwner = Object.fromEntries(this.owners.map((o) => [o, g.vars.map((v, i) => (v.owner === o ? i : -1)).filter((i) => i >= 0)]));
    // separators: variables that appear in a factor with a variable of another owner
    this.sep = new Set();
    for (const f of g.factors) if (g.vars[f.i].owner !== g.vars[f.j].owner) { this.sep.add(f.i); this.sep.add(f.j); }
    this.stage = 1; this.round = 0; this.done = false; this.bytes = 0; this.lastDelta = Infinity;
    this.snap = { cr: Float64Array.from(this.cr), ci: Float64Array.from(this.ci) }; this.growth = 0; this.restarts = 0;
  }
  get separatorCount() { return this.sep.size; }
  step() {
    if (this.done) return;
    const g = this.g;
    if (this.stage === 1) {
      let d = 0;
      if (this.distributed) {
        const snapR = Float64Array.from(this.cr), snapI = Float64Array.from(this.ci);
        for (const o of this.owners) {
          const read = (j) => (g.vars[j].owner === o ? [this.cr[j], this.ci[j]] : [snapR[j], snapI[j]]);
          for (let s = 0; s < this.inner; s++) d = Math.max(d, rotSweep(g, this.cr, this.ci, this.byOwner[o], this.omega, read));
        }
        this.bytes += this.sep.size * 2 * 4;   // each separator: 2 float32 per round
      } else {
        const read = (j) => [this.cr[j], this.ci[j]];
        const all = g.vars.map((_, i) => i);
        for (let s = 0; s < this.inner; s++) d = Math.max(d, rotSweep(g, this.cr, this.ci, all, this.omega, read));
      }
      if (this.guard(d)) return;
      this.lastDelta = d; this.round++;
      if (d < this.tolR || this.round > 1500) {
        for (let i = 0; i < g.vars.length; i++) {
          const n = Math.hypot(this.cr[i], this.ci[i]) || 1;
          this.cosv[i] = this.cr[i] / n; this.sinv[i] = this.ci[i] / n;
          g.vars[i].th = Math.atan2(this.sinv[i], this.cosv[i]);
        }
        this.stage = 2; this.stage1Rounds = this.round; this.round = 0;
        this.snap = { tx: Float64Array.from(this.tx), ty: Float64Array.from(this.ty) }; this.lastDelta = Infinity; this.growth = 0;
      }
      return;
    }
    let d = 0;
    if (this.distributed) {
      const sx = Float64Array.from(this.tx), sy = Float64Array.from(this.ty);
      for (const o of this.owners) {
        const read = (j) => (g.vars[j].owner === o ? [this.tx[j], this.ty[j]] : [sx[j], sy[j]]);
        for (let s = 0; s < this.inner; s++) d = Math.max(d, transSweep(g, this.tx, this.ty, this.byOwner[o], this.omega, read, this.cosv, this.sinv));
      }
      this.bytes += this.sep.size * 2 * 4;
    } else {
      const read = (j) => [this.tx[j], this.ty[j]];
      const all = g.vars.map((_, i) => i);
      for (let s = 0; s < this.inner; s++) d = Math.max(d, transSweep(g, this.tx, this.ty, all, this.omega, read, this.cosv, this.sinv));
    }
    if (this.guard(d)) return;
    this.lastDelta = d; this.round++;
    for (let i = 0; i < g.vars.length; i++) { g.vars[i].x = this.tx[i]; g.vars[i].y = this.ty[i]; }
    if (d < this.tolT || this.round > 1500) { this.done = true; this.stage2Rounds = this.round; }
  }
  // Distributed SOR with stale neighbour values can diverge; if the update keeps
  // growing, restart the current stage from its start with a smaller omega.
  guard(d) {
    const bad = !Number.isFinite(d) || d > 50 || (this.round > 10 && d > this.lastDelta * 1.02 && ++this.growth > 25);
    if (d <= this.lastDelta * 1.02) this.growth = 0;
    if (!bad) return false;
    this.omega = Math.max(1.0, this.omega - 0.3); this.restarts++; this.growth = 0; this.lastDelta = Infinity; this.round = 0;
    if (this.stage === 1) { this.cr.set(this.snap.cr); this.ci.set(this.snap.ci); }
    else { this.tx.set(this.snap.tx); this.ty.set(this.snap.ty); }
    if (this.restarts > 6) { this.done = true; }
    return true;
  }

  // current estimate (rotation stage shows normalized rotations, old translations)
  estimate(i) {
    if (this.stage === 1) {
      const n = Math.hypot(this.cr[i], this.ci[i]) || 1;
      return { x: this.tx[i], y: this.ty[i], th: Math.atan2(this.ci[i] / n, this.cr[i] / n) };
    }
    return { x: this.tx[i], y: this.ty[i], th: this.g.vars[i].th };
  }
  solve() { while (!this.done) this.step(); return this; }
}

// ATE after the best rigid alignment of all estimates to ground truth (one
// transform for the whole set, so inconsistency between robots still counts).
export function ateAligned(est, gt) {
  const n = gt.length;
  let ax = 0, ay = 0, bx = 0, by = 0;
  for (let i = 0; i < n; i++) { ax += gt[i].x; ay += gt[i].y; bx += est[i].x; by += est[i].y; }
  ax /= n; ay /= n; bx /= n; by /= n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const ux = est[i].x - bx, uy = est[i].y - by, vx = gt[i].x - ax, vy = gt[i].y - ay;
    sxx += ux * vx + uy * vy; sxy += ux * vy - uy * vx;
  }
  const th = Math.atan2(sxy, sxx), c = Math.cos(th), s = Math.sin(th);
  let e = 0;
  for (let i = 0; i < n; i++) {
    const ux = est[i].x - bx, uy = est[i].y - by;
    e += (ax + c * ux - s * uy - gt[i].x) ** 2 + (ay + s * ux + c * uy - gt[i].y) ** 2;
  }
  return Math.sqrt(e / n);
}

// Best rigid transform mapping estimates onto ground truth; returns a function
// that maps a pose. Used to register maps to the floor plan for display.
export function rigidAlign(est, gt) {
  const n = gt.length;
  let ax = 0, ay = 0, bx = 0, by = 0;
  for (let i = 0; i < n; i++) { ax += gt[i].x; ay += gt[i].y; bx += est[i].x; by += est[i].y; }
  ax /= n; ay /= n; bx /= n; by /= n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const ux = est[i].x - bx, uy = est[i].y - by, vx = gt[i].x - ax, vy = gt[i].y - ay;
    sxx += ux * vx + uy * vy; sxy += ux * vy - uy * vx;
  }
  const th = Math.atan2(sxy, sxx), c = Math.cos(th), s = Math.sin(th);
  return (p) => ({ x: ax + c * (p.x - bx) - s * (p.y - by), y: ay + s * (p.x - bx) + c * (p.y - by), th: wrap(p.th + th) });
}

export function ate(est, gt) {
  let s = 0;
  for (let i = 0; i < gt.length; i++) s += (est[i].x - gt[i].x) ** 2 + (est[i].y - gt[i].y) ** 2;
  return Math.sqrt(s / gt.length);
}

// Express poses relative to a frame origin (used to hide a robot's true start).
export const toFrame = (origin, p) => between(origin, p);
export const fromFrame = (origin, p) => compose(origin, p);
export { inverse, wrap };

// Team engine: scene, N robots, simulated clock, motion jobs and map actions.
// Runs animated (tick from the render loop) or headless (runHeadless).
//
// Motion model: robots are differential-drive. A job is a list of segments
// (drive along a planned path, turn in place, scan, wait). Paths from the grid
// planner are smoothed into straight lines joined by collision-checked arcs;
// sharp corners become stop-and-pivot. Speed follows a profile with
// acceleration, braking and curvature (lateral-acceleration) limits.
// SLAM keyframes are taken every 0.5 m or 30 degrees of motion.
// Multi-robot deconfliction: each robot brakes so it can always stop before
// coming within 0.75 m (centre to centre) of another robot on its path; a
// robot stuck behind a stationary robot replans around it, and if there is no
// way around (doorway), the lower-priority robot pulls aside, or an idle robot
// is nudged out of the way.
import { buildScene, roomAt, ROBOT_COLORS, CATS } from './scenes.js';
import { makeNav } from './nav.js';
import { makeSensor } from './sensor.js';
import { RobotSim, keyframesAlong, coveragePlan, solveLocal, mergeMaps, fusedObjects, detectEncounter, BYTES } from './team.js';
import { TwoStageSolver } from './slam.js';
import { compose, rng, wrap } from './geom.js';
import { embedText, cosine, labelFor } from './embed.js';

export const MOTION = {
  vmax: 1.0, acc: 0.5, dec: 0.7, decHard: 1.5,   // m/s, m/s^2
  wmax: 1.5, alpha: 2.5,                          // rad/s, rad/s^2
  alat: 0.5, rhoMax: 0.8,                         // lateral acceleration limit, max fillet radius
  dt: 0.05, ds: 0.05,                             // integration step (s), path sampling (m)
  kfDist: 0.5, kfTurn: Math.PI / 6,               // keyframe spacing
  clear: 0.75,                                    // stop before another robot is this close (centre-centre)
};
const SPEED = MOTION.vmax, TURN_RATE = MOTION.wmax;
export const fmt = (v) => (Math.round(v * 10) / 10).toFixed(1);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// ---------- path -> drivable track (lines + arcs + pivots) with a speed cap profile
export function compileTrack(nav, pose, points) {
  const M = MOTION;
  const pts = [{ x: pose.x, y: pose.y }];
  for (const p of points) if (dist(p, pts[pts.length - 1]) > 0.02) pts.push({ x: p.x, y: p.y });
  if (pts.length < 2) return null;
  const n = pts.length, L = [], hd = [];
  for (let k = 0; k < n - 1; k++) { L.push(dist(pts[k], pts[k + 1])); hd.push(Math.atan2(pts[k + 1].y - pts[k].y, pts[k + 1].x - pts[k].x)); }
  // corner treatment at interior vertices: fillet radius (0 = pivot)
  const corner = [];
  for (let k = 1; k < n - 1; k++) {
    const phi = wrap(hd[k] - hd[k - 1]), a = Math.abs(phi);
    if (a < 0.02) { corner.push({ rho: 0, d: 0, phi: 0 }); continue; }
    let rho = a > 1.75 ? 0 : Math.min(M.rhoMax, (0.5 * Math.min(L[k - 1], L[k])) / Math.tan(a / 2));
    for (let tries = 0; rho >= 0.12 && tries < 4; tries++, rho *= 0.5) {
      const arc = arcSamples(pts[k], hd[k - 1], hd[k], phi, rho, 0.1);
      if (arc.every((p) => nav.isFree(p))) break;
    }
    if (rho < 0.12) rho = 0;
    corner.push({ rho, d: rho * Math.tan(a / 2), phi });
  }
  const X = [], Y = [], TH = [], S = [], VL = [], pivots = new Map();
  let s = 0;
  const push = (x, y, th, vl) => { if (X.length) s += Math.hypot(x - X[X.length - 1], y - Y[Y.length - 1]); X.push(x); Y.push(y); TH.push(th); S.push(s); VL.push(vl); };
  const startTurn = wrap(hd[0] - pose.th);
  push(pts[0].x, pts[0].y, hd[0], 0);
  if (Math.abs(startTurn) > 0.03) pivots.set(0, startTurn);
  for (let k = 0; k < n - 1; k++) {
    const dIn = k > 0 ? corner[k - 1].d : 0, dOut = k < n - 2 ? corner[k].d : 0;
    const a = pts[k], b = pts[k + 1], ux = Math.cos(hd[k]), uy = Math.sin(hd[k]);
    const s0 = dIn, s1 = L[k] - dOut, m = Math.max(1, Math.ceil((s1 - s0) / M.ds));
    for (let i = k > 0 && dIn > 0 ? 1 : 0; i <= m; i++) {
      const t = s0 + ((s1 - s0) * i) / m;
      if (X.length && i === 0) continue;
      push(a.x + ux * t, a.y + uy * t, hd[k], M.vmax);
    }
    if (k < n - 2) {
      const c = corner[k];
      if (c.rho > 0) {
        const vl = Math.min(M.vmax, Math.sqrt(M.alat * c.rho), M.wmax * c.rho * 0.9);
        VL[VL.length - 1] = Math.min(VL[VL.length - 1], vl);
        for (const p of arcSamples(b, hd[k], hd[k + 1], c.phi, c.rho, M.ds).slice(1)) push(p.x, p.y, p.th, vl);
      } else if (Math.abs(c.phi) > 0.001) { VL[VL.length - 1] = 0; pivots.set(X.length - 1, c.phi); TH[TH.length - 1] = hd[k]; push(b.x, b.y, hd[k + 1], 0); }
    }
  }
  VL[VL.length - 1] = 0;
  const VC = VL.slice();   // braking-feasible speed cap
  for (let k = VC.length - 2; k >= 0; k--) VC[k] = Math.min(VC[k], Math.sqrt(VC[k + 1] ** 2 + 2 * M.dec * (S[k + 1] - S[k])));
  return { X, Y, TH, S, VC, pivots, len: s, end: { x: X[X.length - 1], y: Y[Y.length - 1] } };
}
// samples of the fillet arc at a corner (vertex P, headings hIn -> hOut)
function arcSamples(P, hIn, hOut, phi, rho, ds) {
  const d = rho * Math.tan(Math.abs(phi) / 2), sg = Math.sign(phi);
  const T1 = { x: P.x - Math.cos(hIn) * d, y: P.y - Math.sin(hIn) * d };
  const c = { x: T1.x - sg * Math.sin(hIn) * rho, y: T1.y + sg * Math.cos(hIn) * rho };
  const m = Math.max(2, Math.ceil((Math.abs(phi) * rho) / ds)), out = [];
  for (let i = 0; i <= m; i++) {
    const h = hIn + (phi * i) / m;
    out.push({ x: c.x + sg * Math.sin(h) * rho, y: c.y - sg * Math.cos(h) * rho, th: wrap(h) });
  }
  return out;
}
// cut a planned polyline at the first point within `standoff` of the target
function truncate(points, target, standoff) {
  if (!standoff) return points;
  const out = [points[0]];
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1], b = points[k], L = dist(a, b), n = Math.max(1, Math.ceil(L / 0.05));
    for (let i = 1; i <= n; i++) {
      const p = { x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n };
      if (dist(p, target) <= standoff) { out.push(p); return out; }
    }
    out.push(b);
  }
  return out;
}

export class Team {
  constructor(sceneDef, nRobots, seed, { shared = true } = {}) {
    this.def = sceneDef; this.seed = seed; this.shared = shared;
    this.scene = buildScene(sceneDef, seed);
    this.nav = makeNav(this.scene); this.detect = makeSensor(this.scene);
    const R = rng(seed + 101);
    this.robots = Array.from({ length: nRobots }, (_, i) => {
      const [x, y] = sceneDef.spawns[i % sceneDef.spawns.length];
      return { i, id: `R${i + 1}`, name: `Robot ${i + 1}`, css: ROBOT_COLORS[i], color: parseInt(ROBOT_COLORS[i].slice(1), 16), start: { x, y, th: (R.next() * 2 - 1) * Math.PI } };
    });
    this.sims = this.robots.map((rb, i) => new RobotSim(this.scene, rb, seed * 31 + i * 977 + 5, this.detect));
    this.locals = this.robots.map(() => null);
    this.time = 0; this.jobs = {}; this.nudges = {}; this.optJob = null; this.listeners = [];
    this.M = null; this.optimized = false; this.solverStats = null;
    this.bytes = { objects: 0, dgs: 0 }; this.log = [];
    this.pose = this.sims.map((s) => ({ ...s.gt[0] }));
    this.vel = this.robots.map(() => ({ v: 0, w: 0 }));
    this.minSep = Infinity;   // smallest robot-robot centre distance seen while moving (diagnostics)
    this.encR = rng(seed + 202); this.encounters = []; this.lastEnc = {};
    this.sims.forEach((_, r) => this.recordEncounters(r));
  }
  on(fn) { this.listeners.push(fn); }
  emit(ev) { for (const f of this.listeners) f(ev); }
  get n() { return this.robots.length; }
  robotIndex(idOrName) {
    const s = String(idOrName).toUpperCase().replace(/ROBOT\s*/, 'R');
    const i = this.robots.findIndex((r) => r.id === s || r.id === `R${s}`);
    return i;
  }

  // ---------- maps
  local(r) {
    const s = this.sims[r], L = this.locals[r];
    if (!L || L.version !== s.version) this.locals[r] = solveLocal(s, L);
    return this.locals[r];
  }
  mergedFresh() { return this.M && this.M.versions.every((v, r) => v === this.sims[r].version); }

  // Live view of robot r for rendering: last solution + dead reckoning for newer keyframes.
  liveView(r) {
    const s = this.sims[r], L = this.locals[r];
    if (!L) return { poses: s.dr.slice(), lms: {} };
    const poses = L.poses.slice();
    for (let k = poses.length; k < s.gt.length; k++) poses.push(compose(poses[k - 1], s.odom[k - 1].z));
    const T = L.align;
    return { poses: poses.map(T), lms: Object.fromEntries(Object.entries(L.lms).map(([o, p]) => [o, T(p)])) };
  }
  teamTransform() {
    if (!this.M) return null;
    const src = this.optJob ? (i) => this.optJob.solver.estimate(i) : (i) => this.M.g.vars[i];
    return { src, T: this.M.teamAlign(src) };
  }

  // What robot r knows: own objects, plus the merged team map if sharing is on.
  objectsFor(r) {
    const L = this.local(r), out = [];
    const mine = (obj) => `${this.robots[r].id}.${obj.replace(/^o/, '')}`;
    const T = L.align;
    const add = (o) => { o.room = roomAt(this.scene, o.x, o.y); out.push(o); };
    if (this.shared && this.M && this.M.joined.includes(r)) {
      const { src, T: TT } = this.teamTransform();
      const fused = fusedObjects(this.sims, this.locals, this.M, src, TT);
      const covered = new Set();
      fused.forEach((f, idx) => {
        f.members.forEach((m) => { if (m.r === r) covered.add(m.obj); });
        add({ id: `T${idx + 1}`, label: f.label, x: f.x, y: f.y, seen_by: [...new Set(f.members.map((m) => this.robots[m.r].id))], _gt: this.scene.objects.find((o) => o.id === f.members[0].obj) });
      });
      for (const [obj, p] of Object.entries(L.lms)) if (!covered.has(obj)) {   // seen after the last merge
        const q = T(p); add({ id: mine(obj), label: this.labelOf(r, obj), x: q.x, y: q.y, seen_by: [this.robots[r].id], _gt: this.scene.objects.find((o) => o.id === obj), recent: true });
      }
    } else {
      for (const [obj, p] of Object.entries(L.lms)) {
        const q = T(p); add({ id: mine(obj), label: this.labelOf(r, obj), x: q.x, y: q.y, seen_by: [this.robots[r].id], _gt: this.scene.objects.find((o) => o.id === obj) });
      }
    }
    for (const o of out) {
      o.near = out.filter((q) => q !== o).map((q) => ({ q, d: Math.hypot(q.x - o.x, q.y - o.y) })).filter((e) => e.d < 3).sort((a, b) => a.d - b.d).slice(0, 2).map((e) => `${e.q.label} ${e.d.toFixed(1)}m`);
    }
    return out;
  }
  labelOf(r, obj) { const l = labelFor(this.local(r).meanEmb[obj]); return `${l.color} ${l.cat}`; }
  search(r, query, k = 6) {
    const q = embedText(query); if (!q) return [];
    return this.objectsFor(r).map((o) => { const lab = embedText(o.label); return { o, s: lab ? cosine(q.vec, lab.vec) : 0 }; })
      .filter((e) => e.s > 0.6).sort((a, b) => b.s - a.s).slice(0, k).map((e) => ({ ...e.o, similarity: +e.s.toFixed(2) }));
  }
  estPose(r) { const v = this.liveView(r).poses; return v[v.length - 1]; }

  // ---------- actions (resolve in simulated time)
  // segs: [{ type: 'path', to, standoff?, tol?, points? } | { type: 'turn', by } | { type: 'turn', toward } | { type: 'wait', until, max }]
  motion(r, segs, kind, label, { until } = {}) {
    if (this.jobs[r]) return Promise.reject(new Error(`${this.robots[r].name} is busy (${this.jobs[r].label}).`));
    if (this.nudges[r]) this.endMover(r, this.nudges[r]);
    if (!segs.length) return Promise.resolve();
    return new Promise((resolve) => { this.jobs[r] = { segs: segs.slice(), si: 0, kind, label, resolve, until, from: { ...this.pose[r] } }; this.emit({ type: 'job', r }); });
  }
  async exploreRoom(r, room, { until } = {}) {
    if (!this.scene.coverage[room]) throw new Error(`Unknown room "${room}". Rooms: ${this.scene.rooms.map((q) => q.name).join(', ')}`);
    const before = Object.keys(this.local(r).lms).length, d0 = this.sims[r].distance, t0 = this.time;
    const segs = coveragePlan(this.nav, this.scene, this.pose[r], room);
    await this.motion(r, segs, 'explore', `exploring ${room}`, { until });
    this.sims[r].explored.add(room);
    const L = this.local(r);
    return { room, new_objects: Object.keys(L.lms).length - before, objects_in_my_map: Object.keys(L.lms).length, driven_m: +(this.sims[r].distance - d0).toFixed(1), took_s: Math.round(this.time - t0) };
  }
  async goTo(r, target, label) {
    const cur = this.pose[r];
    const plan = this.nav.plan(cur, target, { block: this.parkedBlocks(r) }) || this.nav.plan(cur, target);
    if (!plan) throw new Error('No path found.');
    // stop short of the target: in front of an object, or next to a robot standing there
    const cat = target.gt && CATS[target.gt.cat];
    let standoff = target.standoff ?? (target.gt ? Math.min(1.0, (cat?.r ?? 0.4) + 0.45) : 0.05);
    if (this.robots.some((_, j) => j !== r && dist(this.pose[j], target) < 0.7)) standoff = Math.max(standoff, 0.9);
    const pts = truncate(plan.points, target, standoff);
    this.emit({ type: 'navplan', r, points: [{ x: cur.x, y: cur.y }, ...pts.slice(1)] });
    const d0 = this.sims[r].distance, t0 = this.time;
    const segs = [{ type: 'path', to: { x: target.x, y: target.y }, standoff, tol: 1.6, points: pts.slice(1) }];
    if (target.gt || target.face) segs.push({ type: 'turn', toward: { x: target.x, y: target.y } });
    await this.motion(r, segs, 'nav', `driving to ${label}`);
    const p = this.pose[r];
    return { arrived: true, driven_m: +(this.sims[r].distance - d0).toFixed(1), took_s: Math.round(this.time - t0), now_in: roomAt(this.scene, p.x, p.y),
      ...(target.gt ? { distance_to_real_object_m: +Math.hypot(target.gt.x - p.x, target.gt.y - p.y).toFixed(2) } : {}) };
  }
  exchange() {
    if (!this.shared) throw new Error('Map sharing is disabled in this run (independent robots).');
    this.robots.forEach((_, r) => this.local(r));
    this.M = mergeMaps(this.sims, this.locals, this.encounters); this.optimized = false; this.solverStats = null;
    this.bytes.objects += this.M.bytes;
    const src = (i) => this.M.init[i];
    this.M.disInit = this.M.disagreement(src);
    this.emit({ type: 'merged' });
    return {
      robots_merged: this.M.joined.map((r) => this.robots[r].id), robots_not_overlapping: this.M.missing.map((r) => this.robots[r].id),
      verified_matches: this.M.links.length, robot_encounters_used: this.M.encounters.length, rejected_lookalikes: this.M.rejectedTotal, bytes_sent: this.M.bytes,
      map_disagreement_m: +this.M.disInit.toFixed(2),
    };
  }
  optimize(animated = false) {
    if (!this.M) throw new Error('No merged team map yet: exchange maps first.');
    if (this.optimized) return Promise.resolve({ ...this.solverStats, note: 'already optimized; no new merge since' });
    const solver = new TwoStageSolver(this.M.g, { distributed: true, inner: 8 });
    const finish = () => {
      const after = this.M.disagreement((i) => this.M.g.vars[i]);
      this.bytes.dgs += solver.bytes; this.optimized = true;
      this.solverStats = { rounds: solver.stage1Rounds + solver.stage2Rounds, bytes_exchanged: solver.bytes, map_disagreement_before_m: +this.M.disInit.toFixed(2), map_disagreement_after_m: +after.toFixed(2) };
      this.emit({ type: 'optimized' });
      return this.solverStats;
    };
    if (!animated) { solver.solve(); return Promise.resolve(finish()); }
    return new Promise((resolve) => { this.optJob = { solver, resolve: () => { this.optJob = null; resolve(finish()); } }; });
  }

  // keep at most one encounter per robot pair every 12 keyframes (avoids redundant constraints)
  recordEncounters(r) {
    for (const e of detectEncounter(this.scene, this.sims, r, this.encR)) {
      const key = [e.ra, e.rb].sort().join('-'), last = this.lastEnc[key];
      if (last != null && this.sims[e.ra].k - last < 12) continue;
      this.lastEnc[key] = this.sims[e.ra].k; this.encounters.push(e);
    }
  }

  // ---------- motion execution
  mover(r) { return this.jobs[r] || this.nudges[r] || null; }
  moving(r) { const m = this.mover(r); return !!m && !(m.cur && m.cur.type === 'wait'); }
  speed(r) { return Math.abs(this.vel[r].v); }
  // robots that are standing still (idle, waiting or stalled) as disc obstacles for the planner
  parkedBlocks(r, range = 9) {
    const out = [];
    this.robots.forEach((_, j) => {
      if (j === r) return;
      const d = dist(this.pose[j], this.pose[r]);
      if (d > range || this.speed(j) > 0.1 || (this.moving(j) && !(this.mover(j).stall > 1))) return;
      out.push({ x: this.pose[j].x, y: this.pose[j].y, r: Math.min(0.8, d - 0.15) });
    });
    return out.filter((b) => b.r > 0.3);
  }
  keyframe(r, force = false) {
    const s = this.sims[r], last = s.gt[s.k], p = this.pose[r];
    const dd = dist(p, last), dth = Math.abs(wrap(p.th - last.th));
    if (dd >= MOTION.kfDist || dth >= MOTION.kfTurn - 1e-6 || (force && (dd > 0.02 || dth > 0.02))) {
      s.addKeyframe({ x: p.x, y: p.y, th: wrap(p.th) }); this.recordEncounters(r);
      return true;
    }
    return false;
  }
  endMover(r, m) {
    this.keyframe(r, true);
    this.vel[r] = { v: 0, w: 0 };
    if (this.jobs[r] === m) { delete this.jobs[r]; this.local(r); this.emit({ type: 'jobdone', r }); m.resolve(); return true; }
    if (this.nudges[r] === m) delete this.nudges[r];
    return false;
  }
  // activate segment si of mover m (compile paths into tracks from the current pose)
  activate(r, m) {
    const seg = m.segs[m.si], p = this.pose[r];
    m.stall = 0; m.waited = 0;
    if (seg.type === 'path') {
      let pts = seg.points;
      if (!pts) {
        const plan = this.nav.plan(p, seg.to, { block: this.parkedBlocks(r) }) || this.nav.plan(p, seg.to);
        if (!plan) return (m.cur = null);
        pts = truncate(plan.points, seg.to, seg.standoff || 0).slice(1);
      }
      seg.points = null;   // a replan later starts from wherever the robot is then
      const tr = compileTrack(this.nav, p, pts);
      m.cur = tr ? { type: 'track', tr, s: 0, k: 0, pivotDone: -1, pivot: null, w: 0, seg } : null;
    } else if (seg.type === 'turn') {
      const by = seg.by ?? wrap(Math.atan2(seg.toward.y - p.y, seg.toward.x - p.x) - p.th);
      m.cur = Math.abs(by) > 0.02 ? { type: 'turn', left: by, w: 0 } : null;
    } else if (seg.type === 'wait') m.cur = { type: 'wait', t: 0, seg };
    return m.cur;
  }
  // free distance along robot r's track before it would come too close to another robot
  freeDistance(r, c) {
    const tr = c.tr, p = this.pose[r], v = this.vel[r].v, M = MOTION;
    const look = M.clear + (v * v) / (2 * M.decHard) + 0.9;
    let f = Infinity, who = -1;
    for (let j = 0; j < this.n; j++) {
      if (j === r) continue;
      const q = this.pose[j], d0 = dist(p, q);
      if (d0 > look + 1.6) continue;
      let C = M.clear;
      const vj = this.vel[j].v;
      if (vj > 0.05) { const toMe = (Math.cos(q.th) * (p.x - q.x) + Math.sin(q.th) * (p.y - q.y)) / (d0 || 1); if (toMe > 0.3) C += (vj * vj) / (2 * M.decHard) + 0.1; }
      for (let m = c.k + 1; m < tr.X.length && tr.S[m] - c.s <= look; m++) {
        const dm = Math.hypot(tr.X[m] - q.x, tr.Y[m] - q.y);
        if (dm < C && dm < d0 - 0.005) { const fj = tr.S[m] - c.s; if (fj < f) { f = fj; who = j; } break; }
      }
    }
    return { f, who };
  }
  stepTrack(r, m, dt) {
    const c = m.cur, tr = c.tr, M = MOTION;
    if (c.pivot != null) {   // turning in place at a sharp corner / path start
      const done = this.stepTurn(r, c, dt, 'pivot');
      if (done) { c.pivot = null; c.pivotDone = c.k; }
      return false;
    }
    if (tr.pivots.has(c.k) && c.pivotDone < c.k && tr.S[c.k] - c.s < 1e-6) { c.pivot = tr.pivots.get(c.k); c.w = 0; return false; }
    const { f, who } = this.freeDistance(r, c);
    let next = tr.X.length - 1; for (const [k] of tr.pivots) if (k > c.k || (k === c.k && c.pivotDone < k)) next = Math.min(next, k);
    const sStop = tr.S[next];
    const cap = tr.VC[Math.min(c.k + 1, tr.X.length - 1)];
    const vf = Math.sqrt(2 * M.decHard * Math.max(0, f - 0.05));
    let vt = Math.max(cap, 0.06);
    if (m.stopping) vt = 0;
    const limited = vf < vt;
    if (limited) vt = vf;
    let v = this.vel[r].v;
    v = v < vt ? Math.min(vt, v + M.acc * dt) : Math.max(vt, v - M.decHard * dt);
    if (limited && vf < 0.02) v = 0;
    let s = Math.min(c.s + v * dt, sStop);
    if (s >= sStop - 1e-9 && sStop - c.s > 0) { s = sStop; }
    c.s = s;
    while (c.k < tr.X.length - 1 && tr.S[c.k + 1] <= s + 1e-9) c.k++;
    const k = c.k, k2 = Math.min(k + 1, tr.X.length - 1), seg = tr.S[k2] - tr.S[k], t = seg > 0 ? (s - tr.S[k]) / seg : 0;
    const th = tr.TH[k] + wrap(tr.TH[k2] - tr.TH[k]) * t;
    this.pose[r] = { x: tr.X[k] + (tr.X[k2] - tr.X[k]) * t, y: tr.Y[k] + (tr.Y[k2] - tr.Y[k]) * t, th: wrap(th) };
    this.vel[r] = { v, w: 0 };
    // stall bookkeeping (stuck behind another robot)
    if (limited && v < 0.03) { m.stall = (m.stall || 0) + dt; m.blocker = who; } else if (v > 0.1) m.stall = 0;
    if (m.stopping && v === 0) return true;
    if (s >= tr.len - 1e-6 && k === tr.X.length - 1) return true;
    if (m.stall > 1.2 && this.time - (m.lastResolve ?? -9) > 2) { m.lastResolve = this.time; this.resolveStall(r, m); }
    return false;
  }
  stepTurn(r, c, dt, key = 'left') {
    const M = MOTION, rem = c[key];
    const wt = Math.max(0.15, Math.min(M.wmax, Math.sqrt(2 * M.alpha * Math.abs(rem))));
    c.w = c.w < wt ? Math.min(wt, c.w + M.alpha * dt) : wt;
    const step = Math.min(Math.abs(rem), c.w * dt) * Math.sign(rem);
    c[key] = rem - step;
    const p = this.pose[r]; this.pose[r] = { ...p, th: wrap(p.th + step) };
    this.vel[r] = { v: 0, w: c.w };
    return Math.abs(c[key]) < 1e-4;
  }
  // a robot has been stuck behind another one for a while: go around, give up near the goal, or make way
  resolveStall(r, m) {
    const c = m.cur, seg = c.seg, p = this.pose[r], j = m.blocker;
    const goal = seg.to || c.tr.end, remaining = c.tr.len - c.s;
    const blocks = this.parkedBlocks(r);
    const goalTaken = blocks.some((b) => dist(b, goal) < 0.8 + (seg.standoff || 0) * 0.5);
    if (goalTaken && dist(p, goal) <= (seg.tol ?? 2.2)) { m.cur = null; m.si++; return; }   // close enough: stop here
    let target = goal;
    if (goalTaken) target = this.spotNear(goal, r, 3) || goal;
    const plan = this.nav.plan(p, target, { block: blocks });
    if (plan && plan.length < remaining + 12 && plan.points.length > 1) {
      const tr = compileTrack(this.nav, p, truncate(plan.points, target, target === goal ? (seg.standoff || 0) : 0).slice(1));
      if (tr) { m.cur = { type: 'track', tr, s: 0, k: 0, pivotDone: -1, pivot: null, w: 0, seg }; m.stall = 0; return; }
    }
    if (j < 0) return;
    const other = this.mover(j);
    if (!other && !this.nudges[j]) {   // an idle robot is in the way: ask it to move aside
      const spot = this.asideSpot(j, r, c);
      if (spot) this.nudges[j] = { segs: [{ type: 'path', to: spot }], si: 0, kind: 'yield', label: 'making way', nudge: true };
      return;
    }
    // two working robots blocking each other: the lower-priority one (or the one stuck longest) pulls aside
    const otherStuck = other && (other.stall > 0.5 || (other.cur && other.cur.type === 'wait'));
    if (otherStuck && (r > j || m.stall > 8) && !m.asideOnce) {
      const spot = this.asideSpot(r, j, other.cur && other.cur.type === 'track' ? other.cur : null);
      if (spot) {
        m.asideOnce = true;
        const back = { ...seg, points: null };
        const t0 = this.time;
        m.segs.splice(m.si, 1, { type: 'path', to: spot }, { type: 'wait', until: () => dist(this.pose[j], spot) > 1.8 || !this.mover(j) || this.time - t0 > 15, max: 20 }, back);
        m.cur = null;
      }
    }
  }
  // free spot near p, reachable, away from other robots
  spotNear(p, r, maxR) {
    const { W, H, RES, occ } = this.nav.grid;
    const ci = Math.floor(p.x / RES), cj = Math.floor(p.y / RES); let best = null;
    for (let rr = 0; rr * RES <= maxR; rr++) {
      for (let dj = -rr; dj <= rr; dj++) for (let di = -rr; di <= rr; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== rr) continue;
        const a = ci + di, b = cj + dj; if (a < 0 || b < 0 || a >= W || b >= H || occ[b * W + a]) continue;
        const q = { x: (a + 0.5) * RES, y: (b + 0.5) * RES };
        if (this.robots.some((_, j) => j !== r && dist(this.pose[j], q) < 0.95)) continue;
        if (!this.nav.lineFree(q, p) && dist(q, p) > 0.5) continue;
        const d = dist(q, p); if (!best || d < best.d) best = { d, q };
      }
      if (best) return best.q;
    }
    return null;
  }
  // where robot a can wait out of the way of robot b (b's upcoming track c, if any): BFS from a
  asideSpot(a, b, c) {
    const { W, H, RES, occ } = this.nav.grid, pa = this.pose[a], pb = this.pose[b];
    const future = [];
    if (c && c.tr) for (let k = c.k; k < c.tr.X.length && c.tr.S[k] - c.s < 6; k += 4) future.push({ x: c.tr.X[k], y: c.tr.Y[k] });
    const start = Math.floor(pa.y / RES) * W + Math.floor(pa.x / RES);
    const seen = new Uint8Array(W * H), q = [start]; seen[start] = 1;
    for (let h = 0; h < q.length && h < 4000; h++) {
      const id = q[h], i = id % W, j = (id / W) | 0, p = { x: (i + 0.5) * RES, y: (j + 0.5) * RES };
      if (dist(p, pa) > 7) continue;
      const good = !occ[id] && dist(p, pb) > 1.4 && future.every((f) => dist(f, p) > 1.05) &&
        this.robots.every((_, k) => k === a || k === b || dist(this.pose[k], p) > 1.0);
      if (good && h > 0) return p;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = i + di, y = j + dj, nid = y * W + x;
        if (x < 0 || y < 0 || x >= W || y >= H || seen[nid] || occ[nid]) continue;
        if (dist({ x: (x + 0.5) * RES, y: (y + 0.5) * RES }, pb) < 0.55) continue;   // cannot drive through b
        seen[nid] = 1; q.push(nid);
      }
    }
    return null;
  }
  stepMover(r, m, dt) {
    for (let guard = 0; guard < 8; guard++) {
      if (!m.cur) {
        if (m.si >= m.segs.length) return this.endMover(r, m);
        if (!this.activate(r, m)) { m.si++; continue; }
      }
      const c = m.cur; let done = false;
      if (c.type === 'track') done = this.stepTrack(r, m, dt);
      else if (c.type === 'turn') done = m.stopping ? true : this.stepTurn(r, c, dt);
      else if (c.type === 'wait') { c.t += dt; this.vel[r] = { v: 0, w: 0 }; done = c.t >= (c.seg.max ?? 30) || (c.seg.until && c.seg.until()); }
      if (this.keyframe(r) && m.until && !m.stopping && m.until()) m.stopping = true;
      if (m.stopping && (!m.cur || m.cur.type !== 'track' || this.vel[r].v === 0)) return this.endMover(r, m);
      if (m.cur !== c) return false;   // replaced during the step (replan / pull aside)
      if (done) { m.cur = null; m.si++; if (m.si >= m.segs.length) return this.endMover(r, m); }
      return false;
    }
    return false;
  }

  // ---------- clock
  tick(dt) {
    if (Object.keys(this.jobs).length) this.time += dt;   // the clock measures robot work, not map computation
    let finished = 0;
    for (let left = dt; left > 1e-9; left -= MOTION.dt) {
      const h = Math.min(MOTION.dt, left);
      for (let r = 0; r < this.n; r++) {
        const m = this.mover(r);
        if (m && this.stepMover(r, m, h)) finished++;
      }
      for (let a = 0; a < this.n; a++) for (let b = a + 1; b < this.n; b++) {
        if (!this.mover(a) && !this.mover(b)) continue;
        const d = dist(this.pose[a], this.pose[b]); if (d < this.minSep) this.minSep = d;
      }
    }
    if (this.optJob) {
      const S = this.optJob.solver;
      for (let i = 0; i < 12 && !S.done; i++) S.step();
      if (S.done) this.optJob.resolve();
    }
    return finished;
  }
  busy() { return Object.keys(this.jobs).length > 0 || Object.keys(this.nudges).length > 0 || !!this.optJob; }

  // Run an async policy to completion without rendering.
  async runHeadless(policy, maxSimSeconds = 3600) {
    let done = false, result, error;
    policy(this).then((r) => { done = true; result = r; }, (e) => { done = true; error = e; });
    const t0 = this.time;
    while (!done) {
      await new Promise((res) => setTimeout(res, 0));
      // advance until some job finishes so its policy can react without idling
      if (this.busy()) { for (let i = 0; i < 400 && this.busy(); i++) if (this.tick(0.25)) break; }
      if (this.time - t0 > maxSimSeconds) throw new Error('simulation time limit');
    }
    if (error) throw error;
    return result;
  }
  teamAte() { if (!this.M) return null; return this.M.teamAte((i) => this.M.g.vars[i]); }
  pooledLocalAte() {
    let s = 0, n = 0; this.robots.forEach((_, r) => { const L = this.local(r); s += L.ate ** 2 * L.poses.length; n += L.poses.length; });
    return Math.sqrt(s / n);
  }
}
export { BYTES, keyframesAlong, SPEED, TURN_RATE };

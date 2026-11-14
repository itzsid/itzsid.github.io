// Team engine: scene, N robots, simulated clock, motion jobs and map actions.
// Runs animated (tick from the render loop) or headless (runHeadless).
import { buildScene, roomAt, ROBOT_COLORS } from './scenes.js';
import { makeNav } from './nav.js';
import { makeSensor } from './sensor.js';
import { RobotSim, keyframesAlong, coveragePlan, solveLocal, mergeMaps, fusedObjects, detectEncounter, BYTES } from './team.js';
import { TwoStageSolver } from './slam.js';
import { compose, rng } from './geom.js';
import { embedText, cosine, labelFor } from './embed.js';

const SPEED = 1.0;            // m/s
const TURN_RATE = 1.6;        // rad/s
export const fmt = (v) => (Math.round(v * 10) / 10).toFixed(1);

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
    this.time = 0; this.jobs = {}; this.optJob = null; this.listeners = [];
    this.M = null; this.optimized = false; this.solverStats = null;
    this.bytes = { objects: 0, dgs: 0 }; this.log = [];
    this.pose = this.sims.map((s) => ({ ...s.gt[0] }));
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
  motion(r, kfs, kind, label) {
    if (this.jobs[r]) return Promise.reject(new Error(`${this.robots[r].name} is busy (${this.jobs[r].label}).`));
    if (!kfs.length) return Promise.resolve();
    return new Promise((resolve) => { this.jobs[r] = { kfs, idx: 0, t: 0, kind, label, resolve, from: { ...this.pose[r] } }; this.emit({ type: 'job', r }); });
  }
  async exploreRoom(r, room) {
    if (!this.scene.coverage[room]) throw new Error(`Unknown room "${room}". Rooms: ${this.scene.rooms.map((q) => q.name).join(', ')}`);
    const before = Object.keys(this.local(r).lms).length, d0 = this.sims[r].distance, t0 = this.time;
    const kfs = coveragePlan(this.nav, this.scene, this.sims[r].gt[this.sims[r].k], room);
    await this.motion(r, kfs, 'explore', `exploring ${room}`);
    this.sims[r].explored.add(room);
    const L = this.local(r);
    return { room, new_objects: Object.keys(L.lms).length - before, objects_in_my_map: Object.keys(L.lms).length, driven_m: +(this.sims[r].distance - d0).toFixed(1), took_s: Math.round(this.time - t0) };
  }
  async goTo(r, target, label) {
    const cur = this.sims[r].gt[this.sims[r].k];
    const plan = this.nav.plan(cur, target);
    if (!plan) throw new Error('No path found.');
    const pts = plan.points.slice(1);
    if (pts.length) {   // stop ~0.7 m before the object
      const last = pts[pts.length - 1], prev = pts[pts.length - 2] || cur, d = Math.hypot(last.x - prev.x, last.y - prev.y);
      if (d > 0.8) pts[pts.length - 1] = { x: last.x - ((last.x - prev.x) / d) * 0.7, y: last.y - ((last.y - prev.y) / d) * 0.7 };
    }
    this.emit({ type: 'navplan', r, points: [cur, ...pts] });
    const d0 = this.sims[r].distance, t0 = this.time;
    const kfs = keyframesAlong(cur, pts);
    if (target.gt) { const end = kfs[kfs.length - 1] || cur; const h = Math.atan2(target.gt.y - end.y, target.gt.x - end.x); kfs.push(...keyframesAlong(end, [], {}), { ...end, th: h }); }
    await this.motion(r, kfs, 'nav', `driving to ${label}`);
    const p = this.sims[r].gt[this.sims[r].k];
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

  // ---------- clock
  tick(dt) {
    if (Object.keys(this.jobs).length) this.time += dt;   // the clock measures robot work, not map computation
    for (const [r, j] of Object.entries(this.jobs)) {
      let budget = dt;
      while (budget > 0 && j.idx < j.kfs.length) {
        const a = j.idx === 0 ? j.from : j.kfs[j.idx - 1], b = j.kfs[j.idx];
        const dur = Math.max(Math.hypot(b.x - a.x, b.y - a.y) / SPEED, Math.abs(Math.atan2(Math.sin(b.th - a.th), Math.cos(b.th - a.th))) / TURN_RATE, 0.05);
        const use = Math.min(budget, dur - j.t); j.t += use; budget -= use;
        const f = Math.min(1, j.t / dur);
        this.pose[r] = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, th: a.th + Math.atan2(Math.sin(b.th - a.th), Math.cos(b.th - a.th)) * f };
        if (j.t >= dur - 1e-9) { this.sims[r].addKeyframe(b); this.recordEncounters(+r); j.idx++; j.t = 0; }
      }
      if (j.idx >= j.kfs.length) { delete this.jobs[r]; this.local(+r); this.emit({ type: 'jobdone', r: +r }); j.resolve(); }
    }
    if (this.optJob) {
      const S = this.optJob.solver;
      for (let i = 0; i < 12 && !S.done; i++) S.step();
      if (S.done) this.optJob.resolve();
    }
  }
  busy() { return Object.keys(this.jobs).length > 0 || !!this.optJob; }

  // Run an async policy to completion without rendering.
  async runHeadless(policy, maxSimSeconds = 3600) {
    let done = false, result, error;
    policy(this).then((r) => { done = true; result = r; }, (e) => { done = true; error = e; });
    while (!done) {
      await new Promise((res) => setTimeout(res, 0));
      if (this.busy()) { for (let i = 0; i < 50 && this.busy(); i++) this.tick(0.25); }
      if (this.time > maxSimSeconds) throw new Error('simulation time limit');
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
export { BYTES };

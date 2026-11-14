// Live multi-robot simulation for N robots in a scene. Robots move wherever
// they are sent; every keyframe adds noisy odometry and noisy open-vocabulary
// detections. Local object maps are re-solved on demand; maps of all robots
// can be merged (object exchange + RANSAC) and jointly optimized
// (distributed two-stage Gauss-Seidel with SOR).
import { rng, compose, between, wrap, inverse, segIntersect } from './geom.js';
import { NOISE, SENSOR, makeSensor } from './sensor.js';
import { embedObject, labelFor, cosine, CATEGORIES, COLOR_WORDS } from './embed.js';
import { PoseGraph, TwoStageSolver, ateAligned, rigidAlign } from './slam.js';
import { associate } from './assoc.js';

export const BYTES = { objectDescriptor: 512 * 2 + 3 * 4 + 4, keyframeImage: 45_000 };
const W = { odoR: 3000, odoT: 2000, obsR: 250, obsT: 220, sepR: 250, sepT: 300 };
const KF_STEP = 0.5, TURN = Math.PI / 6;
export const MIN_SIGHTINGS = 2;

export class RobotSim {
  constructor(scene, def, seed, detectProb) {
    this.scene = scene; this.robot = def; this.R = rng(seed); this.detectProb = detectProb;
    this.yawBias = (this.R.next() * 2 - 1) * 0.014;     // rad per meter, differs per robot
    this.gt = [{ ...def.start }]; this.dr = [{ ...def.start }]; this.odom = []; this.obs = [];
    this.version = 0; this.explored = new Set(); this.distance = 0; this.falseCount = 0;
    this.observe(0);
  }
  get k() { return this.gt.length - 1; }
  observe(k) {
    const p = this.gt[k], R = this.R;
    for (const o of this.scene.objects) {
      const pd = this.detectProb(p, o);
      if (pd <= 0 || R.next() > pd) continue;
      const rel = between(p, o), far = Math.hypot(rel.x, rel.y) / SENSOR.range;
      this.obs.push({ k, obj: o.id, z: { x: rel.x + R.gauss() * NOISE.obsPos * (1 + far), y: rel.y + R.gauss() * NOISE.obsPos * (1 + far), th: wrap(rel.th + R.gauss() * NOISE.obsRot) }, emb: embedObject(o, R, 0.14 + 0.08 * far) });
    }
    if (R.next() < NOISE.falseRate) {   // spurious detection (never re-observed -> filtered)
      const a = (R.next() - 0.5) * SENSOR.fov, d = 1 + R.next() * 3;
      const fake = { cat: CATEGORIES[Math.floor(R.next() * CATEGORIES.length)], color: COLOR_WORDS[Math.floor(R.next() * COLOR_WORDS.length)] };
      this.obs.push({ k, obj: `f-${this.robot.id}-${this.falseCount++}`, z: { x: d * Math.cos(a), y: d * Math.sin(a), th: 0 }, emb: embedObject(fake, R, 0.2), fake: true });
    }
  }
  addKeyframe(g) {
    const prev = this.gt[this.k], rel = between(prev, g), d = Math.hypot(rel.x, rel.y), R = this.R;
    const slip = R.next() < NOISE.slipProb ? 1 + (R.next() - 0.3) * NOISE.slipScale * 4 : 1;
    const z = { x: rel.x * slip + R.gauss() * NOISE.odoTrans * d, y: rel.y + R.gauss() * NOISE.odoTrans * d * 0.5,
      th: wrap(rel.th + R.gauss() * NOISE.odoRot * (Math.abs(rel.th) > 0.05 || d > 0.05 ? 1 : 0.2) + this.yawBias * d) };
    this.gt.push({ ...g }); this.odom.push({ i: this.k - 1, j: this.k, z });
    this.dr.push(compose(this.dr[this.k - 1], z)); this.distance += d;
    this.observe(this.k); this.version++;
  }
}

// Robot-robot encounter: robots within 4 m with line of sight measure their relative pose.
export function detectEncounter(scene, sims, r, R) {
  const out = [], a = sims[r], pa = a.gt[a.k];
  sims.forEach((b, j) => {
    if (j === r) return;
    const pb = b.gt[b.k], d = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    if (d > 4 || d < 0.3) return;
    if (scene.walls.some((w) => segIntersect(pa, pb, { x: w[0], y: w[1] }, { x: w[2], y: w[3] }))) return;
    const rel = between(pa, pb);
    out.push({ ra: r, ka: a.k, rb: j, kb: b.k, z: { x: rel.x + R.gauss() * 0.05, y: rel.y + R.gauss() * 0.05, th: wrap(rel.th + R.gauss() * 0.03) } });
  });
  return out;
}

// Turn a polyline into ground-truth keyframes (turn in place, then drive).
export function keyframesAlong(start, points, { spinAt = [] } = {}) {
  const out = []; let cur = { ...start };
  const turnTo = (h) => { let d = wrap(h - cur.th); while (Math.abs(d) > 1e-3) { const s = Math.sign(d) * Math.min(Math.abs(d), TURN); cur = { ...cur, th: wrap(cur.th + s) }; out.push({ ...cur }); d = wrap(h - cur.th); } };
  points.forEach((q, idx) => {
    const L = Math.hypot(q.x - cur.x, q.y - cur.y);
    if (L > 0.05) {
      turnTo(Math.atan2(q.y - cur.y, q.x - cur.x));
      const n = Math.max(1, Math.round(L / KF_STEP)), sx = cur.x, sy = cur.y;
      for (let i = 1; i <= n; i++) { cur = { x: sx + ((q.x - sx) * i) / n, y: sy + ((q.y - sy) * i) / n, th: cur.th }; out.push({ ...cur }); }
    }
    if (spinAt.includes(idx)) for (let i = 0; i < 12; i++) { cur = { ...cur, th: wrap(cur.th + TURN) }; out.push({ ...cur }); }
  });
  return out;
}

export function coveragePlan(nav, scene, start, room) {
  const pts = [], spins = []; let from = start;
  for (const w of scene.coverage[room] || []) {
    const p = nav.plan(from, w); if (!p || p.points.length < 1) continue;
    pts.push(...p.points.slice(1)); spins.push(pts.length - 1); from = pts[pts.length - 1] || from;
  }
  return keyframesAlong(start, pts, { spinAt: spins });
}

// ---- local object SLAM for one robot (warm-started)
export function solveLocal(rs, prev) {
  const g = new PoseGraph(), owner = rs.robot.id;
  const init = rs.gt.map((_, k) => (prev && k < prev.poses.length ? prev.poses[k] : null));
  for (let k = 0; k < init.length; k++) if (!init[k]) init[k] = k === 0 ? rs.dr[0] : compose(init[k - 1], rs.odom[k - 1].z);
  const poseIdx = init.map((p, k) => g.addVar({ ...p, owner, kind: 'pose', key: `${owner}:p${k}`, fixed: k === 0 }));
  const count = {}; for (const o of rs.obs) count[o.obj] = (count[o.obj] || 0) + 1;
  const lmIdx = {};
  for (const o of rs.obs) if (count[o.obj] >= MIN_SIGHTINGS && !(o.obj in lmIdx)) {
    lmIdx[o.obj] = g.addVar({ ...(prev?.lms[o.obj] || compose(init[o.k], o.z)), owner, kind: 'object', key: `${owner}:${o.obj}` });
  }
  for (const f of rs.odom) g.addFactor(poseIdx[f.i], poseIdx[f.j], f.z, W.odoR, W.odoT, 'odom');
  for (const o of rs.obs) if (o.obj in lmIdx) g.addFactor(poseIdx[o.k], lmIdx[o.obj], o.z, W.obsR, W.obsT, 'obs');
  if (rs.odom.length) new TwoStageSolver(g, { inner: 8 }).solve();
  const poses = poseIdx.map((i) => ({ ...g.vars[i] }));
  const lms = Object.fromEntries(Object.entries(lmIdx).map(([id, i]) => [id, { ...g.vars[i] }]));
  const embs = {}; for (const o of rs.obs) if (o.obj in lmIdx) (embs[o.obj] ||= []).push(o.emb);
  const meanEmb = Object.fromEntries(Object.entries(embs).map(([id, es]) => {
    const m = es[0].map((_, d) => es.reduce((a, e) => a + e[d], 0) / es.length); const n = Math.hypot(...m); return [id, m.map((x) => x / n)];
  }));
  const lastSeen = {}; for (const o of rs.obs) if (o.obj in lmIdx) lastSeen[o.obj] = o.k;
  return { version: rs.version, g, poseIdx, lmIdx, poses, lms, meanEmb, lastSeen, count,
    align: rigidAlign(poses, rs.gt), ate: rs.gt.length > 2 ? ateAligned(poses, rs.gt) : 0 };
}

// ---- merge all robots' maps into one team graph
// Robots join greedily: the robot whose objects best match the current team
// map (verified with RANSAC) is aligned and added next.
export function mergeMaps(sims, locals, encounters = []) {
  const n = sims.length;
  const shared = locals.map((l, r) => Object.entries(l.lms).map(([obj, p]) => {
    const q = between(sims[r].robot.start, p);   // in the robot's own frame
    return { key: `${r}:${obj}`, r, obj, emb: l.meanEmb[obj], x: q.x, y: q.y };
  }));
  const own = (r, k) => between(sims[r].robot.start, locals[r].poses[Math.min(k, locals[r].poses.length - 1)]);
  const T = new Array(n).fill(null); T[0] = { x: 0, y: 0, th: 0 };   // robot frame -> robot 0 frame
  const joined = [0], pending = new Set([...Array(n).keys()].slice(1));
  const links = [], encUsed = [], via = {};
  let rejectedTotal = 0;
  const teamObjects = () => joined.flatMap((r) => shared[r].map((s) => { const q = compose(T[r], { x: s.x, y: s.y, th: 0 }); return { ...s, x: q.x, y: q.y }; }));
  while (pending.size) {
    let pick = null;
    // 1) direct robot-robot observations: unambiguous frame link
    for (const e of encounters) {
      const inA = joined.includes(e.ra) && pending.has(e.rb), inB = joined.includes(e.rb) && pending.has(e.ra);
      if (!inA && !inB) continue;
      const [ra, ka, rb, kb, z] = inA ? [e.ra, e.ka, e.rb, e.kb, e.z] : [e.rb, e.kb, e.ra, e.ka, inverse(e.z)];
      const Tb = compose(compose(T[ra], own(ra, ka)), compose(z, inverse(own(rb, kb))));
      pick = { r: rb, T: Tb, how: 'encounter' }; break;
    }
    // 2) otherwise object association with strict anti-aliasing checks
    if (!pick) {
      const team = teamObjects();
      for (const r of pending) {
        if (!shared[r].length || !team.length) continue;
        const a = associate(team, shared[r], { inlierDist: 0.8 });
        const cats = new Set(a.inliers.map((c) => labelFor(c.b.emb).cat));
        rejectedTotal += a.outliers.length;
        if (a.T && a.inliers.length >= 5 && cats.size >= 3 && (!pick || a.inliers.length > pick.n)) pick = { r, T: a.T, how: 'objects', n: a.inliers.length };
      }
    }
    if (!pick) break;
    T[pick.r] = pick.T; via[pick.r] = pick.how; joined.push(pick.r); pending.delete(pick.r);
    // gated object association given the frame link (one-to-one, by similarity)
    const team = teamObjects().filter((o) => o.r !== pick.r);
    const used = new Set(), cand = [];
    for (const s2 of shared[pick.r]) {
      const q = compose(pick.T, { x: s2.x, y: s2.y, th: 0 });
      for (const o of team) {
        const d = Math.hypot(o.x - q.x, o.y - q.y), sim = cosine(o.emb, s2.emb);
        if (d < 1.0 && sim > 0.8) cand.push({ o, s2, score: sim - d * 0.2 });
      }
    }
    cand.sort((x, y) => y.score - x.score);
    for (const c of cand) {
      if (used.has(c.o.key) || used.has(c.s2.key)) continue;
      used.add(c.o.key); used.add(c.s2.key);
      links.push({ ra: c.o.r, objA: c.o.obj, rb: pick.r, objB: c.s2.obj });
    }
  }
  const g = new PoseGraph(), idx = sims.map(() => ({}));
  const origin0 = sims[0].robot.start;
  for (const r of joined) {
    const toTeam = (p) => compose(origin0, compose(T[r], between(sims[r].robot.start, p)));
    locals[r].g.vars.forEach((v, i) => { idx[r][i] = g.addVar({ ...toTeam(v), owner: v.owner, kind: v.kind, key: v.key, fixed: r === 0 && v.key.endsWith(':p0') }); });
    for (const f of locals[r].g.factors) g.addFactor(idx[r][f.i], idx[r][f.j], f.z, f.wR, f.wT, f.kind);
  }
  for (const L of links) g.addFactor(idx[L.ra][locals[L.ra].lmIdx[L.objA]], idx[L.rb][locals[L.rb].lmIdx[L.objB]], { x: 0, y: 0, th: 0 }, W.sepR, W.sepT, 'sep');
  for (const e of encounters) {
    if (!joined.includes(e.ra) || !joined.includes(e.rb)) continue;
    const ia = idx[e.ra][locals[e.ra].poseIdx[Math.min(e.ka, locals[e.ra].poseIdx.length - 1)]], ib = idx[e.rb][locals[e.rb].poseIdx[Math.min(e.kb, locals[e.rb].poseIdx.length - 1)]];
    g.addFactor(ia, ib, e.z, 400, 400, 'enc'); encUsed.push(e);
  }
  const poseIndices = sims.map((_, r) => (joined.includes(r) ? locals[r].poseIdx.map((i) => idx[r][i]) : null));
  const lmIndices = sims.map((_, r) => (joined.includes(r) ? Object.fromEntries(Object.entries(locals[r].lmIdx).map(([o, i]) => [o, idx[r][i]])) : null));
  const init = g.vars.map((v) => ({ ...v }));
  const est = (src) => joined.flatMap((r) => poseIndices[r].map(src));
  const gtAll = joined.flatMap((r) => sims[r].gt);
  const disagreement = (src) => {
    if (!links.length) return 0;
    let s2 = 0; for (const L of links) { const a2 = src(lmIndices[L.ra][L.objA]), b2 = src(lmIndices[L.rb][L.objB]); s2 += Math.hypot(a2.x - b2.x, a2.y - b2.y); }
    return s2 / links.length;
  };
  return {
    joined, missing: [...pending], links, encounters: encUsed, via, rejectedTotal, g, init, poseIndices, lmIndices,
    teamAte: (src) => ateAligned(est(src), gtAll), teamAlign: (src) => rigidAlign(est(src), gtAll), disagreement,
    versions: sims.map((s2) => s2.version), bytes: shared.reduce((a2, s2) => a2 + s2.length, 0) * BYTES.objectDescriptor * Math.max(1, joined.length - 1),
  };
}

// Fused object list from a merged team map (union-find over verified links).
export function fusedObjects(sims, locals, M, src, T) {
  const parent = {}; const key = (r, o) => `${r}|${o}`;
  const find = (k) => (parent[k] === k || !parent[k] ? (parent[k] = parent[k] || k) : (parent[k] = find(parent[k])));
  for (const L of M.links) { const a = find(key(L.ra, L.objA)), b = find(key(L.rb, L.objB)); if (a !== b) parent[a] = b; }
  const groups = {};
  for (const r of M.joined) for (const obj of Object.keys(M.lmIndices[r])) { const root = find(key(r, obj)); (groups[root] ||= []).push({ r, obj }); }
  return Object.values(groups).map((mem) => {
    let x = 0, y = 0; for (const m of mem) { const p = T(src(M.lmIndices[m.r][m.obj])); x += p.x; y += p.y; }
    const lab = labelFor(locals[mem[0].r].meanEmb[mem[0].obj]);
    return { members: mem, x: x / mem.length, y: y / mem.length, label: `${lab.color} ${lab.cat}`, cat: lab.cat, color: lab.color };
  });
}

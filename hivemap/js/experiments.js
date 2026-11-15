// Experiment harness: communication conditions for multi-robot tasks.
//
// Conditions (all start from the identical world state after priorExploration):
//   alone        - existing independent policy (no communication at all)
//   language     - no map merging, no shared frame; robots exchange short
//                  natural-language messages (labels + ROOM names, never
//                  coordinates). Answers come from each robot's OWN noisy map.
//   shared_noopt - existing shared policy, maps exchanged and merged, but the
//                  distributed optimization (optimize()) is skipped
//   shared_opt   - existing shared policy (exchange + distributed optimization)
//   oracle       - upper bound: same policy as shared_opt, but the team map holds
//                  every object any robot has in its map at its GROUND-TRUTH
//                  position, merged perfectly (no SLAM error, no merge failures).
//                  Labels stay perceptual (mean of the members' descriptors).
//   shared_noverify - ablation: shared_opt with map merging stripped of its
//                  anti-aliasing safeguards (no category-diversity / uniqueness /
//                  trajectory-through-wall checks on the alignment, no look-alike
//                  or wall checks on object links) and robot encounters disabled,
//                  so appearance + RANSAC object matching alone links the maps.
//   shared_noenc - control for shared_noverify: the verified merge (team.js
//                  mergeMaps, all safeguards on) but with robot encounters disabled.
//
// runOne(scene, n, seed, task, condition) runs one episode headless and returns
// a flat metrics record (see metrics() below). Node-importable, no DOM.
import { Team } from './engine.js';
import { SCENES, CATS, roomAt } from './scenes.js';
import { priorExploration, makeTask, runTask, placeItem, _internal as H } from './tasks.js';
import { embedText, labelFor, cosine } from './embed.js';
import { BYTES, mergeMaps } from './team.js';
import { PoseGraph, ateAligned, rigidAlign } from './slam.js';
import { associate } from './assoc.js';
import { compose, between } from './geom.js';

export const CONDITIONS = ['alone', 'language', 'shared_noopt', 'shared_opt', 'oracle', 'shared_noverify', 'shared_noenc'];
const SHARED = new Set(['shared_noopt', 'shared_opt', 'oracle', 'shared_noverify', 'shared_noenc']);
export const TASK_KINDS = ['fetch', 'inventory', 'rendezvous', 'dispatch', 'search'];
const { reachedOk, center, quickKnows, sighted, instances, matchesCat, matchesTarget, findTarget, roomGap, dedupe, exploreUntil, meetingSlots } = H;
// label matches the query and the estimate is in the named room, or (no strict match needed here) within the room margin: used for scoring only
const matchesLoose = (o, task) => matchesTarget(o, task) || (task.room && task.roomMargin > 0 && matchesTarget(o, { query: task.query }) && roomGap(o, task.roomRect) <= task.roomMargin);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const reach = (o) => (CATS[o?.cat]?.r ?? 0.4) + 1.0;
const ROOM_MARGIN = 1.0;   // see tasks.js findTarget
const COLLIDE = 0.5;   // centre-centre distance (m) below which two 0.56 x 0.44 m robots are counted as colliding

// ---------------------------------------------------------------- instrumentation
function instrument(T) {
  const I = { goals: [], explores: [], timeouts: 0, noPath: 0, stuckNav: 0, stuckExplore: 0, exchanges: 0, dgsRounds: 0, mapMsgs: 0 };
  const goTo = T.goTo.bind(T), exploreRoom = T.exploreRoom.bind(T), exchange = T.exchange.bind(T), optimize = T.optimize.bind(T);
  T.goTo = async (r, target, label) => {
    let res;
    try { res = await goTo(r, target, label); }
    catch (e) {
      // the planner found no path to this goal (e.g. the goal estimate falls in a cut-off pocket): count the leg
      // as failed and let the policy continue, instead of aborting the whole episode (same in every condition)
      if (!/No path/.test(String(e.message))) throw e;
      I.noPath++;
      res = { arrived: false, no_path: true, driven_m: 0, took_s: 0, now_in: roomAt(T.scene, T.pose[r].x, T.pose[r].y), ...(target.gt ? { distance_to_real_object_m: +dist(T.pose[r], target.gt).toFixed(2) } : {}) };
    }
    I.goals.push({ r, x: target.x, y: target.y, gtId: target.gt?.id ?? null, standoff: target.standoff ?? null, t: T.time, pose: { ...T.pose[r] }, timed_out: !!res.timed_out });
    // stuck leg: the robot ended far from the goal, beyond any early stop the engine allows by design (tol 1.6 m + 1.5 m)
    if (!res.no_path && dist(T.pose[r], target) > Math.max(3.5, (target.standoff ?? 1.0) + 2.0)) I.stuckNav++;
    if (res.timed_out) I.timeouts++;
    return res;
  };
  T.exploreRoom = async (r, room, opts) => {
    const k0 = T.sims[r].k;
    let fired = false;   // an early stop (target seen) before entering the room is not "stuck"
    if (opts?.until) { const u = opts.until; opts = { ...opts, until: () => { const v = u(); if (v) fired = true; return v; } }; }
    const res = await exploreRoom(r, room, opts);
    // stuck coverage: the robot never got inside the room it was asked to cover (e.g. blocked by parked robots)
    const q = T.scene.rooms.find((x) => x.name === room);
    if (q && !fired && !T.sims[r].gt.slice(k0).some((p) => p.x > q.x0 + 0.3 && p.x < q.x1 - 0.3 && p.y > q.y0 + 0.3 && p.y < q.y1 - 0.3)) I.stuckExplore++;
    I.explores.push({ r, room, t: T.time });
    if (res.timed_out) I.timeouts++;
    return res;
  };
  T.exchange = () => {
    const ex = exchange();
    const J = T.M.joined.length; I.exchanges++; I.mapMsgs += J * (J - 1);   // every joined robot sends its object map to every other
    return ex;
  };
  T.optimize = async (animated) => {
    if (T.skipOptimize) {   // shared_noopt: keep the merged map as initialised by the RANSAC alignment
      const d = +T.M.disInit.toFixed(2);
      T.solverStats = { rounds: 0, bytes_exchanged: 0, map_disagreement_before_m: d, map_disagreement_after_m: d, skipped: true };
      return T.solverStats;
    }
    const st = await optimize(animated);
    if (!st.note && T.M.joined.length > 1) { I.dgsRounds += st.rounds; I.mapMsgs += st.rounds * T.M.joined.length; }   // each robot broadcasts its separator estimates once per round
    return st;
  };
  return I;
}

// ---------------------------------------------------------------- ORACLE team map
// exchange(): snapshot of every object in any robot's local map (perfect association by
// true identity); objectsFor(r): those objects at ground-truth positions, plus objects r
// itself has seen since (also at ground truth). Bytes booked like mergeMaps.
function makeOracle(T) {
  T.exchange = function () {
    T.robots.forEach((_, r) => T.local(r));
    const emb = {}, members = {};
    T.locals.forEach((L, r) => { for (const id of Object.keys(L.lms)) { const e = L.meanEmb[id]; const acc = (emb[id] ||= new Array(e.length).fill(0)); e.forEach((x, d) => { acc[d] += x; }); (members[id] ||= []).push(r); } });
    const nDesc = T.locals.reduce((a, L) => a + Object.keys(L.lms).length, 0);
    const joined = T.robots.map((_, r) => r);
    T.M = { oracle: true, joined, missing: [], links: [], encounters: [], emb, members, versions: T.sims.map((s) => s.version), bytes: nDesc * BYTES.objectDescriptor * Math.max(1, T.n - 1), disInit: 0 };
    T.bytes.objects += T.M.bytes; T.optimized = false; T.solverStats = null;
    const linked = Object.values(members).reduce((a, m) => a + m.length - 1, 0);
    return { robots_merged: joined.map((r) => T.robots[r].id), robots_not_overlapping: [], verified_matches: linked, robot_encounters_used: 0, rejected_lookalikes: 0, bytes_sent: T.M.bytes, map_disagreement_m: 0 };
  };
  T.optimize = async function () { T.optimized = true; T.solverStats = { rounds: 0, bytes_exchanged: 0, map_disagreement_before_m: 0, map_disagreement_after_m: 0, oracle: true }; return T.solverStats; };
  T.objectsFor = function (r) {
    const L = T.local(r), out = [];
    const ids = new Set(T.M ? Object.keys(T.M.emb) : []);
    for (const id of Object.keys(L.lms)) ids.add(id);
    let k = 0;
    for (const id of ids) {
      const g = T.scene.objects.find((o) => o.id === id); if (!g) continue;
      const e = T.M?.emb[id] || L.meanEmb[id], n = Math.hypot(...e) || 1, lab = labelFor(e.map((x) => x / n));
      const seen = T.M?.members[id] ? T.M.members[id].map((j) => T.robots[j].id) : [T.robots[r].id];
      out.push({ id: `T${++k}`, label: `${lab.color} ${lab.cat}`, x: g.x, y: g.y, room: roomAt(T.scene, g.x, g.y), seen_by: seen, _gt: g });
    }
    return out;
  };
  T.teamAte = () => 0;
}

// ---------------------------------------------------------------- NO-VERIFY merge (ablation)
// Copy of team.js mergeMaps with the safeguards removed: the best RANSAC alignment is
// accepted as soon as associate() returns one (>= 3 appearance-consistent inliers), and
// object links only need distance < 1 m and similarity > 0.8 (one-to-one), with no
// look-alike exclusion and no wall check. Called with no robot encounters.
const W_SEP = { R: 250, T: 300 };
function mergeMapsNoVerify(sims, locals) {
  const n = sims.length;
  const shared = locals.map((l, r) => Object.entries(l.lms).map(([obj, p]) => { const q = between(sims[r].robot.start, p); return { key: `${r}:${obj}`, r, obj, emb: l.meanEmb[obj], x: q.x, y: q.y }; }));
  const T = new Array(n).fill(null); T[0] = { x: 0, y: 0, th: 0 };
  const joined = [0], pending = new Set([...Array(n).keys()].slice(1)), links = [], via = {};
  const origin0 = sims[0].robot.start;
  const teamObjects = () => joined.flatMap((r) => shared[r].map((s) => { const q = compose(T[r], { x: s.x, y: s.y, th: 0 }); return { ...s, x: q.x, y: q.y }; }));
  while (pending.size) {
    let pick = null;
    const team = teamObjects();
    for (const r of pending) {
      if (!shared[r].length || !team.length) continue;
      const a = associate(team, shared[r], { inlierDist: 0.8 });
      if (a.T && (!pick || a.inliers.length > pick.n)) pick = { r, T: a.T, how: 'objects-unverified', n: a.inliers.length };
    }
    if (!pick) break;
    T[pick.r] = pick.T; via[pick.r] = pick.how; joined.push(pick.r); pending.delete(pick.r);
    const teamO = teamObjects().filter((o) => o.r !== pick.r);
    const mineT = shared[pick.r].map((s2) => ({ ...s2, ...compose(pick.T, { x: s2.x, y: s2.y, th: 0 }) }));
    const used = new Set(), cand = [];
    for (const q of mineT) for (const o of teamO) { const d = Math.hypot(o.x - q.x, o.y - q.y), sim = cosine(o.emb, q.emb); if (d < 1.0 && sim > 0.8) cand.push({ o, s2: q, score: sim - d * 0.2 }); }
    cand.sort((x, y) => y.score - x.score);
    for (const c of cand) { if (used.has(c.o.key) || used.has(c.s2.key)) continue; used.add(c.o.key); used.add(c.s2.key); links.push({ ra: c.o.r, objA: c.o.obj, rb: pick.r, objB: c.s2.obj }); }
  }
  const g = new PoseGraph(), idx = sims.map(() => ({}));
  for (const r of joined) {
    const toTeam = (p) => compose(origin0, compose(T[r], between(sims[r].robot.start, p)));
    locals[r].g.vars.forEach((v, i) => { idx[r][i] = g.addVar({ ...toTeam(v), owner: v.owner, kind: v.kind, key: v.key, fixed: r === 0 && v.key.endsWith(':p0') }); });
    for (const f of locals[r].g.factors) g.addFactor(idx[r][f.i], idx[r][f.j], f.z, f.wR, f.wT, f.kind);
  }
  for (const L of links) g.addFactor(idx[L.ra][locals[L.ra].lmIdx[L.objA]], idx[L.rb][locals[L.rb].lmIdx[L.objB]], { x: 0, y: 0, th: 0 }, W_SEP.R, W_SEP.T, 'sep');
  const poseIndices = sims.map((_, r) => (joined.includes(r) ? locals[r].poseIdx.map((i) => idx[r][i]) : null));
  const lmIndices = sims.map((_, r) => (joined.includes(r) ? Object.fromEntries(Object.entries(locals[r].lmIdx).map(([o, i]) => [o, idx[r][i]])) : null));
  const init = g.vars.map((v) => ({ ...v }));
  const est = (src) => joined.flatMap((r) => poseIndices[r].map(src));
  const gtAll = joined.flatMap((r) => sims[r].gt);
  const disagreement = (src) => { if (!links.length) return 0; let s2 = 0; for (const L of links) { const a2 = src(lmIndices[L.ra][L.objA]), b2 = src(lmIndices[L.rb][L.objB]); s2 += Math.hypot(a2.x - b2.x, a2.y - b2.y); } return s2 / links.length; };
  return { joined, missing: [...pending], links, encounters: [], via, frames: T, rejectedTotal: 0, g, init, poseIndices, lmIndices,
    teamAte: (src) => ateAligned(est(src), gtAll), teamAlign: (src) => rigidAlign(est(src), gtAll), disagreement,
    versions: sims.map((s2) => s2.version), bytes: shared.reduce((a2, s2) => a2 + s2.length, 0) * BYTES.objectDescriptor * Math.max(1, joined.length - 1) };
}
function makeNoVerify(T, verified = false) {
  T.exchange = function () {
    T.robots.forEach((_, r) => T.local(r));
    T.M = verified ? mergeMaps(T.sims, T.locals, []) : mergeMapsNoVerify(T.sims, T.locals); T.optimized = false; T.solverStats = null;
    T.bytes.objects += T.M.bytes;
    T.M.disInit = T.M.disagreement((i) => T.M.init[i]);
    return { robots_merged: T.M.joined.map((r) => T.robots[r].id), robots_not_overlapping: T.M.missing.map((r) => T.robots[r].id), verified_matches: T.M.links.length, robot_encounters_used: 0, rejected_lookalikes: 0, bytes_sent: T.M.bytes, map_disagreement_m: +T.M.disInit.toFixed(2) };
  };
}
// Quality of the last merge, scored with ground truth: object links joining two different
// physical objects, and robot frames placed > 1.5 m (mean over its objects) from where they belong.
function mergeQuality(T) {
  const M = T.M; if (!M || M.oracle) return { merge_joined: M ? M.joined.length : null, merge_links: null, merge_wrong_links: M ? 0 : null, merge_wrong_frames: M ? 0 : null };
  const wrongLinks = M.links.filter((L) => L.objA !== L.objB).length;
  const s0 = T.sims[0].robot.start;
  let wrongFrames = 0;
  for (const r of M.joined) {
    if (r === 0) continue;
    const Tt = between(s0, T.sims[r].robot.start), Te = M.frames[r], L = T.locals[r];
    const pts = Object.values(L.lms).map((p) => between(T.sims[r].robot.start, p));
    if (!pts.length) pts.push({ x: 0, y: 0, th: 0 });
    const e = pts.reduce((a, q) => { const u = compose(Te, { x: q.x, y: q.y, th: 0 }), v = compose(Tt, { x: q.x, y: q.y, th: 0 }); return a + Math.hypot(u.x - v.x, u.y - v.y); }, 0) / pts.length;
    if (e > 1.5) wrongFrames++;
  }
  return { merge_joined: M.joined.length, merge_links: M.links.length, merge_wrong_links: wrongLinks, merge_wrong_frames: wrongFrames };
}

// Natural-language channel. Bytes = UTF-8 length of the message text, counted
// once per recipient (a broadcast to k teammates counts k messages), matching
// the per-recipient accounting of the map exchange.
function makeComm(T, log) {
  const C = { msgs: 0, bytes: 0, transcript: [] };
  const deliver = (from, to, text) => {
    const k = to.length; if (!k) return;
    C.msgs += k; C.bytes += k * Buffer.byteLength(text, 'utf8');
    const line = `${T.robots[from].id} -> ${k === T.n - 1 ? 'all' : to.map((j) => T.robots[j].id).join(',')}: "${text}"`;
    C.transcript.push(line); log(line);
  };
  C.send = (from, to, text) => deliver(from, [to], text);
  C.broadcast = (from, text) => deliver(from, T.robots.map((_, j) => j).filter((j) => j !== from), text);
  return C;
}

const plural = (label, k) => (k === 1 ? `a ${label}` : `${k} ${label.endsWith('s') || label.endsWith('x') || label.endsWith('h') ? `${label}es` : `${label}s`}`);
const phraseRooms = (byRoom) => { const parts = Object.entries(byRoom).map(([room, k]) => `${k} in the ${room}`); return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0]; };
// loose room membership: own estimate inside the room rectangle grown by m metres
const inRoomLoose = (T, o, room, m = 1.0) => { const q = T.scene.rooms.find((x) => x.name === room); return q && o.x > q.x0 - m && o.x < q.x1 + m && o.y > q.y0 - m && o.y < q.y1 + m; };
const roomDist = (T, p, room) => dist(p, center(T, room));

// Ask teammates where "<color> <category>" is. Each teammate answers from its own
// map with label + room only; teammates that have not seen a match stay silent
// (silence = "no"). toAll: answers are broadcast so every robot hears them.
// Returns [{ j, label, room, gt }] (gt only for scoring, never used by the policy).
function askWhere(T, C, from, task, { prefix = '', toAll = false, ask = true } = {}) {
  const what = `${task.query}${task.room ? ` in the ${task.room}` : ''}`;
  if (ask) C.broadcast(from, `${prefix}Has anyone seen the ${what}? Which room is it in?`);
  const out = [];
  T.robots.forEach((_, j) => {
    if (j === from) return;
    const mineAll = T.objectsFor(j), strict = dedupe(mineAll.filter((o) => matchesTarget(o, task))), loose = findTarget(mineAll, task);
    const cands = strict.length ? strict : loose ? [loose] : [];
    if (!cands.length) return;
    const byRoom = {}; for (const o of cands) byRoom[o.room] = (byRoom[o.room] || 0) + 1;
    const text = cands.length === 1 ? `I saw a ${cands[0].label} in the ${cands[0].room}.` : `I saw ${cands.length} that match: ${phraseRooms(byRoom)}.`;
    if (toAll) C.broadcast(j, text); else C.send(j, from, text);
    for (const o of cands) out.push({ j, label: o.label, room: o.room, gt: o._gt?.id ?? null });
  });
  return out;
}
// candidate rooms: most-reported first, then nearest
function rankRooms(T, r, replies) {
  const votes = {}; for (const c of replies) votes[c.room] = (votes[c.room] || 0) + 1;
  return Object.keys(votes).filter((x) => x !== 'outside').sort((a, b) => votes[b] - votes[a] || roomDist(T, T.pose[r], a) - roomDist(T, T.pose[r], b));
}
// cover `room` until pred() holds (pred is checked cheaply first, full map solve at most every 3 s)
async function searchRoom(T, r, room, pred, cheap) {
  if (pred()) return true;
  let last = -1e9;
  const until = () => { if (cheap && !cheap()) return false; if (T.time - last < 3) return false; last = T.time; return pred(); };
  await T.exploreRoom(r, room, { until, untilEvery: 0 });
  return pred();
}

// ---------------------------------------------------------------- LANGUAGE policy
export async function runLanguage(T, task, log = () => {}, { agg = 'max' } = {}) {
  const t0 = T.time, d0 = T.sims.map((s) => s.distance);
  const say = (m) => log(`[t=${Math.round(T.time - t0)}s] ${m}`);
  const C = makeComm(T, (m) => say(`msg ${m}`));
  const G = { room_misses: 0, fallback_explore: 0, false_found: 0, not_found: 0 };
  let out = {};
  if (task.kind === 'search' && task.item) { task = { ...task, target: placeItem(T, task.item) }; say(`a ${task.query} was left somewhere in the building`); }

  // locate the target for robot r: own map, else ask, search the named rooms, else explore
  const locate = async (r, tk, heard = null) => {
    const find = () => findTarget(T.objectsFor(r), tk);
    if (find()) return find();
    const replies = heard ? heard.filter((c) => c.j !== r) : askWhere(T, C, r, tk);
    for (const room of rankRooms(T, r, replies)) {
      say(`${T.robots[r].id} searches the ${room} (told by teammates)`);
      // stop as soon as the robot itself observes a matching object (anywhere on the way, or in the room)
      const ok = await searchRoom(T, r, room, () => !!find(), () => quickKnows(T, r, tk));
      if (ok) return find();
      G.room_misses++; say(`${T.robots[r].id}: no ${tk.query} in the ${room}`);
    }
    if (!replies.length) say(`${T.robots[r].id}: nobody has seen it; exploring`);
    G.fallback_explore++;
    await exploreUntil(T, r, () => !!find(), { cheap: () => quickKnows(T, r, tk) });
    return find() || null;
  };

  if (task.kind === 'fetch') {
    const o = await locate(0, task);
    if (o) { say(`Robot 1 drives to ${o.label}`); const nav = await T.goTo(0, { x: o.x, y: o.y, gt: task.target }, o.label); out.reached_m = nav.distance_to_real_object_m; }
    else G.not_found++;
    out.success = reachedOk(out.reached_m, task.target); out.score = out.success ? 1 : 0;
  }

  if (task.kind === 'search') {
    const id = task.target.id, q = embedText(task.query);
    const before = T.robots.map((_, r) => T.objectsFor(r).filter((o) => matchesCat(o, q.cat)));
    const isNew = (r, o) => matchesCat(o, q.cat) && !before[r].some((b) => dist(b, o) < 1.5);
    const findFor = (r) => { const os = T.objectsFor(r); return os.find((o) => matchesTarget(o, task) && isNew(r, o)) || os.find((o) => isNew(r, o)); };
    // 1) maybe someone already saw it (normally not: it appeared after the map was built)
    const replies = askWhere(T, C, 0, task, { prefix: `Someone lost a ${task.query}. ` });
    let announced = null;   // { r, room, label }
    for (const room of rankRooms(T, 0, replies)) {
      say(`Robot 1 searches the ${room} (told by teammates)`);
      if (await searchRoom(T, 0, room, () => sighted(T, 0, id) && !!findFor(0), () => sighted(T, 0, id))) { announced = { r: 0 }; break; }
      G.room_misses++;
    }
    if (!announced) {
      // 2) split the rooms (same split as the shared policy, sent as plain-language assignments)
      const rooms = T.scene.rooms.map((x) => x.name), queues = T.robots.map(() => []), pos = T.pose.map((p) => ({ ...p }));
      const order = rooms.slice().sort((a, b) => roomDist(T, T.pose[0], a) - roomDist(T, T.pose[0], b));
      for (const room of order) {
        let best = null;
        T.robots.forEach((_, r) => { const d = dist(center(T, room), pos[r]) + queues[r].length * 12; if (!best || d < best.d) best = { d, r }; });
        queues[best.r].push(room); pos[best.r] = center(T, room);
      }
      queues.forEach((qq, r) => { if (r && qq.length) C.send(0, r, `Please search the ${qq.join(', ')} for a ${task.query} and tell me if you find it.`); });
      const seen = () => {
        if (announced) return true;
        const r = T.robots.findIndex((_, i) => sighted(T, i, id));
        if (r < 0) return false;
        // the finder describes what it saw from its own map: label + room (no coordinates)
        const o = findFor(r);
        const room = o ? o.room : roomAt(T.scene, T.pose[r].x, T.pose[r].y);
        announced = { r, room, label: o ? o.label : task.query, gt: o?._gt?.id ?? null };
        if (r) C.broadcast(r, `I found a ${announced.label} in the ${room}.`);
        else C.broadcast(0, `Found it, you can stop searching.`);
        if (announced.gt && announced.gt !== id) G.false_found++;
        return true;
      };
      await Promise.all(queues.map((qq, r) => (async () => { for (const room of qq) { if (seen()) return; await T.exploreRoom(r, room, { until: seen, untilEvery: 0 }); } })()));
      seen();
    }
    let o = null;
    if (announced && announced.r === 0) o = findFor(0);
    else if (announced) {
      say(`Robot 1 goes to the ${announced.room} to look for it`);
      const ok = await searchRoom(T, 0, announced.room, () => !!findFor(0) && sighted(T, 0, id), () => sighted(T, 0, id));
      if (!ok) G.room_misses++;
      o = ok ? findFor(0) : null;
    }
    if (!o) {   // fall back: Robot 1 searches the building itself
      G.fallback_explore++;
      await exploreUntil(T, 0, () => sighted(T, 0, id) && !!findFor(0), { done: () => false, every: 0 });
      o = findFor(0);
    }
    if (o) { say(`Robot 1 drives to ${o.label}`); const nav = await T.goTo(0, { x: o.x, y: o.y, gt: task.target }, o.label); out.reached_m = nav.distance_to_real_object_m; }
    else { G.not_found++; say(`the ${task.query} was not found`); }
    out.success = reachedOk(out.reached_m, task.target); out.score = out.success ? 1 : 0;
  }

  if (task.kind === 'inventory') {
    // teammates report per-room counts from their own maps; no coordinates -> no cross-robot de-duplication
    C.broadcast(0, `How many ${task.cat}s did you see, and in which rooms?`);
    const reports = T.robots.map((_, r) => {
      const own = dedupe(T.objectsFor(r).filter((o) => matchesCat(o, task.cat)));
      const byRoom = {}; for (const o of own) byRoom[o.room] = (byRoom[o.room] || 0) + 1;
      if (r) C.send(r, 0, own.length ? `I saw ${plural(task.cat, own.length)}: ${phraseRooms(byRoom)}.` : `I did not see any ${task.cat}.`);
      return byRoom;
    });
    const rooms = [...new Set(reports.flatMap((b) => Object.keys(b)))];
    const roomCounts = {}, sumCounts = {};
    for (const room of rooms) { const ks = reports.map((b) => b[room] || 0); roomCounts[room] = Math.max(...ks); sumCounts[room] = ks.reduce((a, b) => a + b, 0); }
    out.room_counts = agg === 'sum' ? sumCounts : roomCounts;
    out.room_counts_max = roomCounts; out.room_counts_sum = sumCounts;
    const tot = Object.values(out.room_counts).reduce((a, b) => a + b, 0);
    say(`Robot 1 reports ${tot} × ${task.cat}: ${phraseRooms(out.room_counts) || 'none'}`);
  }

  if (task.kind === 'rendezvous') {
    const near = (CATS[task.target.cat]?.r ?? 0.4) + 1.5, claims = new Set();
    // one round: Robot 1 sends the instruction; whoever has seen the object broadcasts the room
    const mine = findTarget(T.objectsFor(0), task);
    C.broadcast(0, mine ? `${task.text} I saw it in the ${mine.room}.` : `${task.text} Whoever has seen it: which room is it in?`);
    const heard = mine ? [{ j: 0, label: mine.label, room: mine.room, gt: mine._gt?.id ?? null }] : askWhere(T, C, 0, task, { toAll: true, ask: false });
    const arrivals = await Promise.all(T.robots.map((_, r) => (async () => {
      const o = await locate(r, task, heard); if (!o) { G.not_found++; return null; }
      const slots = meetingSlots(T, o, T.n + 4, (CATS[task.target.cat]?.r ?? 0.4) + 0.75);
      if (dist(T.pose[r], o) > 3.5) await T.goTo(r, { x: o.x, y: o.y, standoff: 3.0 }, o.label);
      const key = (s) => `${s.x.toFixed(1)},${s.y.toFixed(1)}`;
      const cost = (s) => dist(s, o) + 0.3 * dist(s, T.pose[r]);
      const free = slots.filter((s) => !claims.has(key(s)) && T.robots.every((_, j) => j === r || dist(T.pose[j], s) > 0.6)).sort((a, b) => cost(a) - cost(b));
      const s = free[0] || o; if (free[0]) { claims.add(key(free[0])); C.broadcast(r, `I am taking a spot next to the ${o.label}.`); }
      await T.goTo(r, { x: s.x, y: s.y, standoff: 0.05, faceTo: { x: o.x, y: o.y }, ...(free[0] ? {} : { gt: task.target }) }, o.label);
      const p = T.pose[r];
      return { d: dist(task.target, p), allow: Math.max(near, dist(s, o) + 1.3) };
    })()));
    const ok = arrivals.filter((a) => a && a.d < a.allow).length;
    out = { arrived: ok, robots: T.n, distances_m: arrivals.map((a) => (a ? +a.d.toFixed(2) : null)) }; out.success = ok === T.n; out.score = ok / T.n;
    say(`${ok}/${T.n} robots at the meeting point`);
  }

  if (task.kind === 'dispatch') {
    const gt = instances(T, task.cat), visited = new Set();
    C.broadcast(0, `${task.text} First tell me how many ${task.cat}s you saw and in which rooms.`);
    const own = T.robots.map((_, r) => dedupe(T.objectsFor(r).filter((o) => matchesCat(o, task.cat))));
    const counts = own.map((list, r) => {
      const byRoom = {}; for (const o of list) byRoom[o.room] = (byRoom[o.room] || 0) + 1;
      if (r) C.send(r, 0, list.length ? `I saw ${plural(task.cat, list.length)}: ${phraseRooms(byRoom)}.` : `I did not see any ${task.cat}.`);
      return byRoom;
    });
    const rooms = [...new Set(counts.flatMap((b) => Object.keys(b)))].filter((x) => x !== 'outside');
    const expect = {}; for (const room of rooms) { const ks = counts.map((b) => b[room] || 0); expect[room] = agg === 'sum' ? ks.reduce((a, b) => a + b, 0) : Math.max(...ks); }
    // greedy room assignment: prefer robots that saw the instances (they can drive to them), balance load
    const queues = T.robots.map(() => []), load = T.robots.map(() => 0), pos = T.pose.map((p) => ({ ...p }));
    for (const room of rooms.slice().sort((a, b) => expect[b] - expect[a])) {
      let best = null;
      T.robots.forEach((_, r) => {
        const mine = counts[r][room] || 0, search = mine < expect[room];
        const c = load[r] + dist(pos[r], center(T, room)) + (mine ? 0 : 25) + (search ? 10 : 0);
        if (!best || c < best.c) best = { c, r, search };
      });
      queues[best.r].push(room); load[best.r] += 8 * expect[room] + (best.search ? 30 : 0); pos[best.r] = center(T, room);
    }
    queues.forEach((qq, r) => { if (r && qq.length) C.send(0, r, `Please visit the ${task.cat}s in the ${qq.map((room) => `${room} (${expect[room]})`).join(', ')}.`); });
    const visit = async (r, o) => { const nav = await T.goTo(r, { x: o.x, y: o.y, gt: o._gt }, o.label); if (o._gt && reachedOk(nav.distance_to_real_object_m, o._gt)) visited.add(o._gt.id); };
    await Promise.all(queues.map((qq, r) => (async () => {
      for (const room of qq) {
        const done = [];
        const mineIn = () => dedupe(T.objectsFor(r).filter((o) => matchesCat(o, task.cat) && inRoomLoose(T, o, room, 0.5)));
        for (const o of mineIn()) { await visit(r, o); done.push(o); }
        if (done.length < expect[room]) {   // told there are more here than I know of: search the room for them
          say(`${T.robots[r].id} searches the ${room} for more ${task.cat}s (${done.length}/${expect[room]} known)`);
          await searchRoom(T, r, room, () => mineIn().length >= expect[room], null);
          const extra = mineIn().filter((o) => !done.some((d) => dist(d, o) < 1.0));
          if (done.length + extra.length < expect[room]) G.room_misses++;
          for (const o of extra) { await visit(r, o); done.push(o); }
        }
      }
    })()));
    const gtIds = new Set(gt.map((o) => o.id)), v = [...visited].filter((x) => gtIds.has(x)).length;
    out = { visited: v, total: gt.length }; out.success = v === gt.length; out.score = v / gt.length;
    say(`${v}/${gt.length} ${task.cat} visited`);
  }

  out.time_s = Math.round(T.time - t0);
  out.distance_m = +T.sims.reduce((a, s, r) => a + s.distance - d0[r], 0).toFixed(1);
  out.bytes = C.bytes; out.messages = C.msgs; out.grounding = G; out.transcript = C.transcript;
  return out;
}

// ---------------------------------------------------------------- metrics
function priorFingerprint(T) {
  let h = 0; const mix = (v) => { h = (Math.imul(h ^ Math.round(v * 1000), 2654435761) >>> 0); };
  for (const s of T.sims) { for (const g of s.gt) { mix(g.x); mix(g.y); mix(g.th); } mix(s.obs.length); }
  mix(T.time);
  return h.toString(16);
}

function inventoryEval(T, task, out, condition) {
  const gt = instances(T, task.cat), gtRoom = {};
  for (const o of gt) { const room = roomAt(T.scene, o.x, o.y); gtRoom[room] = (gtRoom[room] || 0) + 1; }
  const m = {};
  let repRoom;
  if (condition === 'language') repRoom = out.room_counts;
  else {
    const reported = dedupe(T.objectsFor(0).filter((o) => matchesCat(o, task.cat)));
    const used = new Set(); let hit = 0, dup = 0, mislabel = 0, spurious = 0;
    for (const o of reported) {
      const cand = gt.filter((q) => dist(q, o) < 1.0).sort((a, b) => dist(a, o) - dist(b, o));
      const g = cand.find((q) => !used.has(q.id));
      if (g) { used.add(g.id); hit++; } else if (cand.length) dup++;
      else if (T.scene.objects.some((q) => q.cat !== 'door' && dist(q, o) < 1.0)) mislabel++; else spurious++;
    }
    Object.assign(m, { inv_metric_hits: hit, inv_metric_double: dup, inv_metric_mislabel: mislabel, inv_metric_spurious: spurious, inv_metric_miss: gt.length - hit });
    repRoom = {}; for (const o of reported) repRoom[o.room] = (repRoom[o.room] || 0) + 1;
  }
  let over = 0, miss = 0, okc = 0;
  for (const room of new Set([...Object.keys(gtRoom), ...Object.keys(repRoom)])) {
    const a = repRoom[room] || 0, b = gtRoom[room] || 0; over += Math.max(0, a - b); miss += Math.max(0, b - a); okc += Math.min(a, b);
  }
  Object.assign(m, { inv_total: gt.length, inv_reported: Object.values(repRoom).reduce((a, b) => a + b, 0), inv_room_over: over, inv_room_miss: miss, inv_room_recall: okc / gt.length, inv_room_exact: over === 0 && miss === 0 });
  if (condition === 'language' && out.room_counts_sum) {
    let o2 = 0, m2 = 0; for (const room of new Set([...Object.keys(gtRoom), ...Object.keys(out.room_counts_sum)])) { const a = out.room_counts_sum[room] || 0, b = gtRoom[room] || 0; o2 += Math.max(0, a - b); m2 += Math.max(0, b - a); }
    Object.assign(m, { inv_sum_room_over: o2, inv_sum_room_miss: m2, inv_sum_room_exact: o2 === 0 && m2 === 0 });
  }
  return m;
}

function metrics(T, task, out, condition, I, extra) {
  const rec = { success: !!out.success, score: out.score ?? 0, time_s: out.time_s ?? null, distance_m: out.distance_m ?? null };
  if (condition === 'language') { rec.bytes = out.bytes; rec.messages = out.messages; }
  else if (condition === 'alone') { rec.bytes = 0; rec.messages = 0; }
  else { rec.bytes = out.bytes; rec.messages = I.mapMsgs; rec.exchanges = I.exchanges; rec.dgs_rounds = I.dgsRounds; }
  // bytes per channel: natural-language text vs object descriptors vs distributed-optimization traffic
  rec.bytes_text = condition === 'language' ? out.bytes : 0;
  rec.tokens_approx = condition === 'language' ? Math.round(out.bytes / 4) : 0;
  rec.bytes_objects = T.bytes.objects - extra._b0.objects; rec.bytes_dgs = T.bytes.dgs - extra._b0.dgs;
  if (T.n === 1) { rec.bytes = 0; rec.messages = 0; rec.bytes_objects = 0; rec.bytes_dgs = 0; }
  delete extra._b0;   // (n = 1: a single robot has nobody to talk to; mergeMaps still books one copy of its map)
  const G = out.grounding || { room_misses: 0, fallback_explore: 0, false_found: 0, not_found: 0 };
  const tgt = task.target ? T.scene.objects.find((o) => o.id === task.target.id) : null;
  let ge = 0;
  if (task.kind === 'fetch' || task.kind === 'search') {
    const g0 = I.goals.filter((g) => g.r === 0 && g.gtId);
    const last = g0[g0.length - 1];
    rec.wrong_goal = last ? (dist(last, tgt) > reach(tgt) ? 1 : 0) : 0;
    rec.not_found = last ? 0 : 1;
    // final estimate of the target in Robot 1's map (team map when shared)
    const q = embedText(task.query);
    const est = T.objectsFor(0).filter((o) => matchesLoose(o, task) || (task.kind === 'search' && matchesCat(o, q.cat))).sort((a, b) => dist(a, tgt) - dist(b, tgt))[0];
    rec.target_pos_err_m = last ? +dist(last, tgt).toFixed(3) : null;   // error of the position Robot 1 actually navigated to
    rec.target_map_err_m = est ? +dist(est, tgt).toFixed(3) : null;
    ge = rec.wrong_goal + rec.not_found + G.room_misses + G.false_found;
  }
  if (task.kind === 'rendezvous') {
    let wrong = 0, none = 0, errs = [];
    T.robots.forEach((_, r) => {
      const o = T.objectsFor(r).filter((x) => matchesLoose(x, task)).sort((a, b) => dist(a, tgt) - dist(b, tgt))[0];
      if (!o) { none++; return; }
      const e = dist(o, tgt); errs.push(e); if (e > reach(tgt)) wrong++;
    });
    rec.wrong_goal = wrong; rec.not_found = none; rec.target_pos_err_m = errs.length ? +(errs.reduce((a, b) => a + b, 0) / errs.length).toFixed(3) : null;
    ge = wrong + none + G.room_misses;
  }
  if (task.kind === 'dispatch') {
    const gtIds = new Set(instances(T, task.cat).map((o) => o.id)), hit = new Set();
    let wasted = 0, dup = 0;
    for (const g of I.goals) {
      const o = g.gtId && T.scene.objects.find((x) => x.id === g.gtId);
      const ok = o && gtIds.has(o.id) && reachedOk(dist(g.pose, o), o);
      if (!ok) wasted++; else if (hit.has(o.id)) dup++; else hit.add(o.id);
    }
    // position error of each visited instance's map estimate (goal) vs ground truth
    const errs = I.goals.filter((g) => g.gtId && gtIds.has(g.gtId)).map((g) => dist(g, T.scene.objects.find((x) => x.id === g.gtId)));
    Object.assign(rec, { disp_visits: I.goals.length, disp_wasted: wasted, disp_duplicate: dup, disp_missed: gtIds.size - hit.size, disp_total: gtIds.size, target_pos_err_m: errs.length ? +(errs.reduce((a, b) => a + b, 0) / errs.length).toFixed(3) : null });
    ge = wasted + G.room_misses;
  }
  if (task.kind === 'inventory') {
    Object.assign(rec, inventoryEval(T, task, out, condition));
    ge = rec.inv_room_over + rec.inv_room_miss;
    if (condition === 'language') { rec.success = rec.inv_room_exact; rec.score = rec.inv_room_recall; }
  }
  rec.grounding_errors = ge;
  Object.assign(rec, { room_misses: G.room_misses, false_found: G.false_found, fallback_explore: G.fallback_explore });
  Object.assign(rec, mergeQuality(T));
  rec.ate_team = T.M ? +T.teamAte().toFixed(4) : null;
  rec.ate_local = +T.pooledLocalAte().toFixed(4);
  rec.map_disagreement_m = T.solverStats ? T.solverStats.map_disagreement_after_m : null;
  rec.min_sep_m = Number.isFinite(T.minSep) ? +T.minSep.toFixed(3) : null;
  rec.collision = Number.isFinite(T.minSep) && T.minSep < COLLIDE;
  rec.job_timeouts = I.timeouts; rec.nav_no_path = I.noPath; rec.stuck_nav = I.stuckNav; rec.stuck_explore = I.stuckExplore;
  rec.stuck_legs = I.timeouts + I.stuckNav + I.stuckExplore;
  return Object.assign(rec, extra);
}

// ---------------------------------------------------------------- one episode
export async function runOne(scene, n, seed, kind, condition, { log = null, agg = 'max', maxSim = 3600 } = {}) {
  const def = SCENES.find((s) => s.id === scene);
  if (!def) throw new Error(`unknown scene ${scene}`);
  if (!CONDITIONS.includes(condition)) throw new Error(`unknown condition ${condition}`);
  const w0 = Date.now();
  const T = new Team(def, n, seed, { shared: SHARED.has(condition) });
  await T.runHeadless(priorExploration);
  const prior = { prior_fp: priorFingerprint(T), prior_time_s: Math.round(T.time) };
  const task = makeTask(T, kind);
  // room-qualified targets match estimates up to 1 m outside the named room (same margin in every condition)
  if (task.room && ROOM_MARGIN > 0) { const q = T.scene.rooms.find((x) => x.name === task.room); task.roomRect = { x0: q.x0, y0: q.y0, x1: q.x1, y1: q.y1 }; task.roomMargin = ROOM_MARGIN; }
  const taskInfo = { task_text: task.text, target_id: task.target?.id ?? null, target_label: task.target ? `${task.target.color} ${task.target.cat}` : null, cat: task.cat ?? null, task_room: task.room ?? null };
  const minSep0 = T.minSep; T.minSep = Infinity;   // collisions are counted during the task only (prior reported separately)
  if (condition === 'oracle') makeOracle(T);
  if (condition === 'shared_noverify') makeNoVerify(T);
  if (condition === 'shared_noenc') makeNoVerify(T, true);
  const b0 = { objects: T.bytes.objects, dgs: T.bytes.dgs };
  const I = instrument(T);
  if (condition === 'shared_noopt') T.skipOptimize = true;
  const logs = [];
  const lg = (m) => { logs.push(m); if (log) log(m); };
  let out, error = null;
  const tTask = T.time;
  try {
    out = await T.runHeadless((TT) => (condition === 'language' ? runLanguage(TT, task, lg, { agg }) : runTask(TT, task, lg)), maxSim);
  } catch (e) {
    error = String(e.message || e);
    out = { success: false, score: 0, time_s: Math.round(T.time - tTask), distance_m: null };
  }
  const base = { scene, n, seed, task: kind, condition, agg: condition === 'language' ? agg : null, ...prior, ...taskInfo, prior_min_sep_m: Number.isFinite(minSep0) ? +minSep0.toFixed(3) : null, _b0: b0 };
  const rec = metrics(T, task, out, condition, I, base);
  rec.timeout = !!error && /time limit/.test(error); rec.policy_error = !!error && !rec.timeout; rec.error = error;   // e.g. goTo 'No path found.' thrown by the policy
  rec.wall_s = +((Date.now() - w0) / 1000).toFixed(2);
  rec.log = logs;
  return rec;
}

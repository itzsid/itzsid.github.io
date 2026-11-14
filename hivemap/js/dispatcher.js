// Team dispatcher: takes a task in plain words, makes sure the team map is
// current, decides which robot(s) should do it (by path cost and who is idle),
// and hands the work to those robots' agents.
import { embedText } from './embed.js';
import { roomAt } from './scenes.js';
import { fmt } from './engine.js';

const INTENT_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['go_to', 'meet', 'list', 'visit_all', 'explore', 'answer'] },
    target: { type: 'string', description: 'object words, e.g. "red toolbox"' },
    room: { type: 'string' },
  },
  required: ['intent'],
};

export class Dispatcher {
  constructor(team, ui) { this.T = team; this.ui = ui; this.load = team.robots.map(() => 0); }
  note(text, extra = {}) { this.ui.log({ kind: 'dispatch', text, ...extra }); }

  roomName(t) { return this.T.scene.rooms.find((q) => t.toLowerCase().includes(q.name.toLowerCase()))?.name || null; }

  parse(text) {
    const t = text.toLowerCase();
    const q = embedText(t), room = this.roomName(t);
    const target = q ? `${q.col || ''} ${q.cat || ''}`.trim() : '';
    let intent = 'go_to';
    if (/^(where|what|which|is there|are there|do we|does anyone)\b/.test(t)) intent = 'answer';
    else if (/\b(meet|gather|rendezvous|everyone|all robots|whole team)\b/.test(t)) intent = 'meet';
    else if (/\b(visit|check|inspect)\b/.test(t) && /\b(every|all|each)\b/.test(t)) intent = 'visit_all';
    else if (/\b(list|how many|count|inventory)\b/.test(t) || (/\b(every|all)\b/.test(t) && /\bfind\b/.test(t))) intent = 'list';
    else if (/\b(explore|survey|map)\b/.test(t)) intent = 'explore';
    if (!q && intent === 'go_to') intent = room ? 'explore' : 'answer';
    return { intent, target, room };
  }

  async interpret(text) {
    const base = this.parse(text);
    if (!this.ui.llm.ready) return base;
    try {
      const T = this.T;
      const out = await this.ui.llm.json([
        { role: 'system', content: `You turn a task for a team of indoor robots into JSON. Rooms: ${T.scene.rooms.map((r) => r.name).join(', ')}.
intents: go_to (one robot goes to an object), meet (all robots gather at an object), list (report every instance of a kind of object), visit_all (robots visit every instance), explore (explore a room or the whole building), answer (a question that needs no driving).
Fill "target" with the object words (color + kind) and "room" if a room is named.` },
        { role: 'user', content: text },
      ], INTENT_SCHEMA, 120);
      return { intent: out.intent || base.intent, target: out.target || base.target, room: T.scene.rooms.find((r) => r.name.toLowerCase() === String(out.room || '').toLowerCase())?.name || base.room };
    } catch { return base; }
  }

  // bring the shared map up to date so the choice uses everything the team knows
  async syncMap() {
    const T = this.T;
    if (!T.shared) return;
    if (!T.M || !T.mergedFresh()) {
      const ex = T.exchange();
      this.note(`Merged maps from ${ex.robots_merged.length}/${T.n} robots (${ex.verified_matches} shared objects${ex.robot_encounters_used ? `, ${ex.robot_encounters_used} robot sightings` : ''}).`, { tool: 'exchange_maps', output: ex });
    }
    if (T.M && !T.optimized && T.M.disInit > 0.12) {
      const op = await T.optimize(true);
      this.note(`Optimized the team map: disagreement ${op.map_disagreement_before_m} → ${op.map_disagreement_after_m} m.`, { tool: 'optimize_team_map', output: op });
    }
  }

  matches(target) {
    const q = embedText(target); if (!q) return [];
    const T = this.T, seen = [];
    for (const o of T.objectsFor(0)) {
      const e = embedText(o.label);
      if (!e || (q.cat && e.cat !== q.cat) || (q.col && e.col !== q.col)) continue;
      if (seen.some((s) => Math.hypot(s.x - o.x, s.y - o.y) < 1.0)) continue;
      seen.push(o);
    }
    return seen;
  }
  idle() { return this.T.robots.map((_, r) => r).filter((r) => !this.T.jobs[r] && !this.ui.agents[r].busy); }
  pathCost(r, p) { const pl = this.T.nav.plan(this.T.pose[r], p); return pl ? pl.length : Infinity; }
  roomCenter(name) { const q = this.T.scene.rooms.find((x) => x.name === name); return { x: (q.x0 + q.x1) / 2, y: (q.y0 + q.y1) / 2 }; }
  unexplored() { const T = this.T; return T.scene.rooms.map((q) => q.name).filter((n) => !T.robots.some((_, i) => T.sims[i].explored.has(n))); }

  async handle(text) {
    const T = this.T, t0 = T.time, d0 = T.sims.reduce((a, s) => a + s.distance, 0);
    this.load = this.load.map((x) => x * 0.5);   // older work matters less
    this.ui.log({ kind: 'task', text });
    // direct address: "Robot 3, ..."
    const direct = text.match(/^\s*(?:robot\s*|r)(\d+)\s*[,:]\s*(.+)$/i);
    if (direct) {
      const r = +direct[1] - 1;
      if (!T.robots[r]) return this.done(`There is no Robot ${direct[1]}.`, t0, d0);
      this.note(`Sending the task to ${T.robots[r].name} as asked.`);
      const reply = await this.run(r, direct[2]);
      return this.done(reply, t0, d0);
    }
    const it = await this.interpret(text);
    await this.syncMap();
    const idle = this.idle();
    if (!idle.length && it.intent !== 'answer' && it.intent !== 'list') return this.done('All robots are busy right now. Try again when one is free.', t0, d0);

    if (it.intent === 'answer' || it.intent === 'list') {
      const list = it.target ? this.matches(it.target) : [];
      const rooms = this.unexplored();
      if (it.intent === 'list' && rooms.length && idle.length) {
        this.note(`The team has not seen ${rooms.join(', ')} yet; surveying ${rooms.length > 1 ? 'them in parallel' : 'it'} first.`);
        await this.surveyRooms(rooms, idle); await this.syncMap();
      }
      const final = it.target ? this.matches(it.target) : [];
      if (!it.target && it.room) {
        const os = T.objectsFor(0).filter((o) => o.room === it.room);
        return this.done(os.length ? `In the ${it.room} the team map has: ${[...new Set(os.map((o) => o.label))].slice(0, 12).join(', ')}.` : `Nobody has mapped the ${it.room} yet.`, t0, d0);
      }
      if (!final.length) return this.done(`The team map has no ${it.target || 'match'}.${rooms.length && it.intent === 'answer' ? ` Unexplored: ${rooms.join(', ')}.` : ''}`, t0, d0);
      return this.done(`No driving needed: the team map has ${final.length} × ${it.target}: ${final.map((o) => `${o.id} in the ${o.room}`).join('; ')}.`, t0, d0);
    }

    if (it.intent === 'explore') {
      const rooms = it.room ? [it.room] : this.unexplored();
      if (!rooms.length) return this.done('Every room has already been explored by the team.', t0, d0);
      await this.surveyRooms(rooms, idle); await this.syncMap();
      return this.done(`Explored ${rooms.join(', ')}.`, t0, d0);
    }

    // tasks with a target object
    let objs = this.matches(it.target);
    if (!objs.length) {
      const rooms = this.unexplored();
      if (!rooms.length) return this.done(`Nobody has seen a ${it.target}, and every room has been explored.`, t0, d0);
      this.note(`Nobody has seen a ${it.target} yet; searching unexplored rooms (${rooms.join(', ')}).`);
      await this.surveyRooms(rooms, idle, () => this.matches(it.target).length > 0); await this.syncMap();
      objs = this.matches(it.target);
      if (!objs.length) return this.done(`Searched the building but found no ${it.target}.`, t0, d0);
    }

    if (it.intent === 'meet') {
      const o = objs[0];
      this.note(`All ${T.n} robots will meet at ${o.label} ${o.id} in the ${o.room}.`);
      const res = await Promise.all(T.robots.map((rb, r) => this.run(r, `Go to the ${o.label} (${o.id}).`)));
      return this.done(`${res.filter((x) => !/^Error|could not/i.test(x)).length}/${T.n} robots reached ${o.label} ${o.id}.`, t0, d0);
    }

    if (it.intent === 'visit_all') {
      const free = this.idle(), queues = Object.fromEntries(free.map((r) => [r, []])), pos = Object.fromEntries(free.map((r) => [r, T.pose[r]]));
      for (const o of objs.slice()) {
        let best = null;
        for (const r of free) { const c = Math.hypot(o.x - pos[r].x, o.y - pos[r].y) + queues[r].length * 6; if (!best || c < best.c) best = { r, c }; }
        queues[best.r].push(o); pos[best.r] = o;
      }
      const used = free.filter((r) => queues[r].length);
      this.note(`Splitting ${objs.length} × ${it.target} across ${used.length} robot${used.length > 1 ? 's' : ''}: ${used.map((r) => `${T.robots[r].id} → ${queues[r].map((o) => o.id).join(', ')}`).join('; ')}.`);
      await Promise.all(used.map(async (r) => { for (const o of queues[r]) await this.run(r, `Go to the ${o.label} (${o.id}).`); }));
      return this.done(`Visited all ${objs.length} × ${it.target}.`, t0, d0);
    }

    // go_to: idle robot with the lowest cost = path length + recent workload
    // (so the robot that just worked doesn't win every time)
    const o = objs[0];
    const ranked = this.idle().map((r) => { const d = this.pathCost(r, o); return { r, d, c: d + 0.8 * this.load[r] }; }).sort((a, b) => a.c - b.c);
    const pick = ranked[0], nearest = ranked.slice().sort((a, b) => a.d - b.d)[0];
    const why = ranked.length < 2 ? `the only free robot (${fmt(pick.d)} m away)`
      : nearest.r === pick.r ? `closest by path (${fmt(pick.d)} m; next ${T.robots[ranked[1].r].id} at ${fmt(ranked[1].d)} m)`
        : `${fmt(pick.d)} m away; ${T.robots[nearest.r].id} is a bit closer (${fmt(nearest.d)} m) but just worked, so the load is shared`;
    this.note(`${o.label} ${o.id} is in the ${o.room}. Picked ${T.robots[pick.r].name}: ${why}.`, { r: pick.r });
    const reply = await this.run(pick.r, `Go to the ${o.label} (${o.id}).`);
    return this.done(reply, t0, d0);
  }

  async surveyRooms(rooms, robots, stop = () => false) {
    const T = this.T, todo = rooms.slice();
    await Promise.all(robots.map(async (r) => {
      while (todo.length && !stop()) {
        todo.sort((a, b) => this.pathCost(r, this.roomCenter(a)) - this.pathCost(r, this.roomCenter(b)));
        const room = todo.shift();
        this.note(`${T.robots[r].name} explores the ${room}.`, { r });
        await this.run(r, `Explore the ${room}.`);
      }
    }));
  }

  async run(r, instruction) {
    const agent = this.ui.agents[r], d0 = this.T.sims[r].distance;
    agent.busy = true;
    this._ran = this._ran || new Set(); this._ran.add(r);
    try { return await this._run(agent, instruction); } finally { this.load[r] += this.T.sims[r].distance - d0; }
  }
  async _run(agent, instruction) {
    try { return await agent.handle(`[from Dispatcher] ${instruction}`, { depth: 0, from: 'dispatcher' }); } finally { agent.busy = false; }
  }

  done(text, t0, d0) {
    const T = this.T;
    const took = Math.round(T.time - t0), drove = T.sims.reduce((a, s) => a + s.distance, 0) - d0;
    this.ui.log({ kind: 'result', text, meta: took || drove > 0.1 ? `${took} s · ${fmt(drove)} m driven` : '' });
    return text;
  }
}

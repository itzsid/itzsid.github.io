// One agent per robot. Each agent keeps a short memory, gets the team state
// (robots, rooms, the objects it knows) every turn, and decides which tools to
// use. The model is a free open LLM running in the browser (WebLLM); without
// it an offline rule-based planner drives the same tools. Concrete dispatcher
// assignments ("Go to the X (T12).", "Explore the Kitchen.") are executed
// directly in both modes, so they are fast and never loop.
import { roomAt } from './scenes.js';
import { embedText } from './embed.js';
import { fmt } from './engine.js';
import { parseTask, normalizeText } from './dispatcher.js';

const MAX_STEPS = 6;

const TOOL_TEXT = `Tools (one "action" per reply):
- search_map {query}: find objects you know by words, e.g. "red toolbox".
- navigate_to {object_id}: drive to an object, id exactly as listed (e.g. "T12", "R1.7").
- go_to_room {room}: drive to the middle of a room.
- explore_room {room}: scan a room and add its objects to your map (slow; only rooms nobody explored).
- exchange_maps: share maps with all robots and get the merged team map.
- optimize_team_map: fix drift after exchange_maps when disagreement > 0.15 m.
- ask_robot {robot, message}: ask another robot (e.g. "R2") and get its reply.
- return_to_start: drive back to your start position.
- reply {message}: final answer, 1-2 sentences with object ids and numbers.`;

const ACTION_SCHEMA = {
  type: 'object',
  properties: {
    thought: { type: 'string' },
    action: { type: 'string', enum: ['search_map', 'navigate_to', 'go_to_room', 'explore_room', 'exchange_maps', 'optimize_team_map', 'ask_robot', 'return_to_start', 'reply'] },
    object_id: { type: 'string' }, room: { type: 'string' }, query: { type: 'string' }, robot: { type: 'string' }, message: { type: 'string' },
  },
  required: ['thought', 'action'],
};

const an = (w) => (/^[aeiou]/i.test(w) ? 'an' : 'a');

export class RobotAgent {
  constructor(team, r, ui) { this.T = team; this.r = r; this.ui = ui; this.history = []; this.busy = false; }
  get robot() { return this.T.robots[this.r]; }
  roomName(s) { const t = String(s || '').toLowerCase().trim(); return this.T.scene.rooms.find((q) => q.name.toLowerCase() === t)?.name || this.T.scene.rooms.find((q) => t && (q.name.toLowerCase().includes(t) || t.includes(q.name.toLowerCase())))?.name || null; }
  roomCenter(name) {
    const T = this.T, q = T.scene.rooms.find((x) => x.name === name), c = { x: (q.x0 + q.x1) / 2, y: (q.y0 + q.y1) / 2 };
    const pts = T.scene.coverage[name] || [];
    return T.nav.isFree(c) || !pts.length ? c : pts.slice().sort((a, b) => Math.hypot(a.x - c.x, a.y - c.y) - Math.hypot(b.x - c.x, b.y - c.y))[0];
  }

  systemPrompt() {
    const T = this.T, me = this.robot;
    return `You are ${me.name} (${me.id}), one of ${T.n} wheeled robots in a ${T.scene.name.toLowerCase()}. Rooms: ${T.scene.rooms.map((q) => q.name).join(', ')}.
${T.shared ? 'Robots can merge their object maps (exchange_maps).' : 'Map sharing is OFF: you only know what you saw.'}
${TOOL_TEXT}
Rules:
1. Use the objects in <state> first. If the object is listed, navigate_to its id right away.
2. If it is not listed: exchange_maps once (if the map is not merged or has new observations), then search_map, then explore_room an unexplored room.
3. After navigate_to or go_to_room succeeds, reply. Never repeat the same action.
4. Questions: answer with reply from <state>; do not drive.
5. Messages "[from Robot X]" are from teammates: answer from what you know, or act if asked.
Reply with JSON only: {"thought": "short", "action": "...", ...arguments}.`;
  }

  // compact state for small models: objects relevant to the request first, then the nearest ones
  teamState(request = '') {
    const T = this.T, r = this.r, me = T.pose[r];
    const robots = T.robots.map((rb, i) => {
      const p = T.pose[i], job = T.jobs[i], ex = [...T.sims[i].explored];
      return `${rb.id}${i === r ? ' (you)' : ''}: ${roomAt(T.scene, p.x, p.y)}, ${job ? job.label : 'idle'}, explored ${ex.join('/') || 'nothing'}`;
    }).join('\n');
    const all = T.objectsFor(r).filter((o) => !/\bdoor\b/.test(o.label)).map((o) => ({ ...o, d: Math.hypot(o.x - me.x, o.y - me.y) })).sort((a, b) => a.d - b.d);
    const q = embedText(normalizeText(request));
    const rel = q ? all.filter((o) => { const e = embedText(o.label); return e && (!q.cat || e.cat === q.cat); }) : [];
    const shown = [...rel.slice(0, 12), ...all.filter((o) => !rel.includes(o))].slice(0, 25);
    const unexplored = T.scene.rooms.map((x) => x.name).filter((n) => !T.robots.some((_, i) => (T.shared || i === r) && T.sims[i].explored.has(n)));
    const mapLine = T.shared
      ? (T.M && T.M.joined.includes(r) ? `team map: ${T.M.joined.length}/${T.n} robots merged${T.mergedFresh() ? '' : ', new observations since'}, disagreement ${(T.optimized ? T.solverStats.map_disagreement_after_m : T.M.disInit).toFixed(2)} m` : 'team map: you are not merged yet (exchange_maps)')
      : 'map sharing off';
    return `<state>
${mapLine}; unexplored rooms: ${unexplored.join(', ') || 'none'}
${robots}
objects (${shown.length}/${all.length}): id | label | room | xy | seen by
${shown.map((o) => `${o.id} | ${o.label} | ${o.room} | ${fmt(o.x)},${fmt(o.y)} | ${o.seen_by.join('+')}`).join('\n') || '(none)'}
</state>`;
  }

  async runTool(name, input, depth) {
    const T = this.T, r = this.r;
    try {
      if (name === 'explore_room') {
        const room = this.roomName(input.room);
        if (!room) return { error: `Unknown room. Rooms: ${T.scene.rooms.map((q) => q.name).join(', ')}` };
        return await T.exploreRoom(r, room);
      }
      if (name === 'exchange_maps') return T.exchange();
      if (name === 'optimize_team_map') return await T.optimize(true);
      if (name === 'search_map') {
        const res = T.search(r, normalizeText(input.query || ''));
        return { query: input.query, results: res.map((o) => ({ id: o.id, label: o.label, room: o.room, position: [+fmt(o.x), +fmt(o.y)], seen_by: o.seen_by })) };
      }
      if (name === 'ask_robot') {
        const t = T.robotIndex(String(input.robot || '').replace(/[^0-9rRobt ]/g, ''));
        if (t < 0) return { error: `Unknown robot ${input.robot}. Robots: ${T.robots.map((q) => q.id).join(', ')}` };
        if (t === r) return { error: 'That is you.' };
        if (depth >= 1) return { error: 'Robots can only relay one level deep in this demo.' };
        const other = this.ui.agents[t];
        if (other.busy || T.jobs[t]) return { error: `${T.robots[t].name} is busy.` };
        other.busy = true;
        try { return { reply: await other.handle(`[from ${this.robot.name}] ${input.message || 'What have you seen?'}`, { depth: depth + 1, from: r }) }; } finally { other.busy = false; }
      }
      if (name === 'navigate_to') {
        const mine = T.objectsFor(r);
        let o = mine.find((q) => q.id === String(input.object_id || '').trim());
        // ids can change after a new map exchange: fall back to the same label near the given spot
        if (!o && input.x != null) {
          const e = embedText(input.label || '');
          o = mine.filter((q) => { const f = embedText(q.label); return (!e || (f && f.cat === e.cat)) && Math.hypot(q.x - input.x, q.y - input.y) < 1.5; })
            .sort((a, b) => Math.hypot(a.x - input.x, a.y - input.y) - Math.hypot(b.x - input.x, b.y - input.y))[0];
        }
        if (!o) return { error: `Unknown object id ${input.object_id}. Use an id from the state or search_map.` };
        return { object: `${o.label} ${o.id}`, room: o.room, ...(await T.goTo(r, { x: o.x, y: o.y, gt: o._gt }, `${o.label} ${o.id}`)) };
      }
      if (name === 'go_to_room') {
        const room = this.roomName(input.room);
        if (!room) return { error: `Unknown room. Rooms: ${T.scene.rooms.map((q) => q.name).join(', ')}` };
        const p = T.pose[r];
        if (roomAt(T.scene, p.x, p.y) === room) return { arrived: true, already_there: true, driven_m: 0, now_in: room };
        return await T.goTo(r, this.roomCenter(room), `the ${room}`);
      }
      if (name === 'go_to_robot') {
        const t = T.robotIndex(input.robot);
        if (t < 0 || t === r) return { error: `Unknown teammate ${input.robot}.` };
        return { robot: T.robots[t].id, ...(await T.goTo(r, { x: T.pose[t].x, y: T.pose[t].y }, T.robots[t].name)) };
      }
      if (name === 'return_to_start') {
        const s = this.robot.start, p = T.pose[r];
        if (Math.hypot(p.x - s.x, p.y - s.y) < 0.5) return { arrived: true, already_there: true, driven_m: 0 };
        return await T.goTo(r, { x: s.x, y: s.y }, 'start position');
      }
      return { error: `Unknown tool ${name}` };
    } catch (e) { return { error: e.message }; }
  }

  async handle(text, { depth = 0, from = null } = {}) {
    this.ui.log({ kind: 'user', r: this.r, text, from, depth });
    try {
      const body = text.replace(/^\[from (robot \d+|dispatcher)\]\s*/i, '');
      const direct = from === 'dispatcher' ? await this.assignment(body, depth) : null;
      const reply = direct ?? (this.ui.llm?.ready ? await this.llmTurn(text, depth) : await this.offlineTurn(text, depth, from));
      this.ui.log({ kind: 'reply', r: this.r, text: reply, depth });
      return reply;
    } catch (e) {
      const msg = `Error: ${e.message}`; this.ui.log({ kind: 'error', r: this.r, text: msg, depth }); return msg;
    }
  }

  async call(name, input, depth, thought) {
    this.ui.log({ kind: 'tool', r: this.r, name, input, depth, thought });
    const out = await this.runTool(name, input, depth);
    this.ui.log({ kind: 'tool-result', r: this.r, name, output: out, depth });
    return out;
  }

  // ---------- concrete dispatcher assignments (both modes). Returns null if not one.
  async assignment(body, depth) {
    const t = body.trim();
    let m = t.match(/^go to the (.+?) \(((?:T\d+)|(?:R\d+\.\d+))\)(?: at \((-?[\d.]+), (-?[\d.]+)\))?/i);
    if (m) {
      // the position hint is non-enumerable: used if the id changed, but not shown in the feed
      const input = { object_id: m[2] };
      if (m[3]) Object.defineProperties(input, { x: { value: +m[3] }, y: { value: +m[4] }, label: { value: m[1] } });
      const nav = await this.call('navigate_to', input, depth, 'Dispatcher assignment');
      if (nav.error) return `Could not go to the ${m[1]}: ${nav.error}`;
      return `Reached the ${nav.object} in the ${nav.room}: drove ${nav.driven_m} m, now ${nav.distance_to_real_object_m ?? '?'} m from it.`;
    }
    m = t.match(/^explore the (.+?)\.?$/i);
    if (m && this.roomName(m[1])) {
      const o = await this.call('explore_room', { room: this.roomName(m[1]) }, depth, 'Dispatcher assignment');
      return o.error ? `Could not explore: ${o.error}` : `Explored the ${o.room}: ${o.new_objects} new objects (${o.objects_in_my_map} in my map), ${o.driven_m} m.`;
    }
    m = t.match(/^go to the (.+?)\.?$/i);
    if (m && this.roomName(m[1]) && this.roomName(m[1]).toLowerCase() === m[1].toLowerCase()) {
      const o = await this.call('go_to_room', { room: m[1] }, depth, 'Dispatcher assignment');
      return o.error ? `Could not go there: ${o.error}` : o.already_there ? `Already in the ${o.now_in}.` : `Reached the ${this.roomName(m[1])} after ${o.driven_m} m.`;
    }
    if (/^return to (your )?start/i.test(t)) {
      const o = await this.call('return_to_start', {}, depth, 'Dispatcher assignment');
      return o.error ? `Could not return: ${o.error}` : o.already_there ? 'Back at my start position (already there).' : `Back at my start position after ${o.driven_m} m.`;
    }
    m = t.match(/^drive to robot (\d+)/i);
    if (m) {
      const o = await this.call('go_to_robot', { robot: `R${m[1]}` }, depth, 'Dispatcher assignment');
      return o.error ? `Could not reach Robot ${m[1]}: ${o.error}` : `Reached Robot ${m[1]} after ${o.driven_m} m.`;
    }
    return null;
  }

  // ---------- LLM agent loop (free in-browser model, schema-constrained JSON)
  async llmTurn(text, depth) {
    const llm = this.ui.llm;
    this.history = this.history.slice(-4);
    const msgs = [{ role: 'system', content: this.systemPrompt() }, ...this.history, { role: 'user', content: `${this.teamState(text)}\nRequest: ${text}` }];
    const seen = new Set();
    let last = null, errors = 0;
    const finish = (reply) => { this.history.push({ role: 'user', content: `Request: ${text}` }, { role: 'assistant', content: reply }); return reply; };
    for (let step = 0; step < MAX_STEPS; step++) {
      this.ui.log({ kind: 'thinking', r: this.r, depth });
      let act;
      try { act = await llm.json(msgs, ACTION_SCHEMA, 200); } finally { this.ui.log({ kind: 'thinking-done', r: this.r, depth }); }
      if (!act || typeof act !== 'object') act = { action: 'reply', message: '' };
      if (!act.action || act.action === 'reply') return finish((act.message || act.thought || this.summarize(last) || 'Done.').trim());
      const input = {
        explore_room: { room: act.room }, go_to_room: { room: act.room }, search_map: { query: act.query || act.message || text },
        ask_robot: { robot: act.robot, message: act.message || text }, navigate_to: { object_id: act.object_id || act.query },
      }[act.action] || {};
      const sig = act.action + JSON.stringify(input);
      if (seen.has(sig)) return finish(this.summarize(last) || 'I could not make progress on that.');   // never loop
      seen.add(sig);
      const out = await this.call(act.action, input, depth, act.thought);
      last = { name: act.action, out };
      errors = out.error ? errors + 1 : 0;
      if (errors >= 2) return finish(`I could not finish: ${out.error}`);
      if (!out.error && ['navigate_to', 'go_to_room', 'return_to_start'].includes(act.action) && !/\b(and|then|after)\b/i.test(text)) return finish(this.summarize(last));
      const refresh = ['explore_room', 'exchange_maps', 'optimize_team_map'].includes(act.action) && !out.error;
      msgs.push({ role: 'assistant', content: JSON.stringify(act) });
      msgs.push({ role: 'user', content: `Result of ${act.action}: ${JSON.stringify(out).slice(0, 700)}${refresh ? `\n${this.teamState(text)}` : ''}\nNext action (JSON)?` });
    }
    return finish(this.summarize(last) || `I stopped after ${MAX_STEPS} steps.`);
  }

  summarize(last) {
    if (!last) return '';
    const { name, out: o } = last;
    if (o.error) return `Could not finish: ${o.error}`;
    if (name === 'navigate_to') return `Reached the ${o.object} in the ${o.room} after ${o.driven_m} m (${o.distance_to_real_object_m} m from it).`;
    if (name === 'go_to_room') return o.already_there ? `Already in the ${o.now_in}.` : `Reached the ${o.now_in} after ${o.driven_m} m.`;
    if (name === 'return_to_start') return `Back at my start position after ${o.driven_m} m.`;
    if (name === 'explore_room') return `Explored the ${o.room}: ${o.new_objects} new objects.`;
    if (name === 'search_map') return o.results.length ? `Found ${o.results.slice(0, 4).map((x) => `${x.label} ${x.id} (${x.room})`).join(', ')}.` : `No ${o.query} in my map.`;
    if (name === 'exchange_maps') return `Merged maps from ${o.robots_merged.length} robots.`;
    if (name === 'ask_robot') return o.reply;
    return '';
  }

  // ---------- Offline planner: rule-based use of the same tools
  async offlineTurn(text, depth, from) {
    const T = this.T, r = this.r, body = text.replace(/^\[from (robot \d+|dispatcher)\]\s*/i, '');
    const t = body.toLowerCase();
    const call = (n, i = {}) => this.call(n, i, depth);
    const it = parseTask(T.scene, T.n, body);
    const q = it.target, roomIn = it.room;
    const idMatch = body.match(/\b(T\d+|R\d+\.\d+)\b/);
    if (idMatch && /\b(go|drive|navigate|visit|head)\b/.test(t)) {
      const nav = await call('navigate_to', { object_id: idMatch[1] });
      return nav.error || `Reached the ${nav.object} after ${nav.driven_m} m (${nav.distance_to_real_object_m} m from it).`;
    }
    const ensureTeamMap = async () => {
      if (!T.shared) return;
      if (!T.M || !T.mergedFresh()) await call('exchange_maps');
      if (T.M && !T.optimized && T.M.disInit > 0.15) await call('optimize_team_map');
    };
    const matches = (o) => { const e = embedText(o.label); return e && q && (!q.cat || e.cat === q.cat) && (!q.col || e.col === q.col) && (!it.objRoom || o.room === it.objRoom); };
    const findKnown = () => {
      if (!q) return [];
      const me = T.pose[r];
      return T.objectsFor(r).filter(matches).sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y));
    };
    const what = q ? `${an(q.text)} ${q.text}` : 'that';
    const exploreFor = async (found) => {
      for (let guard = 0; guard < T.scene.rooms.length && !found(); guard++) {
        const todo = T.scene.rooms.map((x) => x.name).filter((n) => !T.robots.some((_, i) => (T.shared || i === r) && T.sims[i].explored.has(n)) && (!it.objRoom || n === it.objRoom));
        if (!todo.length) return false;
        const p = T.pose[r]; const c = (n) => { const x = this.roomCenter(n); return T.nav.plan(p, x)?.length ?? 1e9; };
        todo.sort((a, b) => c(a) - c(b));
        await call('explore_room', { room: todo[0] }); if (T.shared) await call('exchange_maps');
      }
      return found();
    };

    // a question from another robot: answer from my own observations
    const question = /^(what|where|which|is|are|do|did|have|has|how|can|tell)\b/.test(t.trim()) || /\?\s*$/.test(t);
    if (((from != null && from !== 'dispatcher') || question) && !/\b(go|drive|come|navigate|meet|explore|head)\b/.test(t)) {
      const mine = findKnown().filter((o) => o.seen_by.includes(this.robot.id));
      if (roomIn && !q) { const os = T.objectsFor(r).filter((o) => o.room === roomIn && o.seen_by.includes(this.robot.id) && !/door/.test(o.label)); return os.length ? `In the ${roomIn} I saw: ${[...new Set(os.map((o) => o.label))].slice(0, 8).join(', ')}.` : `I have not seen the ${roomIn}.`; }
      if (!q) { const ex = [...T.sims[r].explored]; return `I explored ${ex.join(', ') || 'nothing yet'} and have ${Object.keys(T.local(r).lms).length} objects in my own map.`; }
      if (!mine.length) return `I have not seen ${what}.`;
      return `Yes: ${mine.slice(0, 3).map((o) => `${o.label} ${o.id} in the ${o.room}`).join('; ')}.`;
    }
    if (it.intent === 'unsupported') return 'I can drive, explore and map, but I have no arms.';
    if (it.intent === 'explore' && (it.rooms[0] || roomIn)) { const o = await call('explore_room', { room: it.rooms[0] || roomIn }); return o.error || `Explored the ${o.room}: ${o.new_objects} new objects (${o.objects_in_my_map} in my map).`; }
    if (it.intent === 'explore') { const ok = await exploreFor(() => false); return ok ? 'Done.' : `Explored what was left; I know ${T.objectsFor(r).length} objects now.`; }
    if (it.intent === 'return') { const o = await call('return_to_start'); return o.error || (o.already_there ? 'I am already at my start position.' : `Back at my start position after ${o.driven_m} m.`); }
    if (it.intent === 'go_room') { const o = await call('go_to_room', { room: roomIn }); return o.error || (o.already_there ? `Already in the ${roomIn}.` : `Reached the ${roomIn} after ${o.driven_m} m.`); }
    if (/\b(merge|exchange|share|sync)\b/.test(t) && !q) { const o = await call('exchange_maps'); return o.error || `Merged ${o.robots_merged.length}/${T.n} robots: ${o.verified_matches} object matches, ${o.robot_encounters_used} encounters.`; }
    if (/optimi[sz]/.test(t) && !q) { if (!T.M) await call('exchange_maps'); const o = await call('optimize_team_map'); return o.error || `Optimized: disagreement ${o.map_disagreement_before_m} -> ${o.map_disagreement_after_m} m.`; }
    const askM = body.match(/\bask\s+(robot\s*\d+|r\d+)\s*(.*)$/i);
    if (askM) {
      const t2 = T.robotIndex(askM[1]);
      const o = await call('ask_robot', { robot: askM[1], message: askM[2].replace(/^(to|if|whether)\s+/i, '') || 'What have you seen?' });
      return o.error || `${T.robots[t2]?.name || askM[1]} says: ${o.reply}`;
    }
    if (it.intent === 'room_contents' && roomIn) {
      await ensureTeamMap();
      const os = T.objectsFor(r).filter((o) => o.room === roomIn && !/door/.test(o.label));
      return os.length ? `In the ${roomIn} I know: ${[...new Set(os.map((o) => o.label))].slice(0, 10).join(', ')}.` : `Nobody I know of has mapped the ${roomIn}.`;
    }
    if (it.intent === 'status') { const p = T.pose[r]; return `I'm in the ${roomAt(T.scene, p.x, p.y)}, ${T.jobs[r] ? T.jobs[r].label : 'idle'}; explored ${[...T.sims[r].explored].join(', ') || 'nothing yet'}.`; }
    if (!q) return `I can go to objects or rooms, explore rooms, list or count objects, and return to start. For example: "go to the plant", "explore the ${T.scene.rooms[0].name}", "how many chairs?".`;
    if (it.intent === 'list' || it.intent === 'count') {
      await ensureTeamMap();
      const list = findKnown();
      const seenRooms = new Set(T.robots.flatMap((_, i) => (T.shared || i === r ? [...T.sims[i].explored] : [])));
      const missing = T.scene.rooms.map((x) => x.name).filter((n) => !seenRooms.has(n));
      return `I know ${list.length} × ${q.text}: ${list.slice(0, 10).map((o) => `${o.id} (${o.room})`).join(', ') || 'none'}.${missing.length ? ` Not yet explored: ${missing.join(', ')}.` : ''}`;
    }
    await ensureTeamMap();
    if (!findKnown().length) await exploreFor(() => findKnown().length > 0);
    const targets = findKnown();
    if (!targets.length) return `I could not find ${what}.`;
    if (it.intent === 'answer') { const o = targets[0]; return `${o.label} ${o.id} is in the ${o.room} at (${fmt(o.x)}, ${fmt(o.y)}), seen by ${o.seen_by.join('+')}.`; }
    if (it.intent === 'visit_all') {
      let n = 0; for (const o of targets) { const nav = await call('navigate_to', { object_id: o.id }); if (!nav.error) n++; }
      return `Visited ${n}/${targets.length} × ${q.text}.`;
    }
    const target = targets[0];
    const goOthers = it.intent === 'meet' && depth === 0;
    const mine = call('navigate_to', { object_id: target.id });
    const others = goOthers ? T.robots.map((_, k) => (k === r || this.ui.agents[k].busy ? null : this.runTool('ask_robot', { robot: T.robots[k].id, message: `Please go to the ${target.label} in the ${target.room}.` }, depth))).filter(Boolean) : [];
    const [nav] = await Promise.all([mine, ...others]);
    if (nav.error) return nav.error;
    return `${goOthers ? 'Asked the team to meet me. ' : ''}Reached the ${target.label} ${target.id} in the ${target.room}: drove ${nav.driven_m} m, now ${nav.distance_to_real_object_m} m from it.`;
  }
}

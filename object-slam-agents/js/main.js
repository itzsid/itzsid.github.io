import { SceneView } from './scene.js';
import { Team } from './engine.js';
import { SCENES } from './scenes.js';
import { TASKS, priorExploration, makeTask, runTask, compare } from './tasks.js';
import { RobotAgent } from './agents.js';
import { Dispatcher } from './dispatcher.js';
import { LocalLLM, MODELS, webgpuAvailable } from './llm.js';
import { BYTES } from './team.js';

const $ = (s) => document.querySelector(s);
const view = new SceneView($('#stage'));
const llm = new LocalLLM();
const ui = { agents: [], llm, log: (e) => addLog(e) };
let team = null, speed = 6, seed = 7, worldBusy = false, dirtyLinks = true, dispatcher = null, taskRunning = false;

// ---------- world setup
$('#scene').innerHTML = SCENES.map((s, i) => `<option value="${i}">${s.name}</option>`).join('');
$('#task').innerHTML = TASKS.map((t) => `<option value="${t.id}">${t.name}</option>`).join('');
$('#nrob').oninput = () => { $('#nval').textContent = $('#nrob').value; };
const setWorldStatus = (t) => { $('#world-status').innerHTML = t; };

async function buildWorld({ shared = true, prior = $('#prior').checked } = {}) {
  const def = SCENES[+$('#scene').value], n = +$('#nrob').value;
  worldBusy = true;
  setWorldStatus(`<span class="spin">Building ${def.name.toLowerCase()} with ${n} robot${n > 1 ? 's' : ''}</span>`);
  await new Promise((r) => setTimeout(r, 20));
  const T = new Team(def, n, seed, { shared });
  if (prior) await T.runHeadless(priorExploration);
  T.animated = true;
  team = T;
  T.on((ev) => {
    if (ev.type === 'navplan') view.setNavPath(ev.r, ev.points, T.robots[ev.r].color);
    if (ev.type === 'jobdone') { const r = ev.r; setTimeout(() => { if (!T.jobs[r] && T === team) view.setNavPath(r, null); }, 1500); }
    if (['merged', 'optimized', 'jobdone'].includes(ev.type)) { dirtyLinks = true; refreshMapKpis(); }
  });
  view.load(T);
  ui.agents = T.robots.map((_, r) => new RobotAgent(T, r, ui));
  dispatcher = new Dispatcher(T, ui);
  renderChips(); refreshMapKpis(); $('#log').innerHTML = '';
  const objs = T.robots.reduce((a, _, r) => a + Object.keys(T.local(r).lms).length, 0);
  setWorldStatus(`${def.name}: ${def.rooms.length} rooms, ${T.scene.objects.filter((o) => o.cat !== 'door').length} objects, ${n} robot${n > 1 ? 's' : ''}. ${prior ? 'Each robot starts knowing only its own rooms; maps are merged when a task needs it.' : 'Robots start with empty maps.'}`);
  worldBusy = false; dirtyLinks = true;
  return T;
}
$('#b-apply').onclick = () => !worldBusy && buildWorld();
$('#b-seed').onclick = () => { if (worldBusy) return; seed = Math.floor(Math.random() * 1e6); buildWorld(); };
$('#scene').onchange = () => !worldBusy && buildWorld();
$('#nrob').onchange = () => !worldBusy && buildWorld();
document.querySelectorAll('#speed button').forEach((b) => (b.onclick = () => { speed = +b.dataset.s; document.querySelectorAll('#speed button').forEach((x) => x.classList.toggle('on', x === b)); }));
document.querySelectorAll('[data-layer]').forEach((c) => (c.onchange = () => view.setLayer(c.dataset.layer, c.checked)));

// ---------- experiment
const taskBlurb = () => { $('#task-text').textContent = TASKS.find((t) => t.id === $('#task').value).blurb; };
$('#task').onchange = taskBlurb; taskBlurb();
const kb = (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1024 ? `${(b / 1024).toFixed(0)} KB` : `${b} B`);
let lastCmp = null;
$('#b-compare').onclick = async () => {
  if (worldBusy) return;
  const btn = $('#b-compare'); btn.disabled = true; btn.classList.add('spin'); btn.textContent = 'Running both teams';
  $('#cmp').innerHTML = '';
  await new Promise((r) => setTimeout(r, 30));
  try {
    const def = SCENES[+$('#scene').value], n = +$('#nrob').value, kind = $('#task').value;
    const c = await compare(Team, def, n, seed, kind);
    lastCmp = { c, def, n, kind, seed };
    renderCompare(c);
  } catch (e) { $('#cmp').innerHTML = `<div class="msg err">${e.message}</div>`; }
  btn.disabled = false; btn.classList.remove('spin'); btn.textContent = 'Run comparison';
};
function renderCompare(c) {
  const S = c.results.shared, I = c.results.independent;
  const rows = [
    ['Task done', S.success ? '✓' : `✗ (${Math.round(S.score * 100)}%)`, I.success ? '✓' : `✗ (${Math.round(I.score * 100)}%)`, (S.score > I.score) - (S.score < I.score)],
    ['Time to finish', `${S.time_s} s`, `${I.time_s} s`, Math.sign(I.time_s - S.time_s)],
    ['Distance driven (all)', `${S.distance_m} m`, `${I.distance_m} m`, Math.sign(I.distance_m - S.distance_m)],
    ['Data sent', kb(S.bytes), kb(I.bytes), 0],
  ];
  const speedup = S.time_s > 0 ? I.time_s / S.time_s : Infinity;
  const head = S.score >= I.score && I.time_s > S.time_s * 1.15
    ? `<div class="headline">With the shared map the team finished <b>${Number.isFinite(speedup) ? speedup.toFixed(1) + '× faster' : 'immediately'}</b>${I.distance_m > S.distance_m ? ` and drove <b>${(I.distance_m / Math.max(1, S.distance_m)).toFixed(1)}× less</b>` : ''}.</div>`
    : S.score > I.score ? `<div class="headline">Only the shared-map team completed the task.</div>`
      : `<div class="headline meh">Here sharing did not pay off: the robots already knew what they needed, and merging maps costs time and data.</div>`;
  const cell = (v, w, side) => `<td class="${w === side ? 'win' : ''}">${v}</td>`;
  $('#cmp').innerHTML = `<div class="cmp"><p class="task-text"><b>${c.task.text}</b></p>${head}
    <table><thead><tr><th></th><th>Shared map</th><th>Each alone</th></tr></thead><tbody>
    ${rows.map(([n, a, b, w]) => `<tr><td>${n}</td>${cell(a, w, 1)}${cell(b, w, -1)}</tr>`).join('')}
    </tbody></table>
    <div class="watch"><button class="btn" id="w-s">Watch shared team</button><button class="btn" id="w-i">Watch robots alone</button></div>
    <div class="runlog" id="runlog">${S.logs.map((l) => `shared  ${l}`).join('\n')}\n${I.logs.map((l) => `alone   ${l}`).join('\n')}</div></div>`;
  $('#w-s').onclick = () => watch(true); $('#w-i').onclick = () => watch(false);
}
async function watch(shared) {
  if (!lastCmp || worldBusy) return;
  $('#scene').value = SCENES.indexOf(lastCmp.def); $('#nrob').value = lastCmp.n; $('#nval').textContent = lastCmp.n; $('#task').value = lastCmp.kind; seed = lastCmp.seed;
  const T = await buildWorld({ shared, prior: true });
  const task = { ...lastCmp.c.task, target: lastCmp.c.task.target && T.scene.objects.find((o) => o.id === lastCmp.c.task.target.id) };
  const lines = [];
  const rl = () => { const el = $('#runlog'); if (el) { el.textContent = `${shared ? 'shared' : 'alone'} (live)\n` + lines.join('\n'); el.scrollTop = el.scrollHeight; } };
  setWorldStatus(`Watching: <b>${shared ? 'shared map' : 'robots alone'}</b> — ${task.text}`);
  const res = await runTask(T, task, (m) => { lines.push(m); rl(); });
  lines.push(`done: ${res.success ? 'success' : 'incomplete'} in ${res.time_s} s, ${res.distance_m} m driven`); rl();
}

// ---------- status strip
function refreshMapKpis() {
  const T = team; if (!T) return;
  const ate = T.M ? T.teamAte() : T.pooledLocalAte();
  const dis = T.M ? (T.optimized ? T.solverStats.map_disagreement_after_m : T.M.disInit) : null;
  const busy = Object.keys(T.jobs).length;
  $('#stats').innerHTML = [
    `<span><b>${T.n}</b> robot${T.n > 1 ? 's' : ''}${busy ? ` · <b>${busy}</b> moving` : ''}</span>`,
    `<span>maps merged <b>${T.shared ? (T.M ? `${T.M.joined.length}/${T.n}` : `0/${T.n}`) : 'off'}</b></span>`,
    dis != null ? `<span>disagreement <b>${dis.toFixed(2)} m</b></span>` : '',
    ate != null ? `<span>error vs truth <b>${ate.toFixed(2)} m</b></span>` : '',
    `<span>data sent <b>${kb(T.bytes.objects + T.bytes.dgs)}</b></span>`,
  ].filter(Boolean).join('');
}

// ---------- model
$('#model').innerHTML = MODELS.map((m, i) => `<option value="${i}">${m.name} (${m.note.split(' · ')[0].replace('~', '')})</option>`).join('');
function renderModelNote() {
  const n = $('#model-note');
  if (!webgpuAvailable()) { n.innerHTML = 'This browser has no WebGPU, so robots use the built-in <b>offline planner</b> (same tools, simple rules). Try recent Chrome/Edge or Safari 26 for the free LLM.'; $('#b-load').disabled = true; return; }
  n.innerHTML = llm.ready ? `Agents run <b>${MODELS.find((m) => m.id === llm.modelId).name}</b> on your GPU. Free, private, nothing leaves your browser.`
    : 'Agents use the <b>offline planner</b> until you load a free open model. It runs on your GPU; the download (~1–4 GB) happens once and is cached.';
}
renderModelNote();
$('#b-load').onclick = async () => {
  const m = MODELS[+$('#model').value];
  $('#b-load').disabled = true; $('#prog').hidden = false;
  try {
    await llm.load(m.id, (r) => { $('#prog-bar').style.width = `${Math.round((r.progress || 0) * 100)}%`; $('#model-note').textContent = r.text || 'Loading…'; });
    $('#b-load').textContent = 'Loaded';
  } catch (e) { $('#model-note').textContent = `Could not load the model: ${e.message}`; $('#b-load').disabled = false; }
  $('#prog').hidden = true; if (llm.ready) renderModelNote();
};

// ---------- tasks
function renderChips() {
  const T = team; if (!T) return;
  const pick = (k) => { try { return makeTask(T, k); } catch { return null; } };
  const f = pick('fetch'), inv = pick('inventory');
  const unexplored = T.scene.rooms.find((q) => !T.robots.some((_, i) => T.sims[i].explored.has(q.name)))?.name;
  const chips = [f && `Bring a robot to the ${f.query}`, inv && `Visit every ${inv.cat}`, f && T.n > 1 && `Everyone meet at the ${f.query}`,
    inv && `Where are the ${inv.cat}s?`, unexplored ? `Explore the ${unexplored}` : `What is in the ${T.scene.rooms[T.scene.rooms.length - 1].name}?`].filter(Boolean);
  $('#chips').innerHTML = chips.map((c) => `<button type="button">${c}</button>`).join('');
  $('#chips').querySelectorAll('button').forEach((b) => (b.onclick = () => send(b.textContent)));
}
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
let typingEl = null;
function addLog(e) {
  const T = team, log = $('#log');
  const rb = e.r != null && e.r !== 'dispatcher' ? T.robots[e.r] : null;
  const dot = (r) => `<span class="dot" style="background:${T.robots[r].css}"></span>`;
  const put = (el) => { log.append(el); log.scrollTop = log.scrollHeight; return el; };
  const div = (cls, html) => { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; return put(d); };
  if (e.kind !== 'thinking') { typingEl?.remove(); typingEl = null; }
  switch (e.kind) {
    case 'task': div('f-task', esc(e.text)); break;
    case 'dispatch': div('f-disp', esc(e.text)); break;
    case 'result': div('f-result', `${esc(e.text)}${e.meta ? `<small>${e.meta}</small>` : ''}`); break;
    case 'thinking': typingEl?.remove(); typingEl = div('f-say typing', `${dot(e.r)}${rb.name} is thinking`); break;
    case 'thinking-done': break;
    case 'user':
      if (e.from === 'dispatcher' || e.from == null) break;
      div('f-peer', `<b>${T.robots[e.from].name} → ${rb.name}:</b> ${esc(e.text.replace(/^\[from Robot \d+\]\s*/, ''))}`); break;
    case 'tool': {
      const d = document.createElement('details'); d.className = 'f-step'; d.dataset.pending = '1'; d.dataset.r = e.r; d.dataset.name = e.name;
      const args = e.input && Object.values(e.input).filter(Boolean).join(', ');
      d.innerHTML = `<summary>${dot(e.r)}<b style="color:${rb.css}">${rb.id}</b> ${e.name.replace(/_/g, ' ')}${args ? ` <span style="color:var(--mute)">${esc(args)}</span>` : ''} <span class="res"></span></summary>`;
      put(d); break;
    }
    case 'tool-result': {
      const pend = [...log.querySelectorAll('details.f-step[data-pending]')].reverse().find((x) => x.dataset.r === String(e.r) && x.dataset.name === e.name);
      if (pend) { delete pend.dataset.pending; const o = e.output || {}; pend.querySelector('.res').textContent = o.error ? `⚠ ${o.error}` : summarize(e.name, o); pend.insertAdjacentHTML('beforeend', `<pre>${esc(JSON.stringify(o, null, 1))}</pre>`); }
      break;
    }
    case 'reply': if (e.depth) div('f-say', `${dot(e.r)}${esc(e.text)}`); break;
    case 'error': div('f-err', esc(e.text)); break;
  }
}
function summarize(name, o) {
  if (name === 'explore_room') return `→ +${o.new_objects} objects`;
  if (name === 'exchange_maps') return `→ ${o.robots_merged?.length} merged`;
  if (name === 'optimize_team_map') return `→ ${o.map_disagreement_after_m} m`;
  if (name === 'search_map') return `→ ${o.results?.length ?? 0} found`;
  if (name === 'navigate_to') return `→ ${o.distance_to_real_object_m} m from object`;
  if (name === 'ask_robot') return '→ replied';
  return '';
}
async function send(text) {
  text = text.trim(); if (!text || !team || taskRunning) return;
  $('#q').value = ''; taskRunning = true; $('#ask .go').disabled = true;
  try { await dispatcher.handle(text); } catch (e) { addLog({ kind: 'error', text: e.message }); }
  finally { taskRunning = false; $('#ask .go').disabled = false; refreshMapKpis(); renderChips(); }
}
$('#ask').onsubmit = (e) => { e.preventDefault(); send($('#q').value); };

// ---------- render loop
let last = performance.now(), lastSlow = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  const T = team;
  if (T) {
    if (T.busy()) T.tick(dt * speed);
    T.robots.forEach((rb, r) => view.setRobotPose(r, T.pose[r]));
    if (now - lastSlow > 120) {
      lastSlow = now;
      T.robots.forEach((rb, r) => {
        const v = T.liveView(r);
        view.setTrail(r, v.poses, T.sims[r].gt, false);
        view.setLandmarks(r, v.lms, rb.color);
      });
      if (dirtyLinks || T.optJob) {
        dirtyLinks = false;
        const links = [];
        if (T.M) {
          const views = T.robots.map((_, r) => T.liveView(r));
          for (const L of T.M.links) { const a = views[L.ra].lms[L.objA], b = views[L.rb].lms[L.objB]; if (a && b) links.push({ a, b, kind: 'obj' }); }
          for (const e of T.M.encounters) { const a = views[e.ra].poses[e.ka], b = views[e.rb].poses[e.kb]; if (a && b) links.push({ a, b, kind: 'enc' }); }
        }
        view.setLinks(links.slice(0, 400));
        refreshMapKpis();
      }
    }
  }
  view.render(now);
  requestAnimationFrame(frame);
}
buildWorld().then(() => requestAnimationFrame(frame));
window.__ui = { get team() { return team; }, ui, send };

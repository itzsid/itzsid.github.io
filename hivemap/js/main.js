import { SceneView } from './scene.js';
import { Team } from './engine.js';
import { SCENES, roomAt } from './scenes.js';
import { TASKS, priorExploration, makeTask, runTask, compare } from './tasks.js';
import { RobotAgent } from './agents.js';
import { Dispatcher } from './dispatcher.js';
import { LocalLLM, MODELS, webgpuAvailable } from './llm.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const view = new SceneView($('#stage'));
const llm = new LocalLLM();
const ui = { agents: [], llm, log: (e) => addLog(e) };
let team = null, speed = 6, paused = false, seed = 7, sceneIdx = Math.max(0, SCENES.findIndex((d) => d.id === 'hospital')), taskKind = 'fetch';   // default: hospital wing, 10 robots
let worldBusy = false, dirtyLinks = true, dispatcher = null, taskRunning = false, lastCmp = null, worldId = 0;
const kb = (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clock = (t) => { t = Math.max(0, Math.round(t || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
const store = {
  get(k) { try { return localStorage.getItem(`hivemap.${k}`); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(`hivemap.${k}`, v); } catch { /* private mode */ } },
};
const isMobile = () => window.innerWidth <= 860;
const tick = () => new Promise((r) => setTimeout(r, 20));

// ---------- layout: keep the building centred in the area the dock leaves free
const dock = $('#dock');
function applyInsets() {
  if (isMobile()) {
    const h = dock.dataset.sheet === 'full' ? window.innerHeight * 0.5 : dock.getBoundingClientRect().height;
    view.setInsets({ bottom: Math.round(Math.min(h, window.innerHeight * 0.6)), top: 56 });
  } else view.setInsets({ left: 412, top: 64 });
}
window.addEventListener('resize', () => { applyInsets(); placePop(); });

// ---------- mobile bottom sheet: tap the handle to toggle, or drag it
const SHEETS = ['peek', 'half', 'full'];
function setSheet(s) {
  dock.dataset.sheet = s;
  $('#handle').setAttribute('aria-expanded', String(s !== 'peek'));
  dock.style.height = '';
  setTimeout(applyInsets, 260);
}
{
  const h = $('#handle'); let y0 = null, h0 = 0, moved = false;
  h.addEventListener('pointerdown', (e) => { if (!isMobile()) return; y0 = e.clientY; h0 = dock.getBoundingClientRect().height; moved = false; h.setPointerCapture(e.pointerId); dock.classList.add('dragging'); });
  h.addEventListener('pointermove', (e) => {
    if (y0 == null) return; const dy = e.clientY - y0; if (Math.abs(dy) > 4) moved = true;
    dock.style.height = `${Math.max(120, Math.min(window.innerHeight * 0.9, h0 - dy))}px`;
  });
  const end = (e) => {
    if (y0 == null) return; dock.classList.remove('dragging');
    const hNow = dock.getBoundingClientRect().height, vh = window.innerHeight; y0 = null;
    if (!moved) { setSheet(dock.dataset.sheet === 'peek' ? 'half' : 'peek'); return; }
    const snaps = { peek: 0, half: vh * 0.58, full: vh * 0.86 };
    const peekH = parseFloat(getComputedStyle(dock).getPropertyValue('--peek')) || 196; snaps.peek = peekH;
    setSheet(Object.entries(snaps).sort((a, b) => Math.abs(a[1] - hNow) - Math.abs(b[1] - hNow))[0][0]);
    e.preventDefault();
  };
  h.addEventListener('pointerup', end); h.addEventListener('pointercancel', end);
  h.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') { setSheet(SHEETS[Math.min(2, SHEETS.indexOf(dock.dataset.sheet) + 1)]); e.preventDefault(); }
    if (e.key === 'ArrowDown') { setSheet(SHEETS[Math.max(0, SHEETS.indexOf(dock.dataset.sheet) - 1)]); e.preventDefault(); }
    if (e.key === 'Enter' || e.key === ' ') { setSheet(dock.dataset.sheet === 'peek' ? 'half' : 'peek'); e.preventDefault(); }
  });
}
$('#q').addEventListener('focus', () => { if (isMobile() && dock.dataset.sheet === 'peek') setSheet('half'); });

// ---------- drawers (Esc closes, focus returns to the opener)
const scrim = $('#scrim');
let opener = null;
function openDrawer(id) {
  closePop(); opener = document.activeElement;
  $$('.drawer').forEach((d) => (d.hidden = d.id !== id)); scrim.hidden = false;
  const d = $(`#${id}`); requestAnimationFrame(() => ($('[data-close]', d) || d).focus());
}
function closeDrawers() {
  const wasOpen = $$('.drawer').some((d) => !d.hidden);
  $$('.drawer').forEach((d) => (d.hidden = true)); scrim.hidden = true;
  if (wasOpen && opener && document.contains(opener)) opener.focus(); opener = null;
}
$('#open-settings').onclick = () => openDrawer('settings');
$('#scene-pill').onclick = () => openDrawer('settings');
$('#open-compare').onclick = () => { renderTasks(); openDrawer('compare'); };
scrim.onclick = closeDrawers;
$$('[data-close]').forEach((b) => (b.onclick = closeDrawers));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#pop').hidden) { closePop(true); return; }
  closeDrawers();
});
// keep Tab inside an open drawer
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const d = $$('.drawer').find((x) => !x.hidden); if (!d) return;
  const f = $$('button, input, select, a[href], [tabindex]:not([tabindex="-1"])', d).filter((x) => !x.disabled && x.offsetParent);
  if (!f.length) return;
  if (e.shiftKey && document.activeElement === f[0]) { f[f.length - 1].focus(); e.preventDefault(); }
  else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { f[0].focus(); e.preventDefault(); }
});

// ---------- legend (map key)
const legend = $('#legend');
function setLegend(open) {
  legend.classList.toggle('closed', !open); $('#legend-toggle').setAttribute('aria-expanded', String(open));
}
setLegend(store.get('legend') ? store.get('legend') === 'open' : !isMobile());
$('#legend-toggle').onclick = () => { const open = legend.classList.contains('closed'); setLegend(open); store.set('legend', open ? 'open' : 'closed'); };
function syncLegend() {
  const on = Object.fromEntries($$('[data-layer]').map((c) => [c.dataset.layer, c.checked]));
  $$('#legend-body li[data-l]').forEach((li) => (li.hidden = !on[li.dataset.l]));
}

// ---------- settings
const SCENE_NOTES = { office: 'Lab, offices, hall, kitchen and lounge.', warehouse: 'Racks block the view; many identical pallets.', home: 'Five rooms full of small objects.', hospital: 'Ten look-alike patient rooms.' };
function renderScenes() {
  $('#scenes').innerHTML = SCENES.map((s, i) => `<button type="button" role="radio" aria-checked="${i === sceneIdx}" class="card-opt ${i === sceneIdx ? 'on' : ''}" data-i="${i}">
    <b>${esc(s.name)}</b><small>${esc(s.note || SCENE_NOTES[s.id] || '')}</small><em>${s.rooms.length} rooms</em></button>`).join('');
  $$('#scenes button').forEach((b) => (b.onclick = () => { if (worldBusy || +b.dataset.i === sceneIdx) return; sceneIdx = +b.dataset.i; renderScenes(); buildWorld(); }));
}
renderScenes();
$('#nrob').oninput = () => { $('#nval').textContent = $('#nrob').value; };
$('#nrob').onchange = () => !worldBusy && buildWorld();
$('#prior').onchange = () => !worldBusy && buildWorld();
$('#b-apply').onclick = () => !worldBusy && buildWorld();
$('#b-seed').onclick = () => { if (worldBusy) return; seed = Math.floor(Math.random() * 1e6); buildWorld(); };
function renderSpeed() { $$('#speed button').forEach((x) => { const on = +x.dataset.s === speed; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(on)); }); }
$$('#speed button').forEach((b) => (b.onclick = () => { speed = +b.dataset.s; renderSpeed(); }));
// ?speed=N overrides the simulation speed (handy for demos and automated tests)
{ const q = +new URLSearchParams(location.search).get('speed'); if (q > 0 && q <= 200) speed = q; }
renderSpeed();
$$('[data-layer]').forEach((c) => (c.onchange = () => { view.setLayer(c.dataset.layer, c.checked); syncLegend(); }));
syncLegend();
$('#b-intro').onclick = () => { store.set('intro', ''); introOpen = true; closeDrawers(); renderFeedEmpty(); if (isMobile()) setSheet('half'); };

$('#model').innerHTML = MODELS.map((m, i) => `<option value="${i}">${esc(m.name)} · ${esc(m.note.split(' · ')[0].replace('~', ''))}</option>`).join('');
function modelState(state, pct) {
  const badge = $('#model-badge'), note = $('#model-note'), btn = $('#b-load');
  badge.className = `badge ${state}`;
  badge.textContent = { unsupported: 'Unsupported', idle: 'Not loaded', loading: `Loading ${pct ?? 0}%`, ready: 'Ready', error: 'Failed' }[state];
  $('#prog').hidden = state !== 'loading';
  if (state === 'unsupported') { note.textContent = 'This browser has no WebGPU, so robots use the built-in planner (same tools, simple rules). Recent Chrome, Edge or Safari can run the free model.'; btn.disabled = true; $('#model').disabled = true; }
  if (state === 'idle') { note.textContent = 'Robots use the built-in planner until you load a free open model. It runs on your GPU; the one-time download (1–4 GB) is cached.'; btn.disabled = false; btn.textContent = 'Load'; }
  if (state === 'loading') { btn.disabled = true; btn.textContent = 'Loading…'; $('#prog-bar').style.width = `${pct ?? 0}%`; }
  if (state === 'ready') { note.textContent = `Robots think with ${MODELS.find((m) => m.id === llm.modelId)?.name || 'the model'}, running on your GPU. Free and private.`; btn.disabled = false; btn.textContent = 'Switch'; }
  if (state === 'error') { btn.disabled = false; btn.textContent = 'Retry'; }
}
modelState(webgpuAvailable() ? 'idle' : 'unsupported');
$('#b-load').onclick = async () => {
  const m = MODELS[+$('#model').value];
  modelState('loading', 0);
  try {
    await llm.load(m.id, (r) => { const pct = Math.round((r.progress || 0) * 100); modelState('loading', pct); if (r.text) $('#model-note').textContent = r.text; });
    modelState('ready'); refreshStats();
  } catch (e) { modelState('error'); $('#model-note').textContent = `Could not load the model: ${e.message}`; }
};

// ---------- world
async function buildWorld({ shared = true, prior = $('#prior').checked, replay = null } = {}) {
  const def = SCENES[sceneIdx], n = +$('#nrob').value, id = ++worldId;
  worldBusy = true; taskRunning = false; setRunning(false); closePop();
  if (!replay) setReplay(null);
  $('#world-status').innerHTML = `<span class="spin">Building the ${esc(def.name.toLowerCase())}</span>`;
  $('#scene-pill').textContent = `${def.name} · ${n} robot${n > 1 ? 's' : ''}`;
  $('#team-status').textContent = 'Setting up…';
  await tick();
  const T = new Team(def, n, seed, { shared });
  if (prior) await T.runHeadless(priorExploration);
  if (id !== worldId) return null;   // superseded by a newer build
  T.animated = true; team = T;
  T.on((ev) => {
    if (T !== team) return;
    if (ev.type === 'objectadded' && ev.object && view.addObject) view.addObject(ev.object);
    if (ev.type === 'navplan') view.setNavPath(ev.r, ev.points, T.robots[ev.r].color);
    if (ev.type === 'jobdone') { const r = ev.r; setTimeout(() => { if (!T.jobs[r] && T === team) view.setNavPath(r, null); }, 1500); }
    if (['merged', 'optimized', 'jobdone', 'job'].includes(ev.type)) { dirtyLinks = true; refreshStats(); updateRoster(); }
  });
  view.load(T);
  $$('[data-layer]').forEach((c) => view.setLayer(c.dataset.layer, c.checked));
  activeState = [];
  applyInsets();
  // per-world logger so events from a replaced world never reach the new feed
  const wui = { llm, agents: [], log: (e) => { if (T === team) addLog(e); } };
  wui.agents = T.robots.map((_, r) => new RobotAgent(T, r, wui));
  ui.agents = wui.agents;
  dispatcher = new Dispatcher(T, wui);
  usedSuggestions.clear();
  clearFeed(true); buildRoster(); renderSuggestions(); refreshStats(); updateHeader();
  const nObj = T.scene.objects.filter((o) => o.cat !== 'door' && o.cat !== 'rack').length;
  $('#world-status').textContent = `${def.rooms.length} rooms, ${nObj} objects. ${prior ? 'Each robot starts knowing only the rooms it explored; maps are merged when a task needs it.' : 'Robots start with empty maps.'}`;
  worldBusy = false; dirtyLinks = true;
  return T;
}

// ---------- header + roster
function robotState(T, r) {
  const job = T.jobs[r], p = T.pose[r], room = roomAt(T.scene, p.x, p.y);
  const thinking = !job && ui.agents[r]?.busy;
  const doing = job ? job.label.replace(/ T\d+| R\d+\.\d+/, '') : thinking ? 'thinking' : 'idle';
  return { job, room, thinking, doing, busy: !!job || thinking };
}
function updateHeader() {
  const T = team; if (!T) return;
  const working = T.robots.filter((_, r) => robotState(T, r).busy).length;
  $('#team-title').textContent = `${T.n} robot${T.n > 1 ? 's' : ''}`;
  $('#team-status').textContent = paused ? 'Paused' : working ? `${working} working` : taskRunning ? 'Planning…' : 'All idle';
  $('#team-status').className = `status ${paused ? 'paused' : working || taskRunning ? 'on' : ''}`;
}
function buildRoster() {
  const T = team;
  $('#roster').innerHTML = T.robots.map((rb, r) => `<button type="button" class="rob" role="listitem" data-r="${r}" aria-haspopup="dialog" aria-expanded="false">
    <i style="background:${rb.css}">${r + 1}</i><span class="rob-t"></span></button>`).join('');
  $$('#roster .rob').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); const r = +b.dataset.r; if (popR === r) closePop(); else openPop(r); }));
  updateRoster();
}
function updateRoster() {
  const T = team; if (!T) return;
  $$('#roster .rob').forEach((b) => {
    const r = +b.dataset.r, s = robotState(T, r), txt = s.busy ? s.doing : s.room;
    b.classList.toggle('busy', s.busy);
    const t = $('.rob-t', b); if (t.textContent !== txt) t.textContent = txt;
    b.setAttribute('aria-label', `${T.robots[r].name}: ${s.doing} in ${s.room}`);
  });
  updateHeader();
  if (popR != null) renderPop();
}

// ---------- robot popover
let popR = null;
const pop = $('#pop');
function openPop(r) {
  popR = r; pop.hidden = false;
  $$('#roster .rob').forEach((b) => b.setAttribute('aria-expanded', String(+b.dataset.r === r)));
  renderPop(true); placePop();
}
function closePop(refocus = false) {
  if (popR == null) return;
  const r = popR; popR = null; pop.hidden = true;
  $$('#roster .rob').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  if (refocus) $(`#roster .rob[data-r="${r}"]`)?.focus();
}
function placePop() {
  if (popR == null) return;
  const chip = $(`#roster .rob[data-r="${popR}"]`); if (!chip) return;
  const d = dock.getBoundingClientRect(), c = chip.getBoundingClientRect();
  const w = Math.min(300, d.width - 24);
  pop.style.width = `${w}px`;
  pop.style.left = `${Math.max(12, Math.min(c.left - d.left, d.width - w - 12))}px`;
  const top = c.bottom - d.top + 8;
  pop.style.top = `${top}px`; pop.style.maxHeight = `${Math.max(160, d.height - top - 10)}px`;
}
function renderPop(first = false) {
  const T = team, r = popR; if (!T || r == null) return;
  const rb = T.robots[r], s = robotState(T, r), sim = T.sims[r];
  const objs = Object.keys(T.locals[r]?.lms || {}).length;
  const rooms = [...sim.explored];
  const html = `<div class="pop-h"><i style="background:${rb.css}">${r + 1}</i><div><b id="pop-title">${esc(rb.name)}</b><span class="${s.busy ? 'on' : ''}">${esc(s.busy ? s.doing : 'Idle')}</span></div>
      <button type="button" class="x" data-pop-close aria-label="Close">✕</button></div>
    <dl class="pop-g">
      <div><dt>Room</dt><dd>${esc(s.room)}</dd></div>
      <div><dt>Objects known</dt><dd>${objs}</dd></div>
      <div><dt>Driven</dt><dd>${sim.distance.toFixed(1)} m</dd></div>
      <div><dt>Rooms explored</dt><dd>${rooms.length}</dd></div>
    </dl>
    ${rooms.length ? `<p class="pop-rooms">Explored: ${rooms.map(esc).join(', ')}</p>` : ''}
    <button type="button" class="btn primary wide" data-pop-ask>Give ${esc(rb.name)} a task</button>`;
  if (pop.dataset.html === html) return;
  pop.dataset.html = html; pop.innerHTML = html;
  $('[data-pop-close]', pop).onclick = () => closePop(true);
  $('[data-pop-ask]', pop).onclick = () => { const q = $('#q'); q.value = `${rb.name}, `; closePop(); q.focus(); q.setSelectionRange(q.value.length, q.value.length); };
  if (first) requestAnimationFrame(() => $('[data-pop-ask]', pop)?.focus({ preventScroll: true }));
}
document.addEventListener('pointerdown', (e) => { if (popR != null && !pop.contains(e.target) && !e.target.closest('#roster .rob')) closePop(); });

// ---------- hover details in the 3D view (tap on touch screens)
const tip = document.createElement('div'); tip.id = 'hovertip'; tip.hidden = true; tip.setAttribute('role', 'tooltip'); document.body.append(tip);
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
function objectTip(T, o) {
  const seers = T.robots.map((_, r) => r).filter((r) => T.locals[r] && o.id in T.locals[r].lms);
  const chip = (r) => `<span class="tchip"><i style="background:${T.robots[r].css}"></i>${T.robots[r].id}</span>`;
  const shared = T.objectsFor(0).find((x) => x._gt && x._gt.id === o.id && /^T/.test(x.id));
  const est = shared || (seers.length ? T.objectsFor(seers[0]).find((x) => x._gt && x._gt.id === o.id) : null);
  const err = est ? Math.hypot(est.x - o.x, est.y - o.y) : null;
  let called = '';
  if (seers.length) { const lab = T.labelOf(seers[0], o.id); if (lab && lab !== `${o.color} ${o.cat}`) called = `<p class="tnote">${T.robots[seers[0]].id} recognizes it as “${esc(lab)}”.</p>`; }
  return `<b>${esc(cap(`${o.color} ${o.cat}`))}</b><span class="tsub">${esc(roomAt(T.scene, o.x, o.y))}</span>
    <div class="trow"><span class="tk">In maps of</span><span class="tv">${seers.length ? seers.map(chip).join('') : '<em>nobody yet</em>'}</span></div>
    ${shared ? `<div class="trow"><span class="tk">Shared map</span><span class="tv">${shared.id}${seers.length > 1 ? ' · links their maps' : ''}</span></div>` : ''}
    ${err != null ? `<div class="trow"><span class="tk">Map error</span><span class="tv">${err.toFixed(2)} m</span></div>` : ''}${called}`;
}
function robotTip(T, r) {
  const rb = T.robots[r], s = robotState(T, r), sim = T.sims[r];
  const objs = Object.keys(T.locals[r]?.lms || {}).length, rooms = [...sim.explored];
  return `<b><i class="tdot" style="background:${rb.css}"></i>${esc(rb.name)}</b><span class="tsub ${s.busy ? 'on' : ''}">${esc(s.busy ? s.doing : 'Idle')} · ${esc(s.room)}</span>
    <div class="trow"><span class="tk">Objects known</span><span class="tv">${objs}</span></div>
    <div class="trow"><span class="tk">Driven</span><span class="tv">${sim.distance.toFixed(1)} m</span></div>
    <div class="trow"><span class="tk">Explored</span><span class="tv">${rooms.length ? rooms.map(esc).join(', ') : 'nothing yet'}</span></div>`;
}
let tipAt = null, tipQueued = false, tipTimer = null;
function updateTip() {
  tipQueued = false;
  const T = team; if (!T || !tipAt) { tip.hidden = true; return; }
  const hit = view.pick(tipAt.x, tipAt.y);
  if (!hit) { tip.hidden = true; $('#stage').style.cursor = ''; return; }
  tip.innerHTML = hit.type === 'robot' ? robotTip(T, hit.i) : objectTip(T, hit.object);
  tip.hidden = false; $('#stage').style.cursor = 'pointer';
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = `${Math.min(window.innerWidth - w - 10, tipAt.x + 14)}px`;
  tip.style.top = `${Math.max(10, Math.min(window.innerHeight - h - 10, tipAt.y + 14))}px`;
}
const stageEl = $('#stage');
stageEl.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse') return;
  if (e.buttons) { tipAt = null; tip.hidden = true; return; }   // orbiting the camera
  tipAt = { x: e.clientX, y: e.clientY };
  if (!tipQueued) { tipQueued = true; requestAnimationFrame(updateTip); }
});
stageEl.addEventListener('pointerleave', () => { tipAt = null; tip.hidden = true; });
let downAt = null;
stageEl.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; });
stageEl.addEventListener('pointerup', (e) => {   // tap to inspect on touch screens
  if (e.pointerType === 'mouse' || !downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 8) return;
  tipAt = { x: e.clientX, y: e.clientY }; updateTip();
  clearTimeout(tipTimer); tipTimer = setTimeout(() => { tipAt = null; tip.hidden = true; }, 5000);
});
// keep the card live while hovering (robots move, maps change)
setInterval(() => { if (tipAt && !tip.hidden) updateTip(); }, 400);

// ---------- stats footer
function refreshStats() {
  const T = team; if (!T) return;
  const ate = T.M ? T.teamAte() : T.pooledLocalAte();
  const dis = T.M ? (T.optimized ? T.solverStats.map_disagreement_after_m : T.M.disInit) : null;
  const stat = (k, v, tip, cls = '') => `<span class="${cls}" title="${esc(tip)}">${k} <b>${v}</b></span>`;
  const agent = llm.ready ? (MODELS.find((m) => m.id === llm.modelId)?.name || 'open LLM') : 'built-in planner';
  $('#stats').innerHTML = [
    T.shared ? stat('Shared map:', T.M ? `${T.M.joined.length}/${T.n} robots` : `0/${T.n} robots`, "How many robots' maps are combined into one team map.")
      : stat('Shared map:', 'off', 'This replay runs without a shared map: each robot only knows what it saw.'),
    Number.isFinite(dis) && T.M?.links?.length ? stat('Robots agree within', `${dis.toFixed(2)} m`, 'Average distance between where different robots place the same object. Lower means the maps line up.') : '',
    Number.isFinite(ate) && ate > 0 ? stat('Accuracy vs. truth', `${ate.toFixed(2)} m`, 'How far the team map is from the true layout. Only knowable in a simulation.') : '',
    stat('Data shared', kb(T.bytes.objects + T.bytes.dgs), 'Bytes robots sent each other: object descriptors and optimization messages, not images.'),
    stat('Agents:', agent, 'The brain each robot uses: a built-in planner, or an open LLM running in your browser.', 'agent'),
  ].filter(Boolean).join('');
}
$('#stats-i').onclick = () => {
  const h = $('#stats-help'), open = h.hidden;
  h.hidden = !open; $('#stats-i').setAttribute('aria-expanded', String(open)); $('#stats-i').classList.toggle('on', open);
};

// ---------- suggestions (short, refreshed after each task)
const usedSuggestions = new Set();
function renderSuggestions() {
  const T = team; if (!T) return;
  // only suggest objects the team has actually mapped
  const known = new Set(); T.robots.forEach((_, r) => Object.keys(T.locals[r]?.lms || {}).forEach((id) => known.add(id)));
  const objs = T.scene.objects.filter((o) => known.has(o.id) && o.cat !== 'door' && o.cat !== 'rack');
  const unique = objs.filter((o) => T.scene.objects.filter((q) => q.cat === o.cat && q.color === o.color).length === 1);
  // prefer objects no robot is standing next to, so "go to" means a real trip
  const away = (o) => Math.min(...T.pose.map((p) => Math.hypot(p.x - o.x, p.y - o.y)));
  unique.sort((a, b) => away(b) - away(a));
  const f = unique.length ? unique[(T.seed + usedSuggestions.size) % Math.min(4, unique.length)] : null;
  const counts = {}; for (const o of objs) counts[o.cat] = (counts[o.cat] || 0) + 1;
  const cat = Object.keys(counts).filter((c) => counts[c] >= 2).sort((a, b) => counts[b] - counts[a])[0];
  const plural = (c) => (/(s|x|ch|sh)$/.test(c) ? `${c}es` : `${c}s`);
  const unexplored = T.scene.rooms.filter((q) => !T.robots.some((_, i) => T.sims[i].explored.has(q.name))).map((q) => q.name);
  const idleR = T.robots.findIndex((_, r) => !robotState(T, r).busy);
  const s = [
    unexplored.length > 1 && !objs.length && 'Explore the building',
    f && `Go to the ${f.color} ${f.cat}`,
    cat && `Where are the ${plural(cat)}?`,
    unexplored.length > 1 && objs.length && 'Explore the rest of the building',
    unexplored[0] && `Explore the ${unexplored[0]}`,
    cat && `Check every ${cat}`,
    f && T.n > 1 && `Everyone meet at the ${f.color} ${f.cat}`,
    idleR >= 0 && T.n > 1 && unexplored.length && `Robot ${idleR + 1}, explore the ${unexplored[unexplored.length - 1]}`,
  ].filter((x) => x && !usedSuggestions.has(x)).slice(0, 3);
  $('#chips').innerHTML = s.map((c) => `<button type="button" ${taskRunning ? 'disabled' : ''}>${esc(c)}</button>`).join('');
  $$('#chips button').forEach((b) => (b.onclick = () => send(b.textContent)));
}

// ---------- activity feed: one card per task, steps collapsible
const log = $('#log');
let card = null, typingEl = null, introOpen = !store.get('intro'), pinned = true;
log.addEventListener('scroll', () => {
  pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  if (pinned) $('#jump').hidden = true;
});
$('#jump').onclick = () => { log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' }); $('#jump').hidden = true; };
function follow() {
  if (pinned) log.scrollTop = log.scrollHeight; else $('#jump').hidden = false;
}
function renderFeedEmpty() {
  $('.intro', log)?.remove(); $('.empty', log)?.remove();
  if ($('.card', log)) return;
  if (introOpen) {
    const d = document.createElement('div'); d.className = 'intro';
    d.innerHTML = `<button type="button" class="x" aria-label="Dismiss intro">✕</button>
      <b>A robot team that shares one map</b>
      <p>The robots wait at their dock with empty maps. Each one maps the rooms it drives through, and Hivemap merges those maps so any robot can use what the others have seen.</p>
      <ol><li><span>Start with “Explore the building”: the team splits up the rooms.</span></li><li><span>Then ask for something they saw, like “go to the red toolbox”. The dispatcher picks a robot and says why.</span></li><li><span>Open <em>Compare</em> to see what sharing the map saves.</span></li></ol>
      <div class="row"><button type="button" class="btn primary" data-try>Try a task</button><button type="button" class="btn ghost" data-dismiss>Got it</button></div>`;
    const dismiss = () => { introOpen = false; store.set('intro', 'seen'); renderFeedEmpty(); };
    $('.x', d).onclick = dismiss; $('[data-dismiss]', d).onclick = dismiss;
    $('[data-try]', d).onclick = () => { const c = $('#chips button'); dismiss(); if (c) send(c.textContent); else $('#q').focus(); };
    log.append(d);
  } else {
    const d = document.createElement('p'); d.className = 'empty';
    d.textContent = 'Tasks appear here with the robot that was picked, why, and what it did.'; log.append(d);
  }
}
function clearFeed(all = false) {
  if (all) { log.innerHTML = ''; card = null; }
  else $$('.card', log).forEach((c) => { if (c !== card || !taskRunning) c.remove(); });
  if (!taskRunning) card = null;
  typingEl = null; $('#jump').hidden = true; pinned = true;
  renderFeedEmpty();
}
$('#b-clear').onclick = () => clearFeed(false);
$('#b-pause').onclick = () => {
  paused = !paused; const b = $('#b-pause');
  b.setAttribute('aria-pressed', String(paused)); b.classList.toggle('on', paused);
  $('span', b).textContent = paused ? 'Resume' : 'Pause';
  $('svg', b).innerHTML = paused ? '<path d="M7 5l12 7-12 7z"/>' : '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>';
  updateHeader();
};

function newCard(text, tag) {
  if (introOpen) { introOpen = false; store.set('intro', 'seen'); }
  $('.intro', log)?.remove(); $('.empty', log)?.remove();
  const c = document.createElement('article'); c.className = 'card running';
  c.innerHTML = `<header><div class="c-q">${esc(text)}${tag ? ` <span class="tag">${esc(tag)}</span>` : ''}</div><span class="c-st"><span class="spin"></span>Working</span></header>
    <div class="c-notes"></div>
    <details class="c-steps" open hidden><summary><span class="c-n">Robot steps</span></summary><div class="c-list"></div></details>`;
  c._t0 = team?.time || 0; c._userToggled = false;
  $('.c-steps > summary', c).addEventListener('click', () => { c._userToggled = true; });
  log.append(c); card = c; pinned = true; follow();
  return c;
}
function stamp() { return `<time>${clock(team?.time)}</time>`; }
function addLog(e) {
  const T = team; if (!T) return;
  const rb = typeof e.r === 'number' ? T.robots[e.r] : null;
  const dot = (r) => (typeof r === 'number' && T.robots[r] ? `<span class="dot" style="background:${T.robots[r].css}" aria-hidden="true"></span>` : '');
  if (!card && !['task', 'thinking-done', 'tool-result'].includes(e.kind)) newCard('Team activity');
  const notes = card && $('.c-notes', card), list = card && $('.c-list', card);
  const row = (parent, cls, html) => { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; parent.append(d); follow(); return d; };
  const countSteps = () => { const n = list.children.length, st = $('.c-steps', card); st.hidden = !n; $('.c-n', card).textContent = `${n} robot step${n === 1 ? '' : 's'}`; };
  if (e.kind !== 'thinking') { typingEl?.remove(); typingEl = null; }
  switch (e.kind) {
    case 'task': newCard(e.text, e.tag); break;
    case 'dispatch': row(notes, 'n-disp', `${dot(e.r)}<span>${esc(e.text)}</span>${stamp()}`); break;
    case 'thinking': typingEl = row(notes, 'n-think', `${dot(e.r)}<span>${esc(rb?.name || 'Robot')} is thinking</span>`); break;
    case 'thinking-done': break;
    case 'user':
      if (e.from === 'dispatcher' || e.from == null) {
        if (rb) { row(list, 's-row s-cmd', `${dot(e.r)}<span>Dispatcher → ${esc(rb.id)}: ${esc(String(e.text).replace(/^\[from Dispatcher\]\s*/, ''))}</span>${stamp()}`); countSteps(); }
      } else if (T.robots[e.from] && rb) row(notes, 'n-peer', `${dot(e.from)}<span><b>${esc(T.robots[e.from].name)} → ${esc(rb.name)}</b> ${esc(String(e.text).replace(/^\[from Robot \d+\]\s*/, ''))}</span>`);
      break;
    case 'tool': {
      const d = document.createElement('details'); d.className = 's-row s-tool'; d.dataset.pending = '1'; d.dataset.r = e.r; d.dataset.name = e.name;
      const args = e.input && Object.values(e.input).filter((v) => v != null && v !== '').join(', ');
      d.innerHTML = `<summary>${dot(e.r)}<span><b>${esc(rb?.id || '')}</b> ${esc(String(e.name).replace(/_/g, ' '))}${args ? ` <em>${esc(args)}</em>` : ''} <span class="res">…</span></span>${stamp()}</summary>${e.thought ? `<p class="thought">${esc(e.thought)}</p>` : ''}`;
      list.append(d); countSteps(); follow(); break;
    }
    case 'tool-result': {
      const pend = $$('details.s-tool[data-pending]', log).reverse().find((x) => x.dataset.r === String(e.r) && x.dataset.name === e.name);
      if (pend) {
        delete pend.dataset.pending; const o = e.output || {}; const res = $('.res', pend);
        res.textContent = o.error ? `failed: ${o.error}` : summarize(e.name, o); res.classList.toggle('bad', !!o.error);
        pend.insertAdjacentHTML('beforeend', `<pre>${esc(JSON.stringify(o, null, 1))}</pre>`);
      }
      break;
    }
    case 'reply': if (e.depth) row(notes, 'n-say', `${dot(e.r)}<span>${esc(e.text)}</span>`); break;
    case 'error': row(notes, 'n-err', `${dot(e.r)}<span>${esc(e.text)}</span>${stamp()}`); break;
    case 'result': finishCard(e); break;
    default: break;
  }
}
const BAD = /^(error|there is no|all robots are busy|nobody|searched the building but found no|could not|the team map has no)|failed|\b0\/\d+/i;
function finishCard(e) {
  const c = card; if (!c) return;
  const bad = BAD.test(e.text);
  const meta = String(e.meta || '').split(' · ').filter(Boolean);
  const res = document.createElement('div'); res.className = `c-res ${bad ? 'warn' : 'ok'}`;
  res.innerHTML = `<p>${esc(e.text)}</p>${meta.length ? `<div class="chips">${meta.map((m) => `<span>${esc(m)}</span>`).join('')}</div>` : ''}`;
  c.append(res);
  // what the shared map changed for this task (computed by the dispatcher from who saw what)
  if (e.alt) {
    const neutral = /didn't change|already knew all/.test(e.alt);
    const alt = document.createElement('div'); alt.className = `c-alt ${neutral ? 'neutral' : ''}`;
    alt.innerHTML = `<span class="alt-tag">${neutral ? 'Shared map' : 'Shared map helped'}</span><p>${esc(e.alt)}</p><button type="button" class="linkbtn">Run it side by side: shared map vs. robots alone</button>`;
    $('button', alt).onclick = () => openComparison(e.altKind || 'fetch');
    c.append(alt);
  }
  c.classList.remove('running'); c.classList.add(bad ? 'warn' : 'done');
  $('.c-st', c).innerHTML = `${bad ? 'Needs attention' : 'Done'} <time>${clock(team?.time)}</time>`;
  const st = $('.c-steps', c); if (!c._userToggled) st.open = false;
  card = null; follow();
}
function summarize(name, o) {
  return { explore_room: `+${o.new_objects} objects`, exchange_maps: `${o.robots_merged?.length} merged`, optimize_team_map: `${o.map_disagreement_after_m} m`,
    search_map: `${o.results?.length ?? 0} found`, navigate_to: o.distance_to_real_object_m != null ? `${o.distance_to_real_object_m} m from it` : 'arrived', ask_robot: 'replied' }[name] || 'done';
}

function setRunning(on) {
  taskRunning = on; dock.classList.toggle('running', on);
  $('#ask .go').disabled = on; $$('#chips button').forEach((b) => (b.disabled = on));
  $('#q').placeholder = on ? 'The team is working…' : 'Give the team a task…';
  updateHeader();
}
async function send(text) {
  text = String(text || '').trim(); if (!text || !team || taskRunning || worldBusy) return;
  const id = worldId;
  usedSuggestions.add(text);
  $('#q').value = ''; closePop(); setRunning(true);
  if (isMobile() && dock.dataset.sheet === 'peek') setSheet('half');
  try { await dispatcher.handle(text); } catch (e) { addLog({ kind: 'error', text: e.message }); if (card) finishCard({ text: `Error: ${e.message}` }); }
  finally { if (id === worldId) { setRunning(false); refreshStats(); updateRoster(); renderSuggestions(); } }
}
$('#ask').onsubmit = (e) => { e.preventDefault(); send($('#q').value); };

// ---------- compare
// open Compare with a task preselected and start the run immediately
function openComparison(kind) {
  if (TASKS.some((t) => t.id === kind)) taskKind = kind;
  renderTasks(); openDrawer('compare');
  const btn = $('#b-compare'); if (btn && !btn.disabled) btn.click();
}
function renderTasks() {
  $('#task').innerHTML = TASKS.map((t) => `<button type="button" role="radio" aria-checked="${t.id === taskKind}" class="card-opt ${t.id === taskKind ? 'on' : ''}" data-k="${t.id}"><b>${esc(t.name)}</b><small>${esc(t.blurb)}</small></button>`).join('');
  $$('#task button').forEach((b) => (b.onclick = () => { taskKind = b.dataset.k; renderTasks(); }));
  $('#task-text').textContent = `In the ${SCENES[sceneIdx].name.toLowerCase()} with ${$('#nrob').value} robots, same object layout for both runs.`;
}
renderTasks();
$('#b-compare').onclick = async () => {
  if (worldBusy) return;
  const btn = $('#b-compare'); btn.disabled = true; btn.textContent = 'Running…';
  $('#cmp').innerHTML = ''; $('#cmp-prog').hidden = false;
  // progress: a Team subclass reports which run and phase compare() is in
  const steps = { 'true:0': [8, 'Shared map: robots explore their own rooms'], 'true:1': [35, 'Shared map: merging maps and running the task'],
    'false:0': [55, 'Robots alone: robots explore their own rooms'], 'false:1': [80, 'Robots alone: running the task'] };
  const show = (k, T) => { const [p, t] = steps[k]; $('#cmp-bar').style.width = `${p}%`; $('#cmp-text').textContent = `${t}${T && T.time ? ` · ${clock(T.time)} simulated` : '…'}`; };
  class Tracked extends Team {
    constructor(...a) { super(...a); this._phase = 0; show(`${this.shared}:0`); }
    async runHeadless(policy, max) {
      const k = `${this.shared}:${this._phase++}`; show(k, this);
      const iv = setInterval(() => show(k, this), 250);
      try { return await super.runHeadless(policy, max); } finally { clearInterval(iv); }
    }
  }
  await tick();
  try {
    const def = SCENES[sceneIdx], n = +$('#nrob').value;
    const c = await compare(Tracked, def, n, seed, taskKind);
    $('#cmp-bar').style.width = '100%';
    lastCmp = { c, sceneIdx, n, seed }; renderCompare(c);
    $('#cmp .cmp')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) { $('#cmp').innerHTML = `<p class="n-err">Could not run the comparison: ${esc(e.message)}</p>`; }
  $('#cmp-prog').hidden = true; btn.disabled = false; btn.textContent = 'Run again';
};
// Mini floor plan of one run: rooms Robot 1 knew about (tinted) vs unknown (hatched),
// objects Robot 1 knew (gold = relevant to the task), the target, and each robot's route.
function planSVG(scene, r, cls) {
  const W = 340, sc = W / scene.w, H = Math.round(scene.h * sc), X = (x) => (x * sc).toFixed(1), Y = (y) => (y * sc).toFixed(1);   // same orientation as the 3D view
  const v = r.viz, known = new Set(v.rooms_known);
  const rooms = scene.rooms.map((q) => `<rect x="${X(q.x0)}" y="${Y(q.y0)}" width="${((q.x1 - q.x0) * sc).toFixed(1)}" height="${((q.y1 - q.y0) * sc).toFixed(1)}" fill="${known.has(q.name) ? 'var(--known)' : 'url(#hatch)'}"/>`).join('');
  const walls = scene.walls.map(([x1, y1, x2, y2]) => `<line x1="${X(x1)}" y1="${Y(y1)}" x2="${X(x2)}" y2="${Y(y2)}"/>`).join('');
  const objs = v.known.map((o) => `<circle cx="${X(o.x)}" cy="${Y(o.y)}" r="${o.rel ? 3.4 : 1.8}" class="${o.rel ? 'rel' : 'obj'}"/>`).join('');
  const star = (p) => { const cx = +X(p.x), cy = +Y(p.y), pts = []; for (let k = 0; k < 10; k++) { const rr = k % 2 ? 3.2 : 7.5, a = -Math.PI / 2 + (k * Math.PI) / 5; pts.push(`${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`); } return `<polygon points="${pts.join(' ')}" class="star"/>`; };
  const targets = v.target ? star(v.target) : (v.targets || []).map(star).join('');
  const paths = v.paths.map((pts, i) => pts.length > 1 ? `<polyline points="${pts.map((p) => `${X(p.x)},${Y(p.y)}`).join(' ')}" stroke="${scene.colors[i]}" class="route"/><circle cx="${X(pts[pts.length - 1].x)}" cy="${Y(pts[pts.length - 1].y)}" r="3.2" fill="${scene.colors[i]}" class="end"/>` : '').join('');
  return `<svg class="plan ${cls}" viewBox="0 0 ${W} ${H}" role="img"><defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#f1f2f5"/><line x1="0" y1="0" x2="0" y2="6" stroke="#dcdfe5" stroke-width="2"/></pattern></defs>
    <g>${rooms}</g><g class="walls">${walls}</g><g>${objs}</g><g>${paths}</g><g>${targets}</g></svg>`;
}
function knowledgeLine(c, r, shared) {
  const v = r.viz, k = c.task.kind, rooms = `${v.rooms_known.length} of ${c.scene.rooms.length} rooms`;
  if (k === 'fetch' || k === 'rendezvous') return v.relevant_known
    ? `Robot 1 knew <b>${v.known_count} objects</b> in ${rooms}, <b>including the target</b>, so it ${k === 'fetch' ? 'drove straight there' : 'could send everyone straight there'}.`
    : `Robot 1 knew <b>${v.known_count} objects</b> in ${rooms}, <b>but not the target</b>, so ${k === 'fetch' ? 'it had to search room by room' : 'robots had to search for it themselves'}.`;
  if (k === 'inventory' || k === 'dispatch') return `Robot 1 knew <b>${v.relevant_known} of ${(v.targets || []).length}</b> ${esc(c.task.cat)}s in ${rooms}${v.relevant_known < (v.targets || []).length ? `, so ${k === 'inventory' ? 'it had to survey the rest itself' : 'the rest stayed unknown to it'}` : ''}.`;
  if (k === 'search') return shared ? 'Nobody knew where the item was, so the team <b>split the rooms</b> and stopped as soon as anyone saw it.' : 'Nobody knew where the item was, and Robot 1 <b>searched alone</b>: the others could not tell it what they saw.';
  return `Robot 1 knew ${v.known_count} objects in ${rooms}.`;
}
function verdictFor(S, I) {
  const speedup = S.time_s > 0 ? I.time_s / S.time_s : Infinity;
  if (S.score > I.score) return { text: 'Only the team with the shared map finished the task.', good: true };
  if (I.score > S.score) return { text: 'Here the robots on their own did better.', good: false };
  // answered straight from the map (no real driving): ratios are meaningless, say what "alone" cost instead
  if (S.time_s < 5 && S.distance_m < 3 && I.time_s > S.time_s + 10) return { text: `With the shared map the answer came <b>straight from the map</b>, no driving needed. Alone, Robot 1 needed <b>${clock(I.time_s)}</b> and <b>${(+I.distance_m).toFixed(0)} m</b> of driving to find out.`, good: true };
  if (I.time_s > S.time_s * 1.15) {
    const dr = I.distance_m / Math.max(1, S.distance_m);
    return { text: `With the shared map the team finished <b>${speedup.toFixed(1)}× faster</b>${dr > 1.15 ? ` and drove <b>${dr > 20 ? `${(+I.distance_m).toFixed(0)} m less` : `${dr.toFixed(1)}× less`}</b>` : ''}.`, good: true };
  }
  if (S.time_s > I.time_s * 1.15) return { text: 'Here sharing cost more than it saved: the robots already knew what they needed, and linking maps takes time.', good: false };
  return { text: 'About the same: the robots already knew what they needed.', good: false };
}
function renderCompare(c) {
  const S = c.results.shared, I = c.results.independent, n = S.viz.paths.length;
  const vd = verdictFor(S, I);
  const bars = (label, a, b, fmt) => {
    const m = Math.max(a, b, 1e-9);
    return `<div class="bars"><div class="bl">${label}</div>
      <div class="bt"><span class="b s-shared" style="width:${Math.max(2, (a / m) * 100)}%"></span><em>${fmt(a)}</em></div>
      <div class="bt"><span class="b s-alone" style="width:${Math.max(2, (b / m) * 100)}%"></span><em>${fmt(b)}</em></div></div>`;
  };
  const pct = (r) => (r.success ? 'done' : `${Math.round(r.score * 100)}% done`);
  const run = (title, r, cls, id, shared) => `<div class="runcard">
      <div class="run-h"><span class="swatch ${cls}"></span><b>${title}</b><span class="run-stat">${clock(r.time_s)} · ${(+r.distance_m).toFixed(0)} m · ${pct(r)}</span></div>
      ${planSVG(c.scene, r, cls)}
      <p class="run-k">${knowledgeLine(c, r, shared)}</p>
      <button class="btn small" type="button" id="${id}"><svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M7 5l12 7-12 7z"/></svg> Watch in 3D</button>
    </div>`;
  $('#cmp').innerHTML = `<div class="cmp">
    <p class="setup">${n} robot${n > 1 ? 's' : ''} each explored a share of the building on their own. Then: <b>“${esc(c.task.text)}”</b></p>
    <div class="verdict ${vd.good ? '' : 'meh'}">${vd.text}</div>
    <div class="chart" aria-label="Comparison chart">
      ${bars('Time to finish', S.time_s, I.time_s, (v) => clock(v))}
      ${bars('Distance driven', S.distance_m, I.distance_m, (v) => `${(+v).toFixed(0)} m`)}
      <div class="chart-key"><span><i class="swatch s-shared"></i>Shared map</span><span><i class="swatch s-alone"></i>Robots alone</span><span class="mute">shorter is better</span></div>
    </div>
    ${run('With the shared map', S, 's-shared', 'w-s', true)}
    ${run('Each robot alone', I, 's-alone', 'w-i', false)}
    <p class="plan-key"><span><i class="k-known"></i>rooms Robot 1 knew</span><span><i class="k-unknown"></i>unknown to Robot 1</span><span><i class="k-obj"></i>objects it knew</span><span><i class="k-rel"></i>relevant</span><span>★ target</span><span>lines: routes during the task</span></p>
    <p class="cost">Sharing cost ${kb(S.bytes)} of radio traffic (object descriptions, not camera images).</p>
    <button class="btn wide" type="button" id="b-all">Run every task in this building</button>
    <div id="cmp-all"></div>
    <details class="runlog"><summary>Run log</summary><pre>${[...S.logs.map((l) => `shared  ${l}`), ...I.logs.map((l) => `alone   ${l}`)].map(esc).join('\n')}</pre></details></div>`;
  $('#w-s').onclick = () => watch(true); $('#w-i').onclick = () => watch(false);
  $('#b-all').onclick = runAll;
}
// Run every task kind on the same building and summarize: evidence beyond one example.
async function runAll() {
  const btn = $('#b-all'); if (!btn || worldBusy) return;
  btn.disabled = true; const box = $('#cmp-all'); const rows = [];
  const def = SCENES[sceneIdx], n = +$('#nrob').value;
  for (const t of TASKS) {
    btn.textContent = `Running ${t.name.toLowerCase()}…`; await tick();
    try { const c = await compare(Team, def, n, seed, t.id); rows.push({ t, S: c.results.shared, I: c.results.independent }); }
    catch (e) { rows.push({ t, err: e.message }); }
    draw();
  }
  btn.textContent = 'Run every task again'; btn.disabled = false;
  function draw() {
    const ok = rows.filter((x) => !x.err);
    const wins = ok.filter((x) => verdictFor(x.S, x.I).good).length;
    const ratios = ok.map((x) => x.I.time_s / Math.max(1, x.S.time_s)).sort((a, b) => a - b);
    const med = ratios.length ? ratios[Math.floor(ratios.length / 2)] : 0;
    const maxT = Math.max(1, ...ok.flatMap((x) => [x.S.time_s, x.I.time_s]));
    box.innerHTML = `<div class="allsum">${ok.length === TASKS.length ? `<div class="verdict ${wins >= ok.length / 2 ? '' : 'meh'}">Sharing helped in <b>${wins} of ${ok.length}</b> tasks; typical speed-up <b>${med.toFixed(1)}×</b>.</div>` : ''}
      ${rows.map((x) => x.err ? `<div class="allrow"><b>${esc(x.t.name)}</b><span class="n-err">${esc(x.err)}</span></div>` : `<div class="allrow"><b>${esc(x.t.name)}</b>
        <div class="bt"><span class="b s-shared" style="width:${Math.max(2, (x.S.time_s / maxT) * 100)}%"></span><em>${clock(x.S.time_s)}${x.S.success ? '' : ` (${Math.round(x.S.score * 100)}%)`}</em></div>
        <div class="bt"><span class="b s-alone" style="width:${Math.max(2, (x.I.time_s / maxT) * 100)}%"></span><em>${clock(x.I.time_s)}${x.I.success ? '' : ` (${Math.round(x.I.score * 100)}%)`}</em></div></div>`).join('')}</div>`;
  }
}

// ---------- replay of a compared run, with a banner and an exit
function setReplay(shared, state = 'Replaying') {
  const b = $('#replay');
  if (shared == null) { b.hidden = true; document.body.classList.remove('replaying'); return; }
  b.hidden = false; document.body.classList.add('replaying');
  $('#replay-text').innerHTML = `${state}: <b>${shared ? 'shared map' : 'robots alone'}</b>`;
}
$('#replay-exit').onclick = () => { setReplay(null); buildWorld(); };
async function watch(shared) {
  if (!lastCmp || worldBusy) return;
  closeDrawers();
  sceneIdx = lastCmp.sceneIdx; renderScenes(); $('#nrob').value = lastCmp.n; $('#nval').textContent = lastCmp.n; seed = lastCmp.seed;
  setReplay(shared, 'Setting up replay');
  const T = await buildWorld({ shared, prior: true, replay: true }); if (!T) return;
  const id = worldId;
  setReplay(shared);
  const task = { ...lastCmp.c.task, target: lastCmp.c.task.target && T.scene.objects.find((o) => o.id === lastCmp.c.task.target.id) };
  addLog({ kind: 'task', text: task.text, tag: shared ? 'shared map' : 'robots alone' });
  if (isMobile()) setSheet('half');
  setRunning(true);
  try {
    const res = await runTask(T, task, (m) => { if (T === team) addLog({ kind: 'dispatch', text: m.replace(/^\[t=\d+s\]\s*/, '') }); });
    if (T === team) addLog({ kind: 'result', text: res.success ? 'Task complete.' : `Task ${Math.round(res.score * 100)}% complete.`, meta: `${res.time_s} s · ${res.distance_m} m driven` });
  } catch (e) { if (T === team) addLog({ kind: 'result', text: `Error: ${e.message}` }); }
  finally { if (id === worldId) { setRunning(false); setReplay(shared, 'Replay finished'); refreshStats(); } }
}

// ---------- render loop
let last = performance.now(), lastSlow = 0, activeState = [];
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  const T = team;
  if (T) {
    if (T.busy() && !paused) T.tick(dt * speed);
    T.robots.forEach((_, r) => view.setRobotPose(r, T.pose[r]));
    if (now - lastSlow > 120) {
      lastSlow = now;
      T.robots.forEach((rb, r) => {
        const v = T.liveView(r); view.setTrail(r, v.poses, T.sims[r].gt, false); view.setLandmarks(r, v.lms, rb.color);
        const on = !!T.jobs[r];
        if (view.setActive && activeState[r] !== on) { activeState[r] = on; view.setActive(r, on); }
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
        refreshStats();
      }
      if (T.busy() || taskRunning) updateRoster();
      const ck = clock(T.time); if ($('#clock').textContent !== ck) $('#clock').textContent = ck;
    }
  }
  view.render(now);
  requestAnimationFrame(frame);
}
if (isMobile()) setSheet(introOpen ? 'half' : 'peek');
renderFeedEmpty();
applyInsets();
buildWorld().then(() => requestAnimationFrame(frame));
window.__ui = { get team() { return team; }, ui, send };

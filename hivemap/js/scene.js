// three.js rendering of the building, objects, robots and estimates.
// World (x, y) maps to three.js (x, z = y); y-up.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { objectMesh, robotMesh, Kit } from './models.js';
import { mats, floorTypeFor, floorMaterial } from './materials.js';

const V = (x, y, h = 0) => new THREE.Vector3(x, h, y);
const WALL_H = 1.2, WALL_T = 0.14;
const LINK_OBJ = 0xeab308, LINK_ENC = 0x334155;
const TRAIL = { idleOpacity: 0.35, idleWidth: 1.6, activeOpacity: 0.95, activeWidth: 3.2 };

function textLabel(text, cls) {
  const d = document.createElement('div'); d.className = cls; d.textContent = text;
  return new CSS2DObject(d);
}

// landmark marker texture: faint filled disc with a crisp ring (tinted by material colour)
let markerTex = null;
function getMarkerTex() {
  if (markerTex) return markerTex;
  const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
  g.fillStyle = 'rgba(255,255,255,0.22)'; g.beginPath(); g.arc(64, 64, 50, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#ffffff'; g.lineWidth = 9; g.beginPath(); g.arc(64, 64, 52, 0, Math.PI * 2); g.stroke();
  g.fillStyle = '#ffffff'; g.beginPath(); g.arc(64, 64, 9, 0, Math.PI * 2); g.fill();
  markerTex = new THREE.CanvasTexture(c); markerTex.colorSpace = THREE.SRGBColorSpace; markerTex.anisotropy = 4;
  return markerTex;
}
const markerGeo = Object.assign(new THREE.PlaneGeometry(0.4, 0.4).rotateX(-Math.PI / 2), { _shared: true });
const targetGeo = Object.assign(new THREE.PlaneGeometry(0.7, 0.7).rotateX(-Math.PI / 2), { _shared: true });

// find the gap a door marker sits in: {vertical, lo, hi, at}
function doorGap(walls, d) {
  for (const vertical of [true, false]) {
    const ends = [];
    for (const [x1, y1, x2, y2] of walls) {
      if (vertical && Math.abs(x1 - x2) < 1e-3 && Math.abs(x1 - d.x) < 0.05) ends.push(y1, y2);
      if (!vertical && Math.abs(y1 - y2) < 1e-3 && Math.abs(y1 - d.y) < 0.05) ends.push(x1, x2);
    }
    const p = vertical ? d.y : d.x;
    const lo = Math.max(-Infinity, ...ends.filter((e) => e <= p + 1e-3)), hi = Math.min(Infinity, ...ends.filter((e) => e >= p - 1e-3));
    if (isFinite(lo) && isFinite(hi) && hi - lo > 0.4 && hi - lo < 4) return { vertical, lo, hi, at: vertical ? d.x : d.y };
  }
  return null;
}

export class SceneView {
  constructor(container) {
    this.container = container;
    const q = new URLSearchParams(location.search);
    this.aoForced = q.get('ao') === '1' ? true : q.get('ao') === '0' ? false : null;
    this.useAO = this.aoForced ?? (window.innerWidth > 860 && (window.devicePixelRatio || 1) <= 2.5);
    const r = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio, this.useAO ? 1.5 : 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.05;
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(r.domElement); this.renderer = r;
    this.labels = new CSS2DRenderer(); this.labels.domElement.className = 'labels-layer'; container.appendChild(this.labels.domElement);
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(0xeef0f3);
    const pmrem = new THREE.PMREMGenerator(r);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; pmrem.dispose();
    this.scene.environmentIntensity = 0.45;
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.3, 300);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true; this.controls.maxPolarAngle = Math.PI * 0.47; this.controls.minDistance = 4; this.controls.maxDistance = 120;
    this.controls.addEventListener('start', () => { this.userMoved = true; });
    this.hemi = new THREE.HemisphereLight(0xf3f6ff, 0xb8a990, 0.75); this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff0dd, 2.5); this.sun.castShadow = true;
    const sm = window.innerWidth > 860 ? 2048 : 1024; this.sun.shadow.mapSize.set(sm, sm);
    this.sun.shadow.bias = -0.0004; this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);
    this.layers = { gt: false, est: true, fov: false, links: true };
    this.insets = { left: 0, bottom: 0, top: 0 };
    this.size = { w: 24, h: 16 };
    this.active = {};
    this.frameTimes = [];
    window.__sceneView = this;   // debug handle (camera tweaks from the console)
    if (this.useAO) this.initAO();
    new ResizeObserver(() => this.resize()).observe(container); this.resize();
  }

  initAO() {
    try {
      const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
      const comp = new EffectComposer(this.renderer, rt);
      comp.addPass(new RenderPass(this.scene, this.camera));
      const ao = new GTAOPass(this.scene, this.camera, 1, 1);
      ao.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1.5, thickness: 1.2, scale: 1.0, samples: 12, distanceFallOff: 1.0, screenSpaceRadius: false });
      ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
      ao.blendIntensity = 0.85;
      // overlays (trails, links, markers, FOV wedges) must not cast AO
      const ov = ao.overrideVisibility.bind(ao);
      ao.overrideVisibility = () => { ov(); this.scene.traverse((o) => { if (o.userData.noAO) o.visible = false; }); };
      comp.addPass(ao);
      comp.addPass(new OutputPass());
      this.composer = comp; this.aoPass = ao;
    } catch (e) { console.warn('AO disabled', e); this.composer = null; }
  }
  dropAO() {
    if (!this.composer) return;
    this.composer.passes.forEach((p) => p.dispose?.()); this.composer.renderTarget1.dispose(); this.composer.renderTarget2.dispose();
    this.composer = null; this.aoPass = null; this.useAO = false;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); this.resize();
  }

  clear() {
    if (!this.world) return;
    const drop = (g) => {
      g.traverse((o) => {
        if (o.geometry && !o.geometry._shared) o.geometry.dispose();
        if (o.material && !o.material._shared) { o.material.map?.dispose?.(); o.material.dispose?.(); }
        if (o.isCSS2DObject) o.element.remove();
      });
      this.scene.remove(g);
    };
    drop(this.world); drop(this.dyn);
  }

  load(team) {
    this.clear();
    const sc = team.scene; this.size = { w: sc.w, h: sc.h }; this.sceneDef = sc;
    this.world = new THREE.Group(); this.dyn = new THREE.Group(); this.scene.add(this.world, this.dyn);
    const S = Math.max(sc.w, sc.h), cx = sc.w / 2, cz = sc.h / 2;
    // warm, high sun from the camera side so shadows fall away from the viewer
    const sh = this.sun.shadow.camera, ext = S * 0.72;
    Object.assign(sh, { left: -ext, right: ext, top: ext, bottom: -ext, near: 1, far: S * 3 });
    this.sun.position.set(cx - S * 0.35, S * 1.1, cz + S * 0.55); this.sun.target.position.set(cx, 0, cz); sh.updateProjectionMatrix();

    // ground around the building (blends into the background)
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(S * 6, S * 6), mats.ground());
    ground.rotation.x = -Math.PI / 2; ground.position.set(cx, -0.02, cz); ground.receiveShadow = true; this.world.add(ground);
    // building slab edge
    const slab = new THREE.Mesh(new THREE.BoxGeometry(sc.w + 0.5, 0.06, sc.h + 0.5), mats.paint('#d5d8dc', 0.9));
    slab.position.set(cx, -0.03, cz); slab.receiveShadow = true; this.world.add(slab);
    // floors per room
    sc.rooms.forEach((rm, i) => {
      const w = rm.x1 - rm.x0, h = rm.y1 - rm.y0;
      const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), floorMaterial(floorTypeFor(sc, rm.name), w, h));
      p.rotation.x = -Math.PI / 2; p.position.set((rm.x0 + rm.x1) / 2, 0.002 + i * 0.0002, (rm.y0 + rm.y1) / 2); p.receiveShadow = true; this.world.add(p);
      const l = textLabel(rm.name, 'room-label'); l.position.copy(V((rm.x0 + rm.x1) / 2, rm.y0 + Math.min(0.55, h * 0.12), 0.05)); this.world.add(l);
    });
    // cut-away walls: plaster body, dark top cap, baseboards on both faces
    const k = new Kit(), wall = mats.wall(), cap = mats.wallTop(), base = mats.baseboard();
    for (const [x1, y1, x2, y2] of sc.walls) {
      const len = Math.hypot(x2 - x1, y2 - y1), ang = -Math.atan2(y2 - y1, x2 - x1), mx = (x1 + x2) / 2, mz = (y1 + y2) / 2;
      const L = len + WALL_T, nx = -Math.sin(-ang), nz = Math.cos(-ang);   // wall normal in xz
      k.box(L, WALL_H, WALL_T, wall, mx, WALL_H / 2, mz, 0, 0, ang, 0);
      k.box(L + 0.01, 0.03, WALL_T + 0.02, cap, mx, WALL_H + 0.015, mz, 0.006, 0, ang, 0);
      for (const s of [-1, 1]) k.box(L - 0.002, 0.08, 0.014, base, mx + s * nx * (WALL_T / 2 + 0.007), 0.04, mz + s * nz * (WALL_T / 2 + 0.007), 0, 0, ang, 0);
    }
    // door frames (casings at the gap edges + threshold strip; never blocking)
    const frame = mats.frame(), thr = mats.metal('#a8adb4', 0.45);
    for (const o of sc.objects) {
      if (o.cat !== 'door') continue;
      const g = doorGap(sc.walls, o); if (!g) continue;
      const mid = (g.lo + g.hi) / 2, gw = g.hi - g.lo;
      for (const e of [g.lo + WALL_T / 2 + 0.03, g.hi - WALL_T / 2 - 0.03]) {
        if (g.vertical) k.box(WALL_T + 0.05, WALL_H + 0.06, 0.06, frame, g.at, (WALL_H + 0.06) / 2, e, 0.008);
        else k.box(0.06, WALL_H + 0.06, WALL_T + 0.05, frame, e, (WALL_H + 0.06) / 2, g.at, 0.008);
      }
      if (g.vertical) k.box(WALL_T, 0.008, gw - WALL_T - 0.12, thr, g.at, 0.004, mid, 0);
      else k.box(gw - WALL_T - 0.12, 0.008, WALL_T, thr, mid, 0.004, g.at, 0);
    }
    const walls = k.bake(); this.world.add(walls);
    for (const o of sc.objects) if (o.cat !== 'door') this.world.add(objectMesh(o));

    // robots + overlays
    this.robots = {}; this.trails = {}; this.rings = {}; this.navLines = {}; this.ringMats = {}; this.active = {};
    const overlay = (vis = true) => { const g = new THREE.Group(); g.visible = vis; g.userData.noAO = true; this.dyn.add(g); return g; };
    this.gtGroup = overlay(this.layers.gt); this.estGroup = overlay(this.layers.est); this.linkGroup = overlay(this.layers.links); this.navGroup = overlay(true);
    this.objLinks = null; this.encLinks = null;
    for (const rb of team.robots) {
      const m = robotMesh(rb); m.userData.fov.visible = this.layers.fov; this.dyn.add(m);
      const tag = textLabel(rb.name.replace('Robot ', 'R'), 'robot-tag'); tag.element.style.background = rb.css; tag.position.set(0, 0.9, 0); m.add(tag);
      this.robots[rb.i] = m;
      const lm = new LineMaterial({ color: rb.color, linewidth: TRAIL.idleWidth, worldUnits: false, transparent: true, opacity: TRAIL.idleOpacity, depthWrite: false });
      lm.resolution.set(this.width || 1, this.height || 1);
      const trail = new Line2(new LineGeometry(), lm); trail.visible = false; trail.renderOrder = 2; this.estGroup.add(trail);
      const gtl = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0x64748b, dashSize: 0.18, gapSize: 0.14, transparent: true, opacity: 0.6 })); this.gtGroup.add(gtl);
      this.trails[rb.i] = { trail, gtl, lm, n: -1 }; this.rings[rb.i] = {};
      this.ringMats[rb.i] = new THREE.MeshBasicMaterial({ color: rb.color, map: getMarkerTex(), transparent: true, opacity: 0.9, depthWrite: false, depthTest: false });
    }
    this.userMoved = false; this.fitCamera();
  }

  setRobotPose(i, p) { const m = this.robots?.[i]; if (m) { m.position.copy(V(p.x, p.y)); m.rotation.y = -p.th; } }
  // highlight robot i's estimated trail while it is busy (optional; safe to never call)
  setActive(i, on) {
    on = !!on; if (!this.trails?.[i] || this.active[i] === on) return;
    this.active[i] = on;
    const t = this.trails[i];
    t.lm.opacity = on ? TRAIL.activeOpacity : TRAIL.idleOpacity; t.lm.linewidth = on ? TRAIL.activeWidth : TRAIL.idleWidth;
    t.trail.renderOrder = on ? 3 : 2;
  }
  setTrail(i, est, gt, force) {
    const t = this.trails?.[i]; if (!t) return;
    if (!force && t.n === est.length) return;
    t.n = est.length;
    if (est.length >= 2) {
      const pos = []; for (const p of est) pos.push(p.x, 0.05, p.y);
      t.trail.geometry.dispose(); t.trail.geometry = new LineGeometry(); t.trail.geometry.setPositions(pos); t.trail.computeLineDistances(); t.trail.visible = true;
    } else t.trail.visible = false;
    t.gtl.geometry.dispose(); t.gtl.geometry = new THREE.BufferGeometry().setFromPoints(gt.map((p) => V(p.x, p.y, 0.04))); t.gtl.computeLineDistances();
  }
  setLandmarks(i, lms, color) {
    const rings = this.rings?.[i]; if (!rings) return; const seen = new Set();
    let m = this.ringMats[i];
    if (color != null && m.userData.c !== color) { m.color.set(color); m.userData.c = color; }
    for (const [key, p] of Object.entries(lms)) {
      seen.add(key); let r = rings[key];
      if (!r) { r = new THREE.Mesh(markerGeo, m); r.renderOrder = 4; this.estGroup.add(r); rings[key] = r; }
      r.position.copy(V(p.x, p.y, 0.03 + i * 0.002));
    }
    for (const [k, r] of Object.entries(rings)) if (!seen.has(k)) { this.estGroup.remove(r); delete rings[k]; }
  }
  // cross-robot links: [{a:{x,y}, b:{x,y}, kind:'obj'|'enc'}]
  //  obj = same object in two robots' maps (gold arcs), enc = robots saw each other (dark dashed)
  setLinks(list) {
    if (!this.linkGroup) return;
    const obj = [], enc = [];
    for (const m of list) {
      if (m.kind === 'enc') { enc.push(m.a.x, 0.32, m.a.y, m.b.x, 0.32, m.b.y); continue; }
      const a = V(m.a.x, m.a.y, 0.06), b = V(m.b.x, m.b.y, 0.06), mid = a.clone().add(b).multiplyScalar(0.5); mid.y = 0.35 + 0.12 * a.distanceTo(b);
      const pts = new THREE.QuadraticBezierCurve3(a, mid, b).getPoints(14);
      for (let j = 0; j < pts.length - 1; j++) obj.push(pts[j].x, pts[j].y, pts[j].z, pts[j + 1].x, pts[j + 1].y, pts[j + 1].z);
    }
    const make = (arr, prev, opts) => {
      if (prev) { this.linkGroup.remove(prev); prev.geometry.dispose(); }
      if (!arr.length) { if (prev) prev.material.dispose(); return null; }
      const g = new LineSegmentsGeometry(); g.setPositions(arr);
      const mat = prev?.material || new LineMaterial({ worldUnits: false, transparent: true, depthWrite: false, ...opts });
      mat.resolution.set(this.width || 1, this.height || 1);
      const l = new LineSegments2(g, mat); if (opts.dashed) l.computeLineDistances(); l.renderOrder = 5;
      this.linkGroup.add(l); return l;
    };
    this.objLinks = make(obj, this.objLinks, { color: LINK_OBJ, linewidth: 1.6, opacity: 0.9 });
    this.encLinks = make(enc, this.encLinks, { color: LINK_ENC, linewidth: 1.6, opacity: 0.85, dashed: true, dashSize: 0.22, gapSize: 0.16 });
  }
  setNavPath(i, points, color) {
    if (!this.navLines) return;
    const old = this.navLines[i]; if (old) { old.traverse((o) => { if (o.geometry && !o.geometry._shared) o.geometry.dispose(); o.material?.dispose(); }); this.navGroup.remove(old); delete this.navLines[i]; }
    if (!points || points.length < 2) return;
    const g = new THREE.Group(), pos = []; for (const p of points) pos.push(p.x, 0.08, p.y);
    const lm = new LineMaterial({ color, linewidth: 2.4, dashed: true, dashSize: 0.28, gapSize: 0.18, worldUnits: false, transparent: true, opacity: 0.95 }); lm.resolution.set(this.width || 1, this.height || 1);
    const lg = new LineGeometry(); lg.setPositions(pos); const l = new Line2(lg, lm); l.computeLineDistances(); l.renderOrder = 3; g.add(l);
    const end = points[points.length - 1];
    const tgt = new THREE.Mesh(targetGeo, new THREE.MeshBasicMaterial({ color, map: getMarkerTex(), transparent: true, opacity: 0.9, depthWrite: false }));
    tgt.position.copy(V(end.x, end.y, 0.04)); g.add(tgt);
    const pin = new THREE.Group(); pin.position.copy(V(end.x, end.y, 1.0)); pin.userData.pulse = true;
    const pm = new THREE.MeshStandardMaterial({ color, roughness: 0.35, emissive: color, emissiveIntensity: 0.25 });
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 18, 12), pm); head.position.y = 0.2; pin.add(head);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.28, 18), pm.clone()); tip.rotation.x = Math.PI; tip.position.y = 0.04; pin.add(tip);
    g.add(pin);
    this.navGroup.add(g); this.navLines[i] = g;
  }
  setLayer(name, on) {
    this.layers[name] = on;
    if (name === 'gt' && this.gtGroup) this.gtGroup.visible = on;
    if (name === 'est' && this.estGroup) this.estGroup.visible = on;
    if (name === 'links' && this.linkGroup) this.linkGroup.visible = on;
    if (name === 'fov' && this.robots) for (const m of Object.values(this.robots)) m.userData.fov.visible = on;
  }
  setInsets(ins) { this.insets = { left: 0, bottom: 0, top: 0, ...ins }; this.resize(); }
  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight; if (!w || !h) return;
    this.width = w; this.height = h; this.renderer.setSize(w, h); this.labels.setSize(w, h);
    if (this.composer) { this.composer.setPixelRatio(this.renderer.getPixelRatio()); this.composer.setSize(w, h); }
    const { left, bottom, top } = this.insets;
    this.camera.aspect = w / h;
    // render the full canvas but centre the projection on the visible area
    this.camera.setViewOffset(w, h, -(left / 2), (bottom - top) / 2, w, h);
    this.camera.updateProjectionMatrix();
    for (const t of Object.values(this.trails || {})) t.lm.resolution.set(w, h);
    for (const l of [this.objLinks, this.encLinks]) l?.material.resolution.set(w, h);
    for (const g of Object.values(this.navLines || {})) g.traverse((o) => o.material?.resolution?.set(w, h));
    if (!this.userMoved) this.fitCamera();
  }
  // frame the whole building inside the visible (un-inset) part of the canvas
  fitCamera() {
    const { w: SW, h: SH } = this.size, { left, bottom, top } = this.insets;
    const W = this.width || 1, Hh = this.height || 1, m = 18;
    const x0 = ((left + m) / W) * 2 - 1, x1 = 1 - (m / W) * 2, y0 = -1 + ((bottom + m) / Hh) * 2, y1 = 1 - ((top + m) / Hh) * 2;
    const elev = (58 * Math.PI) / 180, tgt = new THREE.Vector3(SW / 2, 0, SH / 2), v = new THREE.Vector3();
    const pts = []; for (const x of [-0.3, SW + 0.3]) for (const z of [-0.3, SH + 0.3]) for (const y of [0, WALL_H]) pts.push([x, y, z]);
    const place = (d) => { this.camera.position.set(tgt.x, d * Math.sin(elev), tgt.z + d * Math.cos(elev)); this.camera.lookAt(tgt); this.camera.updateMatrixWorld(); };
    const fits = (d) => { place(d); return pts.every((p) => { v.set(...p).project(this.camera); return v.x >= x0 && v.x <= x1 && v.y >= y0 && v.y <= y1; }); };
    let lo = 2, hi = 400;
    if (x1 - x0 > 0.05 && y1 - y0 > 0.05) { for (let i = 0; i < 32; i++) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; } } else hi = Math.max(SW, SH) * 1.6;
    this.controls.target.copy(tgt); place(hi);
  }
  render(t) {
    for (const g of Object.values(this.navLines || {})) for (const c of g.children) if (c.userData.pulse) c.position.y = 0.95 + 0.12 * Math.sin(t / 250);
    for (const [i, m] of Object.entries(this.robots || {})) {
      const led = m.userData.led; if (!led) continue;
      led.material.color.setHex(this.active[i] ? (Math.sin(t / 180) > 0 ? 0x22c55e : 0x14532d) : 0x38bdf8);
    }
    this.controls.update();
    // adaptive quality: drop AO if the GPU can't keep ~30fps with it
    if (this.composer && this.aoForced == null && t) {
      if (this.lastT) this.frameTimes.push(t - this.lastT);
      if (this.frameTimes.length === 150) { const s = this.frameTimes.slice(30).sort((a, b) => a - b); if (s[s.length >> 1] > 34) this.dropAO(); this.frameTimes.push(0); }
    }
    this.lastT = t;
    if (this.composer) this.composer.render(); else this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }
}

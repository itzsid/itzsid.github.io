// three.js rendering of the building, objects, robots and estimates.
// World (x, y) maps to three.js (x, z = y); y-up.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { SENSOR } from './sensor.js';

export const COLORS = { red: 0xdc2626, blue: 0x2563eb, green: 0x16a34a, gray: 0x9ca3af, white: 0xf1f5f9, brown: 0x92400e, black: 0x1f2937, yellow: 0xfacc15, orange: 0xf97316 };
const TINTS = [0xeef2ff, 0xfdf2f8, 0xf8fafc, 0xf0fdf4, 0xfffbeb, 0xecfeff, 0xfef2f2, 0xf5f3ff, 0xf7fee7, 0xfff7ed, 0xf1f5f9];

const V = (x, y, h = 0) => new THREE.Vector3(x, h, y);

function mat(color, opts = {}) { return new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05, ...opts }); }
function box(w, h, d, color, y = h / 2, x = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
  m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; return m;
}
function cyl(r, h, color, y = h / 2, x = 0, z = 0, seg = 20) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), mat(color));
  m.position.set(x, y, z); m.castShadow = true; return m;
}

function objectMesh(o) {
  const c = COLORS[o.color], g = new THREE.Group();
  const add = (...ms) => ms.forEach((m) => g.add(m));
  const legs = (w, d, h, col) => [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => box(0.06, h, 0.06, col, h / 2, a * (w / 2 - 0.06), b * (d / 2 - 0.06)));
  switch (o.cat) {
    case 'workbench': add(box(1.6, 0.08, 0.8, c, 0.9), ...legs(1.6, 0.8, 0.86, 0x6b7280), box(1.5, 0.05, 0.7, 0x6b7280, 0.3)); break;
    case 'toolbox': add(box(0.6, 0.32, 0.34, c, 0.16), box(0.3, 0.05, 0.05, 0x111827, 0.36)); break;
    case '3d printer': add(box(0.6, 0.06, 0.6, 0x334155, 0.03), box(0.06, 0.6, 0.06, c, 0.33, -0.27, -0.27), box(0.06, 0.6, 0.06, c, 0.33, 0.27, -0.27), box(0.06, 0.6, 0.06, c, 0.33, -0.27, 0.27), box(0.06, 0.6, 0.06, c, 0.33, 0.27, 0.27), box(0.6, 0.06, 0.6, c, 0.62)); break;
    case 'fire extinguisher': add(cyl(0.1, 0.5, c, 0.25), cyl(0.04, 0.1, 0x111827, 0.55)); break;
    case 'desk': add(box(1.4, 0.06, 0.7, c, 0.75), ...legs(1.4, 0.7, 0.72, 0x44403c), box(0.5, 0.32, 0.04, 0x111827, 0.95, 0, -0.2)); break;
    case 'chair': add(box(0.45, 0.06, 0.45, c, 0.45), ...legs(0.45, 0.45, 0.43, 0x374151), box(0.45, 0.45, 0.06, c, 0.7, 0, -0.2)); break;
    case 'bookshelf': add(box(1.2, 1.8, 0.35, c, 0.9), ...[0.35, 0.8, 1.25].map((y) => box(1.1, 0.25, 0.3, [0xfca5a5, 0x93c5fd, 0xfde68a][Math.round(y * 2) % 3], y + 0.15, 0, 0.03))); break;
    case 'plant': add(cyl(0.18, 0.35, 0x92400e, 0.175), (() => { const s = new THREE.Mesh(new THREE.IcosahedronGeometry(0.35, 1), mat(c, { flatShading: true })); s.position.y = 0.7; s.castShadow = true; return s; })()); break;
    case 'bench': add(box(1.6, 0.08, 0.42, c, 0.45), ...legs(1.6, 0.42, 0.43, 0x4b5563)); break;
    case 'trash can': add(cyl(0.22, 0.6, c, 0.3)); break;
    case 'vending machine': add(box(0.9, 1.8, 0.75, c, 0.9), box(0.6, 1.0, 0.02, 0x60a5fa, 1.1, 0, 0.38)); break;
    case 'fridge': add(box(0.8, 1.8, 0.75, c, 0.9), box(0.04, 0.5, 0.04, 0x94a3b8, 1.2, 0.3, 0.39)); break;
    case 'table': add(box(1.2, 0.06, 0.8, c, 0.74), ...legs(1.2, 0.8, 0.71, 0x44403c)); break;
    case 'coffee machine': add(box(0.36, 0.45, 0.36, c, 0.225 + 0.9), box(0.6, 0.9, 0.5, 0xe5e7eb, 0.45)); break;
    case 'sofa': add(box(2.0, 0.42, 0.9, c, 0.21), box(2.0, 0.45, 0.2, c, 0.6, 0, -0.35), box(0.2, 0.3, 0.9, c, 0.55, -0.9), box(0.2, 0.3, 0.9, c, 0.55, 0.9)); break;
    case 'tv': add(box(0.6, 0.5, 0.4, 0x6b7280, 0.25), box(1.3, 0.75, 0.06, c, 0.95), box(1.2, 0.66, 0.02, 0x1e3a8a, 0.95, 0, 0.035)); break;
    case 'lamp': add(cyl(0.18, 0.04, 0x374151, 0.02), cyl(0.025, 1.4, 0x374151, 0.72), (() => { const s = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.32, 20, 1, true), mat(c, { side: THREE.DoubleSide, emissive: 0xfacc15, emissiveIntensity: 0.25 })); s.position.y = 1.5; return s; })()); break;
    case 'armchair': add(box(0.9, 0.42, 0.9, c, 0.21), box(0.9, 0.45, 0.2, c, 0.6, 0, -0.35)); break;
    case 'rack': { add(...[[-1.9, -0.4], [1.9, -0.4], [-1.9, 0.4], [1.9, 0.4]].map(([a, b]) => box(0.08, 2.2, 0.08, 0x475569, 1.1, b, a))); for (const y of [0.4, 1.1, 1.8]) add(box(1.0, 0.05, 4.2, 0x64748b, y)); for (const [y, z, col] of [[0.6, -1.2, 0xf97316], [0.6, 0.6, 0x92400e], [1.3, -0.4, 0x2563eb], [1.3, 1.3, 0xf97316], [2.0, -1.5, 0x92400e], [2.0, 0.2, 0x16a34a]]) add(box(0.7, 0.4, 0.8, col, y, 0, z)); break; }
    case 'pallet': add(box(1.2, 0.14, 1.0, c, 0.07), box(1.0, 0.5, 0.8, 0xd6b38a, 0.39)); break;
    case 'forklift': add(box(1.0, 0.6, 1.6, c, 0.5), box(0.9, 0.08, 0.9, 0x1f2937, 1.25, 0, 0.1), box(0.06, 1.8, 0.06, 0x1f2937, 0.9, -0.35, 0.85), box(0.06, 1.8, 0.06, 0x1f2937, 0.9, 0.35, 0.85), box(0.5, 0.05, 0.6, 0x6b7280, 0.1, 0, 1.15)); break;
    case 'box': add(box(0.55, 0.45, 0.55, c, 0.225)); break;
    case 'cart': add(box(0.6, 0.06, 0.9, c, 0.5), box(0.6, 0.06, 0.9, c, 0.15), box(0.04, 0.5, 0.04, 0x334155, 0.75, -0.28, -0.43), box(0.04, 0.5, 0.04, 0x334155, 0.75, 0.28, -0.43)); break;
    case 'safety cone': add((() => { const m = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.5, 16), mat(c)); m.position.y = 0.25; m.castShadow = true; return m; })(), box(0.34, 0.03, 0.34, 0x111827, 0.015)); break;
    case 'charging station': add(box(0.5, 0.6, 0.25, 0x334155, 0.3), box(0.3, 0.12, 0.02, c, 0.45, 0, 0.13)); break;
    case 'bed': add(box(1.0, 0.45, 2.0, 0x92400e, 0.225), box(0.95, 0.15, 1.9, c, 0.52), box(0.8, 0.12, 0.35, 0xffffff, 0.64, 0, -0.75)); break;
    case 'hospital bed': add(box(0.95, 0.12, 2.0, 0x94a3b8, 0.55), box(0.9, 0.12, 1.9, c, 0.67), box(0.95, 0.5, 0.06, 0x94a3b8, 0.8, 0, -1.0), ...legs(0.95, 2.0, 0.5, 0x64748b)); break;
    case 'sink': add(box(0.8, 0.85, 0.55, 0xe5e7eb, 0.425), box(0.5, 0.05, 0.35, 0x93c5fd, 0.88)); break;
    case 'wardrobe': add(box(1.2, 2.0, 0.6, c, 1.0), box(0.02, 1.8, 0.02, 0x111827, 1.0, 0, 0.31)); break;
    case 'dining table': add(box(1.6, 0.06, 0.9, c, 0.74), ...legs(1.6, 0.9, 0.71, 0x44403c)); break;
    case 'backpack': add(box(0.32, 0.42, 0.18, c, 0.21), box(0.26, 0.15, 0.06, 0x111827, 0.18, 0, 0.11)); break;
    case 'laptop': add(box(0.34, 0.02, 0.24, c, 0.76), box(0.34, 0.22, 0.02, c, 0.87, 0, -0.12), box(0.4, 0.74, 0.4, 0xd6d3d1, 0.37)); break;
    case 'mug': add(cyl(0.05, 0.1, c, 0.8), box(0.5, 0.75, 0.5, 0xd6d3d1, 0.375)); break;
    case 'washing machine': add(box(0.6, 0.85, 0.6, c, 0.425), cyl(0.18, 0.02, 0x64748b, 0.45, 0, 0.31)); break;
    case 'wheelchair': add(box(0.5, 0.06, 0.45, c, 0.5), box(0.5, 0.45, 0.06, c, 0.75, 0, -0.22), ...[-0.3, 0.3].map((x) => { const w = cyl(0.28, 0.04, 0x334155, 0.3, x, 0); w.rotation.z = Math.PI / 2; return w; })); break;
    case 'iv stand': add(cyl(0.2, 0.04, 0x334155, 0.05), cyl(0.02, 1.8, 0x94a3b8, 0.95), box(0.12, 0.2, 0.05, 0x93c5fd, 1.7, 0.1)); break;
    case 'medical cart': add(box(0.6, 0.9, 0.45, c, 0.45), box(0.62, 0.04, 0.47, 0xe5e7eb, 0.92)); break;
    case 'defibrillator': add(box(0.3, 0.35, 0.12, c, 1.1), box(0.18, 0.08, 0.02, 0xffffff, 1.15, 0, 0.07), box(0.06, 1.0, 0.06, 0x94a3b8, 0.5)); break;
    case 'reception desk': add(box(2.4, 1.05, 0.7, c, 0.525), box(2.4, 0.05, 0.8, 0x94a3b8, 1.07)); break;
    case 'door': add(box(0.08, 1.2, 0.08, 0xcbd5e1, 0.6, 0, -0.75), box(0.08, 1.2, 0.08, 0xcbd5e1, 0.6, 0, 0.75)); break;
    default: add(box(0.4, 0.4, 0.4, c));
  }
  g.position.copy(V(o.x, o.y)); g.rotation.y = o.cat === 'rack' ? 0 : -o.th;
  g.userData = { object: o };
  return g;
}

function robotMesh(robot) {
  const g = new THREE.Group();
  const body = box(0.56, 0.22, 0.42, robot.color, 0.2); g.add(body);
  for (const [x, z] of [[-0.18, -0.24], [0.18, -0.24], [-0.18, 0.24], [0.18, 0.24]]) {
    const w = cyl(0.09, 0.06, 0x111827, 0.09, x, z, 16); w.rotation.x = Math.PI / 2; g.add(w);
  }
  g.add(cyl(0.025, 0.4, 0x334155, 0.5, -0.12, 0), box(0.12, 0.12, 0.2, 0x0f172a, 0.74, -0.12, 0));
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 12), new THREE.MeshBasicMaterial({ color: 0x67e8f9 }));
  eye.position.set(-0.05, 0.74, 0); g.add(eye);
  // field of view wedge on the floor (local +x is forward)
  const fov = new THREE.Mesh(new THREE.CircleGeometry(SENSOR.range, 32, -SENSOR.fov / 2, SENSOR.fov),
    new THREE.MeshBasicMaterial({ color: robot.color, transparent: true, opacity: 0.06, depthWrite: false, side: THREE.DoubleSide }));
  fov.rotation.x = -Math.PI / 2; fov.position.y = 0.02; g.add(fov);
  g.userData.fov = fov;
  return g;
}

function textLabel(text, cls) {
  const d = document.createElement('div'); d.className = cls; d.textContent = text;
  return new CSS2DObject(d);
}

export class SceneView {
  constructor(container) {
    this.container = container;
    const r = new THREE.WebGLRenderer({ antialias: true });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(r.domElement); this.renderer = r;
    this.labels = new CSS2DRenderer(); this.labels.domElement.className = 'labels-layer'; container.appendChild(this.labels.domElement);
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(0xeef0f4);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 400);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true; this.controls.maxPolarAngle = Math.PI * 0.47; this.controls.minDistance = 5; this.controls.maxDistance = 120;
    this.controls.addEventListener('start', () => { this.userMoved = true; });
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xcbd5e1, 1.6));
    this.sun = new THREE.DirectionalLight(0xffffff, 1.5); this.sun.castShadow = true; this.sun.shadow.mapSize.set(1024, 1024);
    this.scene.add(this.sun, this.sun.target);
    this.layers = { gt: false, est: true, fov: false, links: true };
    this.insets = { left: 0, bottom: 0, top: 0 };
    this.size = { w: 24, h: 16 };
    new ResizeObserver(() => this.resize()).observe(container); this.resize();
  }

  clear() {
    if (!this.world) return;
    const drop = (g) => { g.traverse((o) => { o.geometry?.dispose?.(); if (o.material && !o.material._shared) o.material.dispose?.(); if (o.isCSS2DObject) o.element.remove(); }); this.scene.remove(g); };
    drop(this.world); drop(this.dyn);
  }

  load(team) {
    this.clear();
    const sc = team.scene; this.size = { w: sc.w, h: sc.h };
    this.world = new THREE.Group(); this.dyn = new THREE.Group(); this.scene.add(this.world, this.dyn);
    const S = Math.max(sc.w, sc.h);
    Object.assign(this.sun.shadow.camera, { left: -S * 0.7, right: S * 0.7, top: S * 0.6, bottom: -S * 0.6, near: 1, far: 120 });
    this.sun.position.set(sc.w * 0.35, 30, sc.h * 0.2); this.sun.target.position.set(sc.w / 2, 0, sc.h / 2); this.sun.shadow.camera.updateProjectionMatrix();
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(sc.w, sc.h), mat(0xffffff)); floor.rotation.x = -Math.PI / 2; floor.position.set(sc.w / 2, 0, sc.h / 2); floor.receiveShadow = true; this.world.add(floor);
    sc.rooms.forEach((rm, i) => {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(rm.x1 - rm.x0, rm.y1 - rm.y0), mat(TINTS[i % TINTS.length]));
      p.rotation.x = -Math.PI / 2; p.position.set((rm.x0 + rm.x1) / 2, 0.004 + i * 0.0003, (rm.y0 + rm.y1) / 2); p.receiveShadow = true; this.world.add(p);
      const l = textLabel(rm.name, 'room-label'); l.position.copy(V((rm.x0 + rm.x1) / 2, (rm.y0 + rm.y1) / 2, 0.05)); this.world.add(l);
    });
    const grid = new THREE.GridHelper(S, S, 0xe2e8f0, 0xe2e8f0); grid.position.set(sc.w / 2, 0.01, sc.h / 2); grid.material.transparent = true; grid.material.opacity = 0.45; this.world.add(grid);
    const wm = mat(0xffffff, { roughness: 0.9 }), cap = new THREE.MeshBasicMaterial({ color: 0x94a3b8 });
    for (const [x1, y1, x2, y2] of sc.walls) {
      const len = Math.hypot(x2 - x1, y2 - y1), h = 1.0;
      const m = new THREE.Mesh(new THREE.BoxGeometry(len + 0.15, h, 0.15), wm);
      m.position.set((x1 + x2) / 2, h / 2, (y1 + y2) / 2); m.rotation.y = -Math.atan2(y2 - y1, x2 - x1); m.castShadow = true; m.receiveShadow = true; this.world.add(m);
      const c = new THREE.Mesh(new THREE.BoxGeometry(len + 0.15, 0.02, 0.16), cap); c.position.set(m.position.x, h + 0.01, m.position.z); c.rotation.y = m.rotation.y; this.world.add(c);
    }
    for (const o of sc.objects) this.world.add(objectMesh(o));
    // robots
    this.robots = {}; this.trails = {}; this.rings = {}; this.navLines = {};
    this.gtGroup = new THREE.Group(); this.gtGroup.visible = this.layers.gt; this.dyn.add(this.gtGroup);
    this.estGroup = new THREE.Group(); this.estGroup.visible = this.layers.est; this.dyn.add(this.estGroup);
    this.linkGroup = new THREE.Group(); this.linkGroup.visible = this.layers.links; this.dyn.add(this.linkGroup);
    this.navGroup = new THREE.Group(); this.dyn.add(this.navGroup);
    for (const rb of team.robots) {
      const m = robotMesh(rb); m.userData.fov.visible = this.layers.fov; this.dyn.add(m);
      const tag = textLabel(rb.name.replace('Robot ', 'R'), 'robot-tag'); tag.element.style.background = rb.css; tag.position.set(0, 1.15, 0); m.add(tag);
      this.robots[rb.i] = m;
      const lm = new LineMaterial({ color: rb.color, linewidth: 2, worldUnits: false, transparent: true, opacity: 0.85 }); lm.resolution.set(this.width || 1, this.height || 1);
      const trail = new Line2(new LineGeometry(), lm); trail.visible = false; this.estGroup.add(trail);
      const gtl = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0x64748b, dashSize: 0.18, gapSize: 0.14, transparent: true, opacity: 0.6 })); this.gtGroup.add(gtl);
      this.trails[rb.i] = { trail, gtl, lm, n: -1 }; this.rings[rb.i] = {};
    }
    this.userMoved = false; this.fitCamera();
  }

  setRobotPose(i, p) { const m = this.robots[i]; if (m) { m.position.copy(V(p.x, p.y)); m.rotation.y = -p.th; } }
  setTrail(i, est, gt, force) {
    const t = this.trails[i]; if (!t) return;
    if (!force && t.n === est.length) return;
    t.n = est.length;
    if (est.length >= 2) {
      const pos = []; for (const p of est) pos.push(p.x, 0.06, p.y);
      t.trail.geometry.dispose(); t.trail.geometry = new LineGeometry(); t.trail.geometry.setPositions(pos); t.trail.computeLineDistances(); t.trail.visible = true;
    } else t.trail.visible = false;
    t.gtl.geometry.dispose(); t.gtl.geometry = new THREE.BufferGeometry().setFromPoints(gt.map((p) => V(p.x, p.y, 0.04))); t.gtl.computeLineDistances();
  }
  setLandmarks(i, lms, color) {
    const rings = this.rings[i]; if (!rings) return; const seen = new Set();
    for (const [key, p] of Object.entries(lms)) {
      seen.add(key); let r = rings[key];
      if (!r) { r = new THREE.Mesh(new THREE.RingGeometry(0.18, 0.27, 24), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false })); r.rotation.x = -Math.PI / 2; this.estGroup.add(r); rings[key] = r; }
      r.position.copy(V(p.x, p.y, 0.03 + i * 0.002));
    }
    for (const [k, r] of Object.entries(rings)) if (!seen.has(k)) { r.geometry.dispose(); r.material.dispose(); this.estGroup.remove(r); delete rings[k]; }
  }
  // cross-robot links: [{a:{x,y}, b:{x,y}, kind:'obj'|'enc'}]
  setLinks(list) {
    this.linkGroup.children.forEach((c) => { c.geometry.dispose(); c.material.dispose(); });
    this.linkGroup.clear();
    for (const m of list) {
      const a = V(m.a.x, m.a.y, 0.05), b = V(m.b.x, m.b.y, 0.05), mid = a.clone().add(b).multiplyScalar(0.5); mid.y = 0.5 + 0.08 * a.distanceTo(b);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(new THREE.QuadraticBezierCurve3(a, mid, b).getPoints(16)),
        new THREE.LineBasicMaterial({ color: m.kind === 'enc' ? 0x9333ea : 0x16a34a, transparent: true, opacity: 0.8 }));
      this.linkGroup.add(line);
    }
  }
  setNavPath(i, points, color) {
    const old = this.navLines[i]; if (old) { old.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); }); this.navGroup.remove(old); delete this.navLines[i]; }
    if (!points || points.length < 2) return;
    const g = new THREE.Group(), pos = []; for (const p of points) pos.push(p.x, 0.08, p.y);
    const lm = new LineMaterial({ color, linewidth: 2.2, dashed: true, dashSize: 0.3, gapSize: 0.2, worldUnits: false }); lm.resolution.set(this.width, this.height);
    const lg = new LineGeometry(); lg.setPositions(pos); const l = new Line2(lg, lm); l.computeLineDistances(); g.add(l);
    const end = points[points.length - 1]; const pin = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.36, 14), new THREE.MeshBasicMaterial({ color }));
    pin.rotation.x = Math.PI; pin.position.copy(V(end.x, end.y, 1.1)); pin.userData.pulse = true; g.add(pin);
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
    const { left, bottom, top } = this.insets;
    this.camera.aspect = w / h;
    // render the full canvas but centre the projection on the visible area
    this.camera.setViewOffset(w, h, -(left / 2), (bottom - top) / 2, w, h);
    this.camera.updateProjectionMatrix();
    for (const t of Object.values(this.trails || {})) t.lm.resolution.set(w, h);
    if (!this.userMoved) this.fitCamera();
  }
  fitCamera() {
    const { w: SW, h: SH } = this.size, { left, bottom, top } = this.insets;
    const vw = Math.max(200, (this.width || 1) - left), vh = Math.max(200, (this.height || 1) - bottom - top);
    const vfFull = (this.camera.fov * Math.PI) / 180, vf = 2 * Math.atan(Math.tan(vfFull / 2) * (vh / (this.height || vh)));
    const hf = 2 * Math.atan(Math.tan(vf / 2) * (vw / vh)), elev = (58 * Math.PI) / 180;
    const d = Math.max((SW / 2 + 1.2) / Math.tan(hf / 2), ((SH * Math.sin(elev)) / 2 + 1.2) / Math.tan(vf / 2));
    this.controls.target.set(SW / 2, 0, SH / 2); this.camera.position.set(SW / 2, d * Math.sin(elev), SH / 2 + d * Math.cos(elev)); this.camera.lookAt(this.controls.target);
  }
  render(t) {
    for (const g of Object.values(this.navLines || {})) for (const c of g.children) if (c.userData.pulse) c.position.y = 1.0 + 0.15 * Math.sin(t / 250);
    this.controls.update(); this.renderer.render(this.scene, this.camera); this.labels.render(this.scene, this.camera);
  }
}

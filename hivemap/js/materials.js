// Procedural PBR-ish materials: canvas textures for floors and wood grain,
// plus a small palette of shared materials (metal, plastic, fabric, glass).
import * as THREE from 'three';

const cache = new Map();
function canvasTex(key, size, draw, repeat = [1, 1]) {
  const k = `${key}|${repeat}`;
  if (cache.has(k)) return cache.get(k);
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'); draw(g, size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  cache.set(k, t); return t;
}
let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const shade = (hex, f) => { const c = new THREE.Color(hex); c.offsetHSL(0, 0, f); return `#${c.getHexString()}`; };

const FLOORS = {
  wood: (g, s) => {   // narrow oak planks with grain, staggered joints
    const base = ['#c9a37b', '#bf966d', '#d0ab84', '#b98e66', '#c49c74'];
    const n = 10, pw = s / n;
    for (let i = 0; i < n; i++) {
      let y = -rnd() * s;
      while (y < s) {
        const L = s * (0.35 + rnd() * 0.4);
        g.fillStyle = base[Math.floor(rnd() * base.length)]; g.fillRect(i * pw, y, pw, L);
        for (let k = 0; k < 7; k++) { g.strokeStyle = `rgba(80,50,25,${0.06 + rnd() * 0.08})`; g.lineWidth = 0.6 + rnd(); g.beginPath(); const x = i * pw + rnd() * pw; g.moveTo(x, y); g.bezierCurveTo(x + 2, y + L * 0.3, x - 2, y + L * 0.6, x + 1, y + L); g.stroke(); }
        g.fillStyle = 'rgba(60,35,15,0.4)'; g.fillRect(i * pw, y, pw, 1.5);
        y += L;
      }
      g.fillStyle = 'rgba(60,35,15,0.35)'; g.fillRect(i * pw, 0, 1.5, s);
    }
  },
  tile: (g, s) => {
    const n = 8, w = s / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const v = 222 + Math.floor(rnd() * 12); g.fillStyle = `rgb(${v},${v - 2},${v - 7})`; g.fillRect(i * w, j * w, w, w); }
    g.strokeStyle = '#a9adb3'; g.lineWidth = 2.5; for (let i = 0; i <= n; i++) { g.beginPath(); g.moveTo(i * w, 0); g.lineTo(i * w, s); g.moveTo(0, i * w); g.lineTo(s, i * w); g.stroke(); }
  },
  concrete: (g, s) => {
    g.fillStyle = '#a9adb1'; g.fillRect(0, 0, s, s);
    for (let k = 0; k < 9000; k++) { const v = 150 + Math.floor(rnd() * 70); g.fillStyle = `rgba(${v},${v},${v},0.25)`; g.fillRect(rnd() * s, rnd() * s, 1 + rnd() * 2, 1 + rnd() * 2); }
    g.strokeStyle = 'rgba(90,95,100,0.35)'; g.lineWidth = 2; g.beginPath(); g.moveTo(0, s / 2); g.lineTo(s, s / 2); g.moveTo(s / 2, 0); g.lineTo(s / 2, s); g.stroke();
  },
  carpet: (g, s) => {
    g.fillStyle = '#7d8796'; g.fillRect(0, 0, s, s);
    for (let k = 0; k < 14000; k++) { const v = Math.floor(rnd() * 40) - 20; g.fillStyle = `rgba(${125 + v},${135 + v},${150 + v},0.35)`; g.fillRect(rnd() * s, rnd() * s, 1.5, 1.5); }
    const w = s / 4; g.strokeStyle = 'rgba(40,45,55,0.25)'; g.lineWidth = 1.5; for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(i * w, 0); g.lineTo(i * w, s); g.moveTo(0, i * w); g.lineTo(s, i * w); g.stroke(); }
  },
  vinyl: (g, s) => {
    g.fillStyle = '#c9d3cf'; g.fillRect(0, 0, s, s);
    for (let k = 0; k < 2500; k++) { g.fillStyle = rnd() < 0.5 ? 'rgba(160,175,170,0.35)' : 'rgba(250,255,252,0.5)'; g.fillRect(rnd() * s, rnd() * s, 2 + rnd() * 3, 1 + rnd() * 2); }
    const w = s / 4; g.strokeStyle = 'rgba(140,150,148,0.35)'; for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(i * w, 0); g.lineTo(i * w, s); g.moveTo(0, i * w); g.lineTo(s, i * w); g.stroke(); }
  },
};

export function floorTypeFor(scene, room) {
  const n = room.toLowerCase();
  if (/kitchen|bath|sales|checkout|reception|lobby/.test(n)) return 'tile';
  if (/stock/.test(n)) return 'concrete';
  if (/wet lab|robotics|seminar|nurse|room \d/.test(n)) return 'vinyl';
  if (/storage|loading/.test(n)) return 'concrete';
  if (/office|control/.test(n)) return 'carpet';
  if (/room \d|nurse|corridor/.test(n) || scene.id === 'hospital') return 'vinyl';
  if (/lab|hall/.test(n)) return scene.id === 'office' ? 'vinyl' : 'wood';
  return 'wood';
}
export function floorMaterial(type, w, h) {
  const meters = { wood: 2.4, tile: 2.4, concrete: 6, carpet: 3, vinyl: 3 }[type];
  const base = canvasTex(type, type === 'wood' ? 1024 : 512, FLOORS[type]);
  const map = base.clone(); map.repeat.set(w / meters, h / meters); map.needsUpdate = true;
  return new THREE.MeshStandardMaterial({ map, roughness: { wood: 0.5, tile: 0.3, concrete: 0.85, carpet: 1.0, vinyl: 0.42 }[type], metalness: 0 });
}

// wood grain for furniture, tinted by base colour
function woodTex(hex) {
  return canvasTex(`wood-${hex}`, 256, (g, s) => {
    g.fillStyle = hex; g.fillRect(0, 0, s, s);
    for (let k = 0; k < 40; k++) {
      g.strokeStyle = `rgba(40,20,5,${0.05 + rnd() * 0.1})`; g.lineWidth = 1 + rnd() * 2; g.beginPath();
      const y = rnd() * s; g.moveTo(0, y); g.bezierCurveTo(s * 0.3, y + (rnd() - 0.5) * 20, s * 0.6, y + (rnd() - 0.5) * 20, s, y + (rnd() - 0.5) * 10); g.stroke();
    }
  });
}

// brushed metal: fine horizontal streaks (greyscale, tinted by material colour)
function brushedTex() {
  return canvasTex('brushed', 256, (g, s) => {
    g.fillStyle = '#d8d8d8'; g.fillRect(0, 0, s, s);
    for (let k = 0; k < 700; k++) { const v = 170 + Math.floor(rnd() * 85); g.fillStyle = `rgba(${v},${v},${v},0.35)`; g.fillRect(0, rnd() * s, s, 0.6 + rnd()); }
  });
}
// woven fabric: subtle cross-hatch + speckle
function fabricTex() {
  return canvasTex('fabric', 128, (g, s) => {
    g.fillStyle = '#e6e6e6'; g.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y += 2) { g.fillStyle = `rgba(0,0,0,${0.04 + rnd() * 0.04})`; g.fillRect(0, y, s, 1); }
    for (let x = 0; x < s; x += 2) { g.fillStyle = `rgba(255,255,255,${0.05 + rnd() * 0.05})`; g.fillRect(x, 0, 1, s); }
    for (let k = 0; k < 900; k++) { const v = Math.floor(rnd() * 60) + 180; g.fillStyle = `rgba(${v},${v},${v},0.25)`; g.fillRect(rnd() * s, rnd() * s, 1, 1); }
  }, [3, 3]);
}
// corrugated cardboard with a tape strip down the middle
function cardboardTex() {
  return canvasTex('cardboard', 128, (g, s) => {
    g.fillStyle = '#c49a6c'; g.fillRect(0, 0, s, s);
    for (let k = 0; k < 1500; k++) { g.fillStyle = rnd() < 0.5 ? 'rgba(120,80,40,0.10)' : 'rgba(240,210,170,0.10)'; g.fillRect(rnd() * s, rnd() * s, 1 + rnd() * 3, 1); }
    g.fillStyle = 'rgba(200,170,120,0.85)'; g.fillRect(s * 0.42, 0, s * 0.16, s);
    g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(s * 0.42, 0, 2, s);
  });
}
// a desktop-ish screen: soft gradient + a few UI blocks
function screenTex(kind) {
  return canvasTex(`screen-${kind}`, 128, (g, s) => {
    const gr = g.createLinearGradient(0, 0, s, s);
    if (kind === 'tv') { gr.addColorStop(0, '#1b2a4a'); gr.addColorStop(0.6, '#2b5d8a'); gr.addColorStop(1, '#e09a5a'); }
    else if (kind === 'med') { gr.addColorStop(0, '#04140f'); gr.addColorStop(1, '#0b2a22'); }
    else { gr.addColorStop(0, '#203a5c'); gr.addColorStop(1, '#3b6ea5'); }
    g.fillStyle = gr; g.fillRect(0, 0, s, s);
    if (kind === 'med') { g.strokeStyle = '#34d399'; g.lineWidth = 3; g.beginPath(); for (let x = 0; x < s; x += 4) { const y = s / 2 + (x % 40 === 20 ? -30 : x % 40 === 24 ? 20 : 0); x ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke(); }
    else if (kind !== 'tv') {
      g.fillStyle = 'rgba(255,255,255,0.85)'; g.fillRect(0, 0, s, 8);
      g.fillStyle = 'rgba(255,255,255,0.75)'; g.fillRect(10, 18, s * 0.55, s * 0.5);
      g.fillStyle = 'rgba(255,255,255,0.35)'; for (let k = 0; k < 5; k++) g.fillRect(s * 0.7, 20 + k * 12, s * 0.22, 6);
    }
  });
}

const M = {};
const mk = (key, fn) => (M[key] ||= Object.assign(fn(), { _shared: true }));
export const mats = {
  sharedMat: (key, fn) => mk(key, fn),
  wood: (hex = '#a0703f') => mk(`wood${hex}`, () => new THREE.MeshStandardMaterial({ map: woodTex(hex), roughness: 0.55 })),
  paint: (hex, rough = 0.55) => mk(`paint${hex}${rough}`, () => new THREE.MeshStandardMaterial({ color: hex, roughness: rough, metalness: 0.05 })),
  plastic: (hex) => mk(`plastic${hex}`, () => new THREE.MeshStandardMaterial({ color: hex, roughness: 0.38, metalness: 0 })),
  metal: (hex = '#b8bec6', rough = 0.32) => mk(`metal${hex}${rough}`, () => new THREE.MeshStandardMaterial({ color: hex, roughness: rough, metalness: 0.85 })),
  brushed: (hex = '#c3c8ce') => mk(`brushed${hex}`, () => new THREE.MeshStandardMaterial({ color: hex, map: brushedTex(), roughness: 0.38, metalness: 0.8 })),
  chrome: () => mk('chrome', () => new THREE.MeshStandardMaterial({ color: '#e5e7eb', roughness: 0.12, metalness: 1 })),
  fabric: (hex) => mk(`fabric${hex}`, () => new THREE.MeshStandardMaterial({ color: hex, map: fabricTex(), roughness: 0.95, metalness: 0 })),
  leather: (hex) => mk(`leather${hex}`, () => new THREE.MeshStandardMaterial({ color: hex, roughness: 0.55, metalness: 0 })),
  rubber: () => mk('rubber', () => new THREE.MeshStandardMaterial({ color: '#1d2025', roughness: 0.9 })),
  cardboard: () => mk('cardboard', () => new THREE.MeshStandardMaterial({ map: cardboardTex(), roughness: 0.9 })),
  film: () => mk('film', () => new THREE.MeshStandardMaterial({ color: '#f1f5f9', roughness: 0.2, transparent: true, opacity: 0.42, depthWrite: false })),
  ceramic: (hex = '#f8fafc') => mk(`ceramic${hex}`, () => new THREE.MeshStandardMaterial({ color: hex, roughness: 0.18, metalness: 0 })),
  screen: (kind = 'pc') => mk(`screen${kind}`, () => new THREE.MeshStandardMaterial({ color: '#000000', roughness: 0.2, metalness: 0.1, emissive: '#ffffff', emissiveMap: screenTex(kind), emissiveIntensity: 0.9 })),
  screenOff: () => mk('screenOff', () => new THREE.MeshStandardMaterial({ color: '#0b0f17', roughness: 0.12, metalness: 0.4 })),
  glass: () => mk('glass', () => new THREE.MeshStandardMaterial({ color: '#cfe3f3', roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.35, depthWrite: false })),
  leaf: (hex) => mk(`leaf${hex}`, () => new THREE.MeshStandardMaterial({ color: hex, roughness: 0.6, side: THREE.DoubleSide })),
  soil: () => mk('soil', () => new THREE.MeshStandardMaterial({ color: '#3b2a1e', roughness: 1 })),
  emissive: (hex, k = 0.9) => mk(`em${hex}${k}`, () => new THREE.MeshStandardMaterial({ color: hex, emissive: hex, emissiveIntensity: k, roughness: 0.4 })),
  wall: () => mk('wall', () => new THREE.MeshStandardMaterial({ color: '#f4f2ee', roughness: 0.92 })),
  wallTop: () => mk('wallTop', () => new THREE.MeshStandardMaterial({ color: '#3a3f47', roughness: 0.7 })),
  baseboard: () => mk('baseboard', () => new THREE.MeshStandardMaterial({ color: '#cfccc5', roughness: 0.6 })),
  frame: () => mk('frame', () => new THREE.MeshStandardMaterial({ color: '#e9e4da', roughness: 0.5 })),
  ground: () => mk('ground', () => new THREE.MeshStandardMaterial({ color: '#e3e6ea', roughness: 1 })),
};
export const tone = (name) => ({ red: '#c62828', blue: '#2f5fb8', green: '#2e7d32', gray: '#8d939b', white: '#eceff1', brown: '#7b5232', black: '#26292e', yellow: '#e8b923', orange: '#e8742a' }[name] || '#999999');
export { shade, rnd };

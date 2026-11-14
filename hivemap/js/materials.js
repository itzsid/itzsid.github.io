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
  wood: (g, s) => {   // planks with grain
    const base = ['#c8a27a', '#bf9670', '#cfa982', '#b88d66'];
    const pw = s / 6;
    for (let i = 0; i < 6; i++) {
      let y = -rnd() * s;
      while (y < s) {
        const L = s * (0.4 + rnd() * 0.5);
        g.fillStyle = base[Math.floor(rnd() * base.length)]; g.fillRect(i * pw, y, pw, L);
        g.strokeStyle = 'rgba(80,50,25,0.10)';
        for (let k = 0; k < 9; k++) { g.beginPath(); const x = i * pw + rnd() * pw; g.moveTo(x, y); g.bezierCurveTo(x + 3, y + L * 0.3, x - 3, y + L * 0.6, x + 1, y + L); g.stroke(); }
        g.fillStyle = 'rgba(60,35,15,0.35)'; g.fillRect(i * pw, y, pw, 1.5);
        y += L;
      }
      g.fillStyle = 'rgba(60,35,15,0.3)'; g.fillRect(i * pw, 0, 1.5, s);
    }
  },
  tile: (g, s) => {
    const n = 8, w = s / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const v = 236 + Math.floor(rnd() * 10); g.fillStyle = `rgb(${v},${v},${v - 4})`; g.fillRect(i * w, j * w, w, w); }
    g.strokeStyle = '#c9ccd1'; g.lineWidth = 2; for (let i = 0; i <= n; i++) { g.beginPath(); g.moveTo(i * w, 0); g.lineTo(i * w, s); g.moveTo(0, i * w); g.lineTo(s, i * w); g.stroke(); }
  },
  concrete: (g, s) => {
    g.fillStyle = '#b9bcc0'; g.fillRect(0, 0, s, s);
    for (let k = 0; k < 9000; k++) { const v = 150 + Math.floor(rnd() * 70); g.fillStyle = `rgba(${v},${v},${v},0.25)`; g.fillRect(rnd() * s, rnd() * s, 1 + rnd() * 2, 1 + rnd() * 2); }
    g.strokeStyle = 'rgba(90,95,100,0.35)'; g.lineWidth = 2; g.beginPath(); g.moveTo(0, s / 2); g.lineTo(s, s / 2); g.moveTo(s / 2, 0); g.lineTo(s / 2, s); g.stroke();
  },
  carpet: (g, s) => {
    g.fillStyle = '#7d8796'; g.fillRect(0, 0, s, s);
    for (let k = 0; k < 14000; k++) { const v = Math.floor(rnd() * 40) - 20; g.fillStyle = `rgba(${125 + v},${135 + v},${150 + v},0.35)`; g.fillRect(rnd() * s, rnd() * s, 1.5, 1.5); }
    const w = s / 4; g.strokeStyle = 'rgba(40,45,55,0.25)'; g.lineWidth = 1.5; for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(i * w, 0); g.lineTo(i * w, s); g.moveTo(0, i * w); g.lineTo(s, i * w); g.stroke(); }
  },
  vinyl: (g, s) => {
    g.fillStyle = '#dfe6e3'; g.fillRect(0, 0, s, s);
    for (let k = 0; k < 2500; k++) { g.fillStyle = rnd() < 0.5 ? 'rgba(160,175,170,0.35)' : 'rgba(250,255,252,0.5)'; g.fillRect(rnd() * s, rnd() * s, 2 + rnd() * 3, 1 + rnd() * 2); }
    const w = s / 4; g.strokeStyle = 'rgba(140,150,148,0.35)'; for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(i * w, 0); g.lineTo(i * w, s); g.moveTo(0, i * w); g.lineTo(s, i * w); g.stroke(); }
  },
};

export function floorTypeFor(scene, room) {
  const n = room.toLowerCase();
  if (/kitchen|bath/.test(n)) return 'tile';
  if (/storage|loading/.test(n)) return 'concrete';
  if (/office|control/.test(n)) return 'carpet';
  if (/room \d|nurse|corridor/.test(n) || scene.id === 'hospital') return 'vinyl';
  if (/lab|hall/.test(n)) return scene.id === 'office' ? 'vinyl' : 'wood';
  return 'wood';
}
export function floorMaterial(type, w, h) {
  const meters = { wood: 3.2, tile: 2.4, concrete: 6, carpet: 3, vinyl: 3 }[type];
  const map = canvasTex(type, 512, FLOORS[type], [w / meters, h / meters]);
  return new THREE.MeshStandardMaterial({ map, roughness: { wood: 0.55, tile: 0.35, concrete: 0.85, carpet: 1.0, vinyl: 0.45 }[type], metalness: 0 });
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

const M = {};
const mk = (key, fn) => (M[key] ||= Object.assign(fn(), { _shared: true }));
export const mats = {
  wood: (hex = '#a0703f') => mk(`wood${hex}`, () => new THREE.MeshStandardMaterial({ map: woodTex(hex), roughness: 0.6 })),
  paint: (hex, rough = 0.55) => mk(`paint${hex}${rough}`, () => new THREE.MeshStandardMaterial({ color: hex, roughness: rough, metalness: 0.05 })),
  plastic: (hex) => mk(`plastic${hex}`, () => new THREE.MeshStandardMaterial({ color: hex, roughness: 0.38, metalness: 0 })),
  metal: (hex = '#b8bec6', rough = 0.32) => mk(`metal${hex}${rough}`, () => new THREE.MeshStandardMaterial({ color: hex, roughness: rough, metalness: 0.85 })),
  fabric: (hex) => mk(`fabric${hex}`, () => new THREE.MeshStandardMaterial({ color: hex, roughness: 0.95, metalness: 0 })),
  rubber: () => mk('rubber', () => new THREE.MeshStandardMaterial({ color: '#1d2025', roughness: 0.9 })),
  screen: () => mk('screen', () => new THREE.MeshStandardMaterial({ color: '#0b1220', roughness: 0.15, metalness: 0.3, emissive: '#1e3a8a', emissiveIntensity: 0.35 })),
  glass: () => mk('glass', () => new THREE.MeshPhysicalMaterial({ color: '#dbeafe', roughness: 0.05, transmission: 0.6, transparent: true, opacity: 0.5 })),
  leaf: (hex) => mk(`leaf${hex}`, () => new THREE.MeshStandardMaterial({ color: hex, roughness: 0.75, flatShading: true })),
  emissive: (hex) => mk(`em${hex}`, () => new THREE.MeshStandardMaterial({ color: hex, emissive: hex, emissiveIntensity: 0.9, roughness: 0.4 })),
  wall: () => mk('wall', () => new THREE.MeshStandardMaterial({ color: '#f6f5f2', roughness: 0.92 })),
  wallTop: () => mk('wallTop', () => new THREE.MeshStandardMaterial({ color: '#3a3f47', roughness: 0.7 })),
  baseboard: () => mk('baseboard', () => new THREE.MeshStandardMaterial({ color: '#d8d6d0', roughness: 0.6 })),
};
export const tone = (name) => ({ red: '#c62828', blue: '#2f5fb8', green: '#2e7d32', gray: '#8d939b', white: '#eceff1', brown: '#7b5232', black: '#26292e', yellow: '#e8b923', orange: '#e8742a' }[name] || '#999999');
export { shade };

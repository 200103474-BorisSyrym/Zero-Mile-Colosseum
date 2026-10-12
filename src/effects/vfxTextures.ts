import * as THREE from 'three';

/**
 * Procedural VFX textures, drawn once on canvas. None of them is a clean geometric shape: smoke is lumpy, flames are
 * torn tongues, light on the road is a fan with a hot near end, pools of lamp light are irregular — so the eye reads
 * smoke, fire and light, not discs and rings.
 */
const cache = new Map<string, THREE.Texture>();
let seed = 1;
const rnd = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};
function make(key: string, w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, srgb = false) {
  let t = cache.get(key);
  if (t) return t;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  seed = 1 + [...key].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7) % 100000;
  draw(g);
  t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  cache.set(key, t);
  return t;
}

/** Soft lump: a radial gradient blob. */
function blob(g: CanvasRenderingContext2D, x: number, y: number, r: number, a: number, v = 255) {
  const gr = g.createRadialGradient(x, y, 0, x, y, r);
  gr.addColorStop(0, `rgba(${v},${v},${v},${a})`);
  gr.addColorStop(0.55, `rgba(${v},${v},${v},${a * 0.45})`);
  gr.addColorStop(1, `rgba(${v},${v},${v},0)`);
  g.fillStyle = gr;
  g.fillRect(x - r, y - r, r * 2, r * 2);
}

/**
 * Smoke atlas, 2x2 puffs. Each puff is dozens of lumps of different density inside the cell's inscribed circle
 * (particles rotate, so nothing may reach the corners); brighter lumps on top read as volume.
 */
export function smokeAtlas() {
  return make('vfx_smoke', 512, 512, (g) => {
    for (let cell = 0; cell < 4; cell++) {
      const ox = (cell % 2) * 256 + 128, oy = Math.floor(cell / 2) * 256 + 128;
      const lumps = 26 + Math.floor(rnd() * 14);
      for (let i = 0; i < lumps; i++) {
        const a = rnd() * Math.PI * 2, d = Math.pow(rnd(), 0.7) * 62;
        const x = ox + Math.cos(a) * d, y = oy + Math.sin(a) * d * 0.85;
        const r = 22 + rnd() * 34 * (1 - d / 90);
        // lumps toward the top are lit, toward the bottom in their own shade
        const v = Math.round(170 + 85 * Math.min(1, Math.max(0, 0.5 - (y - oy) / 120)) - rnd() * 30);
        blob(g, x, y, r, 0.18 + rnd() * 0.22, v);
      }
      // wispy edge
      for (let i = 0; i < 12; i++) {
        const a = rnd() * Math.PI * 2;
        blob(g, ox + Math.cos(a) * 78, oy + Math.sin(a) * 70, 16 + rnd() * 14, 0.08 + rnd() * 0.08, 200);
      }
    }
  });
}

/**
 * Additive atlas, 4x2 cells of 128 px: two torn flame tongues, two fireball lumps, a soft dot, a lamp glare with
 * streaks, a small star spark, an electric crackle.
 */
export const ADD_FRAME = { flameA: 0, flameB: 1, ballA: 2, ballB: 3, dot: 4, glare: 5, star: 6, crackle: 7 } as const;
export function addAtlas() {
  return make('vfx_add', 512, 256, (g) => {
    const cell = (i: number) => [(i % 4) * 128 + 64, Math.floor(i / 4) * 128 + 64] as const;
    // flame tongues: a hot base, lumps shrinking and thinning as they rise and wander sideways
    for (const i of [0, 1]) {
      const [cx, cy] = cell(i);
      let x = cx;
      for (let k = 0; k < 18; k++) {
        const t = k / 17;
        x += (rnd() - 0.5) * 7;
        const y = cy + 40 - t * 92;
        const r = (1 - t) * 30 + 5;
        blob(g, x, y, r, (1 - t * 0.7) * 0.5, 255);
      }
      blob(g, cx, cy + 30, 20, 0.6, 255);
    }
    // fireball: turbulent lumps of different heat with dark gaps torn through them — fire, not a soft ball
    for (const i of [2, 3]) {
      const [cx, cy] = cell(i);
      for (let k = 0; k < 16; k++) {
        const a = rnd() * Math.PI * 2, d = Math.pow(rnd(), 0.7) * 36;
        blob(g, cx + Math.cos(a) * d, cy + Math.sin(a) * d, 9 + rnd() * 17, 0.3 + rnd() * 0.55, 255);
      }
      g.globalCompositeOperation = 'destination-out';
      for (let k = 0; k < 7; k++) {
        const a = rnd() * Math.PI * 2, d = 14 + rnd() * 30;
        blob(g, cx + Math.cos(a) * d, cy + Math.sin(a) * d, 6 + rnd() * 10, 0.55 + rnd() * 0.35, 255);
      }
      g.globalCompositeOperation = 'source-over';
    }
    // soft dot
    {
      const [cx, cy] = cell(4);
      const gr = g.createRadialGradient(cx, cy, 0, cx, cy, 60);
      gr.addColorStop(0, 'rgba(255,255,255,1)');
      gr.addColorStop(0.2, 'rgba(255,255,255,0.55)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(cx - 64, cy - 64, 128, 128);
    }
    // glare: a tight core, a wide faint halo, two long and two short streaks
    {
      const [cx, cy] = cell(5);
      const gr = g.createRadialGradient(cx, cy, 0, cx, cy, 60);
      gr.addColorStop(0, 'rgba(255,255,255,1)');
      gr.addColorStop(0.07, 'rgba(255,255,255,0.9)');
      gr.addColorStop(0.2, 'rgba(255,255,255,0.22)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(cx - 64, cy - 64, 128, 128);
      const streak = (len: number, th: number, a: number, ang: number) => {
        g.save();
        g.translate(cx, cy);
        g.rotate(ang);
        const lg = g.createLinearGradient(-len, 0, len, 0);
        lg.addColorStop(0, 'rgba(255,255,255,0)');
        lg.addColorStop(0.5, `rgba(255,255,255,${a})`);
        lg.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = lg;
        g.fillRect(-len, -th / 2, len * 2, th);
        g.restore();
      };
      streak(60, 2.2, 0.75, 0);
      streak(34, 1.6, 0.35, Math.PI / 2);
    }
    // star spark
    {
      const [cx, cy] = cell(6);
      blob(g, cx, cy, 14, 1, 255);
      g.fillStyle = 'rgba(255,255,255,0.6)';
      g.fillRect(cx - 24, cy - 1, 48, 2);
      g.fillRect(cx - 1, cy - 16, 2, 32);
    }
    // electric crackle: jagged bright lines
    {
      const [cx, cy] = cell(7);
      g.strokeStyle = 'rgba(255,255,255,0.95)';
      g.lineWidth = 2;
      for (let k = 0; k < 4; k++) {
        g.beginPath();
        let x = cx, y = cy;
        g.moveTo(x, y);
        const a = rnd() * Math.PI * 2;
        for (let j = 0; j < 5; j++) {
          x += Math.cos(a + (rnd() - 0.5) * 1.6) * 11;
          y += Math.sin(a + (rnd() - 0.5) * 1.6) * 11;
          g.lineTo(x, y);
        }
        g.stroke();
      }
      blob(g, cx, cy, 16, 0.8, 255);
    }
  });
}

/**
 * Headlight light on the road: a fan from the bumper (bottom of the texture) to the far end (top), hot near the car,
 * two overlapping lobes from the two lamps, ragged where the asphalt breaks it up. The car's own spotlights do the
 * real lighting; this carries the beam's reach on a dark road.
 */
export function roadBeamTexture() {
  return make('vfx_roadbeam', 256, 512, (g) => {
    const img = g.createImageData(256, 512);
    for (let y = 0; y < 512; y++) {
      const t = 1 - y / 511; // 0 at the car, 1 at the far end
      for (let x = 0; x < 256; x++) {
        const u = (x - 127.5) / 128;
        let v = 0;
        for (const lx of [-0.28, 0.28]) {
          // each lobe widens with distance and leans outward a little
          const c = lx * (0.35 + t * 0.9);
          const w = 0.18 + t * 0.5;
          const du = (u - c) / w;
          v += Math.exp(-du * du * 2.2);
        }
        const along = Math.pow(1 - t, 1.3) * smooth(0, 0.08, t);
        const n = 0.85 + 0.15 * Math.sin(x * 0.21 + y * 0.05) * Math.sin(y * 0.13 - x * 0.07);
        const a = Math.min(1, v * 0.6) * along * n;
        const i = (y * 256 + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(a * 255);
      }
    }
    g.putImageData(img, 0, 0);
  });
}
const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Street-lamp pool: soft, slightly elongated, uneven — never a clean disc. */
export function poolTexture() {
  return make('vfx_pool', 256, 256, (g) => {
    const img = g.createImageData(256, 256);
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const u = (x - 128) / 128, v = (y - 128) / 128;
        const a0 = Math.atan2(v, u);
        const wob = 1 + 0.12 * Math.sin(a0 * 3 + 1.3) + 0.07 * Math.sin(a0 * 7 - 0.4);
        const r = Math.hypot(u * 0.82, (v - 0.06) * 1.0) / wob;
        let a = Math.max(0, 1 - r);
        a = a * a * (0.75 + 0.25 * Math.max(0, 1 - Math.hypot(u, v + 0.15) * 2.2));
        const n = 0.88 + 0.12 * Math.sin(x * 0.31 + y * 0.17) * Math.sin(y * 0.23 - x * 0.11);
        const i = (y * 256 + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(Math.min(1, a * n) * 255);
      }
    }
    g.putImageData(img, 0, 0);
  });
}

/** Ground flash under a blast or an energy release: hot and irregular, broken up toward the edge. */
export function flashTexture() {
  return make('vfx_flash', 256, 256, (g) => {
    for (let k = 0; k < 40; k++) {
      const a = rnd() * Math.PI * 2, d = Math.pow(rnd(), 1.4) * 80;
      blob(g, 128 + Math.cos(a) * d, 128 + Math.sin(a) * d, 30 + rnd() * 40, 0.12 + rnd() * 0.14, 255);
    }
  });
}

/**
 * Pressure-wave band for shock and EMP: a soft ring of dust/energy that is thick, broken and faint — the eye reads the
 * wave, not the circle (it lives a quarter of a second, under particles).
 */
export function waveTexture() {
  return make('vfx_wave', 256, 256, (g) => {
    const img = g.createImageData(256, 256);
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const u = (x - 128) / 128, v = (y - 128) / 128;
        const r = Math.hypot(u, v), ang = Math.atan2(v, u);
        const band = Math.exp(-Math.pow((r - 0.78) / 0.13, 2)) + 0.35 * Math.exp(-Math.pow((r - 0.55) / 0.2, 2));
        const brk = 0.55 + 0.45 * Math.sin(ang * 9 + Math.sin(ang * 4) * 2) * Math.sin(ang * 5 - 1.2);
        const a = Math.max(0, band * brk) * (r < 1 ? 1 : 0);
        const i = (y * 256 + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(Math.min(1, a) * 255);
      }
    }
    g.putImageData(img, 0, 0);
  });
}

/** Rounded-rectangle shadow (soft) for a car footprint; `tight` adds the dark tyre contact patches. */
export function carShadowTexture(tight: boolean) {
  return make(tight ? 'vfx_shadow_tight' : 'vfx_shadow_soft', 128, 256, (g) => {
    const blur = tight ? 7 : 22;
    g.filter = `blur(${blur}px)`;
    g.fillStyle = `rgba(0,0,0,${tight ? 0.95 : 0.8})`;
    const pad = tight ? 16 : 34;
    roundRect(g, pad, pad, 128 - pad * 2, 256 - pad * 2, tight ? 22 : 40);
    g.fill();
    if (tight) {
      g.filter = 'blur(3px)';
      g.fillStyle = 'rgba(0,0,0,1)';
      for (const x of [24, 104]) for (const y of [52, 204]) {
        g.beginPath();
        g.ellipse(x, y, 9, 18, 0, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.filter = 'none';
  });
}
function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Underglow: light leaking from under the sills — strongest along the car's edges, dark under the car itself. */
export function underglowTexture() {
  // light spilling out from under the sills: brightest at the body line, falling off outward — a filled glow, so
  // what shows around the car is a soft gradient, never a ring with an inner edge
  return make('vfx_underglow', 128, 256, (g) => {
    g.filter = 'blur(16px)';
    g.fillStyle = 'rgba(255,255,255,0.9)';
    roundRect(g, 40, 46, 48, 164, 18);
    g.fill();
    g.filter = 'blur(30px)';
    g.fillStyle = 'rgba(255,255,255,0.35)';
    roundRect(g, 36, 40, 56, 176, 22);
    g.fill();
    g.filter = 'none';
  });
}

/** Rubber on asphalt: streaks along the mark, ragged edges (u across the tyre, v along the mark, repeating). */
export function skidTexture() {
  const t = make('vfx_skid', 32, 128, (g) => {
    const img = g.createImageData(32, 128);
    const lines: number[] = [];
    for (let x = 0; x < 32; x++) lines.push(0.55 + rnd() * 0.45);
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 32; x++) {
        const u = (x - 15.5) / 16;
        const edge = 1 - smooth(0.62, 1, Math.abs(u));
        const a = edge * lines[x] * (0.8 + 0.2 * Math.sin(y * 0.4 + x));
        const i = (y * 32 + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(a * 255);
      }
    }
    g.putImageData(img, 0, 0);
  });
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Hazard surfaces: oil (a dark, glossy, ragged blot), water (a puddle with a soft rim), scorch (soot). */
export function hazardTexture(kind: 'oil' | 'water' | 'scorch' | 'energy') {
  return make('vfx_haz_' + kind, 256, 256, (g) => {
    const n = kind === 'energy' ? 18 : 30;
    for (let k = 0; k < n; k++) {
      const a = rnd() * Math.PI * 2, d = Math.pow(rnd(), 0.9) * 72;
      blob(g, 128 + Math.cos(a) * d, 128 + Math.sin(a) * d * 0.9, 22 + rnd() * 34, kind === 'scorch' ? 0.2 : 0.32, 255);
    }
    if (kind === 'water') {
      g.globalCompositeOperation = 'destination-out';
      blob(g, 128, 128, 70, 0.35, 255);
      g.globalCompositeOperation = 'source-over';
    }
  });
}

/** Every VFX texture, built now: the game uploads them at start so the first explosion never stalls on an upload. */
export function vfxTexturesAll(): THREE.Texture[] {
  return [
    smokeAtlas(), addAtlas(), roadBeamTexture(), poolTexture(), flashTexture(), waveTexture(), carShadowTexture(true), carShadowTexture(false),
    underglowTexture(), skidTexture(), hazardTexture('oil'), hazardTexture('water'), hazardTexture('scorch'), hazardTexture('energy'),
  ];
}

import * as THREE from 'three';

/**
 * Canvas textures for the environment art: facades, shop fronts, adverts, road wear decals, fences, road signs and
 * smoke. Generated once, cached, deterministic (a fixed-seed generator), so every load looks the same.
 */
const cache = new Map<string, THREE.Texture>();

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, g: c.getContext('2d')! };
}

function tex(key: string, make: () => THREE.Texture) {
  let t = cache.get(key);
  if (!t) {
    t = make();
    cache.set(key, t);
  }
  return t;
}

let seed = 90210;
const r = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

export type FacadeStyle = 'office' | 'resi' | 'ind';

/** Metres per texture tile for facades: 8 bays of 1.6 m, 16 floors of 3.2 m. */
export const FACADE_U = 12.8;
export const FACADE_V = 51.2;

/**
 * Building facade. `color` is the structure (slabs, mullions, frames, glass) lit by the scene; `emissive` holds only
 * the lit windows — warm, in whole floors for offices and window by window for homes, the way buildings light at night.
 */
export function facadeTextures(style: FacadeStyle) {
  const color = tex('facade_c_' + style, () => {
    const { c, g } = canvas(256, 512);
    g.fillStyle = style === 'office' ? '#4a4f5a' : style === 'resi' ? '#5a524a' : '#4a4640';
    g.fillRect(0, 0, 256, 512);
    for (let i = 0; i < 260; i++) {
      g.fillStyle = `rgba(0,0,0,${r() * 0.12})`;
      g.fillRect(r() * 256, r() * 512, 1 + r() * 3, 8 + r() * 60);
    }
    for (let fy = 0; fy < 16; fy++) {
      const y = fy * 32;
      if (style === 'ind') {
        // corrugated cladding, a clerestory band high up, roller doors at the bottom
        for (let x = 0; x < 256; x += 4) {
          g.fillStyle = x % 8 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.22)';
          g.fillRect(x, y, 2, 32);
        }
        if (fy === 11 || fy === 12) {
          for (let bx = 0; bx < 8; bx++) {
            g.fillStyle = '#16191e';
            g.fillRect(bx * 32 + 3, y + 8, 26, 14);
          }
        }
        if (fy >= 14) {
          for (let bx = 0; bx < 8; bx += 3) {
            const top = fy === 14 ? 6 : 0;
            g.fillStyle = '#1c1c1e';
            g.fillRect(bx * 32 + 4, y + top, 48, 32 - top);
            g.fillStyle = 'rgba(255,255,255,0.08)';
            for (let k = 0; k < 6; k++) g.fillRect(bx * 32 + 4, y + top + k * 5, 48, 1);
          }
        }
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.fillRect(0, y, 256, 2);
        continue;
      }
      g.fillStyle = style === 'office' ? '#6a707c' : '#6e665c';
      g.fillRect(0, y, 256, style === 'office' ? 4 : 6);
      for (let bx = 0; bx < 8; bx++) {
        const x = bx * 32;
        if (style === 'office') {
          g.fillStyle = '#121820';
          g.fillRect(x + 2, y + 5, 28, 26);
          g.fillStyle = 'rgba(160,190,230,0.10)';
          g.fillRect(x + 2, y + 5, 28, 9);
          g.fillStyle = '#2a2e36';
          g.fillRect(x, y, 2, 32);
        } else {
          g.fillStyle = '#7a7266';
          g.fillRect(x + 7, y + 9, 18, 18);
          g.fillStyle = '#121418';
          g.fillRect(x + 9, y + 11, 14, 14);
          if ((bx + fy) % 5 === 0) {
            g.fillStyle = '#2a2622';
            g.fillRect(x + 3, y + 22, 26, 8);
            g.fillStyle = 'rgba(255,255,255,0.12)';
            g.fillRect(x + 3, y + 22, 26, 1);
          }
        }
      }
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  });
  const emissive = tex('facade_e_' + style, () => {
    const { c, g } = canvas(256, 512);
    g.fillStyle = '#000';
    g.fillRect(0, 0, 256, 512);
    const warm = ['#ffcf8a', '#ffd9a6', '#ffc070', '#ffe2bc'];
    const cool = ['#d8e6ff', '#c4dcff'];
    for (let fy = 0; fy < 16; fy++) {
      const y = fy * 32;
      if (style === 'ind') {
        if (fy === 11 || fy === 12) {
          for (let bx = 0; bx < 8; bx++) {
            if (r() > 0.45) continue;
            g.globalAlpha = 0.35 + r() * 0.3;
            g.fillStyle = '#ffb060';
            g.fillRect(bx * 32 + 3, y + 8, 26, 14);
          }
        }
        if (fy === 13) {
          for (let bx = 0; bx < 8; bx += 3) {
            g.globalAlpha = 0.9;
            g.fillStyle = '#ffc070';
            g.fillRect(bx * 32 + 24, y + 22, 8, 4);
          }
        }
        continue;
      }
      const floorLit = style === 'office' ? (r() < 0.34 ? 1 : r() < 0.3 ? 0.35 : 0) : 0;
      const floorCol = r() < 0.55 ? cool[Math.floor(r() * 2)] : warm[Math.floor(r() * 4)];
      for (let bx = 0; bx < 8; bx++) {
        const x = bx * 32;
        if (style === 'office') {
          const on = floorLit >= 1 ? r() < 0.85 : floorLit > 0 ? r() < 0.35 : r() < 0.06;
          if (!on) continue;
          // two panes per bay, brighter toward the ceiling lights, blinds on some
          for (let pane = 0; pane < 2; pane++) {
            const px = x + 2 + pane * 14;
            const gr = g.createLinearGradient(0, y + 5, 0, y + 31);
            gr.addColorStop(0, floorCol);
            gr.addColorStop(1, 'rgba(0,0,0,0.25)');
            g.globalAlpha = 0.35 + r() * 0.5;
            g.fillStyle = gr;
            g.fillRect(px, y + 5, 13, 26);
            if (r() < 0.25) {
              g.globalAlpha = 0.55;
              g.fillStyle = '#000';
              for (let k = 0; k < 6; k++) g.fillRect(px, y + 6 + k * 4, 13, 2);
            }
          }
        } else {
          if (r() > 0.32) continue;
          g.globalAlpha = 0.4 + r() * 0.55;
          g.fillStyle = r() < 0.08 ? '#9ec8ff' : warm[Math.floor(r() * 4)];
          g.fillRect(x + 9, y + 11, 14, 14);
          if (r() < 0.4) {
            g.globalAlpha = 0.5;
            g.fillStyle = '#000';
            g.fillRect(x + 9, y + 11, 5, 14);
          }
        }
      }
    }
    g.globalAlpha = 1;
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
  return { color, emissive };
}

/** Street-level shop fronts: lit windows, roller shutters, sign bars. One tile = 4 shops (16 m x 4.5 m). */
export function shopfrontTextures() {
  const shops = (emit: boolean) => {
    seed = 4242;
    const { c, g } = canvas(512, 128);
    g.fillStyle = emit ? '#000' : '#2a2626';
    g.fillRect(0, 0, 512, 128);
    const tints = ['#ffcf8a', '#9ef0ff', '#ff9ad0', '#ffe9b0', '#b0ffb8', '#ffb070'];
    for (let k = 0; k < 4; k++) {
      const x = k * 128;
      const shutter = r() < 0.3;
      const tint = tints[Math.floor(r() * tints.length)];
      const signW = 60 + r() * 50;
      const figures = [0, 1, 2, 3].map(() => [r() * 6, 80 + r() * 14, 12 + r() * 8]);
      if (!emit) {
        g.fillStyle = '#1a1a1c';
        g.fillRect(x + 6, 34, 116, 90);
        if (shutter) {
          for (let yy = 34; yy < 124; yy += 4) {
            g.fillStyle = yy % 8 ? '#3a3a3e' : '#2c2c30';
            g.fillRect(x + 6, yy, 116, 3);
          }
        }
        g.fillStyle = '#121214';
        g.fillRect(x + 4, 6, 120, 24);
        g.fillStyle = '#3a3634';
        g.fillRect(x, 0, 4, 128);
      } else {
        g.globalAlpha = 0.85;
        g.fillStyle = tint;
        g.fillRect(x + 10, 12, signW, 10);
        if (!shutter) {
          const gr = g.createLinearGradient(0, 34, 0, 124);
          gr.addColorStop(0, tint);
          gr.addColorStop(1, 'rgba(0,0,0,0.2)');
          g.globalAlpha = 0.7;
          g.fillStyle = gr;
          g.fillRect(x + 6, 34, 116, 90);
          g.globalAlpha = 1;
          g.fillStyle = '#000';
          figures.forEach(([ox, oy, w], n) => g.fillRect(x + 14 + n * 26 + ox, oy, w, 44));
          g.fillRect(x + 62, 34, 4, 90);
        } else {
          g.globalAlpha = 0.25;
          g.fillStyle = tint;
          g.fillRect(x + 6, 118, 116, 6);
        }
      }
    }
    g.globalAlpha = 1;
    const t = new THREE.CanvasTexture(c);
    t.wrapS = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  return { color: tex('shops_c', () => shops(false)), emissive: tex('shops_e', () => shops(true)) };
}

/** Billboard adverts (4 x 3 cells of 256 x 128) for fictional brands. */
export const AD_COUNT = 12;
export function adAtlas() {
  return tex('ads', () => {
    const { c, g } = canvas(1024, 384);
    const ads: [string, string, string, string][] = [
      ['VOLTA', 'ENERGY · ZERO SUGAR', '#ffe040', '#1a0a40'],
      ['RUSTLINE', 'TOOLS THAT OUTLAST YOU', '#ff8a1a', '#141414'],
      ['MILE 0 FM', 'NIGHT DRIVE RADIO', '#ff2bd6', '#08081a'],
      ['KAIJU', 'NOODLE BAR · 24H', '#ff3a3a', '#fff2d8'],
      ['SKYDECK', 'AUTO · NO DEPOSIT', '#40e0ff', '#06202a'],
      ['OXIDE', 'MOTOR OIL', '#ffd23a', '#2a0a0a'],
      ['PULSE', 'CLINIC · WALK-INS', '#7dff9a', '#062014'],
      ['GRID', 'TAXI · ANYWHERE', '#ffd000', '#111111'],
      ['NIGHTSHIFT', 'INSURANCE FOR DRIVERS', '#b98bff', '#0e0620'],
      ['SALT+SMOKE', 'GRILL HOUSE', '#ff9a50', '#200c06'],
      ['HOLO 9', 'SEE MORE', '#40ffd0', '#001a18'],
      ['DRIFTLINE', 'TYRES · GRIP IS A CHOICE', '#ffffff', '#c41030'],
    ];
    ads.forEach(([name, line, fg, bg], i) => {
      const x = (i % 4) * 256, y = Math.floor(i / 4) * 128;
      g.fillStyle = bg;
      g.fillRect(x, y, 256, 128);
      g.fillStyle = fg;
      g.globalAlpha = 0.25;
      if (i % 3 === 0) {
        g.beginPath();
        g.arc(x + 210, y + 64, 70, 0, Math.PI * 2);
        g.fill();
      } else if (i % 3 === 1) {
        g.beginPath();
        g.moveTo(x + 150, y + 128);
        g.lineTo(x + 256, y);
        g.lineTo(x + 256, y + 128);
        g.fill();
      } else for (let k = 0; k < 5; k++) g.fillRect(x + 150 + k * 22, y, 10, 128);
      g.globalAlpha = 1;
      g.textAlign = 'left';
      g.textBaseline = 'alphabetic';
      g.font = `bold ${name.length > 8 ? 40 : 52}px Rajdhani, Arial Narrow, sans-serif`;
      g.fillText(name, x + 14, y + 66);
      g.font = 'bold 17px Rajdhani, Arial Narrow, sans-serif';
      g.fillStyle = bg === '#fff2d8' ? '#401010' : '#e8ecf4';
      g.fillText(line, x + 16, y + 96);
      g.strokeStyle = 'rgba(0,0,0,0.6)';
      g.lineWidth = 6;
      g.strokeRect(x + 3, y + 3, 250, 122);
    });
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  });
}
/** UV rect [u0, v0, u1, v1] of an advert. */
export function adUV(i: number): [number, number, number, number] {
  const k = ((i % AD_COUNT) + AD_COUNT) % AD_COUNT;
  const u0 = (k % 4) / 4, v1 = 1 - Math.floor(k / 4) / 3;
  return [u0, v1 - 1 / 3, u0 + 0.25, v1];
}

/**
 * Road decals (4 x 2 cells of 128 x 128): 0 tyre wear, 1 repair patch, 2 oil stain, 3 skid marks,
 * 4 manhole, 5 cracks, 6 drain grate, 7 transverse joint. Dark RGB with alpha, drawn over the asphalt.
 */
export function roadDecalAtlas() {
  return tex('roaddecals', () => {
    const { c, g } = canvas(512, 256);
    g.clearRect(0, 0, 512, 256);
    const cell = (i: number) => [(i % 4) * 128, Math.floor(i / 4) * 128];
    {
      const [x, y] = cell(0);
      const gr = g.createLinearGradient(x, 0, x + 128, 0);
      gr.addColorStop(0, 'rgba(0,0,0,0)');
      gr.addColorStop(0.5, 'rgba(4,4,6,0.5)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr;
      g.fillRect(x, y, 128, 128);
      for (let i = 0; i < 40; i++) {
        g.fillStyle = `rgba(0,0,0,${r() * 0.3})`;
        g.fillRect(x + 30 + r() * 68, y, 1 + r() * 2, 128);
      }
    }
    {
      const [x, y] = cell(1);
      g.fillStyle = 'rgba(6,6,8,0.5)';
      g.beginPath();
      g.moveTo(x + 8 + r() * 10, y + 6);
      g.lineTo(x + 120 - r() * 10, y + 4 + r() * 8);
      g.lineTo(x + 122, y + 120 - r() * 10);
      g.lineTo(x + 6, y + 124);
      g.closePath();
      g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.7)';
      g.lineWidth = 2;
      g.stroke();
      for (let i = 0; i < 300; i++) {
        g.fillStyle = `rgba(80,80,90,${r() * 0.25})`;
        g.fillRect(x + 10 + r() * 108, y + 10 + r() * 108, 2, 2);
      }
    }
    {
      const [x, y] = cell(2);
      for (let k = 0; k < 4; k++) {
        const cx = x + 64 + (r() - 0.5) * 40, cy = y + 64 + (r() - 0.5) * 40, rad = 20 + r() * 34;
        const gr = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
        gr.addColorStop(0, 'rgba(0,0,0,0.6)');
        gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = gr;
        g.fillRect(x, y, 128, 128);
      }
    }
    {
      const [x, y] = cell(3);
      g.strokeStyle = 'rgba(0,0,0,0.55)';
      g.lineCap = 'round';
      for (const off of [38, 90]) {
        g.lineWidth = 10;
        g.beginPath();
        g.moveTo(x + off - 20, y + 128);
        g.bezierCurveTo(x + off - 10, y + 80, x + off + 14, y + 50, x + off + 4, y);
        g.stroke();
      }
    }
    {
      const [x, y] = cell(4);
      g.fillStyle = 'rgba(10,10,12,0.85)';
      g.beginPath();
      g.arc(x + 64, y + 64, 50, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(90,90,100,0.5)';
      g.lineWidth = 3;
      g.beginPath();
      g.arc(x + 64, y + 64, 50, 0, Math.PI * 2);
      g.stroke();
      for (let k = -40; k <= 40; k += 10) {
        g.beginPath();
        g.moveTo(x + 64 + k, y + 30);
        g.lineTo(x + 64 + k, y + 98);
        g.stroke();
      }
    }
    {
      const [x, y] = cell(5);
      g.strokeStyle = 'rgba(0,0,0,0.75)';
      for (let k = 0; k < 5; k++) {
        g.lineWidth = 1 + r() * 2;
        g.beginPath();
        let px = x + r() * 128, py = y + r() * 128;
        g.moveTo(px, py);
        for (let n = 0; n < 7; n++) {
          px = Math.min(x + 127, Math.max(x, px + (r() - 0.5) * 40));
          py = Math.min(y + 127, Math.max(y, py + (r() - 0.5) * 40));
          g.lineTo(px, py);
        }
        g.stroke();
      }
    }
    {
      const [x, y] = cell(6);
      g.fillStyle = 'rgba(8,8,10,0.85)';
      g.fillRect(x + 24, y + 34, 80, 60);
      g.fillStyle = 'rgba(90,90,100,0.45)';
      for (let k = 0; k < 8; k++) g.fillRect(x + 28 + k * 10, y + 38, 4, 52);
    }
    {
      const [x, y] = cell(7);
      g.fillStyle = 'rgba(0,0,0,0.7)';
      g.fillRect(x, y + 58, 128, 6);
      g.fillStyle = 'rgba(120,120,130,0.3)';
      g.fillRect(x, y + 56, 128, 2);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  });
}
/** UV rect [u0, v0, u1, v1] of a road decal cell. */
export function decalUV(i: number): [number, number, number, number] {
  const u0 = (i % 4) / 4, v1 = 1 - Math.floor(i / 4) / 2;
  return [u0 + 0.004, v1 - 0.5 + 0.004, u0 + 0.25 - 0.004, v1 - 0.004];
}

/** Chain-link fence (alpha-tested). */
export function fenceTexture() {
  return tex('fence', () => {
    const { c, g } = canvas(64, 64);
    g.clearRect(0, 0, 64, 64);
    g.strokeStyle = 'rgba(170,175,185,0.9)';
    g.lineWidth = 2;
    for (let k = -64; k < 128; k += 12) {
      g.beginPath();
      g.moveTo(k, 0);
      g.lineTo(k + 64, 64);
      g.stroke();
      g.beginPath();
      g.moveTo(k + 64, 0);
      g.lineTo(k, 64);
      g.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

/** Direction and warning signs (4 x 2 cells of 256 x 128). */
export const ROAD_SIGNS = ['RING ROAD', 'DOCKS 2', 'CENTRE', 'EXIT 14', 'ZERO MILE', 'NO STOPPING', 'DETOUR', 'BRIDGE 1'];
export function roadSignAtlas() {
  return tex('roadsigns', () => {
    const { c, g } = canvas(1024, 256);
    ROAD_SIGNS.forEach((w, i) => {
      const x = (i % 4) * 256, y = Math.floor(i / 4) * 128;
      const warn = w === 'DETOUR' || w === 'NO STOPPING';
      g.fillStyle = warn ? '#e8a000' : w === 'ZERO MILE' ? '#7a0a20' : '#0e4a2a';
      g.fillRect(x + 4, y + 4, 248, 120);
      g.strokeStyle = warn ? '#111' : '#f0f0f0';
      g.lineWidth = 5;
      g.strokeRect(x + 10, y + 10, 236, 108);
      g.fillStyle = warn ? '#111' : '#f4f4f4';
      g.font = 'bold 44px Barlow, Arial Narrow, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(w, x + 128, y + 64);
    });
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  });
}
export function roadSignUV(i: number): [number, number, number, number] {
  const k = ((i % ROAD_SIGNS.length) + ROAD_SIGNS.length) % ROAD_SIGNS.length;
  const u0 = (k % 4) / 4, v1 = 1 - Math.floor(k / 4) / 2;
  return [u0, v1 - 0.5, u0 + 0.25, v1];
}

/** Soft smoke puff for plumes (white; tinted by the material). */
export function smokeTexture() {
  return tex('smoke', () => {
    const { c, g } = canvas(128, 128);
    for (let k = 0; k < 14; k++) {
      const x = 32 + r() * 64, y = 32 + r() * 64, rad = 18 + r() * 30;
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      gr.addColorStop(0, 'rgba(255,255,255,0.35)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, 128, 128);
    }
    return new THREE.CanvasTexture(c);
  });
}

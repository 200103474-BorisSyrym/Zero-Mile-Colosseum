import * as THREE from 'three';

/** Procedurally generated canvas textures. Created once and cached. */
const cache = new Map<string, THREE.Texture>();

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  return { c, g };
}

function tex(key: string, make: () => THREE.Texture) {
  let t = cache.get(key);
  if (!t) {
    t = make();
    cache.set(key, t);
  }
  return t;
}

// Small deterministic noise for textures so every load looks the same.
let ts = 1337;
const r = () => {
  ts = (ts * 16807) % 2147483647;
  return (ts - 1) / 2147483646;
};

export function asphaltTextures() {
  const color = tex('asphalt', () => {
    const { c, g } = canvas(512, 512);
    g.fillStyle = '#1a1b20';
    g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 26000; i++) {
      const v = 18 + r() * 30;
      g.fillStyle = `rgba(${v},${v},${v + 4},${0.35 + r() * 0.4})`;
      g.fillRect(r() * 512, r() * 512, 1 + r() * 2, 1 + r() * 2);
    }
    // cracks & patches
    for (let i = 0; i < 9; i++) {
      g.fillStyle = `rgba(10,10,14,${0.25 + r() * 0.3})`;
      g.fillRect(r() * 512, r() * 512, 40 + r() * 140, 20 + r() * 90);
    }
    g.strokeStyle = 'rgba(5,5,8,0.6)';
    for (let i = 0; i < 14; i++) {
      g.lineWidth = 1 + r();
      g.beginPath();
      let x = r() * 512, y = r() * 512;
      g.moveTo(x, y);
      for (let k = 0; k < 6; k++) {
        x += (r() - 0.5) * 60;
        y += (r() - 0.5) * 60;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  });
  const rough = tex('asphalt_rough', () => {
    const { c, g } = canvas(512, 512);
    g.fillStyle = '#b0b0b0';
    g.fillRect(0, 0, 512, 512);
    // wet patches: only a little glossier than the asphalt around them, with ragged soft outlines. A strong mirror
    // patch reads as a hole or a blob (its edge catches every lamp as a ring); a gentle one just breaks the
    // reflections up the way standing water does
    g.filter = 'blur(5px)';
    g.fillStyle = 'rgba(112,112,112,0.75)';
    for (let i = 0; i < 6; i++) {
      const x = r() * 512, y = r() * 512, rad = 24 + r() * 50;
      const n = 4 + Math.floor(r() * 5);
      for (let k = 0; k < n; k++) {
        const bx = x + (r() - 0.5) * rad * 0.8, by = y + (r() - 0.5) * rad * 1.8, br = rad * (0.25 + r() * 0.35);
        g.beginPath();
        g.ellipse(bx, by, br * (0.45 + r() * 0.4), br, (r() - 0.5) * 0.6, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.filter = 'none';
    for (let i = 0; i < 9000; i++) {
      const v = 120 + r() * 100;
      g.fillStyle = `rgba(${v},${v},${v},0.25)`;
      g.fillRect(r() * 512, r() * 512, 2, 2);
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  });
  return { color, rough };
}

export function windowTexture() {
  return tex('windows', () => {
    const { c, g } = canvas(256, 512);
    g.fillStyle = '#000';
    g.fillRect(0, 0, 256, 512);
    const cols = 8, rows = 16;
    const palette = ['#ffd9a0', '#ffe2b8', '#ffeacc', '#c8e4ff', '#ffd0a0', '#9fd8ff', '#ff9ad8'];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (r() < 0.3) {
          const col = palette[Math.floor(r() * palette.length)];
          g.globalAlpha = 0.25 + r() * 0.6;
          g.fillStyle = col;
          g.fillRect(x * 32 + 8, y * 32 + 9, 16, 14);
        } else if (r() < 0.2) {
          g.globalAlpha = 0.12;
          g.fillStyle = '#5070a0';
          g.fillRect(x * 32 + 6, y * 32 + 8, 20, 16);
        }
      }
    }
    g.globalAlpha = 1;
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

export const SIGN_WORDS = [
  'ZERO', 'MOTEL', '24H', 'RAMEN', 'CLUB VOLT', 'GARAGE', 'MILE 0', 'NIGHT', 'OPEN', 'HOTEL',
  'NOODLE', 'KARAOKE', 'PARTS', 'BAR', 'DINER', 'LIQUOR', 'TATTOO', 'CASINO', 'NEON', 'FUEL',
];

/** Atlas of 4x5 neon signs; each cell 256x128. */
export function signAtlas() {
  return tex('signs', () => {
    const { c, g } = canvas(1024, 640);
    g.fillStyle = '#000';
    g.fillRect(0, 0, 1024, 640);
    const colors = ['#ff2bd6', '#33e0ff', '#ffe040', '#ff3a3a', '#7dff4a', '#ff8a1a', '#b98bff', '#ffffff'];
    SIGN_WORDS.forEach((w, i) => {
      const cx = (i % 4) * 256, cy = Math.floor(i / 4) * 128;
      const col = colors[i % colors.length];
      g.save();
      g.translate(cx + 128, cy + 64);
      g.strokeStyle = col;
      g.lineWidth = 4;
      g.shadowColor = col;
      g.shadowBlur = 14;
      g.strokeRect(-118, -54, 236, 108);
      g.font = `bold ${w.length > 6 ? 40 : 56}px Rajdhani, Arial Narrow, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = col;
      g.fillText(w, 0, 4);
      g.fillStyle = '#ffffff';
      g.globalAlpha = 0.65;
      g.fillText(w, 0, 4);
      g.restore();
    });
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

export function radialTexture(key = 'radial', inner = 'rgba(255,255,255,1)', mid = 'rgba(255,255,255,0.35)') {
  return tex(key, () => {
    const { c, g } = canvas(128, 128);
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, inner);
    gr.addColorStop(0.35, mid);
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  });
}

/** Elongated cone-of-light texture for headlight beams on the road. */
export function beamTexture() {
  return tex('beam', () => {
    const { c, g } = canvas(128, 256);
    const gr = g.createLinearGradient(0, 256, 0, 0);
    gr.addColorStop(0, 'rgba(255,255,255,0.9)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.beginPath();
    g.moveTo(54, 256);
    g.lineTo(74, 256);
    g.lineTo(128, 0);
    g.lineTo(0, 0);
    g.closePath();
    g.fill();
    // soften edges
    const g2 = g.createLinearGradient(0, 0, 128, 0);
    g2.addColorStop(0, 'rgba(0,0,0,1)');
    g2.addColorStop(0.3, 'rgba(0,0,0,0)');
    g2.addColorStop(0.7, 'rgba(0,0,0,0)');
    g2.addColorStop(1, 'rgba(0,0,0,1)');
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = g2;
    g.fillRect(0, 0, 128, 256);
    return new THREE.CanvasTexture(c);
  });
}

/** Downward chevron used as a hostile marker above enemies. */
export function chevronTexture() {
  return tex('chevron', () => {
    const { c, g } = canvas(64, 64);
    g.strokeStyle = '#ffffff';
    g.lineWidth = 9;
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(10, 18);
    g.lineTo(32, 44);
    g.lineTo(54, 18);
    g.stroke();
    return new THREE.CanvasTexture(c);
  });
}

export function containerTexture() {
  return tex('container', () => {
    const { c, g } = canvas(128, 128);
    g.fillStyle = '#888';
    g.fillRect(0, 0, 128, 128);
    for (let x = 0; x < 128; x += 8) {
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(x, 0, 3, 128);
      g.fillStyle = 'rgba(255,255,255,0.15)';
      g.fillRect(x + 4, 0, 1, 128);
    }
    for (let i = 0; i < 300; i++) {
      g.fillStyle = `rgba(60,30,10,${r() * 0.25})`;
      g.fillRect(r() * 128, r() * 128, 3, 5);
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

/** Distant skyline silhouette strip with lit windows, used on a camera-following cylinder. */
export function skylineTexture() {
  return tex('skyline', () => {
    const { c, g } = canvas(2048, 256);
    g.clearRect(0, 0, 2048, 256);
    let x = 0;
    while (x < 2048) {
      const w = 20 + r() * 70;
      const h = 40 + r() * 190;
      g.fillStyle = '#05050a';
      g.fillRect(x, 256 - h, w, h);
      for (let wy = 256 - h + 6; wy < 250; wy += 9) {
        for (let wx = x + 3; wx < x + w - 4; wx += 7) {
          if (r() < 0.18) {
            g.fillStyle = r() < 0.5 ? 'rgba(255,200,140,0.8)' : 'rgba(140,200,255,0.7)';
            g.fillRect(wx, wy, 3, 4);
          }
        }
      }
      if (r() < 0.15) {
        g.fillStyle = 'rgba(255,40,80,0.9)';
        g.fillRect(x + w / 2 - 1, 256 - h - 12, 2, 12);
      }
      x += w + r() * 6;
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

export function stripeTexture() {
  return tex('stripe', () => {
    const { c, g } = canvas(64, 64);
    g.fillStyle = '#ffcc00';
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#111';
    for (let i = -64; i < 128; i += 22) {
      g.beginPath();
      g.moveTo(i, 0);
      g.lineTo(i + 11, 0);
      g.lineTo(i + 11 + 64, 64);
      g.lineTo(i + 64, 64);
      g.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

export function gridTexture() {
  return tex('grid', () => {
    const { c, g } = canvas(256, 256);
    g.fillStyle = '#000';
    g.fillRect(0, 0, 256, 256);
    g.strokeStyle = '#ffffff';
    g.lineWidth = 3;
    g.strokeRect(0, 0, 256, 256);
    g.globalAlpha = 0.35;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(128, 0);
    g.lineTo(128, 256);
    g.moveTo(0, 128);
    g.lineTo(256, 128);
    g.stroke();
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  });
}

/** Yellow/black corner board: arrow pointing to the left (UVs flip it for right-hand corners). */
export function chevronBoardTexture() {
  return tex('chevboard', () => {
    const { c, g } = canvas(128, 96);
    g.fillStyle = '#111';
    g.fillRect(0, 0, 128, 96);
    g.fillStyle = '#ffcc00';
    for (let i = 0; i < 2; i++) {
      const x = 30 + i * 44;
      g.beginPath();
      g.moveTo(x, 48);
      g.lineTo(x + 30, 12);
      g.lineTo(x + 46, 12);
      g.lineTo(x + 16, 48);
      g.lineTo(x + 46, 84);
      g.lineTo(x + 30, 84);
      g.closePath();
      g.fill();
    }
    g.strokeStyle = '#ffcc00';
    g.lineWidth = 6;
    g.strokeRect(3, 3, 122, 90);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

/** Chevron painted on the asphalt, pointing in the travel direction (+v). */
export function roadArrowTexture() {
  return tex('roadarrow', () => {
    const { c, g } = canvas(64, 64);
    g.clearRect(0, 0, 64, 64);
    g.fillStyle = '#fff';
    g.beginPath();
    g.moveTo(32, 58);
    g.lineTo(62, 26);
    g.lineTo(62, 12);
    g.lineTo(32, 42);
    g.lineTo(2, 12);
    g.lineTo(2, 26);
    g.closePath();
    g.fill();
    return new THREE.CanvasTexture(c);
  });
}

/** Road sign panel with large text and an optional sub line. Cached per text/color. */
export function signTextTexture(text: string, color: number, sub = '') {
  return tex('sign:' + text + ':' + color + ':' + sub, () => {
    const { c, g } = canvas(512, 128);
    const col = '#' + color.toString(16).padStart(6, '0');
    g.fillStyle = 'rgba(6,8,14,0.92)';
    g.fillRect(0, 0, 512, 128);
    g.strokeStyle = col;
    g.lineWidth = 6;
    g.shadowColor = col;
    g.shadowBlur = 12;
    g.strokeRect(6, 6, 500, 116);
    g.shadowBlur = 0;
    g.fillStyle = col;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `bold ${sub ? 54 : 66}px Rajdhani, Arial Narrow, sans-serif`;
    g.fillText(text, 256, sub ? 50 : 66);
    if (sub) {
      g.font = 'bold 30px Rajdhani, Arial Narrow, sans-serif';
      g.fillStyle = '#e8ecf8';
      g.fillText(sub, 256, 98);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  });
}

/** Black and white check (finish bands). One tile = 2 x 1 squares. */
export function checkerTexture() {
  return tex('checker', () => {
    const { c, g } = canvas(64, 32);
    g.fillStyle = '#111';
    g.fillRect(0, 0, 64, 32);
    g.fillStyle = '#f2f2f2';
    g.fillRect(0, 0, 32, 16);
    g.fillRect(32, 16, 32, 16);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.NearestFilter;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

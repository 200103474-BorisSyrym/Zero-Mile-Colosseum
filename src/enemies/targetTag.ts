import * as THREE from 'three';

/**
 * World-space target tag above a car: a plain word that says what the car IS to you, plus its health.
 *   DESTROY (objective target) · ELITE · ENEMY · PROTECT (ally) · RIVAL · HIT IT! (exposed — hit it now) · DUEL
 * Replaces the bare chevrons that players read as "some arrows, like in Cyberpunk".
 * Drawn on a small canvas, redrawn only when the label, health step or distance step changes.
 */
export type TagKind = 'enemy' | 'elite' | 'target' | 'ally' | 'rival' | 'exposed' | 'duel' | 'anvil' | 'debris';

const STYLE: Record<TagKind, { text: string; color: string; bar: string }> = {
  target: { text: 'DESTROY', color: '#ffc21a', bar: '#ffc21a' },
  elite: { text: 'ELITE', color: '#ff7a1a', bar: '#ff7a1a' },
  enemy: { text: 'ENEMY', color: '#ff3a4a', bar: '#ff3a4a' },
  ally: { text: 'PROTECT', color: '#3aff7a', bar: '#3aff7a' },
  rival: { text: 'RIVAL', color: '#ff9a3a', bar: '#ff9a3a' },
  exposed: { text: 'HIT IT!', color: '#ffffff', bar: '#ffffff' },
  duel: { text: 'DUEL', color: '#ff2050', bar: '#ff2050' },
  // road hazards: no health bar, distance shown so you can time the lane change
  anvil: { text: 'ANVIL', color: '#ff9a1a', bar: '' },
  debris: { text: 'DEBRIS', color: '#ff7a1a', bar: '' },
};

const W = 256, H = 88;

export class TargetTag {
  readonly sprite: THREE.Sprite;
  private canvas = document.createElement('canvas');
  private g: CanvasRenderingContext2D;
  private tex: THREE.CanvasTexture;
  private key = '';
  /** a name in place of the kind's word (the street-race rival when it is a real driver) */
  label: string | null = null;

  constructor() {
    this.canvas.width = W;
    this.canvas.height = H;
    this.g = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    // UI in the world: exact colours, no tone mapping, never blooms, drawn over the scene it labels
    const mat = new THREE.SpriteMaterial({ map: this.tex, depthWrite: false, depthTest: false, fog: false, toneMapped: false, transparent: true });
    this.sprite = new THREE.Sprite(mat);
    this.sprite.renderOrder = 20;
    this.sprite.name = 'target-tag';
  }

  /**
   * kind: what to show; hp: 0..1; dist: metres to the player (shown for objectives far away);
   * height: where above the car origin; visible: false hides it.
   */
  update(kind: TagKind, hp: number, dist: number, height: number, visible: boolean, count = 1) {
    this.sprite.visible = visible;
    if (!visible) return;
    const st = STYLE[kind];
    const showDist = ((kind === 'target' || kind === 'elite' || kind === 'ally') && dist > 45) || ((kind === 'anvil' || kind === 'debris') && dist > 25);
    const key = `${kind}|${Math.round(hp * 20)}|${showDist ? Math.round(dist / 10) : -1}|${count}|${this.label ?? ''}`;
    if (key !== this.key) {
      this.key = key;
      const text = this.label ?? (count > 1 ? `${st.text} x${count}` : st.text);
      this.draw({ ...st, text }, hp, showDist ? Math.round(dist / 10) * 10 : -1);
    }
    // stay readable far away: grow with distance (screen size roughly constant past ~30 m)
    // road hazards stay bigger on screen: they are what stops you, not what you hunt
    const hazard = kind === 'anvil' || kind === 'debris';
    const k = Math.max(1, dist / (hazard ? 20 : 30));
    const big = kind === 'target' || kind === 'exposed' || kind === 'duel';
    const w = (hazard ? 4.2 : big ? 3.4 : 2.6) * k;
    this.sprite.scale.set(w, (w * H) / W, 1);
    this.sprite.position.set(0, height + 0.9 + 0.35 * k, 0);
  }

  private draw(st: { text: string; color: string; bar: string }, hp: number, dist: number) {
    const g = this.g;
    g.clearRect(0, 0, W, H);
    // label chip
    g.font = 'bold 40px Rajdhani, Arial Narrow, sans-serif';
    g.textBaseline = 'middle';
    const label = dist >= 0 ? `${st.text}  ${dist} m` : st.text;
    // a long name shrinks to fit the chip
    let tw = g.measureText(label).width;
    if (tw > W - 34) {
      g.font = `bold ${Math.floor((40 * (W - 34)) / tw)}px Rajdhani, Arial Narrow, sans-serif`;
      tw = g.measureText(label).width;
    }
    const cx = W / 2;
    g.fillStyle = 'rgba(6,8,14,0.72)';
    roundRect(g, cx - tw / 2 - 12, 4, tw + 24, 46, 8);
    g.fill();
    g.strokeStyle = st.color;
    g.lineWidth = 3;
    g.stroke();
    g.fillStyle = st.color;
    g.textAlign = 'center';
    g.fillText(label, cx, 28);
    if (!st.bar) {
      // hazard: a striped band instead of a health bar
      for (let i = 0; i < 9; i++) {
        g.fillStyle = i % 2 ? 'rgba(6,8,14,0.85)' : st.color;
        g.fillRect(cx - 90 + i * 20, 60, 20, 12);
      }
      this.tex.needsUpdate = true;
      return;
    }
    // health bar
    const bw = 180, bh = 14, bx = cx - bw / 2, by = 60;
    g.fillStyle = 'rgba(6,8,14,0.8)';
    g.fillRect(bx - 3, by - 3, bw + 6, bh + 6);
    g.fillStyle = st.bar;
    g.fillRect(bx, by, Math.max(0, Math.min(1, hp)) * bw, bh);
    this.tex.needsUpdate = true;
  }

  dispose() {
    this.tex.dispose();
    (this.sprite.material as THREE.SpriteMaterial).dispose();
  }
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

/** Centralised input. Gameplay code reads only this object, never DOM events. */
export interface InputState {
  accelerate: number;
  brake: number;
  steer: number; // -1 left .. +1 right
  handbrake: boolean;
  nitro: boolean;
}

type Action = 'ability1' | 'ability2' | 'pause' | 'build' | 'reset' | 'debug' | 'confirm';

export class Input {
  readonly state: InputState = { accelerate: 0, brake: 0, steer: 0, handbrake: false, nitro: false };
  private keys = new Set<string>();
  private pressed = new Set<string>();
  private actionsPressed = new Set<Action>();
  private padPrev: boolean[] = [];
  /** Set by the UI for mouse clicks on ability buttons. */
  virtualPress(a: Action) {
    this.actionsPressed.add(a);
  }
  usingGamepad = false;
  onAnyKey: ((code: string) => void) | null = null;

  constructor() {
    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (['Space', 'Tab', 'F1', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backquote'].includes(e.code)) e.preventDefault();
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      this.usingGamepad = false;
      this.onAnyKey?.(e.code);
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });
    window.addEventListener('blur', () => this.keys.clear());
  }

  down(code: string) {
    return this.keys.has(code);
  }
  /** Edge-triggered raw key check (consumed at end of frame). */
  hit(code: string) {
    return this.pressed.has(code);
  }
  action(a: Action) {
    return this.actionsPressed.has(a);
  }

  update() {
    const k = (c: string) => this.keys.has(c);
    let acc = k('KeyW') || k('ArrowUp') ? 1 : 0;
    let brk = k('KeyS') || k('ArrowDown') ? 1 : 0;
    let steer = (k('KeyD') || k('ArrowRight') ? 1 : 0) - (k('KeyA') || k('ArrowLeft') ? 1 : 0);
    let hb = k('Space');
    let nitro = k('ShiftLeft') || k('ShiftRight');

    if (this.pressed.has('KeyQ')) this.actionsPressed.add('ability1');
    if (this.pressed.has('KeyE')) this.actionsPressed.add('ability2');
    if (this.pressed.has('Escape') || this.pressed.has('KeyP')) this.actionsPressed.add('pause');
    if (this.pressed.has('Tab')) this.actionsPressed.add('build');
    if (this.pressed.has('KeyR')) this.actionsPressed.add('reset');
    if (this.pressed.has('F1') || this.pressed.has('Backquote')) this.actionsPressed.add('debug');
    if (this.pressed.has('Enter')) this.actionsPressed.add('confirm');

    // Gamepad (standard mapping)
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads && Array.from(pads).find((p) => p && p.connected);
    if (gp) {
      const b = (i: number) => !!gp.buttons[i]?.pressed;
      const bv = (i: number) => gp.buttons[i]?.value ?? 0;
      const edge = (i: number) => b(i) && !this.padPrev[i];
      const ax = gp.axes[0] ?? 0;
      const any = bv(7) > 0.1 || bv(6) > 0.1 || Math.abs(ax) > 0.2 || b(0) || b(1) || b(2);
      if (any) this.usingGamepad = true;
      if (bv(7) > 0.05) acc = Math.max(acc, bv(7));
      if (bv(6) > 0.05) brk = Math.max(brk, bv(6));
      if (Math.abs(ax) > 0.12) steer = Math.sign(ax) * ((Math.abs(ax) - 0.12) / 0.88);
      // RT accelerate, LT brake, A/RB drift, B/LB nitro, X ability1, Y ability2
      if (b(0) || b(5)) hb = true;
      if (b(1) || b(4)) nitro = true;
      if (edge(2)) this.actionsPressed.add('ability1');
      if (edge(3)) this.actionsPressed.add('ability2');
      if (edge(9)) this.actionsPressed.add('pause');
      if (edge(8)) this.actionsPressed.add('build');
      if (edge(13)) this.actionsPressed.add('reset');
      this.padPrev = gp.buttons.map((x) => x.pressed);
    }

    this.state.accelerate = acc;
    this.state.brake = brk;
    this.state.steer = Math.max(-1, Math.min(1, steer));
    this.state.handbrake = hb;
    this.state.nitro = nitro;
  }

  /** Call at the very end of a frame. */
  endFrame() {
    this.pressed.clear();
    this.actionsPressed.clear();
  }
}

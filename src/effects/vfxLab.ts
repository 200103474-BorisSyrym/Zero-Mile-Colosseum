import type { InputState } from '../core/input';
import type { DrivingSession } from '../game/driving';
import type { AIVehicle } from '../enemies/ai';

/**
 * VFX LAB (debug overlay → VFX): every effect on demand, on the real road, with the real lighting, without playing
 * a level to reach it. Effects that come from driving (brake, boost, drift, speed) are produced by holding the inputs
 * for a moment; the rest are fired at the car or ahead of it. Nothing here touches damage or progression.
 */
export type LabEffect =
  | 'night' | 'wet' | 'brake' | 'boost' | 'drift' | 'hitL' | 'hitM' | 'hitH' | 'sparks' | 'explosion' | 'smoke'
  | 'emp' | 'pickup' | 'bossDeath' | 'damage' | 'speed';

export const LAB_EFFECTS: LabEffect[] = ['night', 'wet', 'brake', 'boost', 'drift', 'hitL', 'hitM', 'hitH', 'sparks', 'explosion', 'smoke', 'emp', 'pickup', 'bossDeath', 'damage', 'speed'];

const NIGHT_DISTS = [10, 25, 50, 100];

export class VfxLab {
  private hold: { t: number; input: Partial<InputState> } | null = null;
  /** the night-test car, kept at a fixed distance ahead */
  private probe: { v: AIVehicle; dist: number } | null = null;
  private nightIdx = -1;
  private hullIdx = 0;
  /** wet-road override for the tyre effects */
  forceWet = false;

  constructor(private s: DrivingSession) {}

  /** Input override while a driving effect is being shown. */
  applyInput(st: InputState) {
    if (this.hold && this.hold.t > 0) Object.assign(st, this.hold.input);
  }

  update(dt: number) {
    if (this.hold) {
      this.hold.t -= dt;
      if (this.hold.t <= 0) this.hold = null;
    }
    const pr = this.probe;
    if (pr) {
      if (pr.v.dead || pr.v.removed) this.probe = null;
      else {
        const p = this.s.player;
        pr.v.place(this.s.world.road, p.s + pr.dist, p.d, p.vF);
      }
    }
  }

  private ahead(ds: number, d = 0) {
    const p = this.s.player;
    const o = { x: 0, y: 0, z: 0 };
    this.s.world.road.toWorld(p.s + ds, p.d + d, o);
    return o;
  }

  /** Fire one effect; returns a short label for the HUD. */
  fire(name: LabEffect): string {
    const s = this.s, p = s.player, fx = s.fx;
    const fwdX = Math.sin(p.yaw), fwdZ = Math.cos(p.yaw);
    switch (name) {
      case 'night': {
        // a car ahead in your lane at 10 / 25 / 50 / 100 m, everything else cleared
        this.nightIdx = (this.nightIdx + 1) % NIGHT_DISTS.length;
        const dist = NIGHT_DISTS[this.nightIdx];
        for (const v of s.vehicles) if (v.role === 'traffic' && v !== this.probe?.v) s.removeVehicle(v);
        s.vehicles = s.vehicles.filter((v) => !v.removed);
        if (!this.probe) {
          const v = s.spawnTrafficAt(p.s + dist, p.d, p.vF, 'sedan');
          if (v) this.probe = { v, dist };
        } else this.probe.dist = dist;
        return `NIGHT TEST: CAR AT ${dist} M`;
      }
      case 'wet':
        this.forceWet = !this.forceWet;
        return `WET ROAD ${this.forceWet ? 'ON' : 'OFF'}`;
      case 'brake':
        this.hold = { t: 1.3, input: { brake: 1, accelerate: 0, handbrake: false, nitro: false } };
        return 'HARD BRAKE';
      case 'boost':
        p.nitro = Math.max(p.nitro, 100);
        this.hold = { t: 1.8, input: { nitro: true, accelerate: 1, brake: 0 } };
        return 'BOOST';
      case 'drift':
        this.hold = { t: 1.4, input: { steer: 1, handbrake: true, accelerate: 1, brake: 0 } };
        return 'DRIFT';
      case 'hitL':
      case 'hitM':
      case 'hitH': {
        const k = name === 'hitL' ? 0.22 : name === 'hitM' ? 0.55 : 0.95;
        const side = Math.random() < 0.5 ? -1 : 1;
        const x = p.pos.x + fwdX * 2 - fwdZ * side * 0.9, z = p.pos.z + fwdZ * 2 + fwdX * side * 0.9;
        fx.impact(x, 0.6, z, p.velX, p.velZ, k, 'metal', p.model.bodyMat.color.getHex());
        s.audio.impact(8 + k * 30, side * 0.5);
        if (k > 0.8) s.audio.heavyImpact();
        s.cam.kick(-side, 0.06 + k * 0.2);
        s.cam.addTrauma(0.05 + k * 0.4);
        p.bump(k * 0.6);
        return name === 'hitL' ? 'LIGHT IMPACT' : name === 'hitM' ? 'MEDIUM IMPACT' : 'HEAVY IMPACT';
      }
      case 'sparks': {
        const side = Math.random() < 0.5 ? -1 : 1;
        for (let i = 0; i < 12; i++) fx.after(i * 0.04, () => fx.sparks(p.pos.x - fwdZ * side * 1, 0.4, p.pos.z + fwdX * side * 1, 4, 0xffd090, 6, p.velX * 0.6, p.velZ * 0.6));
        return 'SCRAPE SPARKS';
      }
      case 'explosion': {
        const o = this.ahead(20, 3);
        fx.explosion(o.x, 0.5, o.z, 6, 0xff8a30);
        s.audio.explosion(0.9, 0.3);
        s.cam.addTrauma(0.25);
        return 'EXPLOSION';
      }
      case 'smoke': {
        const kinds = ['exhaust', 'damage', 'explosion', 'dust', 'burning', 'tyre', 'industrial', 'steam'] as const;
        kinds.forEach((k, i) => {
          const o = this.ahead(16 + i * 4, -4 + (i % 2) * 8);
          for (let j = 0; j < 14; j++) fx.after(j * 0.08, () => fx.puff(k, o.x, 0.5, o.z, 0, 0, 0, 1));
        });
        return 'SMOKE PROFILES';
      }
      case 'emp': {
        fx.emp(p.pos.x, 0.3, p.pos.z, 14, 0x5ad1ff);
        for (const d of [-5, 5]) {
          const o = this.ahead(10, d);
          fx.bolt(p.pos.x, 1.2, p.pos.z, o.x, 1, o.z);
        }
        s.audio.emp();
        s.postEmp = 0.6;
        return 'EMP';
      }
      case 'pickup': {
        s.placePickup('gold', p.s + 30, p.d, 0);
        s.placePickup('repair', p.s + 40, p.d + 3.5, 0);
        s.placePickup('boost', p.s + 50, p.d - 3.5, 0);
        return 'PICKUPS AHEAD';
      }
      case 'bossDeath': {
        const o = this.ahead(26, 0);
        fx.deathSequence({ x: o.x, y: 0, z: o.z }, 3, 0xff8020);
        s.audio.explosion(1.2, 0);
        s.cam.addTrauma(0.3);
        return 'BOSS DEATH';
      }
      case 'damage': {
        const hulls = [0.62, 0.35, 0.15, 1];
        this.hullIdx = (this.hullIdx + 1) % hulls.length;
        p.hp = p.maxHp * hulls[this.hullIdx];
        return `HULL ${Math.round(hulls[this.hullIdx] * 100)} %`;
      }
      case 'speed':
        p.nitro = Math.max(p.nitro, 100);
        this.hold = { t: 3.5, input: { nitro: true, accelerate: 1, brake: 0, steer: 0 } };
        return 'TOP SPEED';
    }
    return name;
  }
}

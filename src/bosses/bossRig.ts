import * as THREE from 'three';
import { EMISSIVE, glow } from '../render/visualBudget';
import type { Effects } from '../effects/particles';
import type { CarModel } from '../vehicles/carModels';

/**
 * Boss light rigs: what makes a boss read as THE boss even small on screen. Each one gets its own lights and
 * living effects; they flare up when it telegraphs an attack and go white-hot while it is vulnerable.
 */
export interface BossRig {
  update(t: number, dt: number, state: string, pos: THREE.Vector3, yaw: number): void;
  /** death: every rig lamp dies with the machine, k 1 -> 0, stuttering on the way out */
  shutdown(k: number): void;
}

const BOX = new THREE.BoxGeometry(1, 1, 1);

let lamps: THREE.MeshBasicMaterial[] = [];

function lamp(model: CarModel, color: number, x: number, y: number, z: number, sx: number, sy: number, sz: number) {
  const mat = new THREE.MeshBasicMaterial({ color: glow(color, EMISSIVE.STRONG) });
  const m = new THREE.Mesh(BOX, mat);
  m.position.set(x, y, z);
  m.scale.set(sx, sy, sz);
  model.body.add(m);
  lamps.push(mat);
  return { m, mat, color };
}

export function buildBossRig(id: string, model: CarModel, fx: Effects): BossRig {
  lamps = [];
  const rig = rigFor(id, model, fx);
  const own = lamps;
  return {
    update: rig.update,
    shutdown(k) {
      const st = Math.random() < 0.25 ? 0.15 : 1;
      for (const m of own) m.color.multiplyScalar(k <= 0.02 ? 0 : 0.86 + 0.1 * k * st);
    },
  };
}

function rigFor(id: string, model: CarModel, fx: Effects): Pick<BossRig, 'update'> {
  const L2 = model.length / 2, H = model.height, W = model.width;
  const hot = (state: string) => (state === 'TELEGRAPH' || state === 'ATTACK' ? 1 : state === 'VULNERABLE' || state === 'BREAK' ? 2 : 0);
  switch (id) {
    case 'iron_mule': {
      // two amber beacons on the cab, a furnace grille, the stacks belching smoke and sparks
      // on the cab roof (the cab is 3.6 m tall) and over the radiator behind the plow
      const beacons = [lamp(model, 0xffa010, -0.75, 3.78, L2 - 1.3, 0.35, 0.3, 0.35), lamp(model, 0xffa010, 0.75, 3.78, L2 - 1.3, 0.35, 0.3, 0.35)];
      const grille = lamp(model, 0xff3a10, 0, 1.15, L2 + 0.03, W * 0.5, 0.55, 0.04);
      return {
        update(t, _dt, state, pos, yaw) {
          const h = hot(state);
          beacons.forEach((b, i) => glow(0xffa010, Math.sin(t * 9 + i * Math.PI) > 0 ? EMISSIVE.STRONG : 0.2, b.mat.color));
          glow(h === 2 ? 0xffffff : 0xff3a10, EMISSIVE.MEDIUM + (h ? 1.2 : 0.4) * (0.6 + 0.4 * Math.sin(t * (h ? 14 : 3))), grille.mat.color);
          // smoke and sparks from the stacks — sparse, and never right in front of the camera
          if (Math.random() < (h === 1 ? 0.3 : 0.08)) {
            const fx0 = Math.sin(yaw), fz0 = Math.cos(yaw);
            for (const side of [-1, 1]) {
              const x = pos.x - Math.cos(yaw) * side * (W / 2 - 0.2) + fx0 * 2.8, z = pos.z + Math.sin(yaw) * side * (W / 2 - 0.2) + fz0 * 2.8;
              fx.smokePuff(x, pos.y + H + 2.2, z, 1, true, 0.8);
              if (h === 1) fx.sparks(x, pos.y + H + 1.4, z, 2, 0xffa040, 4);
            }
          }
        },
      };
    }
    case 'drowned_line': {
      // the bus is lit inside, cold, and arcs crawl over the roof
      // the windows are lit from inside (they carry the accent light): cold, flickering, white-hot when vulnerable
      return {
        update(t, _dt, state, pos) {
          const h = hot(state);
          const flick = Math.sin(t * 31) * Math.sin(t * 7.7) > 0.6 ? 0.4 : 1;
          glow(h === 2 ? 0xffffff : 0x40f0e0, EMISSIVE.SUBTLE * (h ? 1.8 : 1.2) * flick, model.accentMat.color);
          if (Math.random() < (h ? 0.5 : 0.12)) fx.electric(pos.x + (Math.random() - 0.5) * 3, pos.y + H + 0.3, pos.z + (Math.random() - 0.5) * 8, 1, 0x60f0ff);
        },
      };
    }
    case 'taxon': {
      // police light bar strobing red and blue, white takedown lights when it locks on
      // over the lenses of the roof light bar
      const red = lamp(model, 0xff1030, -0.4, H - 0.04, -0.15, 0.68, 0.1, 0.28);
      const blue = lamp(model, 0x1060ff, 0.4, H - 0.04, -0.15, 0.68, 0.1, 0.28);
      const take = lamp(model, 0xffffff, 0, H - 0.07, 0.02, 1.5, 0.06, 0.04);
      return {
        update(t, _dt, state) {
          const h = hot(state);
          const ph = Math.floor(t * (h === 1 ? 14 : 7)) % 4;
          glow(0xff1030, ph < 2 ? EMISSIVE.STRONG : 0.15, red.mat.color);
          glow(0x1060ff, ph >= 2 ? EMISSIVE.STRONG : 0.15, blue.mat.color);
          glow(0xffffff, h === 1 && ph % 2 ? EMISSIVE.STRONG : 0.1, take.mat.color);
        },
      };
    }
    case 'apex': {
      // a racer: its tail lights leave streaks at speed
      return {
        update(_t, _dt, state, pos, yaw) {
          if (Math.random() < 0.6) {
            const bx = pos.x - Math.sin(yaw) * (L2 + 0.2), bz = pos.z - Math.cos(yaw) * (L2 + 0.2);
            for (const side of [-1, 1]) fx.trail(bx - Math.cos(yaw) * side * 0.7, pos.y + 0.7, bz + Math.sin(yaw) * side * 0.7, hot(state) === 2 ? 0xffffff : 0xff2040, 0.5, 0.35);
          }
        },
      };
    }
    default: {
      // The Driver: seams of red light that breathe, and burst when it is about to move
      const seam = lamp(model, 0xff1040, 0, H * 0.55, 0, W + 0.04, 0.05, model.length * 0.9);
      // two thin strips along the roof edges: light lines cut into the body, not a slab on top
      const rails = [-1, 1].map((sd) => lamp(model, 0xff1040, sd * W * 0.36, H + 0.02, -0.1, 0.05, 0.035, model.length * 0.46));
      return {
        update(t, _dt, state, pos) {
          const h = hot(state);
          const k = 0.6 + 0.4 * Math.sin(t * (h ? 12 : 2.2));
          glow(h === 2 ? 0xffffff : 0xff1040, EMISSIVE.MEDIUM * (h ? 1.6 : 1) * k, seam.mat.color);
          for (const r of rails) glow(0xff1040, EMISSIVE.MEDIUM * k, r.mat.color);
          if (h === 1 && Math.random() < 0.3) fx.electric(pos.x, pos.y + 1, pos.z, 1, 0xff2050);
        },
      };
    }
  }
}

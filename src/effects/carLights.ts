import * as THREE from 'three';
import type { Effects } from './particles';
import { LAMP, type CarModel } from '../vehicles/carModels';

/**
 * Vehicle lights, every frame: glare on each lamp where the model has it (headlamps seen from the front, tail lamps
 * from behind and brighter under braking, indicators and hazards blinking amber, reverse lamps), the red sheen of the
 * brake lights on the road, and the air beams only for cars close enough to matter.
 */
const tmp = new THREE.Vector3();
const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function updateCarLights(fx: Effects, m: CarModel, pos: THREE.Vector3, yaw: number, cam: THREE.Vector3, time: number) {
  const L = m.lights;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const by = m.body.position.y;
  const dx = cam.x - pos.x, dy = cam.y - pos.y, dz = cam.z - pos.z;
  const dist = Math.hypot(dx, dy, dz) || 1;
  // how much the camera sees the front (1) or the back (-1) of the car
  const facing = (s * dx + c * dz) / dist;
  const world = (p: number[]) => tmp.set(pos.x + p[0] * c + p[2] * s, pos.y + p[1] + by, pos.z - p[0] * s + p[2] * c);
  const grow = 1 + dist * 0.014;

  // brake lights on the road behind: a dim red sheen always (the tail lamps are on), stronger with the pedal
  if (m.brakeGlow) {
    const a = 0.04 + L.brake * 0.26;
    (m.brakeGlow.material as THREE.MeshBasicMaterial).opacity = a;
    m.brakeGlow.visible = dist < 90;
  }
  if (m.beamVolume && m.role !== 'player') m.beamVolume.visible = dist < 75;
  if (dist > 170) return;

  const head = smooth(0.05, 0.75, facing) * L.head;
  if (head > 0.01) {
    const k = (m.role === 'traffic' ? 0.75 : 1.1) * head * (1 + L.highBeam * 1.3);
    for (const h of m.anchors.heads) {
      world(h);
      fx.lampGlare(tmp.x, tmp.y, tmp.z, m.lampColor, 0.55 * grow * (1 + L.highBeam * 1.4), k);
    }
  }
  const rear = smooth(0.0, 0.7, -facing);
  if (rear > 0.01) {
    const k = rear * (0.32 + L.brake * 0.9);
    for (const t of m.anchors.tails) {
      world(t);
      fx.lampGlare(tmp.x, tmp.y, tmp.z, LAMP.tail, (0.32 + L.brake * 0.22) * grow, k);
    }
    if (L.reverse) {
      for (const t of m.anchors.tails) {
        world([t[0] * 0.55, t[1] - 0.05, t[2]]);
        fx.lampGlare(tmp.x, tmp.y, tmp.z, LAMP.reverse, 0.25 * grow, rear * 0.7);
      }
    }
  }
  // indicators (and hazards): amber, on/off at ~1.5 Hz; left is the car's +x side
  if ((L.indicator !== 0 || L.hazard) && Math.sin(time * 9.4) > 0) {
    for (const p of m.anchors.indicators) {
      if (!L.hazard && Math.sign(p[0]) !== -L.indicator) continue;
      const front = p[2] > 0;
      const k = smooth(-0.2, 0.6, front ? facing : -facing);
      if (k < 0.02) continue;
      world(p);
      fx.lampGlare(tmp.x, tmp.y, tmp.z, LAMP.amber, 0.26 * grow, k * 0.9);
    }
  }
}

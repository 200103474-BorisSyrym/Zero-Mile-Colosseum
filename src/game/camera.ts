import * as THREE from 'three';
import { clamp, damp, dampAngle, wrapAngle } from '../core/math';

export interface CamAhead {
  x: number;
  y: number;
  z: number;
  heading: number;
}

/**
 * Third-person chase camera. Priorities: road readability > player visibility > enemies > speed > cinematics.
 * Sits low and close, anticipates corners by looking along the road ahead, and pulls back with speed.
 */
export class ChaseCamera {
  private yaw = 0;
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private rollZ = 0;
  trauma = 0;
  shakeEnabled = true;
  sensitivity = 1;
  cinematic = 0;
  cinematicTarget: THREE.Vector3 | null = null;
  /** a fixed vantage point the camera blends to (arrival shots); look follows the car */
  shot: THREE.Vector3 | null = null;
  shotFov = 50;
  private shotW = 0;
  /** extra FOV kick (final push, boost) on top of the speed FOV */
  fovBoost = 0;
  private t = 0;
  baseFov = 64;
  /** A brief directional kick (hit direction) in camera space. */
  private kickX = 0;
  /** motion responses: pull back under power / lean in under braking, a dip on landing, a short FOV widening */
  private accelOff = 0;
  private landDip = 0;
  private landDipV = 0;
  private fovExtra = 0;
  private airK = 0;

  /** Touchdown: the view compresses with the suspension and springs back. */
  land(impact: number) {
    this.landDipV -= Math.min(2.6, impact * 0.16);
  }
  /** A short widening of the view (boost shove, heavy crash), decaying. */
  fovKick(deg: number) {
    this.fovExtra = Math.max(this.fovExtra, deg);
  }

  constructor(public camera: THREE.PerspectiveCamera) {}

  snap(x: number, y: number, z: number, yaw: number) {
    this.yaw = yaw;
    this.pos.set(x - Math.sin(yaw) * 6.6, y + 2.7, z - Math.cos(yaw) * 6.6);
    this.look.set(x + Math.sin(yaw) * 10, y + 1, z + Math.cos(yaw) * 10);
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
  }

  addTrauma(a: number) {
    this.trauma = Math.min(1, this.trauma + a);
  }

  kick(side: number, amount: number) {
    this.kickX += side * amount;
  }

  update(dt: number, target: { x: number; y: number; z: number }, carYaw: number, velX: number, velZ: number, speed: number, maxSpeed: number, drifting: boolean, nitro: boolean, ahead: CamAhead | null = null, driftAngle = 0, motion: { accel: number; air: boolean; vy: number; roll: number } | null = null) {
    this.t += dt;
    // motion: acceleration pulls the camera back, braking lets the car come toward it; landings dip it
    this.accelOff = damp(this.accelOff, motion ? clamp(motion.accel * 0.018, -0.4, 0.45) : 0, 3, dt);
    this.landDipV += (-this.landDip * 70 - this.landDipV * 9) * dt;
    this.landDip += this.landDipV * dt;
    this.fovExtra = damp(this.fovExtra, 0, 2.2, dt);
    this.airK = damp(this.airK, motion?.air ? 1 : 0, motion?.air ? 3 : 6, dt);
    const sp = clamp(speed / Math.max(30, maxSpeed), 0, 1.3);
    const velYaw = speed > 4 ? Math.atan2(velX, velZ) : carYaw;
    // base: mostly where the car points, swing toward the slide while drifting
    let desired = drifting ? carYaw + wrapAngle(velYaw - carYaw) * 0.55 : carYaw + wrapAngle(velYaw - carYaw) * 0.25;
    // anticipate the corner: lean the view toward the road heading ahead
    if (ahead) desired += clamp(wrapAngle(ahead.heading - desired), -0.6, 0.6) * 0.28;
    this.yaw = dampAngle(this.yaw, desired, (drifting ? 3.4 : 5.2) * this.sensitivity, dt);

    const dist = 6.4 + sp * 1.8 + (nitro ? 0.6 : 0) - this.cinematic * 2.6 + this.accelOff;
    const height = 2.55 + sp * 0.45 - this.cinematic * 1.6;
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    this.pos.x = damp(this.pos.x, target.x - fx * dist, 14, dt);
    this.pos.z = damp(this.pos.z, target.z - fz * dist, 14, dt);
    // in the air the camera rides the arc a little behind the car (softer), so the jump reads as a trajectory
    this.pos.y = damp(this.pos.y, target.y + height, 7 - this.airK * 3.5, dt);

    // look target: a point down the road, so turns are visible before the car commits
    const lookDist = 9 + sp * 9;
    let lx = target.x + fx * lookDist, lz = target.z + fz * lookDist;
    if (ahead) {
      lx = lx * 0.55 + ahead.x * 0.45;
      lz = lz * 0.55 + ahead.z * 0.45;
    }
    const lookUp = motion?.air ? clamp(motion.vy * 0.08, -0.8, 0.8) : 0;
    this.look.set(damp(this.look.x, lx, 10, dt), damp(this.look.y, target.y + 0.9 - this.cinematic * 0.3 + lookUp, 8, dt), damp(this.look.z, lz, 10, dt));
    if (this.cinematicTarget && this.cinematic > 0) this.look.lerp(this.cinematicTarget, this.cinematic * 0.85);
    // arrival shot: ease from the chase position to a fixed vantage point, keep the car framed
    this.shotW = damp(this.shotW, this.shot ? 1 : 0, this.shot ? 2.2 : 4, dt);
    if (this.shotW > 0.001) {
      const w = this.shotW * this.shotW * (3 - 2 * this.shotW);
      if (this.shot) this.pos.lerp(this.shot, w);
      this.look.lerp(tmpV.set(target.x, target.y + 0.8, target.z), w);
    }

    // trauma shake (squared falloff), only for real impacts
    this.trauma = Math.max(0, this.trauma - dt * 1.7);
    this.kickX = damp(this.kickX, 0, 7, dt);
    const sh = this.shakeEnabled ? this.trauma * this.trauma : 0;
    const n = (k: number) => Math.sin(this.t * (37 + k * 13)) * Math.cos(this.t * (23 + k * 7));
    const rx = -fz, rz = fx;
    const kick = this.shakeEnabled ? this.kickX : 0;
    this.camera.position.set(
      this.pos.x + n(1) * sh * 0.5 + rx * kick,
      this.pos.y + n(2) * sh * 0.35 + this.landDip,
      this.pos.z + n(3) * sh * 0.5 + rz * kick,
    );
    this.camera.lookAt(this.look);
    this.rollZ = damp(this.rollZ, drifting ? clamp(driftAngle, -0.6, 0.6) * 0.07 : 0, 4, dt);
    // a rollover: the view leans with the body, a little
    this.camera.rotation.z += this.rollZ + n(6) * sh * 0.03 + (motion?.roll ? Math.sin(motion.roll) * 0.12 : 0);

    let fov = this.baseFov + sp * 14 + (nitro ? 5 : 0) + this.fovBoost + this.fovExtra - this.cinematic * 8;
    if (this.shotW > 0.001) fov += (this.shotFov - fov) * this.shotW;
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov = damp(this.camera.fov, fov, 4, dt);
      this.camera.updateProjectionMatrix();
    }
  }
}

const tmpV = new THREE.Vector3();

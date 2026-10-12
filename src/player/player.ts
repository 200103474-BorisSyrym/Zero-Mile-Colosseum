import * as THREE from 'three';
import { classifyImpact, slideOffRate, COLLISION_MATERIALS, formatContact, type CollisionMaterial, type CollisionMaterialId, type CollisionSeverity, type ContactRecord } from '../core/collision';
import { CONFIG } from '../core/config';
import { HANDLING as H, type LandGrade } from '../core/handling';
import { EMISSIVE, glow } from '../render/visualBudget';
import type { InputState } from '../core/input';
import { clamp, damp, wrapAngle } from '../core/math';
import type { Stats } from '../data/types';
import type { PlayerView } from '../game/simApi';
import { applyCarDamage, type CarModel } from '../vehicles/carModels';
import type { Road } from '../world/road';

export type WallSeverity = CollisionSeverity;

/**
 * What the car is doing right now. Each state has its own grip, steering and damping, and the camera, effects and
 * audio read it; the transitions between them are blended, never switched.
 */
export type DriveState =
  | 'CRUISE' | 'ACCELERATE' | 'BRAKE' | 'DRIFT' | 'AIRBORNE' | 'LANDING' | 'LIGHT_IMPACT' | 'HEAVY_IMPACT'
  | 'ROLLOVER' | 'RECOVERY' | 'OFFROAD' | 'BOOST';

export type PlayerEvent =
  | { type: 'driftStart' }
  | { type: 'driftEnd'; duration: number; perfect: number; charge: number; perfectExit: boolean }
  | { type: 'wall'; impact: number; severity: WallSeverity; material: CollisionMaterialId; x: number; z: number; side: number }
  | { type: 'scrape'; material: CollisionMaterialId; intensity: number; x: number; z: number }
  | { type: 'jump' }
  | { type: 'land'; good: boolean; perfect: boolean; air: number; impact: number; grade: LandGrade }
  | { type: 'crash' }
  | { type: 'rollScrape' }
  | { type: 'rollLand' }
  | { type: 'boostStart' }
  | { type: 'save' }
  | { type: 'unstick' }
  | { type: 'autoReset' }
  | { type: 'fall' }
  | { type: 'overheat' };

/** Per-frame modifiers supplied by the build (archetype resources, synergies). */
export interface DriveMods {
  perfectWiden: number;
  driftBoostMul: number;
  driftNoLoss: boolean;
  chargeMul: number;
  massMul: number;
  topSpeedBonus: number;
  gripMul: number;
}

export const DEFAULT_MODS: DriveMods = { perfectWiden: 0, driftBoostMul: 1, driftNoLoss: false, chargeMul: 1, massMul: 1, topSpeedBonus: 0, gripMul: 1 };

const D = CONFIG.DRIFT;
const N = CONFIG.NITRO;
const DR = CONFIG.DRIVE;

/** Engine: full pull off the line, a strong mid-range, then an asymptote — 240 → 241 is almost nothing, never a wall. */
export function engineCurve(r: number) {
  if (r <= 0) return 1;
  if (r >= 1) return 0;
  return Math.pow(1 - Math.pow(r, H.accelShape), H.accelFade);
}

/**
 * Arcade vehicle model.
 * GRIP: steering sets a target yaw rate (more authority at low speed, more centre sensitivity and less raw yaw at
 * high speed); lateral velocity is removed by the tyres up to a lateral-acceleration budget, beyond which the car
 * runs wide. A heading assist relaxes the nose back along the road when you let go; a slide assist turns the nose
 * into a slide after a knock — neither ever fights your input.
 * DRIFT: a slip-angle state. The nose swings toward a target angle set by your steering (into = more, countersteer =
 * less) on a spring, and the path bends by a share of the drift grip budget. It never spins out on its own; letting
 * go brings nose and path back together, cleanly if the angle was small.
 * AIR: ballistic, with the nose following the arc, limited pitch / yaw / roll control and a small trajectory nudge.
 * LANDING: graded by the worst of pitch, roll and heading-vs-path error; small errors are corrected for you.
 */
export class PlayerCar implements PlayerView {
  pos = new THREE.Vector3();
  velX = 0;
  velZ = 0;
  yaw = 0;
  yawRate = 0;
  vy = 0;
  grounded = true;
  airTime = 0;
  falling = false;
  s = 0;
  d = 0;
  speed = 0;
  vF = 0;
  vL = 0;
  steer = 0;

  hp = 100;
  maxHp = 100;
  nitro = 100;
  heat = 0;
  fuel = 100;
  momentum = 0;

  drifting = false;
  driftDir = 0;
  driftTime = 0;
  driftAngle = 0;
  driftCharge = 0;
  perfectTime = 0;
  inPerfect = false;
  /** 0..1: how hard the tyres are working right now (for HUD / audio). */
  gripLoad = 0;
  sliding = false;
  boostTimer = 0;
  afterburner = 0;
  phase = 0;
  bulldozer = 0;
  systemsLock = 0;
  overheatLock = 0;
  invuln = 0;
  recover = 0;
  nitroActive = false;
  tractionMul = 1;
  stuckTime = 0;
  slipstream = 0;
  braking = false;
  /** wet road (set by the session from the zone weather) */
  wet = false;
  mods: DriveMods = { ...DEFAULT_MODS };

  /** current state and seconds in it (camera / audio / effects / debug) */
  state: DriveState = 'CRUISE';
  stateT = 0;
  /** smoothed longitudinal acceleration (m/s²): the camera pulls back under power and leans in under braking */
  accelLong = 0;
  /** 0..1 blend of the drift (entry ramps it in) */
  driftW = 0;
  /** last landing grade, and seconds since it */
  landGrade: LandGrade = 'good';
  landT = 0;

  events: PlayerEvent[] = [];
  private prevS = 0;
  private lastVF = 0;
  private scrapeCd = 0;
  /** seconds since the last frame in contact with a surface (impact vs. sliding) */
  private contactGap = 9;
  private contactVN = 0;
  /** -1..1: how far the car is riding up a curb (visual roll only) */
  private curbRide = 0;
  /** collision telemetry ring (newest last); printed to the console when debugContacts is on */
  contactLog: ContactRecord[] = [];
  static debugContacts = false;
  private suspension = 0;
  private suspensionVel = 0;
  private droop = 0;
  // body springs (visual): pitch nose-down +, roll right side down +
  private bodyPitch = 0;
  private bodyPitchV = 0;
  private bodyRoll = 0;
  private bodyRollV = 0;
  // whole-car orientation off the ground: on a ramp (ground pitch) and in the air
  private carPitch = 0;
  private airPitchIn = 0;
  private carRoll = 0;
  private airRollKick = 0;
  // input shaping and buffers
  private hbHeld = false;
  private hbBuf = 0;
  private nitroKickT = 0;
  private nitroOffT = 9;
  // drift / exit / impact / save bookkeeping
  private driftLetGoT = 0;
  private driftSettledT = 0;
  private exitT = 0;
  private impactT = 0;
  private impactHeavy = false;
  private saveT = 0;
  private unstickT = 0;
  private driftCool = 0;

  constructor(public model: CarModel, public stats: Stats) {
    // yaw, then pitch about the car's own axis, then roll: the right order for a vehicle
    model.group.rotation.order = 'YXZ';
  }

  get length() {
    return this.model.length;
  }
  get width() {
    return this.model.width;
  }

  get mass() {
    return this.stats.mass * (this.bulldozer > 0 ? 2.5 : 1) * this.mods.massMul;
  }

  /** Additive speed bonuses with diminishing returns above SOFT_CAP and an absolute HARD_CAP. */
  get maxSpeedNow() {
    const st = this.stats;
    let bonus = this.mods.topSpeedBonus + this.slipstream * 0.04;
    if (this.nitroActive) bonus += N.SPEED_BONUS * Math.sqrt(st.nitroMultiplier);
    if (this.boostTimer > 0) bonus += D.BOOST_SPEED_BONUS;
    if (this.afterburner > 0) bonus += 0.12;
    let m = st.maxSpeed * (1 + bonus);
    if (m > DR.SOFT_CAP) m = DR.SOFT_CAP + (m - DR.SOFT_CAP) * 0.5;
    m = Math.min(m, DR.HARD_CAP);
    if (this.fuel <= 0) m *= CONFIG.FUEL.EMPTY_SPEED_MULT;
    return m;
  }

  /** Brake deceleration at a forward speed: bites harder at speed, eases into the stop. */
  brakeDecel(v: number) {
    const k = H.brakeLow + H.brakeHigh * clamp(v / 55, 0, 1);
    const soft = v < H.brakeSoftBelow ? 0.55 + 0.45 * (v / H.brakeSoftBelow) : 1;
    return this.stats.braking * k * soft * (this.wet ? H.wetBrake : 1);
  }

  placeAt(road: Road, s: number, d: number, speed: number) {
    const o = { x: 0, y: 0, z: 0 };
    road.toWorld(s, d, o);
    this.pos.set(o.x, o.y, o.z);
    const h = road.at(s).heading;
    this.yaw = h;
    this.velX = Math.sin(h) * speed;
    this.velZ = Math.cos(h) * speed;
    this.yawRate = 0;
    this.vy = 0;
    this.grounded = true;
    this.falling = false;
    this.drifting = false;
    this.driftW = 0;
    this.driftCharge = 0;
    this.recover = 0;
    this.rollT = 0;
    this.exitT = 0;
    this.impactT = 0;
    this.carPitch = 0;
    this.carRoll = 0;
    this.airPitchIn = 0;
    this.airRollKick = 0;
    this.stuckTime = 0;
    this.unstickT = 0;
    this.s = s;
    this.d = d;
    this.prevS = s;
  }

  update(dt: number, inp: InputState, road: Road, minS: number) {
    const st = this.stats;
    const mods = this.mods;
    this.events.length = 0;
    this.invuln = Math.max(0, this.invuln - dt);
    this.phase = Math.max(0, this.phase - dt);
    this.bulldozer = Math.max(0, this.bulldozer - dt);
    this.systemsLock = Math.max(0, this.systemsLock - dt);
    this.overheatLock = Math.max(0, this.overheatLock - dt);
    this.boostTimer = Math.max(0, this.boostTimer - dt);
    this.afterburner = Math.max(0, this.afterburner - dt);
    this.recover = Math.max(0, this.recover - dt);
    this.landT = Math.max(0, this.landT - dt);
    this.impactT = Math.max(0, this.impactT - dt);
    this.nitroKickT = Math.max(0, this.nitroKickT - dt);
    this.hbBuf = Math.max(0, this.hbBuf - dt);
    this.saveT = Math.max(0, this.saveT - dt);
    this.scrapeCd -= dt;
    this.contactGap += dt;
    this.curbRide = damp(this.curbRide, 0, 6, dt);

    // ---- input: a fresh press bites at once, then builds; release falls away fast; reversal goes through zero
    const wantSteer = inp.steer;
    if (wantSteer !== 0 && Math.sign(wantSteer) !== Math.sign(this.steer) && this.steer !== 0) this.steer = 0;
    if (wantSteer !== 0 && Math.abs(this.steer) < H.steerKick * Math.abs(wantSteer)) this.steer = H.steerKick * wantSteer;
    const rate = Math.abs(wantSteer) > Math.abs(this.steer) ? H.steerRampUp : H.steerRampDown;
    this.steer += clamp(wantSteer - this.steer, -rate * dt, rate * dt);
    if (inp.handbrake && !this.hbHeld) this.hbBuf = H.bufferTime;
    this.hbHeld = inp.handbrake;
    const control = this.recover > 0 ? H.recoverControl : 1;
    const steer = this.steer * control;
    const throttle = inp.accelerate;
    const brake = inp.brake;

    let fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    let vF = this.velX * fx + this.velZ * fz;
    const speed = Math.hypot(this.velX, this.velZ);
    const rp0 = road.at(this.s);
    const sm0 = road.sample(this.s);
    const massF = Math.sqrt(this.mass / 1.4);

    // ---- surface: zone traction, hazards (oil / water), wet weather, curb, and the unsettled moments after a hit / landing
    const curbK = Math.abs(this.curbRide) > 0.3 ? H.curbGrip : 1;
    const settle = (this.impactT > 0 ? H.impactGrip : 1) * (this.landT > 0 ? H.landGrip + (1 - H.landGrip) * (1 - this.landT / H.landTime) : 1);
    const traction = sm0.traction * this.tractionMul * mods.gripMul * (this.wet ? H.wetGrip : 1) * curbK;

    // ---- drift state
    const minDrift = D.MIN_SPEED * (this.wet ? H.wetDriftEntry : 1);
    const canDrift = this.grounded && vF > minDrift && this.recover <= 0 && this.rollT <= 0;
    this.driftCool = Math.max(0, this.driftCool - dt);
    if (!this.drifting && canDrift && (this.hbBuf > 0 || (inp.handbrake && this.driftCool <= 0)) && Math.abs(wantSteer) > 0.2) {
      this.drifting = true;
      this.driftDir = wantSteer > 0 ? -1 : 1;
      this.driftTime = 0;
      this.perfectTime = 0;
      this.driftCharge = 0;
      this.driftW = 0;
      this.driftLetGoT = 0;
      this.driftSettledT = 0;
      this.exitT = 0;
      this.hbBuf = 0;
      this.events.push({ type: 'driftStart' });
    } else if (this.drifting && !canDrift) this.endDrift(mods);

    // ---- nitro / heat / fuel
    const locked = this.systemsLock > 0 || this.overheatLock > 0;
    const wantN = inp.nitro && !locked && this.nitro > 0 && (this.nitroActive || this.nitro > N.MIN_TO_START);
    this.nitroOffT = this.nitroActive ? 0 : this.nitroOffT + dt;
    if (wantN && !this.nitroActive && this.nitroOffT > 0.6) {
      // the first moment of a boost is a shove: acceleration spike, squat, a kick in the camera (once — tapping
      // the button does not pump the camera)
      this.nitroKickT = H.nitroKickTime;
      this.bodyPitchV -= 0.9;
      this.events.push({ type: 'boostStart' });
    }
    this.nitroActive = wantN;
    if (this.nitroActive) {
      this.nitro = Math.max(0, this.nitro - N.DRAIN * dt);
      this.heat += N.HEAT_PER_SEC * st.heatGain * dt;
    } else {
      this.nitro = Math.min(st.nitroCapacity, this.nitro + st.nitroRegen * dt);
    }
    if (!this.nitroActive) this.heat -= CONFIG.HEAT.DISSIPATION * st.heatDissipation * dt * (this.overheatLock > 0 ? 2 : 1);
    this.heat = clamp(this.heat, 0, CONFIG.HEAT.MAX);
    if (this.heat >= CONFIG.HEAT.MAX && this.overheatLock <= 0) this.events.push({ type: 'overheat' });
    this.fuel = Math.max(0, this.fuel - CONFIG.FUEL.CONSUMPTION * st.fuelUse * dt * (0.45 + 0.55 * throttle) * (this.nitroActive ? 1.8 : 1));

    const maxSpd = this.maxSpeedNow;
    let accel = st.acceleration * (this.fuel <= 0 ? CONFIG.FUEL.EMPTY_ACCEL_MULT : 1);
    if (this.nitroActive) accel *= N.ACCEL_MULT * st.nitroMultiplier * (1 + H.nitroKick * (this.nitroKickT / H.nitroKickTime));
    if (this.afterburner > 0) accel *= 2.2;
    accel *= 1 + this.slipstream * 0.35;
    accel /= Math.pow(clamp(this.mods.massMul, 1, 3), 0.5);
    const cornerGrip = (this.drifting ? DR.DRIFT_GRIP_CAP : DR.CORNER_GRIP) * traction * settle;
    this.braking = false;

    if (this.drifting && this.grounded) {
      this.driftStep(dt, steer, wantSteer, throttle, brake, inp.handbrake, accel, maxSpd, traction);
      fx = Math.sin(this.yaw);
      fz = Math.cos(this.yaw);
      vF = this.velX * fx + this.velZ * fz;
    } else {
      // ---- steering: target yaw rate, capped by what the tyres can deliver at this speed
      const vAbs = Math.abs(vF);
      const sr = clamp(vAbs / st.maxSpeed, 0, 1);
      const speedFactor = clamp(Math.max(vAbs, (throttle + brake) * 2.5) / 7, 0, 1);
      const hsf = 1 + (st.steeringAtHighSpeed - 1) * sr;
      const lowAuth = 1 + (H.lowSpeedAuthority - 1) * clamp(1 - vAbs / H.lowSpeedFade, 0, 1);
      const dirSign = vF >= -0.5 ? 1 : -1;
      const steerAuth = st.steering * Math.pow(clamp(1.4 / this.mass, 0.55, 1.2), 0.35);
      // at speed the curve is more sensitive around the centre (small corrections) and capped lower by the grip
      const shaped = Math.sign(steer) * Math.pow(Math.abs(steer), 1 - H.steerCentreGain * sr);
      let targetYR: number;
      let resp = H.yawResponse / massF;
      if (this.grounded) {
        targetYR = -shaped * steerAuth * speedFactor * hsf * lowAuth * dirSign;
        const velH = Math.atan2(this.velX, this.velZ);
        const slip = speed > 6 ? wrapAngle(this.yaw - velH) : 0;
        // heading assist: not steering → the nose relaxes back parallel to the road, so a tap is a lane change.
        // On a ramp it lines you up with the lip whatever you do.
        const ramp = this.carPitch > 0.03;
        if ((Math.abs(wantSteer) < 0.05 && Math.abs(this.steer) < 0.2 && speed > 8 && vF > 0) || ramp) {
          const mis = wrapAngle(this.yaw - rp0.heading);
          if (Math.abs(mis) < DR.ASSIST_WINDOW) targetYR += clamp(-mis * DR.ASSIST_GAIN * (ramp ? 1.6 : 1), -DR.ASSIST_MAX, DR.ASSIST_MAX);
        }
        // slide assist: knocked sideways, the nose turns back into the slide — unless you are steering the other way
        if (Math.abs(slip) > H.slideAssistFrom && vF > 4) {
          const fights = Math.sign(-steer) === Math.sign(slip) && Math.abs(steer) > 0.2;
          if (!fights) targetYR += clamp(-slip * H.slideAssist, -H.slideAssistMax, H.slideAssistMax) * (this.wet ? 0.85 : 1);
        }
        // understeer: past the grip budget the nose simply won't come round any faster (braking helps it rotate)
        const yawCap = (cornerGrip * DR.YAW_LIMIT * (brake > 0 ? DR.TRAIL_BRAKE : 1)) / Math.max(8, speed);
        // (a slide may be caught harder than the grip cap allows: assist plus your countersteer)
        const catchCap = Math.max(yawCap, Math.abs(slip) * H.slideAssist * 2.2);
        targetYR = clamp(targetYR, -catchCap, catchCap);
      } else {
        // air: line up the landing
        targetYR = -steer * H.airYaw * st.airControl * 2.2;
        resp = H.yawResponseAir;
      }
      if (this.recover > 0) resp *= 0.6;
      this.yawRate = damp(this.yawRate, targetYR, resp, dt);
      this.yawRate = clamp(this.yawRate, -DR.MAX_YAW_RATE, DR.MAX_YAW_RATE);
      this.yaw = wrapAngle(this.yaw + this.yawRate * dt);

      // the drift exit: nose and path meet again (60% the path turns, 40% the nose) — quick and nearly free if clean
      if (this.exitT > 0 && this.grounded) {
        this.exitT -= dt;
        const vh = Math.atan2(this.velX, this.velZ);
        const b = wrapAngle(this.yaw - vh);
        const f = 1 - Math.exp(-H.driftExitAlign * dt);
        this.rotateVelocity(b * f * 0.6);
        this.yaw = wrapAngle(this.yaw - b * f * 0.4);
        if (Math.abs(b) > H.driftCleanExit) {
          const sp = Math.hypot(this.velX, this.velZ);
          const k = Math.max(0, sp - (Math.abs(b) - H.driftCleanExit) * 14 * dt) / Math.max(sp, 1e-4);
          this.velX *= k;
          this.velZ *= k;
        }
      }

      fx = Math.sin(this.yaw);
      fz = Math.cos(this.yaw);
      const rx = -fz, rz = fx;
      vF = this.velX * fx + this.velZ * fz;
      let vL = this.velX * rx + this.velZ * rz;

      // ---- longitudinal
      if (this.grounded) {
        if (throttle > 0) {
          if (vF < -0.5) {
            vF += this.brakeDecel(-vF) * throttle * dt;
            this.braking = true;
          } else if (vF < maxSpd) vF += accel * throttle * engineCurve(vF / maxSpd) * dt;
        }
        if (vF > maxSpd) vF = damp(vF, maxSpd, H.overSpeedPull, dt);
        if (brake > 0) {
          if (vF > 0.5) {
            vF = Math.max(0, vF - this.brakeDecel(vF) * brake * dt);
            this.braking = true;
          } else vF = Math.max(-st.reverseSpeed, vF - st.acceleration * 0.7 * brake * dt);
        }
        if (inp.handbrake && !this.drifting) {
          this.braking = true;
          vF -= Math.sign(vF) * Math.min(Math.abs(vF), H.handbrakeDecel * dt);
        }
        if (throttle === 0 && brake === 0) vF -= Math.sign(vF) * Math.min(Math.abs(vF), H.coastDecel * dt);
        // two wheels up on the curb: a little drag and a rumble through the suspension — never a stop
        if (Math.abs(this.curbRide) > 0.3 && speed > 10) {
          vF -= Math.sign(vF) * Math.min(Math.abs(vF), H.curbDrag * dt);
          this.suspensionVel += (Math.random() - 0.5) * H.curbRumble;
        }
        vF -= vF * Math.abs(vF) * H.aeroDrag * dt;
        if (this.boostTimer > 0) vF += D.BOOST_ACCEL * clamp((maxSpd - vF) / 5, 0, 1) * dt;
      }

      // ---- lateral grip, limited by the cornering budget
      let grip = st.grip * traction * settle;
      if (!this.grounded) grip = 0.12;
      const want = vL * (1 - Math.exp(-grip * dt));
      const budget = (this.grounded ? cornerGrip : 3) * dt;
      const lost = clamp(want, -budget, budget);
      vL -= lost;
      if (vF > 0) vF += Math.abs(lost) * 0.12;
      this.gripLoad = this.grounded ? clamp(Math.abs(want) / Math.max(1e-4, budget), 0, 1.5) : 0;
      this.sliding = this.grounded && Math.abs(want) > budget * 1.05 && speed > 14;

      this.velX = fx * vF + rx * vL;
      this.velZ = fz * vF + rz * vL;
      // air: a small sideways nudge of the trajectory — fix a line, not fly a plane
      if (!this.grounded && !this.falling && this.rollT <= 0) {
        const nudge = steer * H.airDodge * (st.airControl / 0.35) * dt;
        const vh = Math.atan2(this.velX, this.velZ);
        this.velX += -Math.cos(vh) * nudge;
        this.velZ += Math.sin(vh) * nudge;
      }
    }

    fx = Math.sin(this.yaw);
    fz = Math.cos(this.yaw);
    vF = this.velX * fx + this.velZ * fz;
    const vL = this.velX * -fz + this.velZ * fx;
    this.vF = vF;
    this.vL = vL;
    this.speed = Math.hypot(this.velX, this.velZ);
    this.driftAngle = Math.atan2(vL, Math.max(1, vF));

    // ---- drift scoring & charge
    if (this.drifting) {
      this.driftTime += dt;
      const a = Math.abs(this.driftAngle);
      const wide = mods.perfectWiden;
      this.inPerfect = a > D.PERFECT_MIN - wide && a < D.PERFECT_MAX + wide && this.speed > 18;
      if (this.inPerfect) this.perfectTime += dt;
      this.driftCharge = Math.min(100, this.driftCharge + D.CHARGE_RATE * mods.chargeMul * (this.inPerfect ? 1.8 : 1) * dt);
    } else this.inPerfect = false;

    // ---- the countersteer save: a big slip or spin brought back in line in time
    const slipNow = this.speed > 10 ? Math.abs(wrapAngle(this.yaw - Math.atan2(this.velX, this.velZ))) : 0;
    const knocked = this.impactT > 0 || (this.landT > 0 && this.landGrade === 'bad');
    if (knocked && !this.drifting && this.grounded && (slipNow > H.saveSlip || Math.abs(this.yawRate) > 2.6) && this.speed > 18) this.saveT = H.saveWindow;
    else if (this.saveT > 0 && slipNow < 0.12 && Math.abs(this.yawRate) < 0.6 && this.speed > 18 && this.rollT <= 0) {
      this.saveT = 0;
      this.events.push({ type: 'save' });
    }

    // ---- integrate
    this.prevS = this.s;
    this.pos.x += this.velX * dt;
    this.pos.z += this.velZ * dt;
    const proj = road.project(this.pos.x, this.pos.z, this.s, tmpProj);
    this.s = proj.s;
    this.d = proj.d;
    const rp = road.at(this.s);
    // the last metre before a lip continues the ramp (the samples drop to the road behind it: interpolating that
    // cliff used to sink the car a metre just before take-off — the crooked jump)
    const roadY = lipHeight(road, this.s, rp.y);

    // ---- the road under the car: slope along the car (backward difference — the lip of a ramp is a cliff ahead)
    const slope = clamp((roadY - road.at(this.s - 2, tmpPt).y) / 2, -0.4, 0.4) * Math.cos(wrapAngle(this.yaw - rp.heading));
    const groundPitch = Math.atan(slope);

    // ---- vertical: ramps, air, falling
    const halfW = rp.width / 2;
    const overHole = road.sample(this.s).gap;
    const offRoad = Math.abs(this.d) > halfW + 1.2 || overHole;
    if (this.grounded) {
      let launched = false;
      for (const lip of road.lips) {
        if (this.prevS < lip.s && this.s >= lip.s && vF > 6) {
          // launch along the ramp: the trajectory, the nose and the road agree
          this.grounded = false;
          this.vy = vF * lip.slope + H.launchPop;
          this.airTime = 0;
          this.carPitch = Math.atan(lip.slope);
          this.airPitchIn = 0;
          this.airRollKick = clamp(this.yawRate * this.speed * 0.004, -0.15, 0.15);
          launched = true;
          this.events.push({ type: 'jump' });
          if (this.drifting) this.endDrift(mods);
          break;
        }
      }
      if (!launched) {
        if (offRoad && !this.falling) {
          this.grounded = false;
          // drive off a broken edge: you drop (and can still be caught by the far side if you are fast)
          this.falling = !overHole;
          this.vy = 0;
          this.airPitchIn = 0;
        } else {
          this.pos.y = roadY;
          this.carPitch = damp(this.carPitch, groundPitch, 10, dt);
          this.carRoll = damp(this.carRoll, 0, 10, dt);
        }
      }
    }
    if (!this.grounded) {
      this.vy -= CONFIG.GRAVITY * dt;
      this.pos.y += this.vy * dt;
      this.airTime += dt;
      // the nose follows the arc; throttle dips it, brake lifts it
      const vh = Math.hypot(this.velX, this.velZ);
      // brake lifts the nose (throttle is held through every jump, so it must not tip the car)
      const ac = st.airControl / 0.35;
      if (brake > 0) this.airPitchIn = Math.min(H.airPitchMax, this.airPitchIn + brake * H.airPitch * ac * dt);
      else this.airPitchIn = damp(this.airPitchIn, 0, 1.2, dt);
      const traj = Math.atan2(this.vy, Math.max(4, vh)) * H.airNoseFollow;
      this.carPitch = damp(this.carPitch, traj + this.airPitchIn, H.airAlign, dt);
      this.airRollKick = damp(this.airRollKick, 0, 0.8, dt);
      this.carRoll = damp(this.carRoll, -steer * H.airRoll + this.airRollKick, 3, dt);
      if (!this.falling && !offRoad && this.pos.y <= roadY) this.land(rp.heading, groundPitch, roadY);
      if (offRoad && !this.falling && this.pos.y < roadY - 0.5) this.falling = true;
      if (this.falling && this.pos.y < roadY - 14) this.events.push({ type: 'fall' });
    }

    // ---- road edges: open-road barriers are low curbs (skim them), tunnel sides are walls
    const sm = road.sample(this.s);
    const limit = halfW + 0.3 - CONFIG.CAR_HALF_WIDTH;
    if (Math.abs(this.d) > limit && this.pos.y < roadY + 2.2 && !this.falling) {
      const side = Math.sign(this.d);
      const has = side < 0 ? sm.barrierL : sm.barrierR;
      if (has) this.surfaceContact(road, side * limit, side, -Math.cos(rp.heading) * side, Math.sin(rp.heading) * side, rp.heading, COLLISION_MATERIALS[sm.tunnel ? 'wall' : 'curb'], dt);
    }
    // central divider of split sections
    if (sm.median > 0) {
      const half = sm.median / 2 + CONFIG.CAR_HALF_WIDTH;
      const rel = this.d - sm.medianD;
      if (Math.abs(rel) < half && this.pos.y < roadY + 2) {
        const side = rel >= 0 ? 1 : -1;
        this.surfaceContact(road, sm.medianD + side * half, -side, Math.cos(rp.heading) * side, -Math.sin(rp.heading) * side, rp.heading, COLLISION_MATERIALS.divider, dt);
      }
    }
    // closed road behind
    if (this.s < minS) {
      const o = { x: 0, y: 0, z: 0 };
      road.toWorld(minS, this.d, o);
      this.pos.x = o.x;
      this.pos.z = o.z;
      const bx = Math.sin(rp.heading), bz = Math.cos(rp.heading);
      const vb = this.velX * bx + this.velZ * bz;
      if (vb < 0) {
        this.velX -= bx * vb * 1.3;
        this.velZ -= bz * vb * 1.3;
      }
      this.s = minS;
    }

    if (!Number.isFinite(this.velX) || !Number.isFinite(this.velZ) || !Number.isFinite(this.pos.x)) {
      // never let NaN physics leak out
      this.velX = this.velZ = 0;
      this.placeAt(road, Math.max(minS + 2, this.prevS), 0, 10);
    }

    // ---- recovery: never stuck. Wrong way and slow → pivot back; stuck → help out; still stuck → put back on the road
    this.recovery(dt, inp, rp.heading, halfW);

    this.updateState(dt, throttle, brake);
    this.updateVisual(dt, vF);
  }

  /** One frame of drift: a slip angle on a spring, a path bent by a share of the drift grip budget. */
  private driftStep(dt: number, steer: number, rawSteer: number, throttle: number, brake: number, handbrake: boolean, accel: number, maxSpd: number, traction: number) {
    // (keyboard or pad: `steer` is the shaped input, `rawSteer` what the player is holding right now)
    const mods = this.mods;
    let sp = Math.hypot(this.velX, this.velZ);
    let vh = Math.atan2(this.velX, this.velZ);
    let beta = wrapAngle(this.yaw - vh);
    this.driftW = Math.min(1, this.driftW + dt / H.driftEntry);
    const w = 1 - (1 - this.driftW) * (1 - this.driftW);
    const into = -steer * this.driftDir;
    const inP = Math.max(0, into), counter = Math.max(0, -into);
    // the angle you ask for: neutral holds the sweet spot, into the turn opens it, countersteer closes it
    let target = H.driftAngle + inP * H.driftAngleInto - counter * H.driftAngleCounter + brake * 0.12;
    target = clamp(target, H.driftAngleMin, H.driftAngleMax) * this.driftDir * w;
    const prevYaw = this.yaw;
    // each car's drift grip: more holds the angle tighter and bends the path harder, less is slidier
    const dg = this.stats.driftGrip / 1.7;
    beta += (target - beta) * (1 - Math.exp(-H.driftSpring * Math.sqrt(dg) * (this.wet ? H.wetDriftSpring : 1) * dt));
    beta = clamp(beta, -H.driftAngleMax * 1.08, H.driftAngleMax * 1.08);
    // the path bends with the grip budget — into the turn tighter, countersteer straighter
    const omegaMax = (DR.DRIFT_GRIP_CAP * traction * (0.85 + 0.15 * dg)) / Math.max(8, sp);
    const bend = clamp(H.driftTurn + inP * H.driftTurnInto - counter * H.driftTurnCounter, -0.15, 1);
    vh += this.driftDir * omegaMax * bend * w * dt;
    // speed: throttle pushes along the slide; more sideways than the sweet spot scrubs it
    const r = sp / Math.max(1, maxSpd);
    if (throttle > 0 && r < 1) sp += accel * throttle * engineCurve(r) * Math.cos(beta) * H.driftThrottle * dt;
    if (sp > maxSpd) sp = damp(sp, maxSpd, H.overSpeedPull, dt);
    if (!mods.driftNoLoss && sp > 15) {
      const over = Math.max(0, Math.abs(beta) - H.driftScrubFrom);
      sp -= (D.SPEED_LOSS + H.driftScrub * over * over) * dt;
    }
    if (brake > 0) {
      sp = Math.max(0, sp - this.brakeDecel(sp) * 0.6 * brake * dt);
      this.braking = true;
    }
    sp -= sp * sp * H.aeroDrag * dt;
    if (this.boostTimer > 0) sp += D.BOOST_ACCEL * clamp((maxSpd - sp) / 5, 0, 1) * dt;
    this.velX = Math.sin(vh) * sp;
    this.velZ = Math.cos(vh) * sp;
    this.yaw = wrapAngle(vh + beta);
    this.yawRate = wrapAngle(this.yaw - prevYaw) / Math.max(dt, 1e-4);
    this.gripLoad = 1.1;
    this.sliding = false;
    // ending: let go of both the handbrake and the turn, or straighten it out completely
    if (!handbrake && (into < 0.12 || Math.abs(rawSteer) < 0.05)) this.driftLetGoT += dt;
    else this.driftLetGoT = 0;
    if (Math.abs(beta) < 0.09 && target * this.driftDir < 0.15) this.driftSettledT += dt;
    else this.driftSettledT = 0;
    if (this.driftLetGoT > H.driftLetGo || this.driftSettledT > 0.2) this.endDrift(mods);
  }

  /** Rotate the velocity vector by `a` radians (keeps its length). */
  private rotateVelocity(a: number) {
    const c = Math.cos(a), s = Math.sin(a);
    const vx = this.velX, vz = this.velZ;
    // heading h has forward (sin h, cos h): turning by +a rotates (x, z) the same way the yaw does
    this.velX = vx * c + vz * s;
    this.velZ = -vx * s + vz * c;
  }

  /** Touchdown: grade it, help it if it was nearly right, punish it in proportion if it wasn't. */
  private land(roadHeading: number, groundPitch: number, roadY: number) {
    const impact = -this.vy;
    this.pos.y = roadY;
    this.grounded = true;
    this.vy = 0;
    const vh = Math.atan2(this.velX, this.velZ);
    const yawErr = Math.abs(wrapAngle(this.yaw - vh)) + Math.abs(wrapAngle(this.yaw - roadHeading)) * 0.3;
    const pitchErr = this.carPitch - groundPitch;
    const err = Math.max(Math.abs(pitchErr) * 0.8, Math.abs(this.carRoll) * 1.3, yawErr);
    let grade: LandGrade = err < H.landGood ? 'good' : err < H.landRough ? 'rough' : err < H.landBad ? 'bad' : 'crash';
    if (grade === 'good' && err < H.landPerfect && this.airTime > 0.45) grade = 'perfect';
    if (grade === 'crash' && this.airTime < 0.6 && impact < 12) grade = 'bad';
    // assist: take away part of the heading error (the path keeps going where it was going)
    const b = wrapAngle(this.yaw - vh);
    this.yaw = wrapAngle(this.yaw - b * H.landAlign[grade]);
    this.yawRate *= grade === 'perfect' || grade === 'good' ? 0.3 : 0.7;
    const keep = H.landKeep[grade];
    this.velX *= keep;
    this.velZ *= keep;
    // a nose-first landing hops a little
    if (pitchErr < -0.32 && grade !== 'perfect') this.vy = Math.min(H.landBounceMax, impact * H.landBounce);
    if (this.vy > 0.5) this.grounded = false;
    this.carPitch = groundPitch + (grade === 'perfect' || grade === 'good' ? 0 : pitchErr * 0.3);
    this.carRoll *= grade === 'perfect' || grade === 'good' ? 0 : 0.4;
    this.airPitchIn = 0;
    if (grade === 'rough') this.recover = Math.max(this.recover, 0.12);
    if (grade === 'bad') {
      this.recover = Math.max(this.recover, 0.35);
      this.yawRate += Math.sign(b || 1) * 0.8;
    }
    this.landT = H.landTime;
    this.landGrade = grade;
    this.suspensionVel -= impact * 0.06;
    this.bodyPitchV += clamp(-pitchErr, -0.4, 0.4) * 3;
    this.events.push({ type: 'land', good: grade === 'perfect' || grade === 'good', perfect: grade === 'perfect', air: this.airTime, impact, grade });
    if (grade === 'crash') {
      this.rollT = 0;
      this.crash(Math.sign(this.carRoll || b || 1));
    }
  }

  /** Never stuck: pivot back when facing the wrong way, crawl off a wall, and as a last resort a reset. */
  private recovery(dt: number, inp: InputState, heading: number, halfW: number) {
    if (this.speed < 1.8 && this.grounded) this.stuckTime += dt;
    else this.stuckTime = Math.max(0, this.stuckTime - dt * 2);
    const mis = wrapAngle(this.yaw - heading);
    const trying = inp.accelerate > 0;
    // wrong way and slow: the car pivots back toward the road while you drive
    if (this.grounded && Math.abs(mis) > 1.9 && this.speed < 8 && inp.accelerate > 0 && Math.abs(inp.steer) < 0.5) {
      this.yaw = wrapAngle(this.yaw - Math.sign(mis) * H.turnAroundRate * dt);
    }
    if (this.stuckTime > H.unstickAfter && trying) {
      if (this.unstickT === 0) this.events.push({ type: 'unstick' });
      this.unstickT += dt;
      // turn toward the road, crawl off whatever holds the car
      this.yaw = wrapAngle(this.yaw - clamp(mis, -H.unstickTurn * dt, H.unstickTurn * dt));
      const fx = Math.sin(heading), fz = Math.cos(heading);
      this.velX += fx * H.unstickPush * dt;
      this.velZ += fz * H.unstickPush * dt;
      if (Math.abs(this.d) > halfW - 2) {
        const rx = -Math.cos(heading), rz = Math.sin(heading);
        const toCentre = -Math.sign(this.d) * 1.5 * dt;
        this.pos.x += rx * toCentre;
        this.pos.z += rz * toCentre;
      }
    } else if (this.stuckTime < 0.2) this.unstickT = 0;
    if (this.stuckTime > H.autoResetAfter) {
      this.stuckTime = 0;
      this.events.push({ type: 'autoReset' });
    }
  }

  /** The state the rest of the game reads (camera, audio, effects, debug). */
  private updateState(dt: number, throttle: number, brake: number) {
    let s: DriveState;
    if (this.rollT > 0) s = 'ROLLOVER';
    else if (!this.grounded) s = 'AIRBORNE';
    else if (this.impactT > 0) s = this.impactHeavy ? 'HEAVY_IMPACT' : 'LIGHT_IMPACT';
    else if (this.recover > 0 || this.unstickT > 0) s = 'RECOVERY';
    else if (this.landT > 0) s = 'LANDING';
    else if (this.drifting) s = 'DRIFT';
    else if (Math.abs(this.curbRide) > 0.5) s = 'OFFROAD';
    else if (this.nitroActive || this.afterburner > 0) s = 'BOOST';
    else if (brake > 0 && this.vF > 2) s = 'BRAKE';
    else if (throttle > 0 && this.vF < this.maxSpeedNow * 0.97) s = 'ACCELERATE';
    else s = 'CRUISE';
    if (s !== this.state) {
      this.state = s;
      this.stateT = 0;
    } else this.stateT += dt;
  }

  /**
   * Hit by another vehicle (the arcade response is computed by the combat system): velocity change, a yaw kick the
   * player can catch, an unsettled moment, and the body rocking with it.
   */
  hitBy(dvx: number, dvz: number, yawKick: number, heavy: boolean, unsettle = true) {
    this.velX += dvx;
    this.velZ += dvz;
    this.yawRate += yawKick;
    if (unsettle) {
      this.impactT = heavy ? H.impactHeavy : Math.max(this.impactT, H.impactLight);
      this.impactHeavy = heavy || (this.impactHeavy && this.impactT > 0);
      if (heavy) this.recover = Math.max(this.recover, 0.25);
    }
    // the body rocks away from the hit
    const rx = -Math.cos(this.yaw), rz = Math.sin(this.yaw);
    const lat = dvx * rx + dvz * rz;
    this.bodyRollV += clamp(lat * 0.12, -1.6, 1.6);
    if (!this.grounded) this.airRollKick += clamp(lat * 0.04, -0.4, 0.4);
    if (this.drifting && heavy) this.endDrift();
  }

  /**
   * Contact with a surface along the road. (nx, nz) points INTO the surface; `pen` is the side on which d grows into it.
   * IMPACT (first contact frame, or a much harder hit while already touching): keep a share of the tangential speed
   * that depends on the impact angle, bounce a little, turn the nose along the surface.
   * SLIDING (every other contact frame): remove only the into-surface velocity and apply a small time-based friction.
   * Speed along the surface is never multiplied away frame after frame — that is what used to stop the car dead.
   *
   * Edge gradation: a scrape (sparks, a rasp), a light touch (a bump: the body hops and the nose twitches), a medium
   * knock (the wheel catches: a lift and a stumble), a heavy hit (the car is spun off the wall — catch it).
   */
  private surfaceContact(road: Road, dLimit: number, pen: number, nx: number, nz: number, heading: number, mat: CollisionMaterial, dt: number) {
    const depth = (this.d - dLimit) * pen;
    if (depth <= 0) return;
    // position: a curb can be ridden a few centimetres before it becomes solid, then the car rolls off it
    let dNew = this.d;
    if (depth > mat.climb) dNew = dLimit + pen * mat.climb;
    if (mat.climb > 0) {
      dNew -= pen * Math.min(Math.max(0, (dNew - dLimit) * pen), 3.5 * dt);
      this.curbRide = clamp((pen * depth) / mat.climb, -1, 1);
    }
    if (dNew !== this.d) {
      const o = { x: 0, y: 0, z: 0 };
      road.toWorld(this.s, dNew, o);
      this.pos.x = o.x;
      this.pos.z = o.z;
      this.d = dNew;
    }
    const vN = this.velX * nx + this.velZ * nz;
    const tX = this.velX - nx * vN, tZ = this.velZ - nz * vN;
    const vT = Math.hypot(tX, tZ);
    // direction along the surface: the way we are sliding, or the road direction when hitting head-on
    let dirX: number, dirZ: number;
    if (vT > 1) {
      dirX = tX / vT;
      dirZ = tZ / vT;
    } else {
      const fx = Math.sin(heading), fz = Math.cos(heading);
      const fwd = Math.sin(this.yaw) * fx + Math.cos(this.yaw) * fz >= 0 ? 1 : -1;
      dirX = fx * fwd;
      dirZ = fz * fwd;
    }
    const cx = this.pos.x + nx * 1.05, cz = this.pos.z + nz * 1.05;
    const isImpact = vN > 0.5 && (this.contactGap > 0.12 || vN > this.contactVN + 3);
    this.contactGap = 0;
    if (vN > 0) {
      if (isImpact) {
        const before = this.speed;
        const { severity, angle } = classifyImpact(vN, vT);
        const deflect = severity === 'heavy' ? 1 : severity === 'medium' ? 0.5 : 0;
        const along = vT * mat.retention[severity] + vN * mat.redirect * deflect;
        const bounce = Math.min(vN * mat.restitution, mat.maxBounce);
        this.velX = dirX * along - nx * bounce;
        this.velZ = dirZ * along - nz * bounce;
        // the nose follows the surface: skim it instead of sticking or spinning
        const rel = wrapAngle(Math.atan2(dirX, dirZ) - this.yaw);
        const align = severity === 'scrape' || severity === 'light' ? mat.alignSoft : mat.alignHard;
        this.yaw = wrapAngle(this.yaw + clamp(rel * align, -0.5, 0.5));
        this.yawRate *= severity === 'heavy' ? 0.2 : 0.55;
        // the body answers: a bump, a stumble, a shove
        const away = -pen; // roll away from the surface
        if (severity === 'light') {
          this.suspensionVel -= 0.35 + vN * 0.03;
          this.bodyRollV += away * 0.5;
          this.yawRate += away * 0.12;
        } else if (severity === 'medium') {
          this.suspensionVel -= 0.6 + vN * 0.03;
          this.bodyRollV += away * 1.1;
          this.yawRate += -rel * 0.6;
          this.impactT = Math.max(this.impactT, H.impactLight);
        } else if (severity === 'heavy') {
          // spun off the wall: a yaw the player can countersteer, not a dead stop
          this.yawRate += clamp(-rel * 2.2, -2.4, 2.4);
          this.bodyRollV += away * 1.6;
          this.impactT = H.impactHeavy;
          this.impactHeavy = true;
        }
        if (severity === 'heavy') {
          this.recover = Math.max(this.recover, mat.recover);
          if (this.drifting) this.endDrift(this.mods);
        } else if (severity === 'medium') {
          // a solid knock unsettles the car briefly — banging off walls is never a free way round a corner
          this.recover = Math.max(this.recover, mat.recover * 0.6);
          if (this.drifting && mat.id !== 'curb') this.endDrift(this.mods);
        }
        this.contactVN = vN;
        this.speed = Math.hypot(this.velX, this.velZ);
        this.logContact({ t: performance.now() / 1000, material: mat.label, severity, angle, before: Math.round(before * 3.6), after: Math.round(this.speed * 3.6), vN, vT, bounce });
        if (severity !== 'scrape') this.events.push({ type: 'wall', impact: vN, severity, material: mat.id, x: cx, z: cz, side: pen });
      } else {
        // sliding: cancel what pushes into the surface, keep what runs along it — minus friction that grows
        // with the load (vN / dt is the acceleration the surface had to supply this frame)
        const load = Math.min(80, vN / Math.max(dt, 1e-4));
        const keep = Math.max(0, vT - (mat.scrapeFriction + mat.mu * load) * dt) / Math.max(vT, 1e-4);
        this.velX = tX * keep;
        this.velZ = tZ * keep;
        this.contactVN = Math.max(0, this.contactVN - 20 * dt);
      }
    }
    // don't keep driving into it: turn the heading off the surface while in contact
    const into = Math.sin(this.yaw) * nx + Math.cos(this.yaw) * nz;
    if (into > 0.02) {
      const rel = wrapAngle(Math.atan2(dirX, dirZ) - this.yaw);
      const rate = slideOffRate(mat, into);
      this.yaw = wrapAngle(this.yaw + clamp(rel, -rate * dt, rate * dt));
    }
    if (this.speed > 8 && this.scrapeCd <= 0) {
      this.scrapeCd = 0.06;
      this.events.push({ type: 'scrape', material: mat.id, intensity: clamp(vT / 50, 0.1, 1), x: cx, z: cz });
    }
  }

  logContact(r: ContactRecord) {
    this.contactLog.push(r);
    if (this.contactLog.length > 30) this.contactLog.shift();
    if (PlayerCar.debugContacts) console.info('[contact]', formatContact(r));
  }

  endDrift(mods: DriveMods = this.mods) {
    if (!this.drifting) return;
    this.drifting = false;
    this.driftW = 0;
    this.exitT = H.driftExit;
    this.driftCool = 0.3;
    const dur = this.driftTime;
    const perfectExit = this.inPerfect || this.perfectTime > dur * 0.5;
    if (dur > 0.5) {
      this.boostTimer = (Math.min(D.BOOST_MAX, dur * D.BOOST_PER_SECOND) + this.perfectTime * 0.3) * mods.driftBoostMul;
    }
    this.events.push({ type: 'driftEnd', duration: dur, perfect: this.perfectTime, charge: this.driftCharge, perfectExit });
    this.driftTime = 0;
    this.inPerfect = false;
  }

  /** -1..1: how far the car rides up a curb (which side by sign) — effects read it */
  get curbSide() {
    return this.curbRide;
  }

  /** Body roll of the whole car for the camera to follow (rollover, air). */
  get visualRoll() {
    return this.model.group.rotation.z;
  }

  private updateVisual(dt: number, vF: number) {
    const m = this.model;
    m.group.position.copy(this.pos);
    m.group.rotation.y = this.yaw;
    m.group.rotation.x = -this.carPitch;
    m.group.rotation.z = this.carRoll;
    // crash spectacle: one barrel roll around the car's centre, landing back on its wheels
    if (this.rollT > 0) {
      const before = this.rollT;
      this.rollT = Math.max(0, this.rollT - dt);
      const k = 1 - this.rollT / ROLL_TIME;
      const k0 = 1 - before / ROLL_TIME;
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const th = this.rollDir * e * Math.PI * 2;
      const c = 0.75;
      m.group.rotation.z = th;
      m.group.position.x += Math.cos(this.yaw) * c * Math.sin(th);
      m.group.position.z -= Math.sin(this.yaw) * c * Math.sin(th);
      m.group.position.y += c * (1 - Math.cos(th)) + Math.sin(k * Math.PI) * this.rollHeight;
      if (k0 < 0.5 && k >= 0.5) this.events.push({ type: 'rollScrape' });
      if (this.rollT === 0) {
        this.suspensionVel -= 2.5;
        this.events.push({ type: 'rollLand' });
      }
    }
    // longitudinal acceleration (smoothed): the nose dives under braking and squats under power
    // (from the speed itself: in a slide the forward component drops as the car turns sideways, which is not braking)
    const sv = this.speed * (vF >= 0 ? 1 : -1);
    const accelLong = (sv - this.lastVF) / Math.max(dt, 1e-4);
    this.lastVF = sv;
    this.accelLong = damp(this.accelLong, this.grounded ? clamp(accelLong, -40, 40) : 0, 8, dt);
    // simple spring suspension driven by acceleration and landings
    this.suspensionVel += (-this.suspension * 120 - this.suspensionVel * 12) * dt;
    this.suspension += this.suspensionVel * dt;
    const latAcc = this.yawRate * this.speed;
    const targetRoll = this.grounded
      ? clamp(latAcc * H.bodyRoll, -H.bodyRollMax, H.bodyRollMax) + (this.drifting ? -this.driftDir * 0.03 : 0) - this.curbRide * 0.07
      : 0;
    const targetPitch = this.grounded ? clamp(-this.accelLong * H.bodyPitch, -H.bodyPitchMax, H.bodyPitchMax) - (this.nitroKickT > 0 ? 0.03 : 0) : 0;
    // body springs: it overshoots a little and settles — the car breathes
    this.bodyPitchV += ((targetPitch - this.bodyPitch) * H.bodySpring - this.bodyPitchV * H.bodyDamping) * dt;
    this.bodyPitch += this.bodyPitchV * dt;
    this.bodyRollV += ((targetRoll - this.bodyRoll) * H.bodySpring - this.bodyRollV * H.bodyDamping) * dt;
    this.bodyRoll += this.bodyRollV * dt;
    this.bodyPitch = clamp(this.bodyPitch, -0.16, 0.16);
    this.bodyRoll = clamp(this.bodyRoll, -0.2, 0.2);
    m.body.rotation.set(this.bodyPitch, 0, this.bodyRoll);
    m.body.position.y = clamp(this.suspension, -0.15, 0.1) + Math.abs(this.curbRide) * 0.08;
    for (const w of m.wheels) w.rotation.x += (vF / Math.max(0.2, m.wheelR)) * dt;
    // front wheels: steering lock fades with speed; in a drift they point along the slide (opposite lock)
    const sr = clamp(Math.abs(vF) / Math.max(1, this.stats.maxSpeed), 0, 1);
    const lock = H.wheelLock + (H.wheelLockHigh - H.wheelLock) * sr;
    const wheelAngle = this.drifting ? clamp(this.driftAngle * 0.8, -0.55, 0.55) : -this.steer * lock;
    for (const f of m.frontWheels) f.rotation.y = damp(f.rotation.y, wheelAngle, 14, dt);
    // suspension travel: in the air the wheels hang out of the arches, on landing they tuck back in; the wheels on
    // a curb ride up with it
    this.droop = damp(this.droop, this.grounded ? 0 : 0.12, this.grounded ? 16 : 5, dt);
    if (m.pivots) {
      for (const p of m.pivots) {
        const onCurb = this.curbRide !== 0 && Math.sign(p.o.position.x) === -Math.sign(this.curbRide) ? Math.abs(this.curbRide) * 0.1 : 0;
        p.o.position.y = p.y - this.droop + onCurb;
      }
    }
    const brake = this.braking || this.drifting;
    if (brake) glow(0xff1030, EMISSIVE.MEDIUM, m.tailMat.color);
    else m.tailMat.color.setHex(0x7a0010);
    const ghost = this.phase > 0;
    m.bodyMat.transparent = ghost;
    m.bodyMat.opacity = ghost ? 0.35 : 1;
    m.bodyMat.emissive.setHex(this.bulldozer > 0 ? 0x553300 : ghost ? 0x301050 : this.heat > CONFIG.HEAT.HIGH ? 0x400800 : 0x000000);
    if (m.underglow) (m.underglow.material as THREE.MeshBasicMaterial).opacity = 0.22 + (this.nitroActive ? 0.25 : 0) + Math.sin(performance.now() * 0.004) * 0.04;
    applyCarDamage(m, this.hp / Math.max(1, this.maxHp), performance.now() / 1000);
  }

  private rollT = 0;
  private rollDir = 1;
  private rollHeight = 1.4;
  get rolling() {
    return this.rollT > 0;
  }
  /** A big crash: the car barrel-rolls once (visual) and the driver loses most control for a moment. */
  crash(dir: number) {
    if (this.rollT > 0) return;
    this.rollT = ROLL_TIME;
    this.rollDir = dir >= 0 ? 1 : -1;
    // the faster it was going, the higher it tumbles
    this.rollHeight = clamp(0.8 + this.speed * 0.02, 0.8, 2);
    this.velX *= 0.88;
    this.velZ *= 0.88;
    this.recover = Math.max(this.recover, 0.75);
    if (this.drifting) this.endDrift();
    this.events.push({ type: 'crash' });
  }

  /** Kick the suspension (impacts). */
  bump(amount: number) {
    this.suspensionVel -= amount;
  }
}

const tmpProj = { s: 0, d: 0 };
const tmpPt = { x: 0, y: 0, z: 0, heading: 0, width: 0 };

/** Road height at s, with the last metre before a ramp lip following the ramp instead of the drop behind it. */
export function lipHeight(road: Road, s: number, y: number) {
  for (const lip of road.lips) {
    if (s > lip.s - 1.2 && s < lip.s + 0.05) return road.at(lip.s - 1.2, tmpPt).y + lip.slope * (s - (lip.s - 1.2));
  }
  return y;
}
const ROLL_TIME = 0.85;

import { BASE_STATS, VEHICLES } from '../data/vehicles';
import type { Stats } from '../data/types';
import type { InputState } from '../core/input';
import { clamp, wrapAngle } from '../core/math';
import { PlayerCar } from '../player/player';
import type { ModelKind } from '../data/enemies';
import { buildCar } from '../vehicles/carModels';
import { Road, type RoadSample } from '../world/road';

/**
 * Driving physics bench (dev only): the player car on synthetic roads with scripted input, headless, fixed 60 Hz.
 * It measures the feel numbers (0–100, stopping, lane changes, drift, curbs, jumps) and checks invariants —
 * "a curb never stops the car", "a drift never spins out on its own", "a ramp always launches". It does not grade
 * feel; it catches the regressions that make a car feel broken.
 *
 *   zm.physics()            → all benchmarks + invariants for the Courier
 *   zm.physics('ghost')     → another car
 */
const DT = 1 / 60;
const KMH = 3.6;

interface RoadSpec {
  length: number;
  /** curvature (1/m) at s */
  k?: (s: number) => number;
  /** height at s */
  y?: (s: number) => number;
  width?: number;
  traction?: number;
  lips?: { s: number; slope: number }[];
  gaps?: { s0: number; s1: number }[];
}

export function syntheticRoad(spec: RoadSpec): Road {
  const r = new Road();
  let x = 0, z = 0, h = 0;
  for (let s = 0; s <= spec.length; s++) {
    if (s > 0) {
      h += (spec.k?.(s) ?? 0);
      x += Math.sin(h);
      z += Math.cos(h);
    }
    const gap = !!spec.gaps?.some((g) => s > g.s0 + 0.5 && s < g.s1);
    const sample: RoadSample = {
      x, z, y: gap ? 0 : spec.y?.(s) ?? 0, heading: h, width: spec.width ?? 15.6,
      barrierL: !gap, barrierR: !gap, tunnel: false, traction: spec.traction ?? 1, seg: 0,
      median: 0, medianD: 0, markL: 0, markR: 0, gap,
    };
    r.push(sample);
  }
  r.lips = spec.lips ?? [];
  r.gaps = spec.gaps ?? [];
  return r;
}

const NONE: InputState = { accelerate: 0, brake: 0, steer: 0, handbrake: false, nitro: false };
const inp = (o: Partial<InputState>): InputState => ({ ...NONE, ...o });

const modelCache: Record<string, ReturnType<typeof buildCar>> = {};
export function benchCar(vehicle = 'courier', overrides: Partial<Stats> = {}) {
  const def = VEHICLES.find((v) => v.id === vehicle) ?? VEHICLES[0];
  const model = (modelCache[def.model] ??= buildCar(def.model as ModelKind, { color: def.color, accent: def.accent, role: 'player' }));
  const car = new PlayerCar(model, { ...BASE_STATS, ...def.stats, ...overrides });
  car.fuel = 100;
  car.nitro = 100;
  return car;
}

/** Run `frames` steps with input chosen per frame; returns the car. */
function drive(car: PlayerCar, road: Road, frames: number, input: (i: number, car: PlayerCar) => InputState, each?: (i: number, car: PlayerCar) => boolean | void) {
  for (let i = 0; i < frames; i++) {
    car.update(DT, input(i, car), road, -1e9);
    if (each?.(i, car)) break;
  }
  return car;
}

const straight = () => syntheticRoad({ length: 6000 });

function heading(car: PlayerCar, road: Road) {
  return wrapAngle(car.yaw - road.at(car.s).heading);
}

export interface Bench {
  [k: string]: number | string | boolean | Bench | (number | string)[];
}

export function runPhysicsTests(vehicle = 'courier') {
  const out: Bench = {};
  const checks: { name: string; ok: boolean; value: string }[] = [];
  const check = (name: string, ok: boolean, value: string) => checks.push({ name, ok, value });

  // ---- acceleration: launch from standstill
  {
    const road = straight();
    const car = benchCar(vehicle);
    car.placeAt(road, 10, 0, 0);
    const marks: Record<string, number> = {};
    drive(car, road, 60 * 40, () => inp({ accelerate: 1 }), (i, c) => {
      const kmh = c.speed * KMH;
      for (const m of [50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220]) if (kmh >= m && marks[m] === undefined) marks[m] = +((i + 1) * DT).toFixed(2);
    });
    out.accel = { t50: marks[50] ?? -1, t100: marks[100] ?? -1, t150: marks[150] ?? -1, t170: marks[170] ?? -1, t180: marks[180] ?? -1, t200: marks[200] ?? -1, top: Math.round(car.speed * KMH) };
    check('0→100 under 4.5 s', (marks[100] ?? 99) < 4.5, `${marks[100]} s`);
    check('reaches 95% of its top speed within 9 s', (marks[Math.floor(car.stats.maxSpeed * KMH * 0.95 / 10) * 10] ?? 99) < 9, `top ${Math.round(car.speed * KMH)} km/h`);
  }

  // ---- braking: from 100 and 200 km/h
  for (const v0 of [100, 200]) {
    const road = straight();
    const car = benchCar(vehicle);
    car.placeAt(road, 10, 0, v0 / KMH);
    const s0 = car.s;
    let t = 0;
    drive(car, road, 60 * 15, () => inp({ brake: 1 }), (i, c) => {
      t = (i + 1) * DT;
      return c.vF < 0.5;
    });
    (out as Record<string, Bench>)[`brake${v0}`] = { dist: +(car.s - s0).toFixed(1), time: +t.toFixed(2) };
    if (v0 === 100) check('100→0 within 25 m', car.s - s0 < 25, `${(car.s - s0).toFixed(1)} m`);
  }

  // ---- input latency and lane changes: tap A for 0.15 s and 0.3 s, release, watch 2 s
  const lane: Bench = {};
  for (const v0 of [100, 150, 200, 250]) {
    for (const tap of [0.15, 0.3]) {
      const road = straight();
      const car = benchCar(vehicle);
      car.placeAt(road, 10, 0, v0 / KMH);
      const tapF = Math.round(tap / DT);
      let firstYaw = -1, firstLat = -1, peakMis = 0, settle = -1;
      drive(car, road, 60 * 3, (i) => inp({ accelerate: 1, steer: i < tapF ? -1 : 0 }), (i, c) => {
        const mis = Math.abs(heading(c, road));
        if (firstYaw < 0 && Math.abs(c.yawRate) > 0.05) firstYaw = (i + 1) * DT;
        if (firstLat < 0 && Math.abs(c.d) > 0.2) firstLat = (i + 1) * DT;
        peakMis = Math.max(peakMis, mis);
        if (i > tapF && settle < 0 && mis < 0.02) settle = (i + 1) * DT - tap;
      });
      lane[`${v0}_${tap}`] = { dLat: +Math.abs(car.d).toFixed(2), yawMs: Math.round(firstYaw * 1000), latMs: Math.round(firstLat * 1000), peakDeg: +((peakMis * 180) / Math.PI).toFixed(1), settle: +settle.toFixed(2), endKmh: Math.round(car.speed * KMH) };
    }
  }
  out.lane = lane;
  const l200 = lane['200_0.15'] as Bench;
  check('a 0.15 s tap at 200 km/h moves the car 0.8–4.5 m (about one lane)', (l200.dLat as number) > 0.8 && (l200.dLat as number) < 4.5, `${l200.dLat} m`);
  check('steering answers within 50 ms', (l200.yawMs as number) <= 50, `${l200.yawMs} ms`);
  check('heading settles after a tap at 200 km/h', (l200.settle as number) > 0 && (l200.settle as number) < 1.5, `${l200.settle} s`);

  // ---- held steering: steady turn rate and speed kept
  const turn: Bench = {};
  for (const v0 of [60, 120, 200]) {
    const road = straight();
    const car = benchCar(vehicle);
    car.placeAt(road, 10, 0, v0 / KMH);
    let turned = 0, prevYaw = car.yaw;
    drive(car, road, 60, () => inp({ accelerate: 1, steer: 1 }), (_i, c) => {
      turned += Math.abs(wrapAngle(c.yaw - prevYaw));
      prevYaw = c.yaw;
    });
    turn[v0] = { degPerSec: Math.round((turned * 180) / Math.PI), radius: Math.round(car.speed / Math.max(1e-3, turned)), endKmh: Math.round(car.speed * KMH) };
  }
  out.turn = turn;

  // ---- brake + steer: does braking still let you turn?
  {
    const road = straight();
    const a = benchCar(vehicle), b = benchCar(vehicle);
    a.placeAt(road, 10, 0, 150 / KMH);
    b.placeAt(road, 10, 0, 150 / KMH);
    let ta = 0, tb = 0, pa = a.yaw, pb = b.yaw;
    drive(a, road, 60, () => inp({ steer: 1, accelerate: 1 }), (_i, c) => { ta += Math.abs(wrapAngle(c.yaw - pa)); pa = c.yaw; });
    drive(b, road, 60, () => inp({ steer: 1, brake: 1 }), (_i, c) => { tb += Math.abs(wrapAngle(c.yaw - pb)); pb = c.yaw; });
    out.brakeSteer = { steerDeg: Math.round((ta * 180) / Math.PI), brakeSteerDeg: Math.round((tb * 180) / Math.PI), brakeEndKmh: Math.round(b.speed * KMH) };
    check('braking does not kill steering (≥ 80% of the turn)', tb >= ta * 0.8, `${Math.round((tb / ta) * 100)} %`);
  }

  // ---- drift through a long left-hander (R 70 m), driven by a simple "player": enter, hold, then the road
  // straightens and the drift is let go. Checks: it stays on the road, never spins, exits clean.
  {
    const R = 70;
    const road = syntheticRoad({ length: 2400, k: (s) => (s > 200 && s < 200 + R * 2.4 ? 1 / R : 0) });
    const car = benchCar(vehicle);
    car.placeAt(road, 150, 2, 150 / KMH);
    let peak = 0, spun = false, started = -1, maxOff = 0, ended = -1, settle = -1, minKmh = 999;
    const halfW = 15.6 / 2;
    drive(car, road, 60 * 7, (i, c) => {
      const t = i * DT;
      const rh = road.at(c.s).heading;
      const vh = Math.atan2(c.velX, c.velZ);
      const inCurve = c.s > 195 && c.s < 200 + R * 2.4 - 10;
      if (!inCurve) return inp({ accelerate: c.s > 195 ? 1 : 0, steer: c.drifting ? 0 : clamp(-c.d * 0.12 + wrapAngle(c.yaw - rh) * 2, -1, 1) });
      // a player keeps the slide on the line: more into the turn when the path lags the road or runs wide
      const lag = wrapAngle(rh - vh);
      const into = clamp(0.35 + lag * 3 + c.d * 0.12, -1, 1);
      // ... and lifts off the throttle when the slide runs wide
      return inp({ accelerate: c.d > 2.5 ? 0 : 1, handbrake: t < 4.6, steer: c.drifting ? -into : -1 });
    }, (i, c) => {
      if (c.drifting && started < 0) started = i * DT;
      if (started >= 0 && !c.drifting && ended < 0) ended = i * DT;
      if (c.drifting) {
        peak = Math.max(peak, Math.abs(c.driftAngle));
        maxOff = Math.max(maxOff, Math.abs(c.d));
        minKmh = Math.min(minKmh, c.speed * KMH);
      }
      if (ended > 0 && settle < 0 && Math.abs(wrapAngle(c.yaw - Math.atan2(c.velX, c.velZ))) < 0.03) settle = i * DT - ended;
      if (Math.abs(wrapAngle(c.yaw - Math.atan2(c.velX, c.velZ))) > 1.6) spun = true;
    });
    out.drift = { startedAt: +started.toFixed(2), heldFor: +(ended - started).toFixed(2), peakDeg: Math.round((peak * 180) / Math.PI), maxOffset: +maxOff.toFixed(1), minKmh: Math.round(minKmh), exitSettle: +settle.toFixed(2), spun };
    check('a drift enters on handbrake + steer', started >= 0, `${started.toFixed(2)} s`);
    check('a driven drift holds the curve without leaving the road', maxOff < halfW - 1, `max |d| ${maxOff.toFixed(1)} m`);
    check('a drift never spins out', !spun, spun ? 'spun' : 'held');
    check('a drift exit settles within 0.5 s', settle >= 0 && settle < 0.5, `${settle.toFixed(2)} s`);
    check('a drift keeps ≥ 75% of its entry speed', minKmh > 112, `${Math.round(minKmh)} km/h`);
  }

  // ---- spun by a hit at 180 km/h (nose 50° off the path, turning away fast): hands off, the car gathers itself;
  // with a countersteer it is caught sooner
  {
    const res: Bench = {};
    for (const mode of ['hands-off', 'countersteer']) {
      const road = straight();
      const car = benchCar(vehicle);
      car.placeAt(road, 10, 0, 180 / KMH);
      car.yaw += 0.85;
      car.hitBy(0, 0, 2.4, true);
      let rec = -1;
      drive(car, road, 60 * 4, (_i, c) => {
        const slip = wrapAngle(c.yaw - Math.atan2(c.velX, c.velZ));
        return inp({ accelerate: 1, steer: mode === 'countersteer' ? clamp(slip * 2, -1, 1) : 0 });
      }, (i, c) => {
        const slip = Math.abs(wrapAngle(c.yaw - Math.atan2(c.velX, c.velZ)));
        if (rec < 0 && i > 10 && slip < 0.05 && Math.abs(c.yawRate) < 0.3) rec = i * DT;
      });
      res[mode] = { recover: +rec.toFixed(2), endKmh: Math.round(car.speed * KMH), d: +car.d.toFixed(1) };
    }
    out.knock = res;
    check('a spin from a hit straightens by itself within 2 s', ((res['hands-off'] as Bench).recover as number) > 0 && ((res['hands-off'] as Bench).recover as number) < 2, `${(res['hands-off'] as Bench).recover} s`);
    check('countersteer saves it faster than hands-off', ((res.countersteer as Bench).recover as number) > 0 && ((res.countersteer as Bench).recover as number) <= ((res['hands-off'] as Bench).recover as number), `${(res.countersteer as Bench).recover} s`);
  }

  // ---- wedged nose-first against the barrier at a standstill: holding throttle gets it out
  {
    const road = straight();
    const car = benchCar(vehicle);
    car.placeAt(road, 10, 6.3, 0);
    car.yaw -= 1.3;
    let free = -1, reset = false;
    drive(car, road, 60 * 7, () => inp({ accelerate: 1 }), (i, c) => {
      if (c.events.some((e) => e.type === 'autoReset')) reset = true;
      if (free < 0 && c.speed > 12 && Math.abs(wrapAngle(c.yaw - road.at(c.s).heading)) < 0.5) free = i * DT;
      return free > 0 || reset;
    });
    out.wedged = { free: +free.toFixed(2), reset };
    check('a car wedged against the wall drives out (or is reset) within 5 s', free > 0 || reset, free > 0 ? `free ${free.toFixed(1)} s` : reset ? 'reset' : 'stuck');
  }

  // ---- odd cases: steering at a standstill, reversing, 300 km/h
  {
    const road = straight();
    const car = benchCar(vehicle);
    car.placeAt(road, 10, 0, 0);
    drive(car, road, 60, () => inp({ steer: 1 }));
    const idleTurn = Math.abs(heading(car, road));
    const rev = benchCar(vehicle);
    rev.placeAt(road, 50, 0, 0);
    drive(rev, road, 60 * 2, () => inp({ brake: 1 }));
    const fast = benchCar(vehicle);
    fast.placeAt(road, 10, 0, 300 / KMH);
    let fastPeak = 0;
    drive(fast, road, 60 * 3, (i) => inp({ accelerate: 1, steer: i < 9 ? 1 : 0 }), (_i, c) => { fastPeak = Math.max(fastPeak, Math.abs(heading(c, road))); });
    out.odd = { idleTurnDeg: Math.round((idleTurn * 180) / Math.PI), reverseKmh: Math.round(rev.vF * KMH), reverseTurned: Math.round((Math.abs(heading(rev, road)) * 180) / Math.PI), from300Kmh: Math.round(fast.speed * KMH), from300PeakDeg: +((fastPeak * 180) / Math.PI).toFixed(1) };
    check('no spinning on the spot without throttle', idleTurn < 0.05, `${(out.odd as Bench).idleTurnDeg}°`);
    check('reverse works', rev.vF < -5, `${(out.odd as Bench).reverseKmh} km/h`);
    check('300 km/h settles back to top speed, stable', Math.abs(heading(fast, road)) < 0.05 && fast.speed * KMH < 250, `${(out.odd as Bench).from300Kmh} km/h`);
  }

  // ---- curb / barrier: hit the edge at angles
  const curb: Bench = {};
  for (const deg of [5, 15, 30, 60]) {
    const road = straight();
    const car = benchCar(vehicle);
    car.placeAt(road, 10, 5.5, 150 / KMH);
    const a = (deg * Math.PI) / 180;
    // the right edge is at +d: aim the nose right (yaw decreases to the right)
    car.yaw -= a;
    car.velX = Math.sin(car.yaw) * (150 / KMH);
    car.velZ = Math.cos(car.yaw) * (150 / KMH);
    let minSpeed = 999;
    drive(car, road, 60, () => inp({ accelerate: 1 }), (_i, c) => { minSpeed = Math.min(minSpeed, c.speed); });
    const last = car.contactLog[car.contactLog.length - 1];
    curb[deg] = { minKmh: Math.round(minSpeed * KMH), endKmh: Math.round(car.speed * KMH), severity: last?.severity ?? 'none', headingDeg: Math.round((heading(car, road) * 180) / Math.PI) };
  }
  out.curb = curb;
  check('a 5° curb touch keeps ≥ 95% speed', ((curb[5] as Bench).minKmh as number) >= 142, `${(curb[5] as Bench).minKmh} km/h`);
  check('a 15° curb hit keeps ≥ 85% speed', ((curb[15] as Bench).minKmh as number) >= 127, `${(curb[15] as Bench).minKmh} km/h`);

  // ---- jumps: the standard ramp (18 m to 2.6 m) and the bridge gap (20 m to 4.2 m, 22 m hole)
  const jumps: Bench = {};
  for (const [name, h, len, gap] of [['ramp', 2.6, 18, 0], ['gap', 4.2, 20, 22]] as const) {
    for (const v0 of [100, 150, 200]) {
      const lipS = 300;
      const road = syntheticRoad({
        length: 1200,
        y: (s) => (s >= lipS - len && s < lipS ? ((s - (lipS - len)) / len) * h : 0),
        lips: [{ s: lipS, slope: h / len }],
        gaps: gap ? [{ s0: lipS, s1: lipS + gap }] : [],
      });
      const car = benchCar(vehicle);
      car.placeAt(road, lipS - 120, 0, v0 / KMH);
      let air = 0, apex = 0, landS = -1, fell = false, landGood: string | null = null, took = false;
      drive(car, road, 60 * 8, () => inp({ accelerate: 1 }), (_i, c) => {
        if (!c.grounded) { took = true; air += DT; apex = Math.max(apex, c.pos.y); }
        for (const e of c.events) {
          if (e.type === 'land' && landS < 0) { landS = c.s; landGood = e.grade; }
          if (e.type === 'fall') fell = true;
        }
        return fell || (took && c.grounded && c.s > lipS + 60);
      });
      jumps[`${name}_${v0}`] = { launched: took, air: +air.toFixed(2), apex: +apex.toFixed(1), dist: landS > 0 ? Math.round(landS - lipS) : -1, grade: landGood ?? 'none', fell, endKmh: Math.round(car.speed * KMH) };
    }
  }
  out.jumps = jumps;
  check('ramps always launch at speed', Object.values(jumps).every((j) => (j as Bench).launched), '');
  check('a straight jump lands good or perfect', Object.values(jumps).every((j) => ['good', 'perfect'].includes((j as Bench).grade as string)), Object.values(jumps).map((j) => (j as Bench).grade).join(' '));
  check('the bridge gap is cleared at 150 km/h', !((jumps['gap_150'] as Bench).fell), (jumps['gap_150'] as Bench).fell ? 'fell' : 'cleared');

  // ---- slalom: tap left, release, tap right, release at 200 km/h — the car must not diverge
  {
    const road = straight();
    const car = benchCar(vehicle);
    car.placeAt(road, 10, 0, 200 / KMH);
    let peak = 0;
    const plan = (i: number) => (i < 12 ? -1 : i < 30 ? 0 : i < 42 ? 1 : 0);
    drive(car, road, 60 * 3, (i) => inp({ accelerate: 1, steer: plan(i) }), (_i, c) => { peak = Math.max(peak, Math.abs(heading(c, road))); });
    out.slalom = { peakDeg: +((peak * 180) / Math.PI).toFixed(1), endD: +car.d.toFixed(2), endHeadingDeg: +((heading(car, road) * 180) / Math.PI).toFixed(1) };
    check('slalom at 200 km/h ends straight', Math.abs(heading(car, road)) < 0.05, `${(out.slalom as Bench).endHeadingDeg}°`);
  }

  return { vehicle, out, checks, pass: checks.filter((c) => c.ok).length, total: checks.length };
}

/** All four cars, compact. */
export function runAll() {
  return VEHICLES.map((v) => runPhysicsTests(v.id));
}


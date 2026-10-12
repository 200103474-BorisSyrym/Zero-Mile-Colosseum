import * as THREE from 'three';
import { S } from '../atlas';
import { MeshKit } from '../meshkit';
import { buildBody, emptyAnchors, pickupBed, type Anchors, type BodyDesign } from './body';

/** Light and tailpipe anchors of the vehicle being built (collected by the builders below). */
let cur: Anchors = emptyAnchors();
import * as P from './parts';
import type { RimStyle } from './wheel';

/**
 * The vehicle catalogue: every car in the game as a design (body lines + parts), built once and cached.
 * Footprints (length x width) match the gameplay dimensions exactly; the shape inside them is the model.
 */
export interface WheelSpec {
  x: number;
  y: number;
  z: number;
  r: number;
  w: number;
  style: RimStyle;
  front: boolean;
}

export interface VehicleAsset {
  /** lamps, indicators and tailpipes in vehicle space */
  anchors: Anchors;
  geo: THREE.BufferGeometry;
  wheels: WheelSpec[];
  L: number;
  W: number;
  H: number;
  tris: number;
}

type Design = BodyDesign & { rim: RimStyle };

const base = (L: number, W: number, o: Partial<Design>): Design => ({
  L, W,
  H: 1.42, clear: 0.16, wheelR: 0.34, wheelW: 0.24, ohF: 0.95, ohR: 0.95,
  deckEnd: 0.2, roofStart: 0.36, roofEnd: 0.6, cowl: 0.73,
  belt: [0.98, 0.94], deckH: 0.98, tailH: 0.82, hoodH: 0.93, noseH: 0.74, sill: 0.42,
  tumble: 0.24, tumbleBase: 0.1, bulge: 0.035, flare: 0.03, planR: 0.42, crown: 0.03,
  head: 'wide', tail: 'pair', grille: 'small', bumper: 'body', rim: 'spoke5',
  ...o,
});

/** Body + wheels for a design (cars, vans, pickups, SUVs). */
function car(k: MeshKit, d: Design): WheelSpec[] {
  const info = buildBody(k, d);
  for (const key of ['heads', 'tails', 'indicators', 'exhausts'] as const) cur[key].push(...info.anchors[key]);
  pickupBed(k, d);
  return info.axles.map((z, i) => [-1, 1].map((side) => ({ x: side * info.wheelX, y: d.wheelR, z, r: d.wheelR, w: d.wheelW, style: d.rim, front: i === info.axles.length - 1 }))).flat();
}

/** Truck: a cab-over cab lofted at the front, chassis, and a body behind it. */
function truck(k: MeshKit, L: number, W: number, body: 'box' | 'tank' | 'flat' | 'armored', o: { cabH?: number; wheelR?: number; armored?: boolean; plow?: boolean } = {}): WheelSpec[] {
  const wheelR = o.wheelR ?? 0.5;
  const cabL = Math.min(2.6, L * 0.3);
  const cabH = o.cabH ?? 2.9;
  const zCab = L / 2 - cabL / 2;
  const cab = base(cabL, W, {
    H: cabH, clear: 0.48, wheelR, wheelW: 0.36, ohF: 0.75, ohR: cabL - 0.75,
    deckEnd: 0.0, roofStart: 0.04, roofEnd: 0.8, cowl: 0.95,
    belt: [1.62, 1.58], deckH: cabH - 0.15, tailH: cabH - 0.2, hoodH: 1.5, noseH: 1.42, sill: 0.95,
    tumble: 0.12, tumbleBase: 0.05, bulge: 0.02, flare: 0.04, planR: 0.28, crown: 0.04,
    head: 'block', tail: 'slim', grille: 'big', bumper: 'heavy', winFrom: 0.42, pillars: [], mirrors: false, roofSurf: S.PAINT,
    axlesOnly: [cabL / 2 - 0.75],
  });
  const ci = buildBody(k, cab, zCab);
  // the cab's front lamps and indicators are the truck's; its rear face hides behind the body
  cur.heads.push(...ci.anchors.heads);
  cur.indicators.push(...ci.anchors.indicators.filter((p) => p[2] > zCab));
  for (const side of [-1, 1]) cur.exhausts.push([side * (W / 2 - 0.2), 0.55, L / 2 - cabL - 0.2]);
  // big truck mirrors on arms
  for (const side of [-1, 1]) {
    k.tube([side * W / 2, 1.9, L / 2 - 0.55], [side * (W / 2 + 0.3), 2.0, L / 2 - 0.5], 0.025, 5, S.TRIM);
    k.box([side * (W / 2 + 0.34), 1.95, L / 2 - 0.5], [0.08, 0.42, 0.18], S.TRIM, 0, 0.02);
  }
  // sun visor and roof marker lights
  k.box([0, cabH - 0.05, L / 2 - 0.15], [W * 0.92, 0.06, 0.3], S.TRIM, 0, 0.02, 0.2);
  for (let i = -2; i <= 2; i++) k.box([i * 0.3, cabH + 0.04, L / 2 - 0.35], [0.12, 0.06, 0.08], S.AMBER, 0, 0.01);
  const zBack = -L / 2, zFront = L / 2 - cabL - 0.15;
  P.chassis(k, zBack + 0.1, L / 2 - 0.4, 0.62, W);
  const bodyLen = zFront - zBack - 0.1;
  const zb = (zBack + zFront) / 2 - 0.05;
  if (body === 'box' || body === 'armored') {
    const h = cabH + 0.25 - 0.85;
    P.cargoBox(k, [0, 0.85 + h / 2, zb], [W, h, bodyLen], body === 'armored' ? S.PAINT2 : S.PAINT);
    if (body === 'armored') {
      for (let z = zBack + 0.6; z < zFront - 0.3; z += 1.2) for (const side of [-1, 1]) k.box([side * (W / 2 + 0.06), 0.85 + h * 0.4, z], [0.08, h * 0.55, 1.0], S.PAINT, 0, 0.03);
    }
  } else if (body === 'tank') {
    P.tank(k, zBack + 0.35, zFront - 0.3, 1.75, W * 0.46);
  } else {
    k.box([0, 1.0, zb], [W, 0.16, bodyLen], S.TRIM, 0, 0.03);
    P.cargoBox(k, [0, 1.08 + 1.2, zb - 0.2], [W * 0.95, 2.3, bodyLen * 0.82], S.PAINT, true, true);
    for (const z of [zb - bodyLen * 0.3, zb + bodyLen * 0.3]) k.box([0, 1.08 + 2.38, z], [W * 0.97, 0.05, 0.08], S.AMBER, 0, 0.005);
  }
  // rear lights and underrun bar
  for (const side of [-1, 1]) k.box([side * (W / 2 - 0.25), 0.62, zBack - 0.03], [0.3, 0.14, 0.05], S.TAIL, 0, 0.02);
  for (const side of [-1, 1]) cur.tails.push([side * (W / 2 - 0.25), 0.62, zBack - 0.07]);
  for (const side of [-1, 1]) cur.indicators.push([side * (W / 2 - 0.12), 0.62, zBack - 0.07]);
  if (o.plow) P.plow(k, L / 2 + 0.05, 0.3, W * 1.05, 1.3);
  if (o.armored) {
    // armour grille over the windshield
    for (let i = -3; i <= 3; i++) k.box([i * W * 0.13, 2.05, L / 2 - 0.34], [0.05, 0.9, 0.05], S.TRIM, 0, 0.01, -0.25);
  }
  const rear = [zBack + 1.0, zBack + 2.25];
  const wheels: WheelSpec[] = [];
  for (const side of [-1, 1]) {
    wheels.push({ x: side * (W / 2 - 0.22), y: wheelR, z: L / 2 - 0.75, r: wheelR, w: 0.36, style: 'heavy', front: true });
    for (const z of rear) wheels.push({ x: side * (W / 2 - 0.25), y: wheelR, z, r: wheelR, w: 0.46, style: 'heavy', front: false });
  }
  // mudguards over the rear axles
  for (const side of [-1, 1]) k.box([side * (W / 2 - 0.25), wheelR * 2 + 0.12, (rear[0] + rear[1]) / 2], [0.52, 0.06, 2.3], S.TRIM, 0, 0.02);
  return wheels;
}

/** City bus (The Drowned Line). */
function bus(k: MeshKit, L: number, W: number): WheelSpec[] {
  const d = base(L, W, {
    H: 3.15, clear: 0.32, wheelR: 0.55, wheelW: 0.34, ohF: 2.5, ohR: 3.2,
    deckEnd: 0.0, roofStart: 0.012, roofEnd: 0.975, cowl: 0.997,
    belt: [1.25, 1.2], deckH: 3.05, tailH: 3.0, hoodH: 1.25, noseH: 1.15, sill: 0.62,
    tumble: 0.1, tumbleBase: 0.06, bulge: 0.01, flare: 0.02, planR: 0.35, crown: 0.05,
    winFrom: 0.03, winTo: 0.99, pillars: Array.from({ length: 12 }, (_, i) => 0.06 + i * 0.075),
    head: 'quad', tail: 'block', grille: 'wide', bumper: 'heavy', mirrors: false, roofSurf: S.PAINT,
    // the bus is lit inside: its side windows carry the accent light (the boss rig animates it)
    glassSurf: S.ACCENT,
  });
  const w = car(k, d);
  // roof units, destination board, cyan stripes (accent), cow-catcher
  for (const z of [-3, 0.5, 3.6]) k.box([0, 3.32, z], [W * 0.62, 0.28, 2.0], S.PAINT2, 0, 0.05);
  k.box([0, 2.85, L / 2 + 0.01], [W * 0.7, 0.32, 0.04], S.ACCENT, 0, 0.01);
  for (const side of [-1, 1]) k.box([side * (W / 2 + 0.035), 1.05, 0], [0.02, 0.1, L * 0.9], S.ACCENT, 0, 0);
  P.plow(k, L / 2 + 0.05, 0.25, W * 0.98, 0.7, S.TRIM);
  for (const side of [-1, 1]) {
    k.tube([side * W / 2, 2.4, L / 2 - 0.3], [side * (W / 2 + 0.25), 2.5, L / 2 + 0.1], 0.03, 5, S.TRIM);
    k.box([side * (W / 2 + 0.28), 2.2, L / 2 + 0.12], [0.08, 0.45, 0.18], S.TRIM, 0, 0.02);
  }
  return w;
}

/** Build a vehicle by kind and visual variant, at a detail level (0 hero, 1 standard, 2 far LOD). */
export function buildVehicle(kind: string, variant: number, elite: boolean, detail: 0 | 1 | 2 = 1): { geo: THREE.BufferGeometry; wheels: WheelSpec[]; H: number; L: number; W: number; anchors: Anchors } {
  const k = new MeshKit(detail);
  let wheels: WheelSpec[] = [];
  cur = emptyAnchors();
  let L = 4.5, W = 1.95, H = 1.42;
  const go = (d: Design) => {
    L = d.L;
    W = d.W;
    H = d.H;
    wheels = car(k, d);
    return d;
  };
  switch (kind) {
    // ------------------------------------------------------------------ player
    case 'courier': {
      // the hero: a night-shift hot hatch — short and wide, fat flared arches, a near-upright tailgate under a roof
      // wing, black roof and pillars, slit lamps, a vented hood. Its silhouette is the only tall-tailed one among the
      // low hostile wedges.
      const d = go(base(4.2, 1.9, {
        H: 1.32, clear: 0.13, wheelR: 0.36, wheelW: 0.29, ohF: 0.78, ohR: 0.6,
        deckEnd: 0.04, roofStart: 0.19, roofEnd: 0.52, cowl: 0.71, pillars: [0.33], winFrom: 0.09, vent: [0.255, 0.28],
        belt: [0.97, 0.86], deckH: 1.08, tailH: 0.84, hoodH: 0.85, noseH: 0.6, sill: 0.36,
        tumble: 0.29, tumbleBase: 0.1, bulge: 0.045, flare: 0.09, planR: 0.32, crown: 0.025,
        head: 'slit', tail: 'bar', grille: 'mesh', bumper: 'dark', sideSkirt: true, roofSurf: S.PAINT2, pillarSurf: S.PAINT2, rim: 'spoke6',
      }));
      // roof wing over the tailgate on swan-neck struts, a hood scoop, accent strips on the hood
      P.wing(k, -d.L / 2 + 0.6, 1.4, d.W * 0.8, 0.36, S.CARBON);
      P.scoop(k, 1.02, 0.82, 0.5, 0.66);
      for (const side of [-1, 1]) k.box([side * 0.22, 0.89, 0.42], [0.05, 0.02, 0.5], S.ACCENT, 0, 0.005);
      break;
    }
    case 'ghost': {
      // mid-engined, almost flat: cabin forward, long rear deck, canopy glass, huge wing
      const d = go(base(4.5, 2.0, {
        H: 1.1, clear: 0.11, wheelR: 0.37, wheelW: 0.32, ohF: 1.0, ohR: 0.8,
        deckEnd: 0.26, roofStart: 0.4, roofEnd: 0.53, cowl: 0.68,
        belt: [0.84, 0.7], deckH: 0.86, tailH: 0.78, hoodH: 0.7, noseH: 0.45, sill: 0.32,
        tumble: 0.38, tumbleBase: 0.16, bulge: 0.03, flare: 0.085, planR: 0.5, crown: 0.02,
        head: 'slit', tail: 'bar', grille: 'none', bumper: 'dark', sideSkirt: true, roofSurf: S.GLASS, pillarSurf: S.PAINT2, rim: 'mesh', pillars: [],
      }));
      P.wing(k, -d.L / 2 + 0.3, 1.18, d.W * 0.92, 0.42, S.CARBON);
      P.fins(k, -0.9, 0.85, 0.55, 1.1, 0.18);
      for (const side of [-1, 1]) k.box([side * (d.W / 2 - 0.02), 0.6, -0.35], [0.06, 0.24, 0.6], S.GRILLE, 0, 0.02);
      break;
    }
    case 'player_rammer': {
      // a lifted muscle pickup with a plow and a cage: the battering ram
      const d = go(base(5.0, 2.2, {
        H: 1.68, clear: 0.3, wheelR: 0.47, wheelW: 0.37, ohF: 0.9, ohR: 0.85,
        deckEnd: 0.38, roofStart: 0.42, roofEnd: 0.6, cowl: 0.7, bed: [0.03, 0.37],
        belt: [1.16, 1.12], deckH: 1.16, tailH: 1.12, hoodH: 1.16, noseH: 1.04, sill: 0.66,
        tumble: 0.17, tumbleBase: 0.07, bulge: 0.02, flare: 0.1, planR: 0.24, crown: 0.04,
        head: 'block', tail: 'block', grille: 'big', bumper: 'heavy', sideSkirt: true, rim: 'heavy', pillars: [],
      }));
      P.plow(k, d.L / 2 + 0.05, 0.3, d.W * 1.04, 0.85);
      P.cage(k, -0.5, 0.95, d.H, d.W / 2 - 0.15, 0.25);
      P.lightbar(k, 0.25, d.H + 0.3, 1.4, S.HEAD, S.HEAD);
      break;
    }
    case 'hauler': {
      // a rally expedition van: tall, rugged, rack and spare
      const d = go(base(5.4, 2.25, {
        H: 2.05, clear: 0.32, wheelR: 0.42, wheelW: 0.32, ohF: 0.95, ohR: 0.9,
        deckEnd: 0.0, roofStart: 0.025, roofEnd: 0.78, cowl: 0.88,
        belt: [1.16, 1.1], deckH: 1.95, tailH: 1.9, hoodH: 1.12, noseH: 0.96, sill: 0.62,
        tumble: 0.1, tumbleBase: 0.05, bulge: 0.02, flare: 0.07, planR: 0.3, crown: 0.04,
        head: 'quad', tail: 'block', grille: 'wide', bumper: 'heavy', sideSkirt: true, rim: 'heavy', winFrom: 0.05, pillars: [0.3, 0.55],
      }));
      P.rack(k, -0.2, d.H + 0.12, d.W * 0.8, 3.2, 6);
      P.spare(k, [0, 1.25, -d.L / 2 - 0.12], 0.4, [0, 0, -1]);
      P.lightbar(k, 1.3, d.H + 0.2, 1.5, S.HEAD, S.HEAD);
      break;
    }
    // ------------------------------------------------------------------ traffic
    case 'sedan':
    case 'taxi':
    case 'police': {
      const v = kind === 'sedan' ? variant % 3 : 0;
      if (v === 1) {
        go(base(4.5, 1.95, { H: 1.28, deckEnd: 0.18, roofStart: 0.33, roofEnd: 0.55, cowl: 0.7, belt: [0.92, 0.86], deckH: 0.92, noseH: 0.64, hoodH: 0.85, head: 'slit', tail: 'bar', sideSkirt: true, flare: 0.05, tumble: 0.27, rim: 'spoke6' }));
        P.wing(k, -2.05, 0.98, 1.6, 0.22, S.PAINT, false);
      } else if (v === 2) {
        go(base(4.5, 1.95, { H: 1.48, deckEnd: 0.02, roofStart: 0.06, roofEnd: 0.6, cowl: 0.73, deckH: 1.3, tailH: 0.92, pillars: [0.2, 0.42], tail: 'block' }));
        P.rack(k, -0.3, 1.55, 1.3, 2.2, 0);
      } else {
        go(base(kind === 'police' ? 4.6 : 4.5, kind === 'police' ? 2.0 : 1.95, { grille: kind === 'police' ? 'mesh' : 'small', rim: kind === 'taxi' ? 'steel' : 'spoke5' }));
      }
      if (kind === 'taxi') {
        k.box([0, H + 0.09, -0.15], [0.62, 0.16, 0.26], S.AMBER, 0, 0.03);
        for (const side of [-1, 1]) k.box([side * (W / 2 + 0.02), 0.62, 0.1], [0.02, 0.08, 2.4], S.AMBER, 0, 0);
      }
      if (kind === 'police') {
        P.lightbar(k, -0.2, H + 0.06, 1.2);
        P.pushbar(k, L / 2 + 0.12, 0.45, W);
      }
      break;
    }
    case 'hatch': {
      if (variant % 2 === 1) {
        // compact SUV: taller, clad, rails
        const d = go(base(3.9, 1.85, {
          H: 1.64, clear: 0.24, wheelR: 0.38, wheelW: 0.26, ohF: 0.78, ohR: 0.7, sill: 0.6,
          belt: [1.1, 1.06], deckEnd: 0.03, roofStart: 0.09, roofEnd: 0.64, cowl: 0.76, deckH: 1.3, tailH: 1.0,
          hoodH: 1.06, noseH: 0.92, tumble: 0.16, flare: 0.06, sideSkirt: true, bumper: 'dark', pillars: [0.4], tail: 'block', head: 'wide', grille: 'wide', rim: 'spoke6',
        }));
        P.rack(k, -0.15, d.H + 0.07, d.W * 0.72, 1.8, 0);
      } else {
        go(base(3.9, 1.85, { H: 1.45, ohF: 0.75, ohR: 0.62, deckEnd: 0.04, roofStart: 0.12, roofEnd: 0.58, cowl: 0.72, deckH: 1.02, tailH: 0.9, pillars: [0.42], tail: 'block', head: 'wide', noseH: 0.7 }));
      }
      break;
    }
    case 'van': {
      const v = variant % 3;
      if (v === 2) {
        // crew-cab pickup
        go(base(5.2, 2.15, {
          H: 1.82, clear: 0.28, wheelR: 0.42, wheelW: 0.3, ohF: 0.9, ohR: 1.0, bed: [0.03, 0.36],
          deckEnd: 0.37, roofStart: 0.41, roofEnd: 0.66, cowl: 0.75, belt: [1.13, 1.1], deckH: 1.13, tailH: 1.1,
          hoodH: 1.15, noseH: 1.04, sill: 0.62, tumble: 0.14, flare: 0.06, pillars: [0.53], grille: 'big', head: 'block', tail: 'block', bumper: 'heavy', rim: 'heavy',
        }));
      } else {
        const d = go(base(5.2, 2.15, {
          H: 2.0, clear: 0.22, wheelR: 0.38, wheelW: 0.27, ohF: 0.95, ohR: 0.95,
          deckEnd: 0.0, roofStart: 0.025, roofEnd: 0.8, cowl: 0.9, belt: [1.12, 1.1], deckH: 1.92, tailH: 1.88,
          hoodH: 1.1, noseH: 0.92, sill: 0.55, tumble: 0.08, tumbleBase: 0.04, flare: 0.02, planR: 0.32,
          winFrom: v === 1 ? 0.64 : 0.04, pillars: v === 1 ? [] : [0.3, 0.55], tail: 'block', grille: 'wide', rim: 'steel',
        }));
        if (v === 1) {
          // utility van: ladder rack and a beacon
          P.rack(k, -0.3, d.H + 0.1, d.W * 0.8, 3.2, 5);
          k.box([0, d.H + 0.08, 1.35], [0.3, 0.14, 0.2], S.AMBER, 0, 0.03);
          for (const side of [-1, 1]) k.box([side * (d.W / 2 + 0.02), 1.05, -0.4], [0.02, 0.12, 3.4], S.ACCENT, 0, 0);
        }
      }
      break;
    }
    case 'truck': {
      L = 8;
      W = 2.5;
      H = 3.2;
      wheels = truck(k, L, W, variant % 3 === 1 ? 'tank' : variant % 3 === 2 ? 'flat' : 'box');
      break;
    }
    // ------------------------------------------------------------------ enemies
    case 'interceptor': {
      const d = go(base(4.3, 1.95, {
        H: 1.26, clear: 0.12, wheelR: 0.36, wheelW: 0.3, ohF: 0.88, ohR: 0.75,
        deckEnd: 0.16, roofStart: 0.32, roofEnd: 0.54, cowl: 0.69, belt: [0.9, 0.82], deckH: 0.9, tailH: 0.78,
        hoodH: 0.82, noseH: 0.55, sill: 0.34, tumble: 0.3, flare: 0.07, planR: 0.42, head: 'slit', tail: 'bar', grille: 'mesh', bumper: 'dark', sideSkirt: true, roofSurf: S.PAINT2, pillarSurf: S.PAINT2, rim: 'mesh',
      }));
      P.wing(k, -d.L / 2 + 0.25, 1.08, d.W * 0.88, 0.3, S.CARBON);
      k.box([0, 0.16, d.L / 2 - 0.02], [d.W * 0.9, 0.035, 0.24], S.CARBON, 0, 0.01);
      break;
    }
    case 'rammer': {
      // wide, heavy, low: a battering ram with a plow, armour and a cage
      const d = go(base(5.0, 2.2, {
        H: 1.55, clear: 0.24, wheelR: 0.46, wheelW: 0.38, ohF: 0.9, ohR: 0.8, bed: [0.03, 0.34],
        deckEnd: 0.35, roofStart: 0.4, roofEnd: 0.58, cowl: 0.68, belt: [1.06, 1.02], deckH: 1.06, tailH: 1.0,
        hoodH: 1.05, noseH: 0.95, sill: 0.58, tumble: 0.18, flare: 0.11, planR: 0.22, head: 'block', tail: 'block', grille: 'big', bumper: 'heavy', sideSkirt: true, rim: 'heavy', pillars: [],
      }));
      P.plow(k, d.L / 2 + 0.05, 0.22, d.W * 1.08, 0.95);
      P.cage(k, -0.6, 0.9, d.H, d.W / 2 - 0.12, 0.22);
      P.sideArmor(k, d.W / 2 + 0.02, 0.45, 0.95, -1.2, 1.4);
      break;
    }
    case 'gunner': {
      // muscle fastback with a turret on the deck
      const d = go(base(4.6, 2.0, {
        H: 1.34, clear: 0.16, wheelR: 0.37, wheelW: 0.3, ohF: 0.95, ohR: 0.85,
        deckEnd: 0.14, roofStart: 0.33, roofEnd: 0.5, cowl: 0.62, belt: [0.94, 0.9], deckH: 0.94, tailH: 0.86,
        hoodH: 0.92, noseH: 0.76, sill: 0.4, tumble: 0.26, flare: 0.05, planR: 0.34, head: 'quad', tail: 'pair', grille: 'wide', bumper: 'dark', rim: 'spoke5',
      }));
      P.scoop(k, 1.05, 0.9, 0.55, 0.8);
      P.turret(k, -0.3, d.H - 0.01);
      break;
    }
    case 'bomber': {
      // a stripped buggy: small body, big wheels, roll cage, the barrels it carries
      const d = go(base(3.6, 1.85, {
        H: 1.15, clear: 0.34, wheelR: 0.45, wheelW: 0.36, ohF: 0.62, ohR: 0.62,
        deckEnd: 0.32, roofStart: 0.36, roofEnd: 0.5, cowl: 0.62, belt: [0.95, 0.92], deckH: 0.95, tailH: 0.9,
        hoodH: 0.9, noseH: 0.78, sill: 0.62, tumble: 0.3, flare: 0.12, planR: 0.3, head: 'round', tail: 'slim', grille: 'none', bumper: 'heavy', rim: 'steel', roofSurf: S.TRIM, pillars: [],
      }));
      P.cage(k, -0.3, 0.55, d.H - 0.05, d.W / 2 - 0.1, 0.35);
      for (let i = 0; i < 3; i++) P.barrel(k, [(i - 1) * 0.48, 0.95, -1.15], S.ACCENT);
      break;
    }
    case 'empvan': {
      const d = go(base(5.2, 2.2, {
        H: 2.0, clear: 0.24, wheelR: 0.4, wheelW: 0.3, ohF: 0.95, ohR: 0.95, deckEnd: 0.0, roofStart: 0.025, roofEnd: 0.8, cowl: 0.9,
        belt: [1.14, 1.1], deckH: 1.92, tailH: 1.88, hoodH: 1.1, noseH: 0.92, sill: 0.56, tumble: 0.08, tumbleBase: 0.04, flare: 0.04, planR: 0.3,
        winFrom: 0.64, pillars: [], tail: 'block', grille: 'mesh', head: 'slit', bumper: 'dark', rim: 'spoke6',
      }));
      P.empRig(k, -0.5, d.H, d.W);
      for (const side of [-1, 1]) k.box([side * (d.W / 2 + 0.02), 1.1, -0.6], [0.02, 0.12, 3.0], S.ACCENT, 0, 0);
      break;
    }
    case 'blocker': {
      L = 9;
      W = 2.6;
      H = 3.2;
      wheels = truck(k, L, W, 'armored', { armored: true, plow: true, cabH: 3.0, wheelR: 0.55 });
      // a warning band along the box and floodlights on the cab roof
      for (const side of [-1, 1]) k.box([side * (W / 2 + 0.09), 1.0, -1.4], [0.03, 0.14, 5.4], S.ACCENT, 0, 0.005);
      for (const side of [-1, 1]) k.box([side * 0.6, 3.12, L / 2 - 0.5], [0.34, 0.18, 0.14], S.HEAD, 0, 0.03);
      break;
    }
    case 'hunter': {
      // the elite pursuer: long, flat, fins, canopy, a blade of a wing
      const d = go(base(4.6, 2.0, {
        H: 1.12, clear: 0.11, wheelR: 0.38, wheelW: 0.34, ohF: 1.05, ohR: 0.85,
        deckEnd: 0.26, roofStart: 0.39, roofEnd: 0.52, cowl: 0.67, belt: [0.84, 0.7], deckH: 0.86, tailH: 0.76,
        hoodH: 0.7, noseH: 0.44, sill: 0.32, tumble: 0.38, tumbleBase: 0.16, flare: 0.09, planR: 0.5, crown: 0.02,
        head: 'slit', tail: 'bar', grille: 'none', bumper: 'dark', sideSkirt: true, roofSurf: S.GLASS, pillarSurf: S.PAINT2, rim: 'mesh', pillars: [],
      }));
      P.wing(k, -d.L / 2 + 0.3, 1.2, d.W * 0.95, 0.46, S.CARBON);
      P.fins(k, -0.95, 0.85, 0.6, 1.2, 0.26);
      break;
    }
    // ------------------------------------------------------------------ bosses
    case 'boss_mule': {
      L = 12.5;
      W = 3.3;
      H = 4.0;
      wheels = truck(k, L, W, 'armored', { armored: true, plow: true, cabH: 3.6, wheelR: 0.75 });
      P.stacks(k, L / 2 - 2.9, 2.0, W / 2 - 0.25, 2.6);
      // the stacks are its exhausts: smoke and flame go up, not out of the chassis
      cur.exhausts = [-1, 1].map((side) => [side * (W / 2 - 0.25), 2.0 + 2.72, L / 2 - 2.9]);
      break;
    }
    case 'boss_bus': {
      L = 14;
      W = 3.1;
      H = 3.2;
      wheels = bus(k, L, W);
      break;
    }
    case 'boss_taxon': {
      // the police machine: wide body, armour, push bar, a full light bar
      const d = go(base(5.2, 2.25, {
        H: 1.45, clear: 0.18, wheelR: 0.42, wheelW: 0.34, ohF: 1.0, ohR: 0.95, deckEnd: 0.17, roofStart: 0.33, roofEnd: 0.57, cowl: 0.7,
        belt: [1.0, 0.95], deckH: 1.0, tailH: 0.9, hoodH: 0.95, noseH: 0.8, sill: 0.45, tumble: 0.26, flare: 0.09, planR: 0.36,
        head: 'quad', tail: 'pair', grille: 'mesh', bumper: 'heavy', sideSkirt: true, rim: 'heavy', roofSurf: S.PAINT2,
      }));
      P.pushbar(k, d.L / 2 + 0.16, 0.5, d.W);
      P.sideArmor(k, d.W / 2, 0.5, 0.95, -1.4, 1.4);
      P.lightbar(k, -0.15, d.H + 0.06, 1.6);
      break;
    }
    case 'boss_apex': {
      // a hypercar: canopy, long tail, enormous wing
      const d = go(base(5.0, 2.15, {
        H: 1.08, clear: 0.1, wheelR: 0.4, wheelW: 0.38, ohF: 1.15, ohR: 1.0, deckEnd: 0.3, roofStart: 0.42, roofEnd: 0.54, cowl: 0.68,
        belt: [0.82, 0.66], deckH: 0.84, tailH: 0.74, hoodH: 0.66, noseH: 0.4, sill: 0.3, tumble: 0.42, tumbleBase: 0.2, flare: 0.1, planR: 0.55, crown: 0.02,
        head: 'slit', tail: 'bar', grille: 'none', bumper: 'dark', sideSkirt: true, roofSurf: S.GLASS, pillarSurf: S.CARBON, rim: 'mesh', pillars: [],
      }));
      P.wing(k, -d.L / 2 + 0.25, 1.3, d.W * 1.0, 0.55, S.CARBON);
      P.fins(k, -1.0, 0.82, 0.25, 1.6, 0.4);
      break;
    }
    case 'boss_driver': {
      // The Driver: a black wedge — slit eyes, sharp tail, nothing friendly about it
      const d = go(base(5.2, 2.2, {
        H: 1.14, clear: 0.12, wheelR: 0.42, wheelW: 0.36, ohF: 1.2, ohR: 0.95, deckEnd: 0.24, roofStart: 0.36, roofEnd: 0.5, cowl: 0.66,
        belt: [0.9, 0.68], deckH: 0.92, tailH: 0.86, hoodH: 0.68, noseH: 0.38, sill: 0.3, tumble: 0.36, tumbleBase: 0.14, flare: 0.08, planR: 0.3, crown: 0.0,
        head: 'slit', tail: 'slim', grille: 'none', bumper: 'dark', sideSkirt: true, roofSurf: S.PAINT2, pillarSurf: S.PAINT2, rim: 'spoke5', pillars: [],
      }));
      P.fins(k, -1.2, 0.9, 0.7, 1.6, 0.34);
      for (const side of [-1, 1]) k.box([side * (d.W / 2 + 0.01), 0.62, 0], [0.02, 0.04, d.L * 0.85], S.ACCENT, 0, 0);
      break;
    }
    default: {
      go(base(4.5, 1.95, {}));
    }
  }
  if (elite) {
    // elite: armour on the flanks, a roof scoop, gold seams (accent)
    P.sideArmor(k, W / 2, 0.42, 0.85, -L / 2 + 0.9, L / 2 - 1.1);
    P.scoop(k, -0.1, H + 0.01, 0.6, 0.9);
  }
  const geo = k.build(0.62);
  return { geo, wheels, H, L, W, anchors: cur };
}

const cache = new Map<string, VehicleAsset>();
export function vehicleAsset(kind: string, variant: number, elite: boolean, detail: 0 | 1 | 2 = 1): VehicleAsset {
  const key = `${kind}|${variant}|${elite ? 1 : 0}|${detail}`;
  let a = cache.get(key);
  if (!a) {
    const b = buildVehicle(kind, variant, elite, detail);
    a = { ...b, tris: b.geo.getAttribute('position').count / 3 };
    cache.set(key, a);
  }
  return a;
}


import * as THREE from 'three';
import { Random } from '../core/random';
import type { ZoneDef } from '../data/zones';
import { EMISSIVE, glow } from '../render/visualBudget';
import { adUV, decalUV, FACADE_U, FACADE_V, roadSignUV, type FacadeStyle } from './artTextures';
import type { GeoBuilder } from './geobuilder';
import type { SegmentInfo } from './generator';
import type { Road, RoadSample } from './road';
import type { SmokeBatch } from './smoke';
import { S as Surf } from '../assets/atlas';
import { prop, type PropName } from '../assets/kit/props';
import { industry, type IndustryName } from '../assets/kit/industry';
import { dressBuilding } from '../assets/kit/buildings';
import { vehicleAsset } from '../assets/vehicles/catalog';
import { wheelGeometry } from '../assets/vehicles/wheel';

/**
 * Environment art for one road segment: building massing with facades per zone, a second row and back towers,
 * the roadside layer (poles, wires, fences, stops, billboards, parked and wrecked cars, roadworks…), road wear
 * decals and the occasional structure crossing over the road. Everything sits outside the barriers or above the
 * road and never collides: it is scenery, not gameplay. Merged into the segment's per-material builders.
 */
export type V3 = [number, number, number];

export interface SceneryAnim {
  obj: THREE.Object3D;
  kind: 'blink' | 'spin' | 'spinZ' | 'float' | 'traffic';
  phase: number;
  base?: number;
}

export interface SceneryCtx {
  B: Record<string, GeoBuilder>;
  zone: ZoneDef;
  info: SegmentInfo;
  road: Road;
  S: RoadSample[];
  i0: number;
  i1: number;
  group: THREE.Group;
  anims: SceneryAnim[];
  geos: THREE.BufferGeometry[];
  lamps: { x: number; y: number; z: number; s: number }[];
  /** neon sign from the sign atlas on a facade */
  neonSign(cx: number, cy: number, cz: number, nx: number, nz: number, w: number, h: number, cell: number): void;
  signCells: number;
  mats: Record<string, THREE.Material>;
  /** distance of the first finish structure, or -1 */
  finishS: number;
  /** smoke plumes for this segment (one draw call) */
  smoke: SmokeBatch;
}

interface CityRecipe {
  styles: [FacadeStyle, number][];
  warehouse: number;
  shops: number;
  back: number;
  backH: [number, number];
  rooftopAds: number;
}

const CITY: Record<string, CityRecipe> = {
  industrial: { styles: [['ind', 5], ['resi', 2], ['office', 1]], warehouse: 0.45, shops: 0.08, back: 0.75, backH: [30, 72], rooftopAds: 0.18 },
  flood: { styles: [['resi', 5], ['office', 2], ['ind', 1]], warehouse: 0.08, shops: 0.45, back: 0.8, backH: [36, 92], rooftopAds: 0.22 },
  oldcity: { styles: [['resi', 4], ['office', 3]], warehouse: 0, shops: 0.9, back: 0.95, backH: [64, 150], rooftopAds: 0.35 },
  skyway: { styles: [['office', 5], ['resi', 2]], warehouse: 0, shops: 0, back: 1, backH: [110, 210], rooftopAds: 0.1 },
  zeromile: { styles: [['office', 3], ['resi', 2]], warehouse: 0, shops: 0, back: 0.7, backH: [80, 170], rooftopAds: 0 },
};

const FACADE_KEY: Record<FacadeStyle, string> = { office: 'facadeO', resi: 'facadeR', ind: 'facadeI' };

const C = (hex: number) => new THREE.Color(hex);
const PAINTS = [0x5a5f6a, 0x7a2a2a, 0x2a3f6a, 0xa0a0a8, 0x26262a, 0x3a5a3a, 0x6a5a3a, 0xd0d0d8, 0x8a6a20];
const BLINK_GEO = new THREE.BoxGeometry(1, 1, 1);

const UPV = new THREE.Vector3(0, 1, 0);
/** World matrix: position, yaw about Y, uniform scale. */
function place(x: number, y: number, z: number, yaw = 0, scale = 1) {
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(UPV, yaw), new THREE.Vector3(scale, scale, scale));
}
/** A kit prop at a world point; `yaw` turns its +Z (front). */
function kit(ctx: SceneryCtx, name: PropName, p: V3, yaw: number, paint?: number, scale = 1) {
  ctx.B.kit.add(prop(name), place(p[0], p[1], p[2], yaw, scale), paint !== undefined ? C(paint) : undefined);
}
/** Yaw that turns a roadside object's front (+Z) toward the road, for an object on `side` at heading h. */
const faceRoad = (h: number, side: number) => h + (side * Math.PI) / 2;

/** Road frame at s: position, forward f and right r unit vectors (y up). */
function frame(road: Road, s: number) {
  const p = road.at(s);
  return { x: p.x, y: p.y, z: p.z, h: p.heading, w: p.width, f: [Math.sin(p.heading), Math.cos(p.heading)] as [number, number], r: [-Math.cos(p.heading), Math.sin(p.heading)] as [number, number] };
}
/** World point at road coordinates (s, d) and height y above the road. */
function at(road: Road, s: number, d: number, y = 0): V3 {
  const F = frame(road, s);
  return [F.x + F.r[0] * d, F.y + y, F.z + F.r[1] * d];
}

/**
 * A generator: the world builds a segment a slice at a time (World.ensureAhead), and the scenery yields between its
 * parts and after every building. Every part has its own seeded random stream, so the result is the same however
 * many frames it is spread over.
 */
export function* buildScenery(ctx: SceneryCtx): Generator<string, void, void> {
  const { info, zone } = ctx;
  const rng = new Random((info.index * 7919 + 1013) >>> 0);
  if (!info.tunnel) {
    yield* buildBlocks(ctx, rng.fork(1));
    yield 'roadside';
    if (zone.elevated) buildElevatedSide(ctx, rng.fork(2));
    else yield* buildRoadside(ctx, rng.fork(3));
    yield 'crossing';
    buildCrossing(ctx, rng.fork(4));
  }
  yield 'wear';
  buildRoadWear(ctx, rng.fork(5));
  yield 'bridge out';
  if (info.gapJump) bridgeOut(ctx, rng.fork(6));
}

/**
 * Broken bridge: it must read as "the bridge ends here" before any sign is read — floodlights on the edge,
 * police beacons, barricades on the shoulders, torn barrier ends, a car that already went in.
 */
function bridgeOut(ctx: SceneryCtx, rng: Random) {
  const { info, road, B, zone } = ctx;
  const gj = info.gapJump!;
  const F0 = frame(road, gj.s0);
  for (const side of [-1, 1]) {
    // floodlight mast on each side of the near edge, lighting the hole
    const base = at(road, gj.s0 - 10, side * (F0.w / 2 + (zone.elevated ? 0.9 : 3.2)));
    // flood-light mast aimed at the hole (its lamp head is at 16 m, turned toward the road ahead)
    B.kit.add(prop('floodMast'), place(base[0], base[1] - 3, base[2], faceRoad(F0.h, side) - side * 0.6));
    ctx.lamps.push({ x: base[0] + F0.f[0] * 6 - F0.r[0] * side * 3, y: base[1] + 12, z: base[2] + F0.f[1] * 6 - F0.r[1] * side * 3, s: gj.s0 - 4 });
    blinker(ctx, [base[0], base[1] + 13.9, base[2]], 0xffa010, side);
    // torn barrier ends hanging over the drop
    for (const sAt of [gj.s0, gj.s1]) {
      const p = at(road, sAt + (sAt === gj.s0 ? 1.5 : -1.5), side * (F0.w / 2 + 0.3), sAt === gj.s0 ? gj.h - 0.4 : -0.4);
      B.barrier.box(p[0], p[1], p[2], 0.35, 0.8, 3.2, F0.h + side * (sAt === gj.s0 ? 0.5 : -0.5), 0, 0, 0, 0, undefined, false, false);
    }
    if (!zone.elevated) {
      // barricades and a police car on the shoulder before the ramp
      for (let k = 0; k < 3; k++) kit(ctx, 'barrierA', at(road, gj.s0 - 30 + k * 3, side * (F0.w / 2 + 1.6)), F0.h + Math.PI / 2 + 0.2);
      if (side === -1 || rng.chance(0.5)) {
        const p = at(road, gj.s0 - 46, side * (F0.w / 2 + 3.4));
        carShape(ctx, p[0], p[1] + 0.14, p[2], F0.h + side * 0.5, 0x101828, { kind: ['police', 0] });
        blinker(ctx, [p[0] - F0.r[0] * 0.3, p[1] + 1.95, p[2] - F0.r[1] * 0.3], 0xff1030, 0);
        blinker(ctx, [p[0] + F0.r[0] * 0.3, p[1] + 1.95, p[2] + F0.r[1] * 0.3], 0x1060ff, Math.PI);
      }
    }
  }
  if (!zone.elevated) {
    // someone didn't make it: a car nose-down in the canal
    const p = at(road, (gj.s0 + gj.s1) / 2 + rng.range(-3, 3), rng.range(-F0.w / 3, F0.w / 3), -6.6);
    carShape(ctx, p[0], p[1], p[2], F0.h + rng.range(-0.6, 0.6), rng.pick(PAINTS), { burnt: rng.chance(0.5), pitch: 0.55 });
    // rubble on the pavement beyond the far edge
    for (let k = 0; k < 4; k++) kit(ctx, 'rubble', at(road, gj.s1 + rng.range(0.5, 6), rng.sign() * (F0.w / 2 + rng.range(1.5, 5))), rng.range(0, 6), undefined, rng.range(0.6, 1.1));
  }
}

// ------------------------------------------------------------------------------------------------ buildings

function* buildBlocks(ctx: SceneryCtx, rng: Random): Generator<string, void, void> {
  const { B, zone, info, road } = ctx;
  const rec = CITY[zone.id] ?? CITY.industrial;
  const elevated = zone.elevated;
  const baseY = elevated ? -70 : 0;
  const hole = info.gapJump;
  const put = (geo: THREE.BufferGeometry, m: THREE.Matrix4, paint?: THREE.Color) => B.kit.add(geo, m, paint);
  for (const side of [-1, 1]) {
    // ---- front row. A block is `bw` along the road and `depth` away from it; its road face is the local x face
    // (box x runs across the road), which is where the shops, signs and the relief go.
    let s = info.startS + rng.range(0, 6);
    while (s < info.endS) {
      yield 'building';
      const warehouse = rng.chance(rec.warehouse);
      const bw = warehouse ? rng.range(20, 34) : rng.range(8, zone.id === 'oldcity' ? 14 : 22);
      const mid = s + bw / 2;
      if (hole && mid > hole.s0 - 20 && mid < hole.s1 + 20) {
        s += bw + 2;
        continue;
      }
      const F = frame(road, mid);
      const gap = zone.buildingGap + (info.type === 'NARROW_STREET' ? -3 : 0) + (info.bridge && !elevated ? 30 : 0) + (info.type === 'PARKING_AREA' ? 4 : 0);
      const depth = warehouse ? rng.range(18, 30) : rng.range(10, 24);
      const dist = F.w / 2 + 6.5 + Math.max(0, gap) + rng.range(0, 5) + depth / 2;
      let h = warehouse ? rng.range(8, 14) : rng.range(zone.buildingHeight[0], zone.buildingHeight[1]) * (info.type === 'NARROW_STREET' ? 1.2 : 1);
      if (elevated) h = rng.chance(0.18) ? 75 + rng.range(0, 50) : rng.range(18, 66);
      const cx = F.x + F.r[0] * side * dist, cz = F.z + F.r[1] * side * dist;
      if (zone.id === 'zeromile' && rng.chance(0.35)) {
        monolith(ctx, rng, cx, cz, bw);
        s += bw + rng.range(2, 8);
        continue;
      }
      const style: FacadeStyle = warehouse ? 'ind' : rng.weighted(rec.styles);
      const fb = B[FACADE_KEY[style]];
      const uo = Math.floor(rng.range(0, 8)) / 8;
      const vo = style === 'ind' ? 0 : Math.floor(rng.range(0, 16)) / 16;
      fb.box(cx, baseY + h / 2, cz, depth, h, bw, F.h, FACADE_U, FACADE_V, uo, vo, undefined, true, true);
      B.roof.box(cx, baseY + h + 0.3, cz, depth * 0.98, 0.6, bw * 0.98, F.h);
      let top = baseY + h + 0.6;
      const face = (side > 0 ? 1 : -1) as 1 | -1;
      // setbacks break the flat-top silhouette
      const setback = !warehouse && h > 30 && rng.chance(0.55);
      dressBuilding(put, rng, { cx, cz, baseY, yaw: F.h, sx: depth, sz: bw, h, face, style, zone: zone.id, near: true, uoBays: Math.round(uo * 8), roof: !setback });
      if (setback) {
        const h2 = h * rng.range(0.22, 0.45);
        const k = rng.range(0.55, 0.8);
        fb.box(cx, top + h2 / 2, cz, depth * k, h2, bw * k, F.h, FACADE_U, FACADE_V, uo, vo, undefined, true, true);
        B.roof.box(cx, top + h2 + 0.25, cz, depth * k * 0.98, 0.5, bw * k * 0.98, F.h);
        dressBuilding(put, rng, { cx, cz, baseY: top, yaw: F.h, sx: depth * k, sz: bw * k, h: h2, face, style, zone: zone.id, near: false, uoBays: 0, roof: true });
        top += h2 + 0.5;
        roofClutter(ctx, rng, cx, top, cz, depth * k, bw * k, F.h, false);
      } else roofClutter(ctx, rng, cx, top, cz, depth, bw, F.h, warehouse);
      // what faces the road
      const faceD = dist - depth / 2;
      if (!elevated && style !== 'ind' && rng.chance(rec.shops)) shopfront(ctx, rng, mid, side, faceD, bw);
      if (rng.chance(zone.id === 'oldcity' ? 0.95 : 0.5) && (!elevated || baseY + h > 9)) {
        const fx = F.x + F.r[0] * side * (faceD - 0.15), fz = F.z + F.r[1] * side * (faceD - 0.15);
        const vertical = rng.chance(0.3);
        const sy = rng.range(5.5, Math.max(6, Math.min(baseY + h - 2, 18)));
        ctx.neonSign(fx, Math.max(sy, elevated ? 2 : 5.5), fz, -side * F.r[0], -side * F.r[1], vertical ? 3 : rng.range(5, 8), vertical ? 6 : rng.range(2.5, 3.5), Math.floor(rng.range(0, ctx.signCells)));
      }
      if (rng.chance(rec.rooftopAds) && h < 40) rooftopBillboard(ctx, rng, mid, side, dist, top, bw);
      s += bw + rng.range(1, zone.id === 'oldcity' ? 2 : 6);
    }

    // ---- back row: taller, further, fewer — the depth layer between the street and the skyline
    if (!rng.chance(rec.back)) continue;
    let sb = info.startS + rng.range(0, 20);
    while (sb < info.endS) {
      yield 'back row';
      const bw = rng.range(14, 30);
      const mid = sb + bw / 2;
      const F = frame(road, mid);
      const dist = F.w / 2 + zone.buildingGap + rng.range(50, 95);
      const h = rng.range(rec.backH[0], rec.backH[1]);
      const depth = rng.range(16, 30);
      const cx = F.x + F.r[0] * side * dist, cz = F.z + F.r[1] * side * dist;
      if (zone.id === 'industrial' && rng.chance(0.62)) {
        sb += industrialBack(ctx, rng, mid, side, F, baseY);
        continue;
      }
      const style: FacadeStyle = rng.chance(0.6) ? 'office' : 'resi';
      const yaw = F.h + rng.range(-0.2, 0.2);
      B[FACADE_KEY[style]].box(cx, baseY + h / 2, cz, depth, h, bw, yaw, FACADE_U, FACADE_V, Math.floor(rng.range(0, 8)) / 8, Math.floor(rng.range(0, 16)) / 16, undefined, true, true);
      B.roof.box(cx, baseY + h + 0.4, cz, depth * 0.98, 0.8, bw * 0.98, yaw);
      dressBuilding(put, rng, { cx, cz, baseY, yaw, sx: depth, sz: bw, h, face: (side > 0 ? 1 : -1) as 1 | -1, style, zone: zone.id, near: false, uoBays: 0, roof: false });
      if (rng.chance(0.6)) {
        // crown: antenna mast with an aircraft light, or a lit crown band
        if (rng.chance(0.5)) kit(ctx, 'mast', [cx, baseY + h + 0.8, cz], yaw, undefined, rng.range(1, 1.8));
        else B.glow.box(cx, baseY + h - 1.2, cz, depth + 0.2, 0.5, bw + 0.2, yaw, 0, 0, 0, 0, glow(zone.neon[Math.floor(rng.range(0, zone.neon.length))], EMISSIVE.SUBTLE));
      }
      sb += bw + rng.range(10, 30);
    }
  }
}

/**
 * Industrial back row: the plant behind the street — stacks trailing smoke, tank farms, silo batteries, a cooling
 * tower, refinery columns, cranes, a flare. Returns how far along the road it used.
 */
function industrialBack(ctx: SceneryCtx, rng: Random, mid: number, side: number, F: ReturnType<typeof frame>, baseY: number) {
  const pick = rng.weighted<IndustryName>([['stack', 3], ['tank', 2.5], ['silos', 1.5], ['column', 1.5], ['towerCrane', 1], ['gantryCrane', 0.8], ['coolingTower', 0.6], ['flare', 0.8], ['hopper', 1]]);
  const extra: Partial<Record<IndustryName, number>> = { tank: 18, coolingTower: 40, silos: 10, gantryCrane: 10, towerCrane: 6 };
  const dist = F.w / 2 + ctx.zone.buildingGap + rng.range(52, 90) + (extra[pick] ?? 0);
  const cx = F.x + F.r[0] * side * dist, cz = F.z + F.r[1] * side * dist;
  const yaw = F.h + (pick === 'towerCrane' ? rng.range(0, Math.PI * 2) : side > 0 ? Math.PI / 2 : -Math.PI / 2);
  ctx.B.kit.add(industry(pick), place(cx, baseY, cz, yaw));
  if (pick === 'stack') ctx.smoke.column(cx, baseY + 72, cz, 7, 55, 13, rng.next());
  if (pick === 'coolingTower') ctx.smoke.column(cx, baseY + 62, cz, 18, 40, 10, rng.next());
  if (pick === 'flare') ctx.B.glow.box(cx, baseY + 51.2, cz, 1.2, 2.4, 1.2, 0, 0, 0, 0, 0, glow(0xff8020, EMISSIVE.STRONG));
  if (pick === 'tank' && rng.chance(0.6)) {
    // a second tank beside the first: a tank farm
    const d2 = dist + 30;
    ctx.B.kit.add(industry('tank'), place(F.x + F.r[0] * side * d2 + F.f[0] * 26, baseY, F.z + F.r[1] * side * d2 + F.f[1] * 26, yaw + 1));
  }
  return ({ tank: 60, coolingTower: 80, silos: 40, gantryCrane: 45, towerCrane: 40 } as Partial<Record<IndustryName, number>>)[pick] ?? rng.range(30, 50);
}

/** Rooftop clutter: AC units, a water tank, an antenna with a warning light. */
function roofClutter(ctx: SceneryCtx, rng: Random, cx: number, top: number, cz: number, bw: number, depth: number, h: number, warehouse: boolean) {
  const { B } = ctx;
  const c = Math.cos(h), s = Math.sin(h);
  const local = (lx: number, lz: number): [number, number] => [cx + lx * c + lz * s, cz - lx * s + lz * c];
  if (!warehouse && rng.chance(0.35)) {
    // roof access hut
    const [x, z] = local(rng.range(-bw * 0.25, bw * 0.25), rng.range(-depth * 0.25, depth * 0.25));
    B.roof.box(x, top + 1.2, z, 2.6, 2.4, 3.2, h);
  }
  if (rng.chance(warehouse ? 0.5 : 0.4)) {
    // ventilation stack (warehouses) or antenna (towers)
    const [x, z] = local(rng.range(-bw * 0.3, bw * 0.3), rng.range(-depth * 0.3, depth * 0.3));
    if (warehouse) B.pole.prism(x, top, z, 0.6, top + rng.range(3, 7), 0.5, 8);
    else {
      const ah = rng.range(4, 12);
      B.pole.beam([x, top, z], [x, top + ah, z], 0.2);
      B.glow.box(x, top + ah + 0.2, z, 0.45, 0.45, 0.45, 0, 0, 0, 0, 0, glow(0xff1018, EMISSIVE.MEDIUM));
    }
  }
}

/** Ground-floor shops on the face toward the road: lit windows, shutters, sign bars and an awning. */
function shopfront(ctx: SceneryCtx, rng: Random, mid: number, side: number, faceD: number, bw: number) {
  const { B, road } = ctx;
  const F = frame(road, mid);
  const d = side * (faceD - 0.12);
  const a: V3 = [F.x + F.r[0] * d - F.f[0] * bw / 2, F.y + 0.15, F.z + F.r[1] * d - F.f[1] * bw / 2];
  const b: V3 = [F.x + F.r[0] * d + F.f[0] * bw / 2, F.y + 0.15, F.z + F.r[1] * d + F.f[1] * bw / 2];
  const u0 = rng.range(0, 1), u1 = u0 + bw / 16;
  const n: V3 = [-side * F.r[0], 0, -side * F.r[1]];
  B.shop.quad(a, b, [b[0], b[1] + 4.4, b[2]], [a[0], a[1] + 4.4, a[2]], n, side > 0 ? [u1, 0, u0, 0, u0, 1, u1, 1] : [u0, 0, u1, 0, u1, 1, u0, 1]);
  // awnings: one per shop (4 m), in the shop's colour
  const yaw = faceRoad(F.h, side);
  const d0 = side * (faceD - 0.05);
  for (let o = -bw / 2 + 2.2; o < bw / 2 - 1.8; o += 4.1) {
    if (rng.chance(0.25)) continue;
    const p: V3 = [F.x + F.r[0] * d0 + F.f[0] * o, F.y + 4.55, F.z + F.r[1] * d0 + F.f[1] * o];
    kit(ctx, 'awning', p, yaw, rng.pick(AWNINGS));
  }
}
const AWNINGS = [0x7a1a18, 0x1a4a2a, 0x1e2e5a, 0x8a6a10, 0x3a2a4a, 0x6a2a10];

/** Warehouse front: a lamp over each door and a striped kerb. */
function loadingDock(ctx: SceneryCtx, _rng: Random, mid: number, side: number, faceD: number, bw: number) {
  const { B, road } = ctx;
  for (let k = -bw / 2 + 4; k < bw / 2 - 2; k += 9.6) {
    const p = at(road, mid + k, side * (faceD - 0.25), 7.4);
    B.glow.box(p[0], p[1], p[2], 0.7, 0.25, 0.25, frame(road, mid).h, 0, 0, 0, 0, glow(0xffb060, EMISSIVE.MEDIUM));
  }
}

/** Billboard on a rooftop facing the oncoming traffic. */
function rooftopBillboard(ctx: SceneryCtx, rng: Random, mid: number, side: number, dist: number, top: number, bw: number) {
  const { B, road } = ctx;
  const F = frame(road, mid);
  const w = Math.min(bw * 0.9, rng.range(8, 13)), hh = w / 2;
  const d = side * (dist - 2);
  // panel faces back down the road, turned a little toward the lanes
  const yaw = F.h + Math.PI + side * 0.35;
  const nx = Math.sin(yaw), nz = Math.cos(yaw);
  const tx = -nz, tz = nx;
  const cx = F.x + F.r[0] * d, cz = F.z + F.r[1] * d, cy = top + 2.2 + hh / 2;
  for (const o of [-0.35, 0.35]) B.pole.beam([cx + tx * w * o, top, cz + tz * w * o], [cx + tx * w * o, cy, cz + tz * w * o], 0.3);
  const [u0, v0, u1, v1] = adUV(rng.int(0, 11));
  B.ad.quad([cx - tx * w / 2, cy - hh / 2, cz - tz * w / 2], [cx + tx * w / 2, cy - hh / 2, cz + tz * w / 2], [cx + tx * w / 2, cy + hh / 2, cz + tz * w / 2], [cx - tx * w / 2, cy + hh / 2, cz - tz * w / 2], [nx, 0, nz], [u1, v0, u0, v0, u0, v1, u1, v1]);
  B.pole.box(cx - nx * 0.15, cy, cz - nz * 0.15, w + 0.3, hh + 0.3, 0.2, yaw);
}

/** Zero Mile: black monoliths hanging in the air, outlined in red light (merged: no per-object cost). */
function monolith(ctx: SceneryCtx, rng: Random, cx: number, cz: number, size: number) {
  const w = size * rng.range(0.5, 0.8), h = w * rng.range(1.2, 2.6);
  const cy = rng.range(10, 32);
  const yaw = rng.range(0, 3);
  ctx.B.monolith.box(cx, cy, cz, w, h, w, yaw, 0, 0, 0, 0, undefined, false, false);
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const P = (lx: number, ly: number, lz: number): V3 => [cx + lx * c + lz * s, cy + ly, cz - lx * s + lz * c];
  const red = glow(0xff1040, EMISSIVE.STRONG);
  const hx = w / 2 + 0.05, hy = h / 2 + 0.05, hz = w / 2 + 0.05;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) ctx.B.glow.beam(P(sx * hx, -hy, sz * hz), P(sx * hx, hy, sz * hz), 0.16, red);
  for (const sy of [-1, 1]) {
    for (const sx of [-1, 1]) ctx.B.glow.beam(P(sx * hx, sy * hy, -hz), P(sx * hx, sy * hy, hz), 0.16, red);
    for (const sz of [-1, 1]) ctx.B.glow.beam(P(-hx, sy * hy, sz * hz), P(hx, sy * hy, sz * hz), 0.16, red);
  }
}

// ------------------------------------------------------------------------------------------------ roadside

type Callback =
  | 'billboard' | 'busStop' | 'parked' | 'wreck' | 'containers' | 'pallets' | 'jersey' | 'floodMast' | 'construction' | 'sign' | 'tree'
  | 'dumpster' | 'police' | 'sandbags' | 'kiosk' | 'barrels' | 'yard' | 'substation' | 'boat' | 'rubble' | 'streetCorner' | 'scaffold' | 'utility';

const CALLBACKS: Record<string, [Callback, number][]> = {
  industrial: [['containers', 3], ['pallets', 2], ['billboard', 2], ['floodMast', 2], ['jersey', 2], ['parked', 1.5], ['construction', 1], ['sign', 1.5], ['barrels', 1.5], ['wreck', 0.6], ['yard', 1.5], ['substation', 1]],
  flood: [['wreck', 2.5], ['sandbags', 2.5], ['busStop', 1.5], ['billboard', 2], ['tree', 1.5], ['parked', 1.5], ['sign', 1], ['construction', 1], ['police', 0.6], ['boat', 1.5], ['rubble', 1.5], ['utility', 1]],
  oldcity: [['busStop', 2], ['parked', 3], ['tree', 2], ['kiosk', 1.5], ['billboard', 2], ['dumpster', 2], ['sign', 1], ['police', 0.8], ['construction', 0.8], ['streetCorner', 2], ['scaffold', 0.8], ['utility', 1]],
};

function* buildRoadside(ctx: SceneryCtx, rng: Random): Generator<string, void, void> {
  const { info, zone, road } = ctx;
  const len = info.endS - info.startS;
  if (len < 30) return;
  const hole = info.gapJump;
  const blocked = (s: number) => (hole && s > hole.s0 - 50 && s < hole.s1 + 12) || (ctx.finishS > 0 && Math.abs(s - ctx.finishS) < 14) || road.sample(s).y > 0.05;
  // utility poles with wires on one side (industrial / flood) or both (old city: lamps already busy)
  const poleSide = rng.sign();
  if (zone.id !== 'oldcity') {
    let prev: V3 | null = null;
    for (let s = info.startS + rng.range(2, 12); s < info.endS - 2; s += rng.range(28, 38)) {
      if (blocked(s)) {
        prev = null;
        continue;
      }
      const F = frame(road, s);
      const d = poleSide * (F.w / 2 + 4.6);
      const base = at(road, s, d);
      // concrete pole with a cross-arm across the road and insulators; every third carries a transformer
      kit(ctx, rng.chance(0.3) ? 'poleTx' : 'pole', base, F.h + Math.PI / 2);
      const top: V3 = [base[0], base[1] + 10.2, base[2]];
      if (prev) for (const o of [-1.3, 0, 1.3]) wire(ctx, [prev[0] + F.r[0] * o, prev[1] - 0.55, prev[2] + F.r[1] * o], [top[0] + F.r[0] * o, top[1] - 0.55, top[2] + F.r[1] * o], 0.7);
      prev = top;
    }
  }
  yield 'roadside: racks';
  // industrial: pipe runs on racks along the road, on the side away from the poles
  if (zone.id === 'industrial') {
    const ps = -poleSide;
    let s = info.startS + rng.range(4, 30);
    while (s < info.endS - 14) {
      const n = rng.int(1, 4);
      for (let k = 0; k < n && s < info.endS - 14; k++, s += 24) {
        if (blocked(s - 12) || blocked(s + 12)) continue;
        const F = frame(road, s);
        const p = at(road, s, ps * (F.w / 2 + 9.3));
        ctx.B.kit.add(industry('pipeRack'), place(p[0], p[1], p[2], F.h + Math.PI / 2));
      }
      s += rng.range(30, 80);
    }
  }
  yield 'roadside: fences';
  // fences / flood walls along the back of the pavement
  if (zone.id === 'industrial' || zone.id === 'flood') {
    for (const side of [-1, 1]) {
      let s = info.startS + rng.range(0, 30);
      while (s < info.endS - 6) {
        const runLen = rng.range(18, 60);
        const e = Math.min(info.endS - 2, s + runLen);
        if (rng.chance(0.65)) zone.id === 'industrial' ? fence(ctx, s, e, side) : floodWall(ctx, rng, s, e, side, blocked);
        s = e + rng.range(8, 30);
      }
    }
  }
  yield 'roadside: callbacks';
  // callbacks: one every 20-45 m, alternating sides, chosen from the zone's families
  const pool = CALLBACKS[zone.id] ?? CALLBACKS.industrial;
  let side = rng.sign();
  for (let s = info.startS + rng.range(6, 20); s < info.endS - 8; s += rng.range(20, 45)) {
    side = -side;
    if (blocked(s)) continue;
    const kind = rng.weighted(pool);
    callback(ctx, rng, kind, s, side);
    yield 'roadside: callback';
  }
}

/** Sagging cable between two points. */
function wire(ctx: SceneryCtx, a: V3, b: V3, sag: number) {
  const m: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - sag, (a[2] + b[2]) / 2];
  const q1: V3 = [(a[0] + m[0]) / 2, (a[1] + m[1]) / 2 - sag * 0.25, (a[2] + m[2]) / 2];
  const q2: V3 = [(m[0] + b[0]) / 2, (m[1] + b[1]) / 2 - sag * 0.25, (m[2] + b[2]) / 2];
  ctx.B.cable.beam(a, q1, 0.05);
  ctx.B.cable.beam(q1, m, 0.05);
  ctx.B.cable.beam(m, q2, 0.05);
  ctx.B.cable.beam(q2, b, 0.05);
}

function fence(ctx: SceneryCtx, s0: number, s1: number, side: number) {
  const { road, B } = ctx;
  for (let s = s0; s < s1; s += 3) {
    const e = Math.min(s1, s + 3);
    const F = frame(road, s);
    const d = side * (F.w / 2 + 5.8);
    const a = at(road, s, d), b = at(road, e, side * (frame(road, e).w / 2 + 5.8));
    B.pole.beam(a, [a[0], a[1] + 2.6, a[2]], 0.08);
    B.fence.quad(a, b, [b[0], b[1] + 2.4, b[2]], [a[0], a[1] + 2.4, a[2]], [-side * F.r[0], 0, -side * F.r[1]], [0, 0, (e - s) / 1.2, 0, (e - s) / 1.2, 2, 0, 2]);
    B.cable.beam([a[0], a[1] + 2.45, a[2]], [b[0], b[1] + 2.45, b[2]], 0.05);
  }
}

function floodWall(ctx: SceneryCtx, rng: Random, s0: number, s1: number, side: number, blocked: (s: number) => boolean) {
  const { road, B } = ctx;
  for (let s = s0; s < s1; s += 4) {
    if (blocked(s)) continue;
    const F = frame(road, s + 2);
    const p = at(road, s + 2, side * (F.w / 2 + 5.4), 0.5);
    B.concrete.box(p[0], p[1], p[2], 0.5, 1.0, 4.05, F.h);
    if (rng.chance(0.3)) {
      // sandbags piled against it
      for (let k = 0; k < 4; k++) {
        const q = at(road, s + rng.range(0, 4), side * (F.w / 2 + 4.9), 0.15 + (k % 2) * 0.25);
        B.paint.box(q[0], q[1], q[2], 0.5, 0.26, 0.85, F.h + rng.range(-0.3, 0.3), 0, 0, 0, 0, C(0x6a5a3a));
      }
    }
  }
}

/**
 * A parked, wrecked or flooded car: the same authored models as the traffic, merged into the segment. Parked cars
 * have unlit lamps; a burnt-out car is a soot-black shell without glass.
 */
const PARKED: [string, number][] = [['sedan', 0], ['sedan', 2], ['hatch', 0], ['hatch', 1], ['sedan', 1], ['taxi', 0]];
const VANS: [string, number][] = [['van', 0], ['van', 1], ['van', 2]];
const REMAP_PARKED = { [Surf.HEAD]: Surf.CHROME, [Surf.TAIL]: Surf.RED, [Surf.ACCENT]: Surf.TRIM, [Surf.AMBER]: Surf.YELLOW };
const REMAP_BURNT = { [Surf.GLASS]: Surf.UNDER, [Surf.HEAD]: Surf.UNDER, [Surf.TAIL]: Surf.UNDER, [Surf.CHROME]: Surf.RUST, [Surf.PLATE]: Surf.RUST, [Surf.ACCENT]: Surf.UNDER, [Surf.AMBER]: Surf.UNDER, [Surf.PAINT2]: Surf.UNDER, [Surf.RIM]: Surf.RUST, [Surf.RUBBER]: Surf.UNDER, [Surf.GRILLE]: Surf.UNDER, [Surf.CARBON]: Surf.UNDER };
function carShape(ctx: SceneryCtx, x: number, y: number, z: number, yaw: number, paint: number, opts: { burnt?: boolean; roll?: number; pitch?: number; van?: boolean; kind?: [string, number] } = {}) {
  const pool = opts.van ? VANS : PARKED;
  const pick = opts.kind ?? pool[Math.abs(Math.floor(x * 13.13 + z * 7.71)) % pool.length];
  const a = vehicleAsset(pick[0], pick[1], false, 1);
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(opts.pitch ?? 0, yaw, opts.roll ?? 0, 'YXZ')), new THREE.Vector3(1, 1, 1));
  const remap = opts.burnt ? REMAP_BURNT : REMAP_PARKED;
  ctx.B.kit.add(a.geo, m, opts.burnt ? C(0x141210) : C(paint).multiplyScalar(0.85), remap);
  const turn = new THREE.Matrix4().makeRotationY(Math.PI);
  for (const w of a.wheels) {
    const wm = new THREE.Matrix4().makeTranslation(w.x, w.y, w.z);
    if (w.x < 0) wm.multiply(turn);
    ctx.B.kit.add(wheelGeometry(w.r, w.w, w.style, 2), m.clone().multiply(wm), undefined, opts.burnt ? REMAP_BURNT : undefined);
  }
}

function callback(ctx: SceneryCtx, rng: Random, kind: Callback, s: number, side: number) {
  const { road, B, zone } = ctx;
  const F = frame(road, s);
  const edge = F.w / 2;
  const P = (ds: number, d: number, y = 0) => at(road, s + ds, side * (edge + d), y);
  const toRoad = faceRoad(F.h, side);
  switch (kind) {
    case 'billboard': {
      // the billboard structure (legs, frame, catwalk, lamps) with the advert on its face, turned toward the traffic
      const base = P(0, 5.6);
      const yaw = F.h + Math.PI + side * 0.45;
      B.kit.add(prop('billboard'), place(base[0], base[1], base[2], yaw));
      const nx = Math.sin(yaw), nz = Math.cos(yaw), tx = -nz, tz = nx;
      const w = 13, hh = 6.2;
      const c: V3 = [base[0] + nx * -0.17, base[1] + 11.8, base[2] + nz * -0.17];
      const [u0, v0, u1, v1] = adUV(rng.int(0, 11));
      B.ad.quad([c[0] - tx * w / 2, c[1] - hh / 2, c[2] - tz * w / 2], [c[0] + tx * w / 2, c[1] - hh / 2, c[2] + tz * w / 2], [c[0] + tx * w / 2, c[1] + hh / 2, c[2] + tz * w / 2], [c[0] - tx * w / 2, c[1] + hh / 2, c[2] - tz * w / 2], [nx, 0, nz], [u1, v0, u0, v0, u0, v1, u1, v1]);
      break;
    }
    case 'busStop': {
      const p = P(2.75, 4.2);
      B.kit.add(prop('busStop'), place(p[0], p[1], p[2], toRoad), C(0x2a4a3a));
      // the advert in the shelter's lightbox, on its outer end
      const m = place(p[0], p[1], p[2], toRoad);
      const L = (x: number, y: number, z: number): V3 => {
        const v = new THREE.Vector3(x, y, z).applyMatrix4(m);
        return [v.x, v.y, v.z];
      };
      const n = new THREE.Vector3(-1, 0, 0).transformDirection(m);
      const [u0, v0, u1, v1] = adUV(rng.int(0, 11));
      B.ad.quad(L(-3.1, 0.3, 0.55), L(-3.1, 0.3, -0.65), L(-3.1, 2.4, -0.65), L(-3.1, 2.4, 0.55), [n.x, 0, n.z], [u0, v0, u1, v0, u1, v1, u0, v1]);
      kit(ctx, 'bin', P(6.2, 3.4), toRoad, 0x2a4a3a);
      break;
    }
    case 'parked': {
      const n = rng.int(1, 3);
      for (let k = 0; k < n; k++) {
        const p = P(k * 5.4, 3.1);
        carShape(ctx, p[0], p[1] + 0.14, p[2], F.h + (rng.chance(0.5) ? Math.PI : 0) + rng.range(-0.06, 0.06), rng.pick(PAINTS), { van: rng.chance(0.2) });
      }
      if (zone.id !== 'industrial' && rng.chance(0.5)) kit(ctx, 'hydrant', P(-3, 3.3), toRoad);
      break;
    }
    case 'wreck': {
      // burnt-out car, half on the kerb, debris and a slab of broken bumper around it
      const p = P(0, 3.4);
      carShape(ctx, p[0], p[1] + 0.1, p[2], F.h + rng.range(-0.9, 0.9), 0, { burnt: true, roll: rng.range(-0.08, 0.08) });
      kit(ctx, 'rubble', P(rng.range(-4, -2.5), 4.5), rng.range(0, 6), undefined, 0.6);
      for (let k = 0; k < 4; k++) {
        const q = P(rng.range(-4, 4), rng.range(1.5, 5), 0.06);
        B.paint.box(q[0], q[1], q[2], rng.range(0.3, 0.9), 0.08, rng.range(0.3, 1.1), rng.range(0, 3), 0, 0, 0, 0, C(0x1e1c1a));
      }
      if (zone.id === 'flood') B.glow.box(p[0], p[1] + 0.6, p[2], 0.4, 0.15, 0.4, 0, 0, 0, 0, 0, glow(0xff6020, EMISSIVE.MEDIUM));
      break;
    }
    case 'containers': {
      const p = P(0, 6.6);
      const stack = rng.int(1, 3);
      for (let k = 0; k < stack; k++) {
        const col = new THREE.Color().setHSL(rng.pick([0.02, 0.08, 0.55, 0.33, 0.6]), 0.6, 0.3);
        B.kit.add(prop('container'), place(p[0], p[1] + k * 2.6, p[2], F.h + Math.PI / 2 + (k % 2) * 0.05), col);
      }
      break;
    }
    case 'pallets': {
      for (let k = 0; k < rng.int(2, 5); k++) {
        const p = P(rng.range(-3, 3), rng.range(2.6, 5), 0);
        const loaded = rng.chance(0.5);
        const h = loaded ? 0 : rng.int(0, 4) * 0.145;
        kit(ctx, loaded ? 'palletLoad' : 'pallet', [p[0], p[1] + h, p[2]], F.h + rng.range(-0.3, 0.3));
      }
      break;
    }
    case 'barrels': {
      for (let k = 0; k < rng.int(3, 7); k++) kit(ctx, 'drum', P(rng.range(-2.5, 2.5), rng.range(2.4, 5)), rng.range(0, 6), rng.pick([0x2f5fa0, 0x8a2a1a, 0x3a5a2a, 0x8a7a20]));
      break;
    }
    case 'jersey': {
      for (let k = 0; k < rng.int(3, 7); k++) kit(ctx, 'jersey', P(k * 3.05 - 4, 2.2), F.h + Math.PI / 2 + rng.range(-0.04, 0.04));
      break;
    }
    case 'floodMast': {
      const p = P(0, 5);
      kit(ctx, 'floodMast', p, toRoad);
      ctx.lamps.push({ x: p[0] - F.r[0] * side * 3, y: p[1] + 15, z: p[2] - F.r[1] * side * 3, s });
      break;
    }
    case 'construction': {
      // roadworks: barriers, a fenced plant compound with an excavator and a generator, a flashing lamp
      for (let k = 0; k < 3; k++) kit(ctx, 'barrierA', P(k * 2.3 - 3, 1.8), F.h + Math.PI / 2);
      for (let k = 0; k < 3; k++) kit(ctx, 'heras', P(k * 3.5 - 2, 6.6), F.h + Math.PI / 2 + rng.range(-0.05, 0.05));
      kit(ctx, 'excavator', P(2, 4.5), F.h + rng.range(-0.5, 0.5) + (side > 0 ? Math.PI : 0), 0xd09a10);
      kit(ctx, 'generator', P(-5.5, 4.2), F.h + Math.PI / 2, 0xd09a10);
      kit(ctx, 'cone', P(-1, 1.2), 0, 0xff5a10);
      kit(ctx, 'cone', P(3.6, 1.2), 0, 0xff5a10);
      blinker(ctx, P(-3.5, 1.8, 1.35), 0xffa010, rng.range(0, 6));
      break;
    }
    case 'sign': {
      // a road sign on two posts; the face is the sign atlas
      const p = P(0, 1.6);
      const yaw = F.h + Math.PI;
      kit(ctx, 'signPost', p, yaw);
      const nx = Math.sin(yaw), nz = Math.cos(yaw), tx = -nz, tz = nx;
      const c: V3 = [p[0] + nx * 0.005, p[1] + 3.6, p[2] + nz * 0.005];
      const w = 2.6, hh = 1.3;
      const [u0, v0, u1, v1] = roadSignUV(rng.int(0, 7));
      B.roadsign.quad([c[0] - tx * w / 2, c[1] - hh / 2, c[2] - tz * w / 2], [c[0] + tx * w / 2, c[1] - hh / 2, c[2] + tz * w / 2], [c[0] + tx * w / 2, c[1] + hh / 2, c[2] + tz * w / 2], [c[0] - tx * w / 2, c[1] + hh / 2, c[2] - tz * w / 2], [nx, 0, nz], [u1, v0, u0, v0, u0, v1, u1, v1]);
      break;
    }
    case 'tree': {
      for (let k = 0; k < 3; k++) kit(ctx, 'tree', P(k * 7, 2.8), rng.range(0, 6), undefined, rng.range(0.85, 1.2));
      kit(ctx, 'bench', P(3.5, 3.6), toRoad);
      break;
    }
    case 'dumpster': {
      kit(ctx, 'dumpster', P(0, 4.4), toRoad, rng.chance(0.5) ? 0x1e4a2a : 0x2a3a5a);
      for (let k = 0; k < 2; k++) kit(ctx, 'bin', P(1.8 + k * 0.9, 4.6), rng.range(0, 6), 0x1e2e24);
      for (let k = 0; k < 3; k++) {
        const q = P(rng.range(1.4, 3), rng.range(3.6, 5), 0.3);
        B.paint.box(q[0], q[1], q[2], 0.6, 0.6, 0.6, rng.range(0, 3), 0, 0, 0, 0, C(0x0e0e10));
      }
      break;
    }
    case 'kiosk': {
      kit(ctx, 'kiosk', P(0, 4.2), toRoad, rng.pick([0x2a2a30, 0x3a1a1a, 0x1a2a3a]));
      kit(ctx, 'bin', P(2.2, 3.2), toRoad, 0x2a2a30);
      break;
    }
    case 'sandbags': {
      kit(ctx, 'sandbags', P(0, 1.9), F.h + Math.PI / 2);
      kit(ctx, 'sandbags', P(4.6, 1.9), F.h + Math.PI / 2 + 0.06);
      if (rng.chance(0.5)) kit(ctx, 'callbox', P(-3, 2.6), toRoad);
      break;
    }
    case 'police': {
      // a checkpoint on the pavement: a cruiser with its lights going and two barriers
      const p = P(0, 3.4);
      carShape(ctx, p[0], p[1] + 0.14, p[2], F.h + side * 0.25, 0x101828, { kind: ['police', 0] });
      blinker(ctx, [p[0] - 0.3 * F.r[0], p[1] + 1.75, p[2] - 0.3 * F.r[1]], 0xff1030, 0);
      blinker(ctx, [p[0] + 0.3 * F.r[0], p[1] + 1.75, p[2] + 0.3 * F.r[1]], 0x1060ff, Math.PI);
      for (const o of [4, 7]) kit(ctx, 'barrierA', P(o, 1.8), F.h + Math.PI / 2);
      break;
    }
    case 'yard': {
      // an open yard behind the pavement: a forklift, loaded pallets, a cable drum, a generator
      kit(ctx, 'forklift', P(0, 4.6), F.h + rng.range(-1, 1), 0xd0a010);
      for (let k = 0; k < 3; k++) kit(ctx, 'palletLoad', P(2.4 + k * 1.3, 5.4), F.h + rng.range(-0.1, 0.1));
      kit(ctx, 'spool', P(-3, 5), F.h + rng.range(-0.3, 0.3));
      if (rng.chance(0.5)) kit(ctx, 'generator', P(-6.5, 4.5), F.h + Math.PI / 2, 0x2a5a3a);
      break;
    }
    case 'substation': {
      kit(ctx, 'transformer', P(0, 5), toRoad);
      kit(ctx, 'cabinet', P(-2.6, 4.4), toRoad, 0x4a5a5a);
      kit(ctx, 'cabinet', P(2.4, 4.4), toRoad, 0x4a5a5a);
      kit(ctx, 'mast', P(0, 7.2), 0, undefined, 1.2);
      break;
    }
    case 'boat': {
      // the flood brought it here: a motorboat stranded on the pavement, tilted on its keel
      const p = P(0, 4.2);
      const m = new THREE.Matrix4().compose(new THREE.Vector3(p[0], p[1] + 0.1, p[2]), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.08, F.h + rng.range(-0.8, 0.8), side * 0.22, 'YXZ')), new THREE.Vector3(1, 1, 1));
      B.kit.add(prop('boat'), m, C(rng.pick([0x2a4a7a, 0x7a2a2a, 0x2a5a4a])));
      kit(ctx, 'rubble', P(3.5, 5), rng.range(0, 6), undefined, 0.7);
      break;
    }
    case 'rubble': {
      kit(ctx, 'rubble', P(0, 3.6), rng.range(0, 6));
      kit(ctx, 'rubble', P(2.4, 4.6), rng.range(0, 6), undefined, 0.7);
      kit(ctx, 'heras', P(-2, 2.2), F.h + Math.PI / 2 + 0.2);
      kit(ctx, 'warnSign', P(-4, 1.6), F.h + Math.PI);
      break;
    }
    case 'streetCorner': {
      // pavement furniture: a hydrant, an electrical cabinet, bollards, a phone kiosk light
      kit(ctx, 'hydrant', P(0, 1.6), toRoad);
      kit(ctx, 'cabinet', P(2.5, 5.2), toRoad, 0x3a4a4a);
      for (let k = 0; k < 4; k++) kit(ctx, 'bollard', P(-4 + k * 1.3, 1.3), 0);
      kit(ctx, 'bench', P(5.2, 4.6), toRoad);
      break;
    }
    case 'scaffold': {
      for (let k = 0; k < 3; k++) kit(ctx, 'scaffold', P(k * 2.55 - 2.5, 5.0), F.h + Math.PI / 2);
      kit(ctx, 'heras', P(0, 3.0), F.h + Math.PI / 2);
      kit(ctx, 'heras', P(3.6, 3.0), F.h + Math.PI / 2);
      kit(ctx, 'palletLoad', P(-5, 3.6), F.h + 0.2);
      break;
    }
    case 'utility': {
      kit(ctx, 'cabinet', P(0, 4.6), toRoad, 0x5a6a5a);
      kit(ctx, 'callbox', P(1.6, 1.4), toRoad);
      kit(ctx, 'hydrant', P(-2, 1.5), toRoad);
      break;
    }
  }
}

/** A small flashing lamp (roadworks, police). Separate mesh so it can blink. */
function blinker(ctx: SceneryCtx, p: V3, color: number, phase: number) {
  const key = 'blink_' + color.toString(16);
  let mat = ctx.mats[key] as THREE.MeshBasicMaterial | undefined;
  if (!mat) {
    mat = new THREE.MeshBasicMaterial({ color: glow(color, EMISSIVE.STRONG) });
    ctx.mats[key] = mat;
  }
  const m = new THREE.Mesh(BLINK_GEO, mat);
  m.scale.set(0.35, 0.25, 0.35);
  m.position.set(p[0], p[1], p[2]);
  ctx.group.add(m);
  ctx.anims.push({ obj: m, kind: 'blink', phase });
}

// ------------------------------------------------------------------------------------------------ elevated

/** Skyway / Zero Mile: gantries, wind fences on the barrier, and other highways crossing far below. */
function buildElevatedSide(ctx: SceneryCtx, rng: Random) {
  const { info, road, B, zone } = ctx;
  const hole = info.gapJump;
  const blocked = (s: number) => (hole && s > hole.s0 - 50 && s < hole.s1 + 12) || road.sample(s).y > 0.05;
  // wind fence runs on top of the barrier
  for (const side of [-1, 1]) {
    let s = info.startS + rng.range(0, 40);
    while (s < info.endS - 10) {
      const e = Math.min(info.endS - 2, s + rng.range(25, 70));
      if (rng.chance(0.5)) {
        for (let k = s; k < e; k += 4) {
          if (blocked(k)) continue;
          const F = frame(road, k);
          const a = at(road, k, side * (F.w / 2 + 0.4), 0.9), b = at(road, Math.min(e, k + 4), side * (frame(road, Math.min(e, k + 4)).w / 2 + 0.4), 0.9);
          B.pole.beam(a, [a[0], a[1] + 1.8, a[2]], 0.08);
          B.glass.quad(a, b, [b[0], b[1] + 1.7, b[2]], [a[0], a[1] + 1.7, a[2]], [-side * F.r[0], 0, -side * F.r[1]]);
        }
      }
      s = e + rng.range(20, 50);
    }
  }
  // overhead sign gantry
  if (info.endS - info.startS > 100 && rng.chance(0.45)) {
    const s = info.startS + rng.range(20, info.endS - info.startS - 20);
    if (!blocked(s)) {
      const F = frame(road, s);
      const half = F.w / 2 + 0.8;
      for (const side of [-1, 1]) {
        const p = at(road, s, side * half);
        B.pole.beam(p, [p[0], p[1] + 7.4, p[2]], 0.4);
      }
      const l = at(road, s, -half, 7.2), r = at(road, s, half, 7.2);
      B.pole.beam(l, r, 0.5);
      const yaw = F.h + Math.PI;
      const nx = Math.sin(yaw), nz = Math.cos(yaw), tx = -nz, tz = nx;
      for (const o of [-0.25, 0.25]) {
        const c = at(road, s - 0.3, o * F.w, 6.0);
        const [u0, v0, u1, v1] = roadSignUV(rng.int(0, 7));
        const w = 4.2, hh = 2.1;
        B.roadsign.quad([c[0] - tx * w / 2, c[1] - hh / 2, c[2] - tz * w / 2], [c[0] + tx * w / 2, c[1] - hh / 2, c[2] + tz * w / 2], [c[0] + tx * w / 2, c[1] + hh / 2, c[2] + tz * w / 2], [c[0] - tx * w / 2, c[1] + hh / 2, c[2] - tz * w / 2], [nx, 0, nz], [u1, v0, u0, v0, u0, v1, u1, v1]);
      }
    }
  }
  // another highway crossing far below: a lit ribbon with traffic lights on it — depth and scale
  if (rng.chance(0.55)) {
    const sMid = (info.startS + info.endS) / 2;
    const F = frame(road, sMid);
    const ang = F.h + rng.sign() * rng.range(0.6, 1.2);
    const dir: [number, number] = [Math.sin(ang), Math.cos(ang)];
    const rr: [number, number] = [-Math.cos(ang), Math.sin(ang)];
    const y = F.y - rng.range(22, 40);
    const L = 260, W = 14;
    const c0: V3 = [F.x + F.r[0] * rng.range(-30, 30), y, F.z + F.r[1] * rng.range(-30, 30)];
    const corner = (t: number, d: number): V3 => [c0[0] + dir[0] * t + rr[0] * d, y, c0[2] + dir[1] * t + rr[1] * d];
    B.deck.quad(corner(-L / 2, -W / 2), corner(L / 2, -W / 2), corner(L / 2, W / 2), corner(-L / 2, W / 2), [0, 1, 0]);
    B.deck.quad(corner(-L / 2, W / 2), corner(L / 2, W / 2), [corner(L / 2, W / 2)[0], y - 2.5, corner(L / 2, W / 2)[2]], [corner(-L / 2, W / 2)[0], y - 2.5, corner(-L / 2, W / 2)[2]], [rr[0], 0, rr[1]]);
    const neon = glow(zone.neon[0], EMISSIVE.SUBTLE);
    for (const d of [-W / 2, W / 2]) {
      const a = corner(-L / 2, d), b = corner(L / 2, d);
      B.glow.beam([a[0], y + 0.7, a[2]], [b[0], y + 0.7, b[2]], 0.18, neon);
    }
    for (let t = -L / 2 + 20; t < L / 2; t += 60) {
      const p = corner(t, 0);
      B.deck.box(p[0], y - 40, p[2], 4, 76, 4, ang);
    }
    // traffic down there: pairs of head- and tail-lights
    for (let k = 0; k < 10; k++) {
      const t = rng.range(-L / 2 + 10, L / 2 - 10);
      const lane = rng.chance(0.5) ? -3 : 3;
      const p = corner(t, lane);
      const c = lane > 0 ? glow(0xff2030, EMISSIVE.MEDIUM) : glow(0xfff0d0, EMISSIVE.MEDIUM);
      B.glow.box(p[0], y + 0.5, p[2], 1.6, 0.4, 3.6, ang, 0, 0, 0, 0, c);
    }
  }
}

// ------------------------------------------------------------------------------------------------ crossings

/** Something big crossing over the road: pipe bridge, monorail, skybridge, an upper deck, a broken ring. */
function buildCrossing(ctx: SceneryCtx, rng: Random) {
  const { info, road, B, zone } = ctx;
  const len = info.endS - info.startS;
  if (len < 90 || info.lipS > 0 || info.gapJump || info.type === 'INTERSECTION' || info.tag?.role === 'finish') return;
  if (!rng.chance(zone.elevated ? 0.18 : 0.24)) return;
  const s = info.startS + len * rng.range(0.35, 0.65);
  if (ctx.finishS > 0 && Math.abs(s - ctx.finishS) < 60) return;
  const F = frame(road, s);
  const half = F.w / 2 + (zone.elevated ? 1.5 : 6.5);
  const L = at(road, s, -half), R = at(road, s, half);
  const neon = glow(zone.neon[0], EMISSIVE.MEDIUM);
  switch (zone.id) {
    case 'industrial': {
      // pipe bridge: lattice towers each side, twin truss with pipes, a lit walkway — one kit piece
      if (2 * half <= 34) {
        B.kit.add(industry('pipeBridge'), place(F.x, F.y, F.z, F.h + Math.PI / 2));
        break;
      }
      for (const p of [L, R]) {
        for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
          const b: V3 = [p[0] + F.f[0] * ox * 1.2 + F.r[0] * oz * 1.2, p[1], p[2] + F.f[1] * ox * 1.2 + F.r[1] * oz * 1.2];
          B.rust.beam(b, [b[0], b[1] + 14, b[2]], 0.28);
        }
        for (let y = 2; y < 14; y += 3) B.rust.beam([p[0] - F.f[0] * 1.2, p[1] + y, p[2] - F.f[1] * 1.2], [p[0] + F.f[0] * 1.2, p[1] + y + 2.6, p[2] + F.f[1] * 1.2], 0.12);
      }
      for (const [o, y, r] of [[-0.9, 12.6, 0.7], [0.6, 12.9, 0.95], [1.9, 12.4, 0.5]] as const) {
        const a: V3 = [L[0] + F.f[0] * o, L[1] + y, L[2] + F.f[1] * o], b: V3 = [R[0] + F.f[0] * o, R[1] + y, R[2] + F.f[1] * o];
        B.rust.tube(a, b, r, 8);
      }
      const wa: V3 = [L[0] - F.f[0] * 1.6, L[1] + 11.4, L[2] - F.f[1] * 1.6], wb: V3 = [R[0] - F.f[0] * 1.6, R[1] + 11.4, R[2] - F.f[1] * 1.6];
      B.pole.beam(wa, wb, 0.25);
      B.stripe.beam([wa[0], wa[1] + 1, wa[2]], [wb[0], wb[1] + 1, wb[2]], 0.08);
      for (let k = 0.15; k < 1; k += 0.23) {
        const p: V3 = [wa[0] + (wb[0] - wa[0]) * k, wa[1] - 0.35, wa[2] + (wb[2] - wa[2]) * k];
        B.glow.box(p[0], p[1], p[2], 0.5, 0.2, 0.5, F.h, 0, 0, 0, 0, glow(0xffb060, EMISSIVE.MEDIUM));
      }
      break;
    }
    case 'flood': {
      // monorail on concrete piers, a lit two-car train parked on it
      for (const p of [L, R]) B.concrete.box(p[0], p[1] + 6.5, p[2], 2.2, 13, 2.2, F.h);
      B.concrete.beam([L[0], L[1] + 13.6, L[2]], [R[0], R[1] + 13.6, R[2]], 1.4);
      const tc = at(road, s, rng.range(-F.w / 4, F.w / 4), 15.6);
      for (const o of [-6.4, 0.2]) {
        const c: V3 = [tc[0] + F.r[0] * o, tc[1], tc[2] + F.r[1] * o];
        B.paint.box(c[0], c[1], c[2], 2.6, 2.6, 6.2, F.h + Math.PI / 2, 0, 0, 0, 0, C(0xd8dde4), true, false);
        B.glow.box(c[0], c[1] + 0.35, c[2], 2.68, 0.7, 5.4, F.h + Math.PI / 2, 0, 0, 0, 0, glow(0xd8f0ff, EMISSIVE.SUBTLE * 1.2));
      }
      B.glow.beam([L[0], L[1] + 12.8, L[2]], [R[0], R[1] + 12.8, R[2]], 0.12, neon);
      break;
    }
    case 'oldcity': {
      // enclosed skybridge between two buildings, a banner hanging under it
      const y = rng.range(13, 18);
      for (const p of [L, R]) B.concrete.box(p[0], p[1] + y / 2, p[2], 3, y, 3, F.h);
      const a: V3 = [L[0], L[1] + y + 2, L[2]], b: V3 = [R[0], R[1] + y + 2, R[2]];
      const mid: V3 = [(a[0] + b[0]) / 2, a[1], (a[2] + b[2]) / 2];
      B.facadeO.box(mid[0], mid[1], mid[2], 2 * half, 4, 4.4, F.h, FACADE_U, FACADE_V, 0, 0.25, undefined, false, false);
      B.glow.beam([a[0], a[1] - 2.1, a[2]], [b[0], b[1] - 2.1, b[2]], 0.12, neon);
      B.glow.beam([a[0], a[1] + 2.1, a[2]], [b[0], b[1] + 2.1, b[2]], 0.12, glow(zone.neon[1], EMISSIVE.MEDIUM));
      const w = 9, hh = 3.6;
      const yaw = F.h + Math.PI;
      const nx = Math.sin(yaw), nz = Math.cos(yaw), tx = -nz, tz = nx;
      const c: V3 = [mid[0] - F.f[0] * 2.3, mid[1] - 2.2 - hh / 2, mid[2] - F.f[1] * 2.3];
      const [u0, v0, u1, v1] = adUV(rng.int(0, 11));
      B.ad.quad([c[0] - tx * w / 2, c[1] - hh / 2, c[2] - tz * w / 2], [c[0] + tx * w / 2, c[1] - hh / 2, c[2] + tz * w / 2], [c[0] + tx * w / 2, c[1] + hh / 2, c[2] + tz * w / 2], [c[0] - tx * w / 2, c[1] + hh / 2, c[2] - tz * w / 2], [nx, 0, nz], [u1, v0, u0, v0, u0, v1, u1, v1]);
      break;
    }
    case 'skyway': {
      // an upper deck crossing high overhead on massive pillars, with traffic on it
      const y = rng.range(22, 30);
      const span = 2 * half + 60;
      const c: V3 = [F.x, F.y + y, F.z];
      B.deck.box(c[0], c[1], c[2], 14, 2.4, span, F.h + Math.PI / 2, 0, 0, 0, 0, undefined, false, false);
      for (const side of [-1, 1]) {
        const p = at(road, s, side * (half + 6));
        B.deck.box(p[0], p[1] + (y - 70) / 2, p[2], 4.5, y + 70, 4.5, F.h);
        B.glow.beam([c[0] + F.f[0] * side * 7 - F.r[0] * span / 2, c[1] + 1.4, c[2] + F.f[1] * side * 7 - F.r[1] * span / 2], [c[0] + F.f[0] * side * 7 + F.r[0] * span / 2, c[1] + 1.4, c[2] + F.f[1] * side * 7 + F.r[1] * span / 2], 0.15, neon);
      }
      for (let k = 0; k < 4; k++) {
        const o = rng.range(-span / 2 + 8, span / 2 - 8);
        const lane = rng.chance(0.5) ? -3 : 3;
        const p: V3 = [c[0] + F.r[0] * o + F.f[0] * lane, c[1] + 1.9, c[2] + F.r[1] * o + F.f[1] * lane];
        B.paint.box(p[0], p[1], p[2], 1.9, 1.3, 4.4, F.h + Math.PI / 2, 0, 0, 0, 0, C(rng.pick(PAINTS)));
      }
      break;
    }
    case 'zeromile': {
      // a broken ring arcing over the road
      const R0 = half + 8;
      const c: V3 = [F.x, F.y + 4, F.z];
      const segs = 10;
      for (let k = 0; k < segs; k++) {
        if (k === 3 || k === 7) continue; // the breaks
        const a0 = Math.PI * (k / segs), a1 = Math.PI * ((k + 1) / segs);
        const p0: V3 = [c[0] + F.r[0] * Math.cos(a0) * R0, c[1] + Math.sin(a0) * R0, c[2] + F.r[1] * Math.cos(a0) * R0];
        const p1: V3 = [c[0] + F.r[0] * Math.cos(a1) * R0, c[1] + Math.sin(a1) * R0, c[2] + F.r[1] * Math.cos(a1) * R0];
        B.roof.beam(p0, p1, 2.2);
        B.glow.beam([p0[0] - F.f[0] * 1.15, p0[1], p0[2] - F.f[1] * 1.15], [p1[0] - F.f[0] * 1.15, p1[1], p1[2] - F.f[1] * 1.15], 0.18, glow(0xff1040, EMISSIVE.STRONG));
      }
      break;
    }
  }
}

// ------------------------------------------------------------------------------------------------ road wear

/**
 * Wear that says thousands of cars use this road: polished tyre tracks in every lane, repair patches, oil, cracks,
 * manholes and drains, skid marks on bends, expansion joints on bridges.
 */
function buildRoadWear(ctx: SceneryCtx, rng: Random) {
  const { info, road, B, S } = ctx;
  const ok = (s: number) => {
    const sm = road.sample(s);
    return !sm.gap && sm.y < 0.05 && sm.median <= 0;
  };
  const decal = (s: number, d: number, len: number, wid: number, cell: number, rot = 0, y = 0.012) => {
    if (!ok(s) || !ok(s + len)) return;
    const [u0, v0, u1, v1] = decalUV(cell);
    if (rot === 0) {
      // follows the road's curve
      const steps = Math.max(1, Math.round(len / 3));
      for (let k = 0; k < steps; k++) {
        const sa = s + (len * k) / steps, sb = s + (len * (k + 1)) / steps;
        const va = v0 + ((v1 - v0) * k) / steps, vb = v0 + ((v1 - v0) * (k + 1)) / steps;
        B.decal.quad(at(road, sa, d - wid / 2, y), at(road, sa, d + wid / 2, y), at(road, sb, d + wid / 2, y), at(road, sb, d - wid / 2, y), [0, 1, 0], [u0, va, u1, va, u1, vb, u0, vb]);
      }
      return;
    }
    const F = frame(road, s);
    const c = at(road, s, d, y);
    const h = F.h + rot;
    const fx = Math.sin(h), fz = Math.cos(h), rx = -Math.cos(h), rz = Math.sin(h);
    const hl = len / 2, hw = wid / 2;
    B.decal.quad([c[0] - rx * hw - fx * hl, y + F.y, c[2] - rz * hw - fz * hl], [c[0] + rx * hw - fx * hl, y + F.y, c[2] + rz * hw - fz * hl], [c[0] + rx * hw + fx * hl, y + F.y, c[2] + rz * hw + fz * hl], [c[0] - rx * hw + fx * hl, y + F.y, c[2] - rz * hw + fz * hl], [0, 1, 0], [u0, v0, u1, v0, u1, v1, u0, v1]);
  };
  const w = S[Math.min(S.length - 1, ctx.i0)]?.width ?? 12;
  const lanes = Math.max(2, Math.round(w / 3.9));
  const lw = w / lanes;
  // tyre tracks
  for (let l = 0; l < lanes; l++) {
    const dc = -w / 2 + lw * (l + 0.5);
    for (const o of [-0.85, 0.85]) {
      let s = info.startS + rng.range(0, 8);
      while (s < info.endS - 4) {
        const len = Math.min(info.endS - s - 1, rng.range(10, 34));
        if (len > 3) decal(s, dc + o, len, 0.62, 0);
        s += len + rng.range(2, 14);
      }
    }
  }
  const len = info.endS - info.startS;
  const lane = () => -w / 2 + lw * (rng.int(0, lanes - 1) + 0.5);
  for (let k = 0; k < Math.round(len / 70); k++) decal(info.startS + rng.range(5, len - 10), lane() + rng.range(-0.6, 0.6), rng.range(3, 7), rng.range(2, 3.2), 1, rng.range(-0.05, 0.05));
  for (let k = 0; k < Math.round(len / 45); k++) decal(info.startS + rng.range(4, len - 4), lane() + rng.range(-0.4, 0.4), rng.range(1.4, 2.4), rng.range(1.2, 2), 2, rng.range(0, 3));
  for (let k = 0; k < Math.round(len / 50); k++) decal(info.startS + rng.range(4, len - 4), rng.range(-w / 2 + 1, w / 2 - 1), rng.range(2, 4), rng.range(1.5, 3), 5, rng.range(0, 3));
  for (let k = 0; k < Math.round(len / 90); k++) decal(info.startS + rng.range(4, len - 4), lane() + rng.sign() * 0.9, 1.1, 1.1, 4, rng.range(0, 3));
  for (let s = info.startS + rng.range(4, 20); s < info.endS - 2; s += rng.range(22, 34)) for (const side of [-1, 1]) decal(s, side * (w / 2 - 0.55), 0.9, 0.7, 6, 0);
  if (info.type === 'CURVE' || info.type === 'TURN_SHARP' || info.type === 'CHICANE' || info.type === 'S_CURVE') {
    for (let k = 0; k < rng.int(1, 3); k++) decal(info.startS + rng.range(10, len - 14), rng.range(-w / 3, w / 3), rng.range(6, 11), 2.2, 3, rng.range(-0.5, 0.5));
  }
  if (info.bridge) for (let s = Math.ceil(info.startS / 14) * 14; s < info.endS; s += 14) decal(s, 0, 0.6, w + 0.4, 7, 0, 0.014);
}


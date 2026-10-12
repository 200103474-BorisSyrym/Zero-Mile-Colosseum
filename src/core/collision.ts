/**
 * Collision materials: different surfaces must feel different.
 *
 * A contact is split into an IMPACT (the first frame you hit something, classified by angle and normal speed)
 * and SLIDING (every frame after that while you stay in contact). Impacts cost tangential speed once; sliding only
 * costs a small, time-based friction — so touching a curb for half a second is a scrape, not ten crashes.
 */
export type CollisionSeverity = 'scrape' | 'light' | 'medium' | 'heavy';
export type CollisionMaterialId = 'curb' | 'wall' | 'divider' | 'heavyProp' | 'cushion';

export interface CollisionMaterial {
  id: CollisionMaterialId;
  label: string;
  /** fraction of tangential speed kept on an impact of each severity */
  retention: Record<CollisionSeverity, number>;
  /** m/s² of tangential speed lost while sliding along the surface */
  scrapeFriction: number;
  /**
   * Coulomb-style friction: extra deceleration = mu × how hard the car presses into the surface.
   * A straight-line skim barely loads it; leaning on the outside wall through a corner loads it a lot —
   * so the wall is never a free guide rail.
   */
  mu: number;
  /** bounce: share of the normal speed sent back out, capped */
  restitution: number;
  maxBounce: number;
  /** arcade deflection: share of the normal speed redirected along the surface on medium/heavy hits */
  redirect: number;
  /**
   * Share of the "pointing into the surface" heading turned along it on impact (0..1).
   * Scrapes and light touches skim (high), solid hits don't steer you round the corner for free (low).
   */
  alignSoft: number;
  alignHard: number;
  /** rad/s the heading is turned off the surface while sliding (prevents sticking; steering does the rest) */
  alignRate: number;
  /** hull damage and combo penalty scale */
  damageMul: number;
  comboMul: number;
  /** metres the car may ride up onto it before it becomes solid (0 = solid) */
  climb: number;
  /** seconds of reduced control after a heavy hit */
  recover: number;
}

export const COLLISION_MATERIALS: Record<CollisionMaterialId, CollisionMaterial> = {
  // low concrete road-edge barrier: skim it, don't stick to it
  curb: {
    id: 'curb', label: 'CURB',
    retention: { scrape: 0.99, light: 0.975, medium: 0.9, heavy: 0.75 },
    scrapeFriction: 1.5, mu: 1.2, restitution: 0.12, maxBounce: 2.2, redirect: 0.15, alignSoft: 0.85, alignHard: 0.2, alignRate: 0.8,
    damageMul: 0.7, comboMul: 0.6, climb: 0.3, recover: 0.3,
  },
  // tunnel walls: harder, louder, more punishing — but still a slide at shallow angles
  wall: {
    id: 'wall', label: 'WALL',
    retention: { scrape: 0.985, light: 0.955, medium: 0.9, heavy: 0.65 },
    scrapeFriction: 3, mu: 1.3, restitution: 0.22, maxBounce: 3.5, redirect: 0.1, alignSoft: 0.75, alignHard: 0.15, alignRate: 0.7,
    damageMul: 1, comboMul: 1, climb: 0, recover: 0.45,
  },
  // central concrete divider of split roads (tapered noses)
  divider: {
    id: 'divider', label: 'DIVIDER',
    retention: { scrape: 0.985, light: 0.96, medium: 0.92, heavy: 0.68 },
    scrapeFriction: 2.5, mu: 1.2, restitution: 0.18, maxBounce: 3, redirect: 0.14, alignSoft: 0.8, alignHard: 0.2, alignRate: 0.8,
    damageMul: 0.9, comboMul: 0.9, climb: 0, recover: 0.4,
  },
  // concrete blocks, pillars, parked cars
  heavyProp: {
    id: 'heavyProp', label: 'BLOCK',
    retention: { scrape: 0.985, light: 0.95, medium: 0.88, heavy: 0.6 },
    scrapeFriction: 3, mu: 1.2, restitution: 0.3, maxBounce: 4, redirect: 0.1, alignSoft: 0.5, alignHard: 0.15, alignRate: 0.8,
    damageMul: 1, comboMul: 1, climb: 0, recover: 0.45,
  },
  // boss-arena obstacles: they stop you and cost the combo, but barely scratch the hull
  cushion: {
    id: 'cushion', label: 'ANVIL',
    retention: { scrape: 0.985, light: 0.95, medium: 0.88, heavy: 0.6 },
    scrapeFriction: 3, mu: 1.2, restitution: 0.3, maxBounce: 4, redirect: 0.1, alignSoft: 0.5, alignHard: 0.15, alignRate: 0.8,
    damageMul: 0.35, comboMul: 1, climb: 0, recover: 0.35,
  },
};

/**
 * Impact thresholds. Angle (degrees between velocity and surface) sets the class; normal speed caps it both ways:
 * a slow bump is never a crash, and slamming into a wall at heavyVN m/s or more is always one, whatever the angle.
 */
export const IMPACT = { scrapeAngle: 7, lightAngle: 18, mediumAngle: 40, heavyVN: 26 };

/**
 * While sliding along a surface, the nose is turned off it at a rate that depends on how steeply it points in:
 * shallow → skim off quickly (never stick to a curb); a solid angle → slowly (the wall doesn't steer you round a
 * corner for free); nearly head-on → pivot off the wall so you are never pinned facing it.
 */
export function slideOffRate(mat: CollisionMaterial, intoSin: number) {
  if (intoSin < 0.17) return 3; // < ~10°
  if (intoSin < 0.57) return mat.alignRate; // ~10–35°
  return 1.6;
}

/**
 * Classify an impact by its angle, then cap it by the raw normal speed so a slow bump is never a "crash".
 * vN = speed into the surface (m/s), vT = speed along it.
 */
export function classifyImpact(vN: number, vT: number): { severity: CollisionSeverity; angle: number } {
  const angle = (Math.atan2(Math.max(0, vN), Math.abs(vT)) * 180) / Math.PI;
  let severity: CollisionSeverity = angle < IMPACT.scrapeAngle ? 'scrape' : angle < IMPACT.lightAngle ? 'light' : angle < IMPACT.mediumAngle ? 'medium' : 'heavy';
  if (vN < 2) severity = 'scrape';
  else if (vN < 4 && severity !== 'scrape') severity = 'light';
  else if (vN < 8 && severity === 'heavy') severity = 'medium';
  else if (vN >= IMPACT.heavyVN && severity !== 'scrape') severity = 'heavy';
  return { severity, angle };
}

/** One entry of collision telemetry (debug overlay / console when enabled). */
export interface ContactRecord {
  t: number;
  material: string;
  severity: CollisionSeverity;
  angle: number;
  /** km/h */
  before: number;
  after: number;
  vN: number;
  vT: number;
  bounce: number;
  /** filled in by the session: combo and hull change caused by this hit */
  combo?: number;
  hp?: number;
}

export function formatContact(r: ContactRecord) {
  const pen = r.after - r.before;
  return `${r.material} ${r.severity.toUpperCase()} ${r.before} → ${r.after} km/h (${pen >= 0 ? '+' : ''}${pen}) · ${r.angle.toFixed(0)}° · vN ${r.vN.toFixed(1)} vT ${r.vT.toFixed(1)} · bounce ${r.bounce.toFixed(1)}${r.combo !== undefined ? ` · combo ${r.combo >= 0 ? '+' : ''}${r.combo.toFixed(1)}` : ''}${r.hp ? ` · hp -${r.hp.toFixed(1)}` : ''}`;
}

/**
 * Handling: every number that shapes how the car feels, in one place. Units: metres, seconds, m/s, radians.
 *
 * The model is arcade-first. It lies on purpose — the car helps you straighten up, a landing that is nearly right is
 * made right, a ram looks bigger than the momentum it moved — but it lies the same way every time, so the player
 * learns it. Per-car personality (top speed, acceleration, steering, grip, drift grip, mass, air control) lives in
 * `data/vehicles.ts`; this table is the shape every car shares.
 */
export const HANDLING = {
  /* ---------------------------------------------------------------- input */
  /** share of a fresh steering press applied at once (a keyboard tap bites on the first frame) */
  steerKick: 0.4,
  /** per second toward the held input after the kick, and back to zero on release */
  steerRampUp: 7,
  steerRampDown: 12,
  /** at top speed the steering curve gets this much more sensitive around the centre (exponent 1 → 1 - x) */
  steerCentreGain: 0.22,
  /** seconds an early handbrake press is remembered (pressed just before steering, or just before landing) */
  bufferTime: 0.15,

  /* ---------------------------------------------------------------- engine */
  /** acceleration curve f(r) = (1 - r^shape)^fade, r = speed / top speed: hard launch, strong mid-range, an asymptote */
  accelShape: 2.4,
  accelFade: 0.75,
  /** 1/s pull back toward the current top speed when above it (boost ending, downhill, a shove) — never a wall */
  overSpeedPull: 1.6,
  coastDecel: 2.2,
  aeroDrag: 0.0009,
  /** nitro: an explosive first moment (extra acceleration share, decaying over the kick time) */
  nitroKick: 0.9,
  nitroKickTime: 0.35,

  /* ---------------------------------------------------------------- brakes */
  /** brake force = stats.braking × (low + high × speed / 55): the brakes bite harder at speed, ease near a stop */
  brakeLow: 0.5,
  brakeHigh: 0.22,
  /** below this speed (m/s) the bite softens so the car settles instead of stopping like a brick */
  brakeSoftBelow: 6,
  handbrakeDecel: 10,

  /* ---------------------------------------------------------------- steering */
  /** 1/s: how fast the yaw rate follows its target (grip / drift / air) */
  yawResponse: 12,
  yawResponseDrift: 7,
  yawResponseAir: 4,
  /** extra steering authority at parking speeds (fades out by ~65 km/h) */
  lowSpeedAuthority: 1.3,
  lowSpeedFade: 18,
  /** slide stabilisation: a car knocked sideways turns its nose back into the slide (1/s, cap rad/s) */
  slideAssist: 1.6,
  slideAssistMax: 1.1,
  /** slip angle (rad) above which the slide assist starts */
  slideAssistFrom: 0.22,

  /* ---------------------------------------------------------------- drift */
  /** seconds to blend from grip into a full drift (no snap) */
  driftEntry: 0.16,
  /** slip angle targets: neutral steering holds driftAngle; steering into the turn adds, countersteer takes away */
  driftAngle: 0.48,
  driftAngleInto: 0.34,
  driftAngleCounter: 0.62,
  driftAngleMin: 0.06,
  driftAngleMax: 0.95,
  /** 1/s: the nose swings to the target angle on a spring — overcooked, it comes back; it never spins on its own */
  driftSpring: 6,
  /** how hard the path bends, as a share of the drift grip budget (DRIVE.DRIFT_GRIP_CAP) */
  driftTurn: 0.45,
  driftTurnInto: 0.55,
  driftTurnCounter: 0.5,
  /** throttle share that keeps pushing along the slide */
  driftThrottle: 0.75,
  /** extra speed scrub (m/s² per rad²) when the car is more sideways than the sweet spot */
  driftScrub: 22,
  driftScrubFrom: 0.62,
  /** without the handbrake, a drift lives as long as you steer into it; let go this long and it ends */
  driftLetGo: 0.14,
  /** exit: seconds in which the nose and the path meet again; a clean exit (small angle) costs almost nothing */
  driftExit: 0.24,
  driftExitAlign: 9,
  driftCleanExit: 0.45,

  /* ---------------------------------------------------------------- air */
  /** the lip adds this vertical pop (m/s) on top of the ramp's own launch */
  launchPop: 2.0,
  /** air yaw control (scaled by stats.airControl) */
  airYaw: 1.8,
  /** brake lifts the nose (rad/s, scaled by stats.airControl / 0.35); let go and it falls back to the arc */
  airPitch: 1.3,
  airPitchMax: 0.55,
  /** the nose follows the arc at this share of the trajectory angle, at this rate (1/s) */
  airNoseFollow: 0.6,
  airAlign: 2.4,
  /** steering banks the car a little in the air (rad at full lock) */
  airRoll: 0.18,
  /** a small sideways nudge of the trajectory (m/s², scaled by stats.airControl / 0.35): fix a line, not fly */
  airDodge: 3.2,

  /* ---------------------------------------------------------------- landing */
  /** landing error (rad, the worst of pitch / roll / heading-vs-path) for each grade */
  landPerfect: 0.16,
  landGood: 0.3,
  landRough: 0.6,
  landBad: 1.0,
  /** speed kept per grade */
  landKeep: { perfect: 0.995, good: 0.985, rough: 0.94, bad: 0.86, crash: 0.72 },
  /** share of the heading error the landing assist takes away per grade */
  landAlign: { perfect: 0.9, good: 0.8, rough: 0.5, bad: 0.15, crash: 0 },
  /** seconds after touchdown in which grip comes back from landGrip to full */
  landTime: 0.3,
  landGrip: 0.65,
  /** nose-first landings hop: share of the impact speed sent back up (m/s cap) */
  landBounce: 0.13,
  landBounceMax: 3.5,

  /* ---------------------------------------------------------------- impacts and recovery */
  /** seconds of reduced grip after being hit (light / heavy) */
  impactLight: 0.15,
  impactHeavy: 0.4,
  /** grip share while unsettled by a hit */
  impactGrip: 0.75,
  /** steering share kept while recovering from a heavy hit (the countersteer still works) */
  recoverControl: 0.6,
  /** stuck: after this long the car helps itself out (turns to the road, crawls off the wall) */
  unstickAfter: 1.0,
  unstickTurn: 1.4,
  unstickPush: 5,
  /** and after this long it is put back on the road (costs a few seconds, never the run) */
  autoResetAfter: 4.5,
  /** facing the wrong way and slow: the car pivots back toward the road (rad/s) */
  turnAroundRate: 1.6,
  /** a countersteer save: big slip or spin brought back under control within this window earns a SAVE */
  saveSlip: 0.75,
  saveWindow: 1.4,

  /* ---------------------------------------------------------------- vehicle contact (rams) */
  /**
   * Arcade rams: the player keeps most of their speed and the target takes the hit.
   * Player speed loss along the contact normal = closing speed × (lossBase + lossMass × (m / (1 + m))²), m = target /
   * player mass: a sedan gives way (a full-speed T-bone costs ~25 km/h), a truck wins unless you pick your hit.
   */
  ramLossBase: 0.04,
  ramLossMass: 0.45,
  /** head-on: both lose much more */
  ramFrontLoss: 1.6,
  /** share of the way from the arcade loss to a plain impulse for heavy targets (mass ratio 1.2 → 3.2) */
  ramHeavyBlend: 0.7,
  /** seconds after a ram in which further contact with the same car is a slide, not another ram */
  ramCooldown: 0.25,
  /** target launch along the normal = closing speed × (1 + bounce) × player share of mass × launch */
  ramLaunch: 1.45,
  ramBounce: 0.25,
  /** T-bone spin and corner spin given to the target (rad/s, divided by sqrt(mass)) */
  ramSideSpin: 2.6,
  ramCornerSpin: 4.2,
  /** rear hit: share of the closing speed added to the target's forward speed (it gets shoved and wobbles) */
  ramRearShove: 0.55,
  /** a hit on the player turns them this much per m/s of closing speed (rad/s) — enough to feel, easy to catch */
  ramYawKick: 0.045,
  ramYawKickMax: 1.4,
  /** side-by-side contact slides: tiny tangential friction and a separation speed, so cars never lock together */
  rubFriction: 0.04,
  rubSeparate: 1.4,
  /** a nearby explosion nudges the player (m/s at the centre), even their own */
  blastNudge: 3.5,

  /* ---------------------------------------------------------------- surfaces */
  /** wet asphalt: a little less grip, longer braking, drifts come easier and settle slower */
  wetGrip: 0.9,
  wetBrake: 0.88,
  wetDriftEntry: 0.85,
  wetDriftSpring: 0.85,
  /** riding a curb with two wheels: a little less grip, a little drag (m/s²), a rumble (suspension kick per frame) */
  curbGrip: 0.85,
  curbDrag: 1.6,
  curbRumble: 0.6,
  /** zone rain at which the road counts as wet (physics and spray agree) */
  wetRain: 0.45,

  /* ---------------------------------------------------------------- body (visual suspension) */
  /** pitch per m/s² of longitudinal acceleration (rad) and its cap: nose dives under braking, squats under power */
  bodyPitch: 0.0065,
  bodyPitchMax: 0.085,
  /** roll per m/s² of lateral acceleration and its cap */
  bodyRoll: 0.0045,
  bodyRollMax: 0.11,
  /** springs (stiffness, damping): the body overshoots a little and settles — it breathes */
  bodySpring: 90,
  bodyDamping: 10,
  /** front wheels: lock at low speed, at top speed (visual only) */
  wheelLock: 0.5,
  wheelLockHigh: 0.2,
} as const;

export type LandGrade = 'perfect' | 'good' | 'rough' | 'bad' | 'crash';

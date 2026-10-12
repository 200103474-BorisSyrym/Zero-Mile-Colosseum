/** Centralised balance values. Units: metres, seconds, m/s. */
export const CONFIG = {
  GRAVITY: 32,
  CAR_HALF_WIDTH: 1.0,
  CAR_HALF_LENGTH: 2.2,

  PLAYER: {
    COAST_DECEL: 2.2,
    AERO_DRAG: 0.0009,
    HANDBRAKE_DECEL: 14,
    STEER_SMOOTH: 9,
    START_SPEED: 22,
    INVULN_AFTER_HIT: 0.35,
    STUCK_TIME: 3,
    WALL_DAMAGE_THRESHOLD: 11,
    WALL_DAMAGE_PER_MS: 0.42,
    WALL_RESTITUTION: 0.25,
  },

  /** Arcade grip model: cornering is limited by a lateral acceleration budget. */
  DRIVE: {
    CORNER_GRIP: 22, // m/s^2 the tyres can hold while gripping
    DRIFT_GRIP_CAP: 31, // m/s^2 while sliding: drifting turns tighter at speed
    YAW_LIMIT: 1.25, // yaw rate cap = grip * YAW_LIMIT / speed (understeer)
    TRAIL_BRAKE: 1.2, // braking while turning helps rotation
    SOFT_CAP: 57, // ~205 km/h: bonuses above this are halved
    HARD_CAP: 66, // ~238 km/h: absolute ceiling
    WALL_LIGHT: 6, // m/s into the wall: below = scrape
    WALL_HEAVY: 14, // above = crash (damage, combo break, recovery)
    RECOVER_TIME: 0.45,
    MAX_YAW_RATE: 4,
    AIR_YAW: 1.8,
    /** progressive steering: input builds up (per second) so a tap is a correction, and lets go fast */
    STEER_RAMP_UP: 5,
    STEER_RAMP_DOWN: 11,
    /** heading assist: with no steering input the nose relaxes back parallel to the road (1/s, cap rad/s) */
    ASSIST_GAIN: 3.2,
    ASSIST_MAX: 0.9,
    /** beyond this misalignment (rad) the player is doing something deliberate: no assist */
    ASSIST_WINDOW: 0.6,
  },

  DRIFT: {
    MIN_SPEED: 13,
    GRIP: 1.7,
    YAW_BOOST: 1.35,
    BIAS_YAW: 0.55,
    MOMENTUM_RATE: 7,
    PERFECT_MIN: 0.3,
    PERFECT_MAX: 0.72,
    PERFECT_MOMENTUM_BONUS: 6,
    BOOST_PER_SECOND: 0.45,
    BOOST_MAX: 1.6,
    BOOST_ACCEL: 16,
    BOOST_SPEED_BONUS: 0.06,
    SPEED_LOSS: 1.4,
    CHARGE_RATE: 34, // archetype CHARGE per second of drifting
  },

  NITRO: {
    MAX: 100,
    DRAIN: 30,
    REGEN: 5,
    ACCEL_MULT: 1.9,
    SPEED_BONUS: 0.16,
    HEAT_PER_SEC: 22,
    MIN_TO_START: 12,
  },

  HEAT: {
    MAX: 100,
    DISSIPATION: 11,
    OVERHEAT_LOCK: 3.5,
    OVERHEAT_SELF_DAMAGE: 6,
    HIGH: 70,
  },

  FUEL: {
    MAX: 100,
    CONSUMPTION: 0.5,
    EMPTY_SPEED_MULT: 0.5,
    EMPTY_ACCEL_MULT: 0.45,
    PICKUP_AMOUNT: 28,
  },

  MOMENTUM: {
    MAX: 100,
    SPEED_RATE: 1.4, // per second at top speed
    NEAR_MISS: 7,
    RAM: 6,
    KILL: 8,
    CHAIN: 10,
    JUMP: 5,
    PERFECT_LANDING: 10,
  },

  COMBO: {
    DECAY_TIME: 3.6,
    MAX: 50,
    STEP: 0.1,
  },

  RAM: {
    BASE_DAMAGE: 22,
    SPEED_REF: 18,
    MIN_IMPACT: 4,
    HIGH_SPEED: 22,
    SIDE_MULT: 1.65,
    REAR_MULT: 1.15,
    FRONT_MULT: 1.25,
    GLANCING_MULT: 0.45,
    PERFECT_IMPACT: 26,
    PLAYER_DAMAGE_BASE: 0.38,
    HITSTOP: 0.075,
  },

  NEAR_MISS: {
    MIN_SPEED: 24,
    GAP: 1.5,
    CHAIN_WINDOW: 2.2,
  },

  CHAIN: {
    TAG_TIME: 2.6,
    PROPAGATE_SPEED: 7,
  },

  WORLD: {
    SAMPLE_SPACING: 1,
    GEN_AHEAD: 720,
    /** a segment that starts closer than this is finished in one go (World.ensureAhead) */
    BUILD_URGENT: 260,
    /** built in one go when a road starts (reset): past this the fog hides 87–99% of the scene in every zone */
    BUILD_ON_RESET: 450,
    /** CPU time per frame the world may spend building the road ahead, ms */
    GEN_BUDGET_MS: 2,
    KEEP_BEHIND: 160,
    LANE_WIDTH: 3.9,
    FALL_RESPAWN_DAMAGE: 0.12,
  },

  SPAWN: {
    MAX_ENEMIES: 12,
    MAX_TRAFFIC: 16,
    AHEAD: 150,
    BEHIND: 70,
    DESPAWN_BEHIND: 140,
    DESPAWN_AHEAD: 420,
  },

  NODE_LENGTH: {
    ROAD: 1700,
    ELITE: 1500,
    RACE: 2000,
    SHORTCUT: 950,
  },

  ECONOMY: {
    KILL_CREDITS: 6,
    NODE_CREDITS: 25,
    PRICE: { COMMON: 60, RARE: 95, EPIC: 145, LEGENDARY: 210 } as Record<string, number>,
    HEAL_PRICE: 45,
    FUEL_PRICE: 20,
    REROLL_PRICE: 15,
  },
} as const;

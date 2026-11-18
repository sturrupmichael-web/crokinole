/**
 * Board geometry and every tunable physics number. Units are inches and
 * seconds. The board centre is the origin; +x is right, +y is up (toward
 * seat 2). Seat 0 sits at the bottom (angle -90°) and seats go
 * counter-clockwise: 0 bottom, 1 right, 2 top, 3 left.
 */

export const BOARD = {
  /** Playing surface radius. A disc whose centre passes beyond it falls in the ditch. */
  surfaceR: 13,
  /** Outer edge of the ditch / inner edge of the rail (render only). */
  ditchR: 14.5,
  /** Outer edge of the rail (render only). */
  railR: 15.5,
  /** The 20 hole. */
  holeR: 0.69,
  /** Ring radii. */
  r15: 4,
  r10: 8,
  /** Shooting line (also the edge of the 5 zone). */
  r5: 12,
  pegR: 0.19,
  pegCount: 8,
  discR: 0.625,
} as const;

export const PHYSICS = {
  /** Fixed timestep. Never scale this with frame rate. */
  dt: 1 / 240,
  /** Max distance a disc moves in one substep, as a fraction of the disc radius. */
  maxStepFrac: 0.25,
  /** Constant friction deceleration, in/s². */
  friction: 36,
  /** A full-power shot on an empty board travels this far (1.5 board widths). */
  fullPowerDistance: 1.5 * 2 * BOARD.surfaceR,
  /** Shots below this power are raised to it, so every shot leaves the line. */
  minPower: 0.02,
  discRestitution: 0.9,
  pegRestitution: 0.7,
  /** A disc drops in the 20 hole when its centre comes this close to dead centre… */
  holeCaptureR: 0.3,
  /** …and it is moving slower than this (faster discs skip across the hole). */
  holeMaxSpeed: 14,
  /** Below this speed a disc stops. */
  stopSpeed: 0.05,
  /** Safety cap on one shot's simulated time. */
  maxShotSeconds: 30,
  /** How far either side of the seat direction the shot may be aimed (radians). */
  maxAimAngle: (85 * Math.PI) / 180,
} as const;

/** Launch speed (in/s) that travels `fullPowerDistance` under constant friction: v² = 2ad. */
export const FULL_POWER_SPEED = Math.sqrt(2 * PHYSICS.friction * PHYSICS.fullPowerDistance);

export type Seat = 0 | 1 | 2 | 3;

/** Direction from the centre toward a seat, in radians. */
export function seatAngle(seat: Seat): number {
  return -Math.PI / 2 + (seat * Math.PI) / 2;
}

/** Peg centres: 8 on the 15 circle, 22.5° off the quadrant lines (which run at 45° + k·90°). */
export const PEGS: ReadonlyArray<{ x: number; y: number }> = Array.from({ length: BOARD.pegCount }, (_, i) => {
  const a = Math.PI / 8 + (i * Math.PI) / 4;
  return { x: BOARD.r15 * Math.cos(a), y: BOARD.r15 * Math.sin(a) };
});

/**
 * 5-hole board: four extra −10 holes, centred in the 10 zone on the quadrant
 * lines (45° + k·90°), between the pegs. Same size as the 20 hole.
 */
export const PENALTY_HOLE_R = 6;
export const PENALTY_POINTS = 10;
export const PENALTY_HOLES: ReadonlyArray<{ x: number; y: number }> = Array.from({ length: 4 }, (_, i) => {
  const a = Math.PI / 4 + (i * Math.PI) / 2;
  return { x: PENALTY_HOLE_R * Math.cos(a), y: PENALTY_HOLE_R * Math.sin(a) };
});

export type BoardKind = 'classic' | 'five-hole';

/** Angular half-width of a seat's arc of the shooting line, keeping the disc inside its quadrant lines. */
export const ARC_HALF = Math.PI / 4 - BOARD.discR / BOARD.r5;

/** World position on a seat's arc for baselinePos in [0, 1] (0 = the shooter's left end, 1 = their right). */
export function arcPoint(seat: Seat, baselinePos: number): { x: number; y: number } {
  const t = clamp(baselinePos, 0, 1);
  const a = seatAngle(seat) + (t - 0.5) * 2 * ARC_HALF;
  return { x: BOARD.r5 * Math.cos(a), y: BOARD.r5 * Math.sin(a) };
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Board points for a disc whose centre is `d` from the centre. Touching a line scores the lower zone. */
export function zoneScore(d: number): 0 | 5 | 10 | 15 {
  const r = BOARD.discR;
  if (d <= BOARD.r15 - r) return 15;
  if (d <= BOARD.r10 - r) return 10;
  if (d <= BOARD.r5 - r) return 5;
  return 0;
}

/** True when a disc at distance `d` touches or is inside the 15 circle. */
export function reaches15(d: number): boolean {
  return d <= BOARD.r15 + BOARD.discR;
}

/** True when a disc at distance `d` rests on or outside the shooting line (removed after each shot). */
export function onOrBeyondShootingLine(d: number): boolean {
  return d > BOARD.r5 - BOARD.discR;
}

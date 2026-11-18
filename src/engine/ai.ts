/**
 * Computer opponent. Samples candidate shots (position × angle × power), runs
 * each through the real physics and rules, and scores the resulting board from
 * the shooter's side: own points − best opponent's points, a large penalty for
 * fouls and short shots, and a bonus for 20s. Difficulty sets how many
 * candidates it tries and how much random wobble is added to the chosen shot.
 *
 * Pure: randomness comes from the seeded RNG passed in. `chooseShotAsync`
 * yields between batches so a browser stays responsive while it thinks.
 */
import { BOARD, PHYSICS, type Seat, arcPoint, seatAngle } from './board';
import { type GameState, type Shot, currentSeat, resolveShot, tallyRound } from './rules';
import { type Rng, gaussian } from './rng';

export type Difficulty = 'easy' | 'medium' | 'hard';

export const AI_LEVELS: Record<Difficulty, { samples: number; angleNoise: number; powerNoise: number; posNoise: number }> = {
  easy: { samples: 40, angleNoise: 0.05, powerNoise: 0.1, posNoise: 0.03 },
  medium: { samples: 150, angleNoise: 0.03, powerNoise: 0.05, posNoise: 0.015 },
  hard: { samples: 400, angleNoise: 0.016, powerNoise: 0.028, posNoise: 0.006 },
};

const FOUL_PENALTY = 40;
const SHORT_PENALTY = 10;
const TWENTY_BONUS = 8;

/** How good the board after `shot` is for the shooter's team. Higher is better. */
export function evaluateShot(state: GameState, shot: Shot): number {
  const team = state.teamOfSeat[shot.seat];
  const { state: after, outcome } = resolveShot(state, shot);
  const totals = tallyRound(after).tallies.map((t) => t.total);
  const own = totals[team];
  const opp = Math.max(...totals.filter((_, t) => t !== team));
  let score = own - opp;
  if (outcome.foul) score -= FOUL_PENALTY;
  if (outcome.short) score -= SHORT_PENALTY;
  score += TWENTY_BONUS * outcome.twenties.filter((t) => t.team === team).length;
  // Slight preference for discs that end near the centre (better for later shots).
  const mine = after.board.filter((d) => d.team === team);
  for (const d of mine) score += 0.02 * (BOARD.r5 - Math.hypot(d.x, d.y));
  return score;
}

/** Candidate shots: some aimed at the 20 hole and at each opponent disc, the rest random. */
export function candidateShots(state: GameState, count: number, rng: Rng): Shot[] {
  const seat = currentSeat(state);
  const team = state.teamOfSeat[seat];
  const targets: Array<{ x: number; y: number; hit: boolean }> = [{ x: 0, y: 0, hit: false }];
  for (const d of state.board) if (d.team !== team) targets.push({ x: d.x, y: d.y, hit: true });
  const out: Shot[] = [];
  for (let i = 0; i < count; i++) {
    const baselinePos = rng();
    if (i % 3 === 2) {
      out.push({ seat, baselinePos, angle: (rng() * 2 - 1) * 0.9, power: 0.15 + rng() * 0.85 });
      continue;
    }
    const t = targets[Math.floor(rng() * targets.length)];
    const from = arcPoint(seat, baselinePos);
    const dist = Math.hypot(t.x - from.x, t.y - from.y);
    const angle = aimAngle(seat, from, t) + gaussian(rng) * 0.02;
    // To stop on a spot, power = distance / full distance. To knock a disc out, hit harder.
    const stopPower = dist / PHYSICS.fullPowerDistance;
    const power = t.hit ? stopPower * (1 + rng() * 1.6) : stopPower * (0.97 + rng() * 0.06);
    out.push({ seat, baselinePos, angle, power: Math.min(1, power) });
  }
  return out;
}

/** The shot angle (relative to straight-in) that points from `from` toward `to`. */
export function aimAngle(seat: Seat, from: { x: number; y: number }, to: { x: number; y: number }): number {
  const dir = Math.atan2(to.y - from.y, to.x - from.x);
  const a = seatAngle(seat) + Math.PI - dir;
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function wobble(shot: Shot, level: Difficulty, rng: Rng): Shot {
  const n = AI_LEVELS[level];
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  return {
    seat: shot.seat,
    baselinePos: clamp01(shot.baselinePos + gaussian(rng) * n.posNoise),
    angle: shot.angle + gaussian(rng) * n.angleNoise,
    power: clamp01(shot.power * (1 + gaussian(rng) * n.powerNoise)),
  };
}

/**
 * The best-looking candidates are re-tested with this level's wobble a few
 * times, and the one that holds up best on average wins. That steers the AI
 * away from shots that only work if they're perfect (a thin cut that fouls
 * when slightly off), the way a careful player would.
 */
const FINALISTS = 6;
const RETRIES = 4;

function pickRobust(state: GameState, scored: Array<{ shot: Shot; score: number }>, level: Difficulty, rng: Rng): Shot {
  scored.sort((a, b) => b.score - a.score);
  let best = scored[0].shot;
  let bestAvg = -Infinity;
  for (const c of scored.slice(0, FINALISTS)) {
    let sum = c.score;
    for (let i = 0; i < RETRIES; i++) sum += evaluateShot(state, wobble(c.shot, level, rng));
    const avg = sum / (RETRIES + 1);
    if (avg > bestAvg) (bestAvg = avg), (best = c.shot);
  }
  return wobble(best, level, rng);
}

export function chooseShot(state: GameState, level: Difficulty, rng: Rng): Shot {
  const cands = candidateShots(state, AI_LEVELS[level].samples, rng);
  return pickRobust(state, cands.map((shot) => ({ shot, score: evaluateShot(state, shot) })), level, rng);
}

export async function chooseShotAsync(state: GameState, level: Difficulty, rng: Rng, batch = 20): Promise<Shot> {
  const cands = candidateShots(state, AI_LEVELS[level].samples, rng);
  const scored: Array<{ shot: Shot; score: number }> = [];
  for (let i = 0; i < cands.length; i++) {
    scored.push({ shot: cands[i], score: evaluateShot(state, cands[i]) });
    if (i % batch === batch - 1) await new Promise((r) => setTimeout(r, 0));
  }
  return pickRobust(state, scored, level, rng);
}

/**
 * Per-shot highlights, per-seat stats and end-of-game awards. Pure.
 *
 * Every shot is scored for "shot of the round". Because the physics is
 * deterministic, the round's best shot is kept as (state before, shot) and can
 * be replayed exactly by running beginShot again.
 */
import type { Seat } from './board';
import type { BoardDisc, GameState, Shot, ShotOutcome } from './rules';

export interface SeatStats {
  shots: number;
  twenties: number;
  /** Opponent discs knocked off the board (into the ditch or past the shooting line). */
  takeouts: number;
  fouls: number;
  /** Most opponent discs removed in a single shot. */
  bestTakeout: number;
  /** Most peg hits in a single shot. */
  bestPegs: number;
  /** Opponent discs knocked into a −10 hole (5-hole board). */
  sunk?: number;
  /** Own-side discs that ended in a −10 hole on this seat's shots. */
  selfSunk?: number;
}

export interface ShotSummary {
  twenties: number;
  /** Opponent discs sent into a −10 hole. */
  sunk: number;
  /** Own-side discs that went into a −10 hole. */
  selfSunk: number;
  takeouts: number;
  pegHits: number;
  clacks: number;
  /** How replay-worthy the shot was (0 = not at all). */
  score: number;
  /** Short description: "a 20", "a double takeout", "a takeout and a 20"… */
  label: string;
}

export interface Highlight {
  seat: Seat;
  shot: Shot;
  score: number;
  label: string;
  /** Enough of the state before the shot to replay it. */
  before: Pick<GameState, 'board' | 'discsLeft' | 'twenties' | 'turn' | 'nextId'>;
}

/** Shots scoring at least this get the slow-motion replay. */
export const REPLAY_THRESHOLD = 12;

export function emptyStats(): SeatStats[] {
  return Array.from({ length: 4 }, () => ({ shots: 0, twenties: 0, takeouts: 0, fouls: 0, bestTakeout: 0, bestPegs: 0, sunk: 0, selfSunk: 0 }));
}

const COUNT = ['', 'single', 'double', 'triple', 'quadruple', 'quintuple'];

export function summarizeShot(board: BoardDisc[], outcome: ShotOutcome): ShotSummary {
  const teamOf = new Map(board.map((d) => [d.id, d.team]));
  const takeouts = outcome.removed.filter(
    (r) => (r.reason === 'ditch' || r.reason === 'shooting-line') && teamOf.has(r.id) && teamOf.get(r.id) !== outcome.team,
  ).length;
  const twenties = outcome.twenties.filter((t) => t.team === outcome.team).length;
  const pens = outcome.penalties ?? [];
  const sunk = pens.filter((p) => p.team !== outcome.team).length;
  const selfSunk = pens.length - sunk;
  const pegHits = outcome.events.filter((e) => e.kind === 'peg').length;
  const clacks = outcome.events.filter((e) => e.kind === 'disc').length;
  let score = 0;
  if (!outcome.foul) {
    score = 12 * twenties + 7 * takeouts + (takeouts >= 2 ? 10 * (takeouts - 1) : 0) + Math.min(pegHits, 4) + Math.min(clacks, 6) * 0.5;
    // A 20 that also took discs out is the dream shot.
    if (twenties && takeouts) score += 8;
    score += 12 * sunk;
    if (selfSunk) score = Math.max(0, score - 6 * selfSunk);
  }
  const parts: string[] = [];
  if (takeouts === 1) parts.push('a takeout');
  else if (takeouts > 1) parts.push(`a ${COUNT[takeouts] ?? `${takeouts}×`} takeout`);
  if (twenties === 1) parts.push('a 20');
  else if (twenties > 1) parts.push(`${twenties} 20s`);
  if (sunk === 1) parts.push('a −10 for the other side');
  else if (sunk > 1) parts.push(`${sunk}× −10 for the other side`);
  const label = parts.length ? parts.join(' and ') : pegHits >= 3 ? 'a pinball run' : 'a nice shot';
  return { twenties, sunk, selfSunk, takeouts, pegHits, clacks, score, label };
}

/** Fold one shot into the seat stats and the round highlight. */
export function recordShot(
  before: GameState,
  outcome: ShotOutcome,
): { stats: SeatStats[]; highlight: Highlight | null; summary: ShotSummary } {
  const summary = summarizeShot(before.board, outcome);
  const stats = (before.stats ?? emptyStats()).map((s) => ({ ...s }));
  const s = stats[outcome.seat];
  s.shots++;
  s.twenties += summary.twenties;
  s.takeouts += summary.takeouts;
  if (outcome.foul) s.fouls++;
  s.bestTakeout = Math.max(s.bestTakeout, summary.takeouts);
  s.bestPegs = Math.max(s.bestPegs, summary.pegHits);
  s.sunk = (s.sunk ?? 0) + summary.sunk;
  s.selfSunk = (s.selfSunk ?? 0) + summary.selfSunk;
  let highlight = before.highlight ?? null;
  if (summary.score >= REPLAY_THRESHOLD && summary.score > (highlight?.score ?? 0)) {
    highlight = {
      seat: outcome.seat,
      shot: outcome.shot,
      score: summary.score,
      label: summary.label,
      before: { board: before.board, discsLeft: before.discsLeft, twenties: before.twenties, turn: before.turn, nextId: before.nextId },
    };
  }
  return { stats, highlight, summary };
}

/** The state to hand beginShot to replay a highlight exactly. */
export function replayState(state: GameState, h: Highlight): GameState {
  return { ...state, ...h.before, phase: 'shooting', highlight: null };
}

export interface Award {
  title: string;
  blurb: string;
  seats: Seat[];
}

/** End-of-game awards. Each goes to the seat(s) with the highest value, if any did it at all. */
export function gameAwards(state: GameState): Award[] {
  const stats = state.stats ?? emptyStats();
  const pick = (title: string, value: (s: SeatStats) => number, blurb: (v: number) => string, min = 1): Award | null => {
    let best = 0;
    for (const seat of state.seats) best = Math.max(best, value(stats[seat]));
    if (best < min) return null;
    return { title, blurb: blurb(best), seats: state.seats.filter((seat) => value(stats[seat]) === best) };
  };
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return [
    pick('Sharpshooter', (s) => s.twenties, (v) => `Most 20s: ${v}`),
    pick('Demolition crew', (s) => s.takeouts, (v) => `Most takeouts: ${v}`),
    pick('Biggest takeout', (s) => s.bestTakeout, (v) => `${plural(v, 'disc', 'discs')} cleared in one shot`, 2),
    pick('Pinball wizard', (s) => s.bestPegs, (v) => `${v} peg hits in one shot`, 3),
    pick('Foul magnet', (s) => s.fouls, (v) => plural(v, 'foul', 'fouls'), 2),
    pick('Sinker', (s) => s.sunk ?? 0, (v) => `${plural(v, 'opponent disc', 'opponent discs')} sent into a −10 hole`),
    pick('Butterfingers', (s) => s.selfSunk ?? 0, (v) => `${plural(v, 'own disc', 'own discs')} lost to a −10 hole`),
  ].filter((a): a is Award => a !== null);
}

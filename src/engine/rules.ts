/**
 * Crokinole rules: seating, turns, the shot requirement, fouls, 20s, removal
 * from the shooting line, round scoring and the game end. Pure functions over
 * plain JSON state (safe to broadcast and to store for host-refresh recovery):
 * nothing here mutates its input.
 *
 * A shot is resolved in three steps so the renderer can animate the exact same
 * simulation the rules score:
 *   const live = beginShot(state, shot);   // validated launch + a fresh Sim
 *   while (live.sim.isMoving()) live.sim.step();   // in real time, or runToRest()
 *   const { state: next, outcome } = finishShot(state, live);
 * `resolveShot` does all three at once (rules tests, the AI, replays).
 */
import { ARC_HALF, BOARD, type BoardKind, FULL_POWER_SPEED, PENALTY_HOLES, PENALTY_POINTS, PHYSICS, type Seat, arcPoint, clamp, onOrBeyondShootingLine, reaches15, seatAngle, zoneScore } from './board';
import { Sim, type SimDisc, type SimEvent } from './physics';
import { type Highlight, type SeatStats, emptyStats, recordShot } from './highlights';

export type PlayerCount = 2 | 3 | 4;

export interface Settings {
  players: PlayerCount;
  /** First team to reach this at the end of a round wins. */
  target: 50 | 100;
  /** 'five-hole' adds four −10 holes. Missing = classic. */
  board?: BoardKind;
}

export function isFiveHole(s: { settings: Settings }): boolean {
  return s.settings.board === 'five-hole';
}

/** What a controller sends. */
export interface Shot {
  seat: Seat;
  /** 0 = the shooter's left end of their arc, 1 = the right end. */
  baselinePos: number;
  /** Radians off straight-in (toward the far seat); positive aims to the shooter's right. */
  angle: number;
  /** 0–1. */
  power: number;
}

export interface BoardDisc {
  id: number;
  seat: Seat;
  team: number;
  x: number;
  y: number;
}

export type Requirement = 'hit-opponent' | 'reach-15';

export interface TeamTally {
  team: number;
  /** Every disc left on the board for this team, with what it scored, in the order the tally animates them. */
  discs: Array<{ id: number; seat: Seat; x: number; y: number; points: 0 | 5 | 10 | 15 }>;
  boardPoints: number;
  twenties: number;
  /** Discs that dropped in a −10 hole (5-hole board). */
  penalties: number;
  total: number;
  /** Points actually added to the game score (the difference, in 2-team games). */
  awarded: number;
}

export interface RoundResult {
  round: number;
  tallies: TeamTally[];
}

export interface GameState {
  settings: Settings;
  /** Seats in play, in turn order (counter-clockwise). */
  seats: Seat[];
  /** Team of each seat (indexed by seat number; -1 = empty seat). */
  teamOfSeat: [number, number, number, number];
  teamCount: number;
  /** Game score per team. */
  scores: number[];
  round: number;
  /** Index into `seats` of who starts the current round. */
  starter: number;
  /** Index into `seats` of who shoots next. */
  turn: number;
  /** Discs still in hand, indexed by seat number. */
  discsLeft: [number, number, number, number];
  board: BoardDisc[];
  /** 20s banked this round, per team. */
  twenties: number[];
  /** −10 holes this round, per team (5-hole board). Missing in older saves. */
  penalties?: number[];
  nextId: number;
  phase: 'shooting' | 'round-over' | 'game-over';
  lastRound: RoundResult | null;
  /** Per-seat stats for the whole game (indexed by seat number). Missing in games saved before stats existed. */
  stats?: SeatStats[];
  /** The best shot of the current round, for the replay (null until a shot qualifies). */
  highlight?: Highlight | null;
  /** Winning team once phase is 'game-over'. */
  winner: number | null;
}

export const DISCS_PER_PLAYER: Record<PlayerCount, number> = { 2: 12, 3: 8, 4: 6 };

const SEATS: Record<PlayerCount, Seat[]> = { 2: [0, 2], 3: [0, 1, 2], 4: [0, 1, 2, 3] };

export function createGame(settings: Settings): GameState {
  const seats = SEATS[settings.players];
  const teamOfSeat: [number, number, number, number] = [-1, -1, -1, -1];
  seats.forEach((s, i) => (teamOfSeat[s] = settings.players === 4 ? s % 2 : i));
  const teamCount = settings.players === 3 ? 3 : 2;
  const state: GameState = {
    settings,
    seats,
    teamOfSeat,
    teamCount,
    scores: new Array(teamCount).fill(0),
    round: 0,
    starter: 0,
    turn: 0,
    discsLeft: [0, 0, 0, 0],
    board: [],
    twenties: new Array(teamCount).fill(0),
    penalties: new Array(teamCount).fill(0),
    nextId: 1,
    phase: 'round-over',
    lastRound: null,
    stats: emptyStats(),
    highlight: null,
    winner: null,
  };
  return startRound(state, 0);
}

function startRound(prev: GameState, starter: number): GameState {
  const discsLeft: [number, number, number, number] = [0, 0, 0, 0];
  for (const s of prev.seats) discsLeft[s] = DISCS_PER_PLAYER[prev.settings.players];
  return {
    ...prev,
    round: prev.round + 1,
    starter,
    turn: starter,
    discsLeft,
    board: [],
    twenties: new Array(prev.teamCount).fill(0),
    penalties: new Array(prev.teamCount).fill(0),
    phase: 'shooting',
    highlight: null,
  };
}

/** After a round's tally has been shown, deal the next round (the starting seat rotates). */
export function nextRound(state: GameState): GameState {
  if (state.phase !== 'round-over') throw new Error('Round is not over');
  return startRound(state, (state.starter + 1) % state.seats.length);
}

export function currentSeat(state: GameState): Seat {
  return state.seats[state.turn];
}

/** What the next shot has to do. */
export function requirement(state: GameState, seat: Seat = currentSeat(state)): Requirement {
  const team = state.teamOfSeat[seat];
  return state.board.some((d) => d.team !== team) ? 'hit-opponent' : 'reach-15';
}

/** Where a shot's disc starts and how fast it goes. Slides along the arc if the spot is covered by a disc. */
export function launch(state: GameState, shot: Shot): { x: number; y: number; vx: number; vy: number } {
  const pos = freeArcPos(state.board, shot.seat, clamp(shot.baselinePos, 0, 1));
  const p = arcPoint(shot.seat, pos);
  const power = Math.max(PHYSICS.minPower, clamp(shot.power, 0, 1));
  // Speed scales with √power so that power maps linearly onto travel distance.
  const speed = FULL_POWER_SPEED * Math.sqrt(power);
  const dir = seatAngle(shot.seat) + Math.PI - clamp(shot.angle, -PHYSICS.maxAimAngle, PHYSICS.maxAimAngle);
  return { x: p.x, y: p.y, vx: speed * Math.cos(dir), vy: speed * Math.sin(dir) };
}

function freeArcPos(board: BoardDisc[], seat: Seat, want: number): number {
  const minD2 = 4 * BOARD.discR * BOARD.discR;
  const free = (t: number) => {
    const p = arcPoint(seat, t);
    return board.every((d) => (d.x - p.x) ** 2 + (d.y - p.y) ** 2 >= minD2);
  };
  if (free(want)) return want;
  const stepT = 0.01;
  for (let k = 1; k <= 100; k++) {
    for (const t of [want - k * stepT, want + k * stepT]) if (t >= 0 && t <= 1 && free(t)) return t;
  }
  return want;
}

export interface LiveShot {
  shot: Shot;
  shotId: number;
  team: number;
  requirement: Requirement;
  sim: Sim;
  /** Shooter-team discs set moving by the shot (the shot disc, and any own disc it — or they — hit). */
  chain: Set<number>;
  hitOpponent: boolean;
}

export function beginShot(state: GameState, shot: Shot): LiveShot {
  if (state.phase !== 'shooting') throw new Error('Not accepting shots');
  if (shot.seat !== currentSeat(state)) throw new Error(`Not seat ${shot.seat}'s turn`);
  if (state.discsLeft[shot.seat] <= 0) throw new Error('No discs left');
  const team = state.teamOfSeat[shot.seat];
  const shotId = state.nextId;
  const discs: SimDisc[] = state.board.map((d) => ({ id: d.id, team: d.team, x: d.x, y: d.y, vx: 0, vy: 0 }));
  discs.push({ id: shotId, team, ...launch(state, shot) });
  const live: LiveShot = {
    shot,
    shotId,
    team,
    requirement: requirement(state, shot.seat),
    sim: new Sim(discs, isFiveHole(state) ? PENALTY_HOLES : []),
    chain: new Set([shotId]),
    hitOpponent: false,
  };
  live.sim.onContact = (a, b) => {
    const aIn = live.chain.has(a.id);
    const bIn = live.chain.has(b.id);
    if (aIn === bIn) return;
    const other = aIn ? b : a;
    if (other.team === team) live.chain.add(other.id);
    else live.hitOpponent = true;
  };
  return live;
}

export type RemovalReason = 'ditch' | 'foul' | 'short' | 'shooting-line';

export interface ShotOutcome {
  shot: Shot;
  shotId: number;
  seat: Seat;
  team: number;
  requirement: Requirement;
  foul: boolean;
  /** The shot disc failed to reach the 15 on an open board. */
  short: boolean;
  /** 20s banked by this shot (disc id + team). Excludes 20s voided by a foul. */
  twenties: Array<{ id: number; team: number }>;
  /** 20s made on a foul, which don't count. */
  voidedTwenties: number[];
  /** Discs that dropped in a −10 hole (5-hole board): −10 for the disc's owner, foul or not. */
  penalties: Array<{ id: number; team: number }>;
  removed: Array<{ id: number; reason: RemovalReason }>;
  /** Physics events for sound and callouts. */
  events: SimEvent[];
  /** Simulated duration in seconds. */
  duration: number;
}

export function finishShot(state: GameState, live: LiveShot): { state: GameState; outcome: ShotOutcome } {
  const { sim, team, shotId } = live;
  if (sim.isMoving()) sim.runToRest();
  const seatOf = new Map<number, Seat>(state.board.map((d) => [d.id, d.seat]));
  seatOf.set(shotId, live.shot.seat);

  const removed: ShotOutcome['removed'] = sim.ditched.map((d) => ({ id: d.id, reason: 'ditch' as const }));
  let survivors = sim.discs;
  const foul = live.requirement === 'hit-opponent' && !live.hitOpponent;
  let short = false;
  const twenties: ShotOutcome['twenties'] = [];
  const voidedTwenties: number[] = [];

  for (const d of sim.twenties) {
    if (foul && live.chain.has(d.id)) voidedTwenties.push(d.id);
    else twenties.push({ id: d.id, team: d.team });
  }

  if (foul) {
    for (const d of survivors) if (live.chain.has(d.id)) removed.push({ id: d.id, reason: 'foul' });
    survivors = survivors.filter((d) => !live.chain.has(d.id));
  } else if (live.requirement === 'reach-15') {
    const shotDisc = survivors.find((d) => d.id === shotId);
    if (shotDisc && !reaches15(Math.hypot(shotDisc.x, shotDisc.y))) {
      short = true;
      removed.push({ id: shotId, reason: 'short' });
      survivors = survivors.filter((d) => d.id !== shotId);
    }
  }

  const board: BoardDisc[] = [];
  for (const d of survivors) {
    if (onOrBeyondShootingLine(Math.hypot(d.x, d.y))) {
      removed.push({ id: d.id, reason: 'shooting-line' });
      continue;
    }
    board.push({ id: d.id, seat: seatOf.get(d.id)!, team: d.team, x: d.x, y: d.y });
  }

  const newTwenties = state.twenties.slice();
  for (const t of twenties) newTwenties[t.team]++;
  const penalties = sim.penalties.map((d) => ({ id: d.id, team: d.team }));
  const newPenalties = (state.penalties ?? new Array(state.teamCount).fill(0)).slice();
  for (const p of penalties) newPenalties[p.team]++;
  const discsLeft = state.discsLeft.slice() as GameState['discsLeft'];
  discsLeft[live.shot.seat]--;

  const outcome: ShotOutcome = {
    shot: live.shot,
    shotId,
    seat: live.shot.seat,
    team,
    requirement: live.requirement,
    foul,
    short,
    twenties,
    voidedTwenties,
    penalties,
    removed,
    events: sim.events,
    duration: sim.time,
  };
  const { stats, highlight } = recordShot(state, outcome);

  let next: GameState = {
    ...state,
    stats,
    highlight,
    board,
    twenties: newTwenties,
    penalties: newPenalties,
    discsLeft,
    nextId: state.nextId + 1,
    turn: (state.turn + 1) % state.seats.length,
  };
  if (state.seats.every((s) => discsLeft[s] === 0)) next = endRound(next);

  return { state: next, outcome };
}

/** Validate, simulate to rest and apply the rules in one go. */
export function resolveShot(state: GameState, shot: Shot): { state: GameState; outcome: ShotOutcome } {
  const live = beginShot(state, shot);
  live.sim.runToRest();
  return finishShot(state, live);
}

/** Score the board as it stands (also used by the AI to evaluate candidate shots). */
export function tallyRound(state: Pick<GameState, 'board' | 'twenties' | 'penalties' | 'teamCount' | 'round' | 'seats'>): RoundResult {
  const tallies: TeamTally[] = [];
  for (let team = 0; team < state.teamCount; team++) {
    const discs = state.board
      .filter((d) => d.team === team)
      .map((d) => ({ id: d.id, seat: d.seat, x: d.x, y: d.y, points: zoneScore(Math.hypot(d.x, d.y)) }))
      // Animate from the outside in: 5s, then 10s, then 15s.
      .sort((a, b) => a.points - b.points || a.id - b.id);
    const boardPoints = discs.reduce((s, d) => s + d.points, 0);
    const twenties = state.twenties[team];
    const penalties = state.penalties?.[team] ?? 0;
    tallies.push({ team, discs, boardPoints, twenties, penalties, total: boardPoints + 20 * twenties - PENALTY_POINTS * penalties, awarded: 0 });
  }
  if (state.teamCount === 2) {
    const [a, b] = tallies;
    if (a.total > b.total) a.awarded = a.total - b.total;
    else b.awarded = b.total - a.total;
  } else {
    for (const t of tallies) t.awarded = t.total;
  }
  return { round: state.round, tallies };
}

function endRound(state: GameState): GameState {
  const result = tallyRound(state);
  const scores = state.scores.map((s, team) => s + result.tallies[team].awarded);
  const best = Math.max(...scores);
  const leaders = scores.flatMap((s, team) => (s === best ? [team] : []));
  const over = best >= state.settings.target && leaders.length === 1;
  return {
    ...state,
    scores,
    lastRound: result,
    phase: over ? 'game-over' : 'round-over',
    winner: over ? leaders[0] : null,
  };
}

/** Angular half-width of each seat's arc, re-exported for controllers. */
export { ARC_HALF };

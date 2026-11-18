/**
 * The game checked against the standard rules: NCA Official Rules of Crokinole
 * (rule numbers in the test names) and the World Crokinole Championship rules.
 * Every shot here is played through the real physics, then scored by the rules.
 */
import { describe, expect, it } from 'vitest';
import { BOARD, PHYSICS, type Seat, seatAngle, zoneScore } from '../src/engine/board';
import { type BoardDisc, type GameState, createGame, currentSeat, nextRound, requirement, resolveShot, tallyRound } from '../src/engine/rules';

const powerFor = (d: number) => d / PHYSICS.fullPowerDistance;
const R = BOARD.discR;
let nextId = 5000;
function place(state: GameState, discs: Array<{ seat: Seat; x: number; y: number }>): GameState {
  const board: BoardDisc[] = discs.map((d) => ({ id: nextId++, seat: d.seat, team: state.teamOfSeat[d.seat], x: d.x, y: d.y }));
  return { ...state, board };
}
/** Travel a struck disc gets from a straight hit (restitution 0.9 hands on 95% of the speed). */
const hitPower = (toContact: number, struckTravel: number) => powerFor(toContact + struckTravel / 0.95 ** 2);

describe('NCA 2a / 5b: turn order and who starts', () => {
  it('play goes clockwise: bottom, then the left seat, then the top, then the right', () => {
    const g = createGame({ players: 4, target: 100 });
    expect(g.seats).toEqual([0, 3, 2, 1]);
    // Seat 3 is on seat 0's left (−x when seat 0 sits at the bottom facing up).
    expect(Math.cos(seatAngle(3))).toBeLessThan(-0.99);
    let s = g;
    const order: Seat[] = [];
    for (let i = 0; i < 4; i++) {
      order.push(currentSeat(s));
      s = resolveShot(s, { seat: currentSeat(s), baselinePos: 0.5, angle: 0, power: 0.05 }).state;
    }
    expect(order).toEqual([0, 3, 2, 1]);
  });

  it('singles: the first shot alternates every round', () => {
    let g = createGame({ players: 2, target: 100 });
    const starters: Seat[] = [];
    for (let round = 0; round < 3; round++) {
      starters.push(currentSeat(g));
      g = { ...g, phase: 'round-over' };
      g = nextRound(g);
    }
    expect(starters).toEqual([0, 2, 0]);
  });

  it('doubles: the first shot moves one seat clockwise each round', () => {
    let g = createGame({ players: 4, target: 100 });
    const starters: Seat[] = [];
    for (let round = 0; round < 4; round++) {
      starters.push(currentSeat(g));
      g = nextRound({ ...g, phase: 'round-over' });
    }
    expect(starters).toEqual([0, 3, 2, 1]);
  });

  it('doubles: partners sit opposite and share a colour (5a)', () => {
    const g = createGame({ players: 4, target: 100 });
    expect(g.teamOfSeat[0]).toBe(g.teamOfSeat[2]);
    expect(g.teamOfSeat[1]).toBe(g.teamOfSeat[3]);
    expect(g.teamOfSeat[0]).not.toBe(g.teamOfSeat[1]);
    expect(g.discsLeft).toEqual([6, 6, 6, 6]);
  });
});

describe('NCA 3a.i / 3b: with an opponent on the board you must hit one', () => {
  it('a direct hit is a valid shot', () => {
    const g = place(createGame({ players: 2, target: 100 }), [{ seat: 2, x: 0, y: -6 }]);
    const { outcome } = resolveShot(g, { seat: 0, baselinePos: 0.5, angle: 0, power: hitPower(12 - 6 - 2 * R, 2) });
    expect(outcome.foul).toBe(false);
  });

  it('pushing your own disc into an opponent is a valid shot', () => {
    const g = place(createGame({ players: 2, target: 100 }), [
      { seat: 0, x: 0, y: -8 },
      { seat: 2, x: 0, y: -5 },
    ]);
    const { outcome } = resolveShot(g, { seat: 0, baselinePos: 0.5, angle: 0, power: 0.45 });
    expect(outcome.foul).toBe(false);
  });

  it('a miss removes the shooting disc and every disc it struck, and none of them score', () => {
    let g = place(createGame({ players: 2, target: 100 }), [
      { seat: 0, x: 0, y: -8 }, // own disc in the shot's path
      { seat: 2, x: 9, y: 0 }, // opponent well off the line
    ]);
    const own = g.board[0].id;
    const opp = g.board[1].id;
    const { state, outcome } = resolveShot(g, { seat: 0, baselinePos: 0.5, angle: 0, power: hitPower(12 - 8 - 2 * R, 2.5) });
    expect(outcome.foul).toBe(true);
    expect(outcome.removed.map((r) => r.id).sort()).toEqual([own, outcome.shotId].sort());
    expect(state.board.map((d) => d.id)).toEqual([opp]);
    g = state;
    expect(tallyRound(g).tallies[0].total).toBe(0);
  });

  it('a 20 sunk on a missed shot does not count (3b)', () => {
    const g = place(createGame({ players: 2, target: 100 }), [{ seat: 2, x: 9, y: 0 }]);
    const { state, outcome } = resolveShot(g, { seat: 0, baselinePos: 0.5, angle: 0, power: powerFor(12) });
    expect(outcome.foul).toBe(true);
    expect(outcome.voidedTwenties).toEqual([outcome.shotId]);
    expect(state.twenties).toEqual([0, 0]);
  });

  it("in doubles your partner's discs are yours: hitting only them is a miss", () => {
    const g = place(createGame({ players: 4, target: 100 }), [
      { seat: 2, x: 0, y: -7 },
      { seat: 1, x: 9, y: 0 },
    ]);
    const partner = g.board[0].id;
    const { outcome } = resolveShot(g, { seat: 0, baselinePos: 0.5, angle: 0, power: hitPower(12 - 7 - 2 * R, 2) });
    expect(outcome.foul).toBe(true);
    expect(outcome.removed.map((r) => r.id)).toContain(partner);
  });
});

describe('NCA 3a.ii / 3b: with no opponent on the board you must play to the 15 ("no hiding")', () => {
  it('needs the 15 when only your own discs are on the board', () => {
    const g = place(createGame({ players: 2, target: 100 }), [{ seat: 0, x: 0, y: -8 }]);
    expect(requirement(g)).toBe('reach-15');
  });

  it('touching the 15 line is enough', () => {
    const g = createGame({ players: 2, target: 100 });
    // Stop with the disc's edge just over the 15 line.
    const { state, outcome } = resolveShot(g, { seat: 0, baselinePos: 0.5, angle: 0, power: powerFor(12 - BOARD.r15 - R + 0.1) });
    expect(outcome.short).toBe(false);
    expect(state.board).toHaveLength(1);
  });

  it('a 20 counts as inside the 15', () => {
    const { state, outcome } = resolveShot(createGame({ players: 2, target: 100 }), { seat: 0, baselinePos: 0.5, angle: 0, power: powerFor(12) });
    expect(outcome.short).toBe(false);
    expect(state.twenties[0]).toBe(1);
  });

  it('pushing your own disc into the 15 is valid even if the shooting disc stops outside it', () => {
    const g = place(createGame({ players: 2, target: 100 }), [{ seat: 0, x: 0, y: -6.2 }]);
    const own = g.board[0].id;
    const { state, outcome } = resolveShot(g, { seat: 0, baselinePos: 0.5, angle: 0, power: hitPower(12 - 6.2 - 2 * R, 2.6) });
    const shot = state.board.find((d) => d.id === outcome.shotId)!;
    const pushed = state.board.find((d) => d.id === own)!;
    expect(Math.hypot(shot.x, shot.y)).toBeGreaterThan(BOARD.r15 + R);
    expect(Math.hypot(pushed.x, pushed.y)).toBeLessThanOrEqual(BOARD.r15 + R);
    expect(outcome.short).toBe(false);
    expect(outcome.removed).toEqual([]);
  });

  it('when nothing reaches the 15, the shooting disc and the discs it struck all come off', () => {
    const g = place(createGame({ players: 2, target: 100 }), [
      { seat: 0, x: 0, y: -9 },
      { seat: 0, x: 8, y: 3 }, // untouched, stays
    ]);
    const struck = g.board[0].id;
    const untouched = g.board[1].id;
    const { state, outcome } = resolveShot(g, { seat: 0, baselinePos: 0.5, angle: 0, power: hitPower(12 - 9 - 2 * R, 1) });
    expect(outcome.short).toBe(true);
    expect(outcome.removed.map((r) => r.id).sort()).toEqual([struck, outcome.shotId].sort());
    expect(state.board.map((d) => d.id)).toEqual([untouched]);
  });
});

describe('NCA 6 / 8e: scoring and the outer line', () => {
  it('a disc scores the lower region of any line it touches (6b, 6d)', () => {
    expect(zoneScore(BOARD.r15 - R)).toBe(15);
    expect(zoneScore(BOARD.r15 - R + 0.001)).toBe(10);
    expect(zoneScore(BOARD.r10 - R + 0.001)).toBe(5);
  });

  it('a disc that stops touching the outer (shooting) line is out of play (8e)', () => {
    const { state, outcome } = resolveShot(createGame({ players: 2, target: 100 }), { seat: 0, baselinePos: 0.5, angle: 0, power: powerFor(0.5) });
    expect(state.board).toHaveLength(0);
    expect(outcome.removed.map((r) => r.reason)).toContain('short');
  });

  it("an opponent's disc knocked into the 20 scores 20 for its owner", () => {
    const g = place(createGame({ players: 2, target: 100 }), [{ seat: 2, x: 0, y: -1.6 }]);
    const { state, outcome } = resolveShot(g, { seat: 0, baselinePos: 0.5, angle: 0, power: hitPower(12 - 1.6 - 2 * R, 1.6) });
    expect(outcome.foul).toBe(false);
    expect(outcome.twenties.map((t) => t.team)).toEqual([1]);
    expect(state.twenties).toEqual([0, 1]);
  });

  it('20s are added to the round total at 20 points each', () => {
    const g = { ...place(createGame({ players: 2, target: 100 }), [{ seat: 0, x: 0, y: 2 }]), twenties: [2, 0] };
    expect(tallyRound(g).tallies[0].total).toBe(15 + 40);
  });
});

describe('NCA 2 / 4a: tournament format', () => {
  const tour = (players: 2 | 3 | 4 = 2) => createGame({ players, target: 100, format: 'tournament' });
  /** End the current round with the given board (two-team games: seat 0 vs seat 2). */
  const finish = (g: GameState, discs: Array<{ seat: Seat; x: number; y: number }>): GameState => {
    const s = place(g, discs);
    // Last disc of the round: a weak shot that comes off, then the round is scored.
    const last = { ...s, discsLeft: [0, 0, 0, 0] as GameState['discsLeft'] };
    last.discsLeft[currentSeat(s)] = 1;
    return resolveShot(last, { seat: currentSeat(s), baselinePos: 0.5, angle: 0, power: 0.01 }).state;
  };

  it('singles players get 8 discs (4a); doubles 6 each (5a)', () => {
    expect(tour(2).discsLeft).toEqual([8, 0, 8, 0]);
    expect(tour(4).discsLeft).toEqual([6, 6, 6, 6]);
    expect(createGame({ players: 2, target: 100, format: 'casual' }).discsLeft).toEqual([12, 0, 12, 0]);
  });

  it('a round win scores 2 game points whatever the margin (2a.iv)', () => {
    const g = finish(tour(), [
      { seat: 0, x: 0, y: 2 },
      { seat: 0, x: 0.5, y: -2 },
      { seat: 2, x: -10, y: 0 },
    ]);
    expect(g.lastRound!.tallies.map((t) => t.total)).toEqual([30, 5]);
    expect(g.scores).toEqual([2, 0]);
    expect(g.phase).toBe('round-over');
  });

  it('a tied round scores 1 each, including an empty board', () => {
    const g = finish(tour(), []);
    expect(g.scores).toEqual([1, 1]);
  });

  it('a game is 4 rounds; the most game points wins (2b)', () => {
    let g = tour();
    const win0 = [{ seat: 0 as Seat, x: 0, y: 2 }];
    const win2 = [{ seat: 2 as Seat, x: 0, y: 2 }];
    for (const board of [win0, win2, win0, []]) {
      expect(g.phase).toBe('shooting');
      g = finish(g, board);
      if (g.phase === 'round-over') g = nextRound(g);
    }
    expect(g.scores).toEqual([5, 3]);
    expect(g.phase).toBe('game-over');
    expect(g.winner).toBe(0);
    expect(g.round).toBe(4);
  });

  it('level after 4 rounds: extra rounds until someone leads', () => {
    let g = tour();
    for (let i = 0; i < 4; i++) {
      g = finish(g, []);
      expect(g.phase).toBe('round-over');
      g = nextRound(g);
    }
    expect(g.scores).toEqual([4, 4]);
    g = finish(g, [{ seat: 2, x: 0, y: 2 }]);
    expect(g.phase).toBe('game-over');
    expect(g.winner).toBe(1);
    expect(g.round).toBe(5);
  });

  it('3 players: the round winner gets 2, players tied for the top get 1 each', () => {
    const g = finish(tour(3), [
      { seat: 0, x: 0, y: 2 },
      { seat: 2, x: 0.3, y: -2.2 },
      { seat: 1, x: -10, y: 0 },
    ]);
    expect(g.lastRound!.tallies.map((t) => t.total)).toEqual([15, 15, 5]);
    expect(g.scores).toEqual([1, 1, 0]);
  });
});

import { describe, expect, it } from 'vitest';
import { ARC_HALF, BOARD, FULL_POWER_SPEED, PEGS, PHYSICS, arcPoint, seatAngle, zoneScore, type Seat } from '../src/engine/board';
import { Sim } from '../src/engine/physics';
import {
  type BoardDisc,
  type GameState,
  type Shot,
  createGame,
  launch,
  nextRound,
  requirement,
  resolveShot,
  tallyRound,
} from '../src/engine/rules';

const FULL = PHYSICS.fullPowerDistance;
/** Power that makes a disc travel `d` inches on a clear path. */
const powerFor = (d: number) => d / FULL;
const straight = (seat: Seat, power: number): Shot => ({ seat, baselinePos: 0.5, angle: 0, power });

let nextId = 1000;
function place(state: GameState, discs: Array<{ seat: Seat; x: number; y: number }>): GameState {
  const board: BoardDisc[] = discs.map((d) => ({ id: nextId++, seat: d.seat, team: state.teamOfSeat[d.seat], x: d.x, y: d.y }));
  return { ...state, board };
}

const twoPlayer = () => createGame({ players: 2, target: 100 });

describe('board geometry', () => {
  it('puts 8 pegs on the 15 circle, between the quadrant lines', () => {
    expect(PEGS).toHaveLength(8);
    for (const p of PEGS) {
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(BOARD.r15, 9);
      // Quadrant lines run at 45° + k·90°; pegs sit 22.5° off them.
      const deg = ((Math.atan2(p.y, p.x) * 180) / Math.PI + 360) % 45;
      expect(deg).toBeCloseTo(22.5, 9);
    }
  });

  it('keeps each seat arc on the shooting line and inside its quadrant', () => {
    for (const seat of [0, 1, 2, 3] as Seat[]) {
      for (const t of [0, 0.5, 1]) {
        const p = arcPoint(seat, t);
        expect(Math.hypot(p.x, p.y)).toBeCloseTo(BOARD.r5, 9);
        let off = Math.atan2(p.y, p.x) - seatAngle(seat);
        off = Math.atan2(Math.sin(off), Math.cos(off));
        expect(Math.abs(off)).toBeLessThanOrEqual(ARC_HALF + 1e-9);
      }
    }
    // baselinePos 0 is the shooter's left: for seat 0 (bottom, facing up) that's -x.
    expect(arcPoint(0, 0).x).toBeLessThan(0);
    expect(arcPoint(0, 1).x).toBeGreaterThan(0);
  });

  it('scores the zone a disc sits in, and the lower zone when it touches a line', () => {
    const r = BOARD.discR;
    expect(zoneScore(0.8)).toBe(15);
    expect(zoneScore(BOARD.r15 - r)).toBe(15);
    expect(zoneScore(BOARD.r15 - r + 0.01)).toBe(10);
    expect(zoneScore(BOARD.r10 - r + 0.01)).toBe(5);
    expect(zoneScore(BOARD.r5 - r)).toBe(5);
    expect(zoneScore(BOARD.r5 - r + 0.01)).toBe(0);
  });
});

describe('physics', () => {
  it('a full-power shot would travel about 1.5 board widths', () => {
    expect((FULL_POWER_SPEED * FULL_POWER_SPEED) / (2 * PHYSICS.friction)).toBeCloseTo(3 * BOARD.surfaceR, 6);
  });

  it('travel distance is proportional to power, independent of the timestep sampling', () => {
    const g = twoPlayer();
    for (const d of [3, 5.5, 7.8]) {
      const sim = new Sim([{ id: 1, team: 0, ...launch(g, straight(0, powerFor(d))) }]).runToRest();
      const end = sim.discs[0];
      expect(end.x).toBeCloseTo(0, 9);
      expect(end.y - -BOARD.r5).toBeCloseTo(d, 1);
    }
  });

  it('drops a disc that stops on the hole into the 20', () => {
    const sim = new Sim([{ id: 1, team: 0, ...launch(twoPlayer(), straight(0, powerFor(12))) }]).runToRest();
    expect(sim.twenties.map((d) => d.id)).toEqual([1]);
    expect(sim.events.some((e) => e.kind === 'twenty')).toBe(true);
  });

  it('lets a fast disc skate over the hole and fall in the ditch', () => {
    const sim = new Sim([{ id: 1, team: 0, ...launch(twoPlayer(), straight(0, 1)) }]).runToRest();
    expect(sim.twenties).toHaveLength(0);
    expect(sim.ditched.map((d) => d.id)).toEqual([1]);
  });

  it('does not tunnel through a peg at full power', () => {
    const peg = PEGS[5]; // lower-left quadrant, angle 247.5°
    // Aim from seat 0's arc directly at the peg.
    const start = arcPoint(0, 0.5);
    const dir = Math.atan2(peg.y - start.y, peg.x - start.x);
    const sim = new Sim([{ id: 1, team: 0, x: start.x, y: start.y, vx: FULL_POWER_SPEED * Math.cos(dir), vy: FULL_POWER_SPEED * Math.sin(dir) }]);
    sim.runToRest();
    const pegHits = sim.events.filter((e) => e.kind === 'peg');
    expect(pegHits.length).toBeGreaterThan(0);
    expect(pegHits[0]).toMatchObject({ peg: 5 });
  });

  it('transfers momentum disc to disc with restitution 0.9', () => {
    const sim = new Sim([
      { id: 1, team: 0, x: -6, y: 6, vx: 20, vy: 0 },
      { id: 2, team: 1, x: -3, y: 6, vx: 0, vy: 0 },
    ]);
    let before = 0;
    while (!sim.events.some((e) => e.kind === 'disc')) {
      before = sim.discs[0].vx;
      sim.step();
    }
    const [a, b] = sim.discs;
    // Head-on, equal masses: separation speed = e × approach speed (friction slows both
    // equally, so it cancels), and momentum is shared (each loses one tick of friction).
    expect(b.vx - a.vx).toBeCloseTo(PHYSICS.discRestitution * before, 6);
    expect(a.vx + b.vx).toBeCloseTo(before - 2 * PHYSICS.friction * PHYSICS.dt, 6);
    expect(a.vy).toBe(0);
  });

  it('is deterministic: the same break gives bit-identical results', () => {
    const run = () => {
      nextId = 5000;
      let g = place(twoPlayer(), [
        { seat: 2, x: 0.3, y: -5 },
        { seat: 2, x: -1.2, y: -2 },
        { seat: 0, x: 1, y: 1 },
        { seat: 2, x: 2.5, y: 3 },
      ]);
      const r = resolveShot(g, { seat: 0, baselinePos: 0.47, angle: 0.03, power: 0.85 });
      g = r.state;
      return JSON.stringify(r);
    };
    expect(run()).toBe(run());
  });
});

describe('shot requirements', () => {
  it('needs the 15 on an open board, and an opponent hit once one is on the board', () => {
    const g = twoPlayer();
    expect(requirement(g)).toBe('reach-15');
    expect(requirement(place(g, [{ seat: 0, x: 0, y: 5 }]))).toBe('reach-15');
    expect(requirement(place(g, [{ seat: 2, x: 0, y: 5 }]))).toBe('hit-opponent');
  });

  it('keeps an opening shot that reaches the 15', () => {
    const { state, outcome } = resolveShot(twoPlayer(), straight(0, powerFor(7.8)));
    expect(outcome.short).toBe(false);
    expect(outcome.removed).toEqual([]);
    expect(state.board).toHaveLength(1);
  });

  it('removes an opening shot that stops short of the 15', () => {
    const { state, outcome } = resolveShot(twoPlayer(), straight(0, powerFor(4)));
    expect(outcome.short).toBe(true);
    expect(outcome.removed).toEqual([{ id: outcome.shotId, reason: 'short' }]);
    expect(state.board).toHaveLength(0);
  });

  it('banks a 20 for its owner', () => {
    const { state, outcome } = resolveShot(twoPlayer(), straight(0, powerFor(12)));
    expect(outcome.twenties).toEqual([{ id: outcome.shotId, team: 0 }]);
    expect(state.twenties).toEqual([1, 0]);
  });

  it('removes a disc that falls in the ditch', () => {
    const { state, outcome } = resolveShot(twoPlayer(), straight(0, 1));
    expect(outcome.removed).toEqual([{ id: outcome.shotId, reason: 'ditch' }]);
    expect(state.board).toHaveLength(0);
    expect(state.discsLeft[0]).toBe(11);
  });

  it('a clean hit on an opponent is legal', () => {
    const g = place(twoPlayer(), [{ seat: 2, x: 0, y: -6 }]);
    const { outcome } = resolveShot(g, straight(0, 0.5));
    expect(outcome.foul).toBe(false);
    expect(outcome.events.some((e) => e.kind === 'disc')).toBe(true);
  });

  it('missing every opponent is a foul: the shot disc is removed', () => {
    const g = place(twoPlayer(), [{ seat: 2, x: 7, y: 0 }]);
    const { state, outcome } = resolveShot(g, straight(0, powerFor(7.8)));
    expect(outcome.foul).toBe(true);
    expect(outcome.removed).toEqual([{ id: outcome.shotId, reason: 'foul' }]);
    expect(state.board.map((d) => d.team)).toEqual([1]);
  });

  it('a foul also removes your own discs the shot touched', () => {
    const g = place(twoPlayer(), [
      { seat: 0, x: 0, y: -6 },
      { seat: 2, x: 7, y: 0 },
      { seat: 0, x: -7, y: 0 }, // untouched own disc stays
    ]);
    const own = g.board[0].id;
    const { state, outcome } = resolveShot(g, straight(0, 0.25));
    expect(outcome.foul).toBe(true);
    expect(outcome.removed.map((r) => r.id).sort()).toEqual([own, outcome.shotId].sort());
    expect(state.board.map((d) => d.id)).toEqual([g.board[1].id, g.board[2].id]);
  });

  it('hitting an opponent via your own disc is legal', () => {
    const g = place(twoPlayer(), [
      { seat: 0, x: 0, y: -7 },
      { seat: 2, x: 0, y: -4.9 },
    ]);
    const { outcome } = resolveShot(g, straight(0, 0.5));
    expect(outcome.foul).toBe(false);
  });

  it('a 20 made on a foul does not count', () => {
    const g = place(twoPlayer(), [{ seat: 2, x: 8, y: 0 }]);
    const { state, outcome } = resolveShot(g, straight(0, powerFor(12)));
    expect(outcome.foul).toBe(true);
    expect(outcome.twenties).toEqual([]);
    expect(outcome.voidedTwenties).toEqual([outcome.shotId]);
    expect(state.twenties).toEqual([0, 0]);
  });

  it('an opponent knocked into the 20 by a legal shot is banked for the opponent', () => {
    const g = place(twoPlayer(), [{ seat: 2, x: 0, y: -1.6 }]);
    // Shot travels to just touch it with little speed left, nudging it onto the hole.
    let best = null as null | ReturnType<typeof resolveShot>;
    for (let d = 10.5; d < 12.5 && !best; d += 0.05) {
      const r = resolveShot(g, straight(0, powerFor(d)));
      if (r.outcome.twenties.some((t) => t.team === 1)) best = r;
    }
    expect(best).not.toBeNull();
    expect(best!.outcome.foul).toBe(false);
    expect(best!.state.twenties[1]).toBe(1);
  });

  it('removes discs left on or beyond the shooting line after a shot', () => {
    const g = place(twoPlayer(), [{ seat: 2, x: 0, y: -10.2 }]);
    const { state, outcome } = resolveShot(g, straight(0, 0.03));
    expect(outcome.foul).toBe(false);
    expect(outcome.removed).toContainEqual({ id: outcome.shotId, reason: 'shooting-line' });
    expect(state.board.every((d) => Math.hypot(d.x, d.y) <= BOARD.r5 - BOARD.discR)).toBe(true);
  });

  it('slides the launch spot along the arc when a disc covers it', () => {
    const spot = arcPoint(0, 0.5);
    const g = place(twoPlayer(), [{ seat: 2, x: spot.x, y: spot.y + 0.9 }]);
    const l = launch(g, straight(0, 0.5));
    expect(Math.hypot(l.x - spot.x, l.y - (spot.y + 0.9))).toBeGreaterThanOrEqual(2 * BOARD.discR - 1e-9);
  });

  it('rejects a shot out of turn', () => {
    expect(() => resolveShot(twoPlayer(), straight(2, 0.5))).toThrow(/turn/);
  });
});

describe('teams', () => {
  it('seats 2p opposite, 3p free-for-all, 4p partners opposite', () => {
    const two = createGame({ players: 2, target: 100 });
    expect(two.seats).toEqual([0, 2]);
    expect(two.discsLeft).toEqual([12, 0, 12, 0]);
    const three = createGame({ players: 3, target: 100 });
    expect(three.teamOfSeat).toEqual([0, 1, 2, -1]);
    expect(three.discsLeft).toEqual([8, 8, 8, 0]);
    const four = createGame({ players: 4, target: 100 });
    expect(four.teamOfSeat).toEqual([0, 1, 0, 1]);
    expect(four.discsLeft).toEqual([6, 6, 6, 6]);
  });

  it("treats a partner's disc as your own: not an opponent, and removed on your foul", () => {
    let g = createGame({ players: 4, target: 100 });
    g = place(g, [
      { seat: 2, x: 0, y: -6 }, // partner of seat 0
      { seat: 1, x: 7, y: 0 },
    ]);
    expect(requirement(g)).toBe('hit-opponent');
    const partner = g.board[0].id;
    const { outcome } = resolveShot(g, straight(0, 0.25));
    expect(outcome.foul).toBe(true);
    expect(outcome.removed.map((r) => r.id)).toContain(partner);
  });
});

describe('round scoring', () => {
  const r = BOARD.discR;
  it('2 teams: only the difference counts, with banked 20s', () => {
    let g = place(twoPlayer(), [
      { seat: 0, x: 0, y: 2 }, // 15
      { seat: 0, x: 6, y: 0 }, // 10
      { seat: 2, x: 0, y: -(BOARD.r10 - r + 0.05) }, // touches the 10 line → 5
      { seat: 2, x: -10, y: 0 }, // 5
    ]);
    g = { ...g, twenties: [0, 1] };
    const res = tallyRound(g);
    expect(res.tallies.map((t) => t.total)).toEqual([25, 30]);
    expect(res.tallies.map((t) => t.awarded)).toEqual([0, 5]);
    expect(res.tallies[0].discs.map((d) => d.points)).toEqual([10, 15]);
  });

  it('3 players: everyone keeps their own total', () => {
    let g = createGame({ players: 3, target: 100 });
    g = place(g, [
      { seat: 0, x: 0, y: 2 },
      { seat: 1, x: 6, y: 0 },
      { seat: 2, x: -10, y: 0 },
    ]);
    expect(tallyRound(g).tallies.map((t) => t.awarded)).toEqual([15, 10, 5]);
  });

  it('plays a whole round, scores it, and rotates the starter', () => {
    let g = twoPlayer();
    let shots = 0;
    while (g.phase === 'shooting') {
      const seat = g.seats[g.turn];
      // Alternate players; seat 0 lands in the 15, seat 2 always comes up short.
      g = resolveShot(g, { seat, baselinePos: 0.2 + 0.05 * (shots % 12), angle: 0, power: seat === 0 ? powerFor(8.5) : 0.05 }).state;
      shots++;
    }
    expect(shots).toBe(24);
    expect(g.phase).toBe('round-over');
    expect(g.lastRound!.tallies[0].awarded).toBeGreaterThan(0);
    expect(g.scores[0]).toBe(g.lastRound!.tallies[0].awarded);
    expect(g.scores[1]).toBe(0);
    const r2 = nextRound(g);
    expect(r2.round).toBe(2);
    expect(r2.seats[r2.turn]).toBe(2);
    expect(r2.board).toEqual([]);
    expect(r2.discsLeft).toEqual([12, 0, 12, 0]);
  });

  it('ends the game when a team reaches the target', () => {
    let g = createGame({ players: 2, target: 50 });
    g = { ...g, scores: [45, 10], discsLeft: [1, 0, 0, 0] };
    const { state } = resolveShot(g, straight(0, powerFor(12))); // a 20 on the last shot
    expect(state.phase).toBe('game-over');
    expect(state.winner).toBe(0);
    expect(state.scores).toEqual([65, 10]);
  });
});

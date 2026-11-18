import { describe, expect, it } from 'vitest';
import { BOARD, PEGS, PENALTY_HOLES, PHYSICS, arcPoint, zoneScore, type Seat } from '../src/engine/board';
import { aimAngle, evaluateShot } from '../src/engine/ai';
import { type BoardDisc, type GameState, type Settings, createGame, resolveShot, tallyRound } from '../src/engine/rules';

const five: Settings = { players: 2, target: 100, board: 'five-hole' };
const hole = PENALTY_HOLES[3]; // lower right, closest to seat 0
const from = arcPoint(0, 1);
/** Seat 0 shot that stops exactly on the lower-right −10 hole. */
const ontoHole = { seat: 0 as Seat, baselinePos: 1, angle: aimAngle(0, from, hole), power: Math.hypot(hole.x - from.x, hole.y - from.y) / PHYSICS.fullPowerDistance };

let id = 900;
function place(state: GameState, discs: Array<{ seat: Seat; x: number; y: number }>): GameState {
  const board: BoardDisc[] = discs.map((d) => ({ id: id++, seat: d.seat, team: state.teamOfSeat[d.seat], x: d.x, y: d.y }));
  return { ...state, board };
}

describe('5-hole board', () => {
  it('has four −10 holes in the 10 zone, on the quadrant lines, clear of the pegs', () => {
    expect(PENALTY_HOLES).toHaveLength(4);
    for (const h of PENALTY_HOLES) {
      const r = Math.hypot(h.x, h.y);
      expect(zoneScore(r)).toBe(10);
      const deg = ((Math.atan2(h.y, h.x) * 180) / Math.PI + 360) % 90;
      expect(deg).toBeCloseTo(45, 9);
      for (const p of PEGS) expect(Math.hypot(h.x - p.x, h.y - p.y)).toBeGreaterThan(2 * BOARD.discR);
    }
  });

  it('a disc that stops on a −10 hole drops in and costs its owner 10', () => {
    const { state, outcome } = resolveShot(createGame(five), ontoHole);
    expect(outcome.penalties).toEqual([{ id: outcome.shotId, team: 0 }]);
    expect(outcome.events.some((e) => e.kind === 'penalty')).toBe(true);
    expect(state.penalties).toEqual([1, 0]);
    expect(state.board).toHaveLength(0);
    expect(tallyRound(state).tallies[0]).toMatchObject({ penalties: 1, total: -10 });
  });

  it('the classic board has no extra holes', () => {
    const { outcome } = resolveShot(createGame({ players: 2, target: 100 }), ontoHole);
    expect(outcome.penalties).toEqual([]);
    // It just stops there (and, as an opening shot outside the 15, is removed as short).
    expect(outcome.removed).toEqual([{ id: outcome.shotId, reason: 'short' }]);
  });

  it('knocking an opponent into a −10 hole costs them, and counts for the shooter', () => {
    // Put the opponent's disc on the line from seat 0's right end to the hole, then hit it head-on.
    const S = arcPoint(0, 1);
    const len = Math.hypot(S.x - hole.x, S.y - hole.y);
    const u = { x: (S.x - hole.x) / len, y: (S.y - hole.y) / len };
    const D = { x: hole.x + u.x * 1.3, y: hole.y + u.y * 1.3 };
    const g = place(createGame(five), [{ seat: 2, x: D.x, y: D.y }]);
    let hit = null as null | ReturnType<typeof resolveShot>;
    for (let p = 0.04; p < 0.4 && !hit; p += 0.002) {
      const r = resolveShot(g, { seat: 0, baselinePos: 1, angle: aimAngle(0, S, D), power: p });
      if (r.outcome.penalties.some((x) => x.team === 1)) hit = r;
    }
    expect(hit).not.toBeNull();
    expect(hit!.outcome.foul).toBe(false);
    expect(hit!.state.penalties).toEqual([0, 1]);
    expect(hit!.state.stats![0].sunk).toBe(1);
  });

  it('round scoring nets 20s and −10s; only the difference counts', () => {
    const g: GameState = { ...createGame(five), twenties: [1, 0], penalties: [2, 1] };
    const r = tallyRound(g);
    expect(r.tallies.map((t) => t.total)).toEqual([0, -10]);
    expect(r.tallies.map((t) => t.awarded)).toEqual([10, 0]);
  });

  it('the computer rates a −10 drop below a safe stop', () => {
    const g = createGame(five);
    const safe = { seat: 0 as Seat, baselinePos: 0.5, angle: 0, power: 8.5 / PHYSICS.fullPowerDistance };
    expect(evaluateShot(g, ontoHole)).toBeLessThan(evaluateShot(g, safe));
  });
});

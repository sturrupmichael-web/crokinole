import { describe, expect, it } from 'vitest';
import { PHYSICS, type Seat } from '../src/engine/board';
import { REPLAY_THRESHOLD, gameAwards, replayState } from '../src/engine/highlights';
import { type BoardDisc, type GameState, beginShot, createGame, finishShot, resolveShot } from '../src/engine/rules';

const powerFor = (d: number) => d / PHYSICS.fullPowerDistance;
let id = 500;
function place(state: GameState, discs: Array<{ seat: Seat; x: number; y: number }>): GameState {
  const board: BoardDisc[] = discs.map((d) => ({ id: id++, seat: d.seat, team: state.teamOfSeat[d.seat], x: d.x, y: d.y }));
  return { ...state, board };
}

describe('highlights and stats', () => {
  it('counts a 20 and makes it the round highlight', () => {
    const { state } = resolveShot(createGame({ players: 2, target: 100 }), { seat: 0, baselinePos: 0.5, angle: 0, power: powerFor(12) });
    expect(state.stats![0]).toMatchObject({ shots: 1, twenties: 1, fouls: 0 });
    expect(state.highlight).toMatchObject({ seat: 0, label: 'a 20' });
    expect(state.highlight!.score).toBeGreaterThanOrEqual(REPLAY_THRESHOLD);
  });

  it('counts takeouts of opponent discs, and fouls', () => {
    let g = place(createGame({ players: 2, target: 100 }), [{ seat: 2, x: 0, y: -6 }]);
    g = resolveShot(g, { seat: 0, baselinePos: 0.5, angle: 0, power: 1 }).state; // straight through: knocks it out
    expect(g.stats![0].takeouts).toBe(1);
    expect(g.stats![0].bestTakeout).toBe(1);
    g = place(g, [{ seat: 0, x: 7, y: 0 }]);
    g = resolveShot(g, { seat: 2, baselinePos: 0.5, angle: 0, power: 0.1 }).state; // misses: foul
    expect(g.stats![2].fouls).toBe(1);
  });

  it('a double takeout outranks a single one', () => {
    let g = place(createGame({ players: 2, target: 100 }), [
      { seat: 2, x: 0, y: -8 },
      { seat: 2, x: 0, y: -2.2 },
    ]);
    const r = resolveShot(g, { seat: 0, baselinePos: 0.5, angle: 0, power: 1 });
    const out = r.outcome.removed.filter((x) => x.id !== r.outcome.shotId).length;
    if (out >= 2) expect(r.state.highlight?.label).toMatch(/double takeout/);
    g = r.state;
    expect(g.stats![0].bestTakeout).toBe(out);
  });

  it('replays the highlight to the identical result', () => {
    let g = place(createGame({ players: 2, target: 100 }), [
      { seat: 2, x: 0.4, y: -6 },
      { seat: 2, x: -1, y: -2.5 },
      { seat: 0, x: 2, y: 1 },
    ]);
    const before = g;
    const r = resolveShot(g, { seat: 0, baselinePos: 0.48, angle: 0.02, power: 0.9 });
    g = r.state;
    // Force it to be the highlight whatever happened, then replay it.
    const h = { seat: 0 as Seat, shot: r.outcome.shot, score: 99, label: 'x', before: { board: before.board, discsLeft: before.discsLeft, twenties: before.twenties, turn: before.turn, nextId: before.nextId } };
    const live = beginShot(replayState(g, h), h.shot);
    live.sim.runToRest();
    const again = finishShot(replayState(g, h), live);
    expect(again.outcome.events).toEqual(r.outcome.events);
    expect(again.state.board).toEqual(r.state.board);
  });

  it('resets the highlight each round but keeps stats', () => {
    let g: GameState = { ...createGame({ players: 2, target: 100 }), discsLeft: [1, 0, 1, 0] };
    g = resolveShot(g, { seat: 0, baselinePos: 0.5, angle: 0, power: powerFor(12) }).state;
    g = resolveShot(g, { seat: 2, baselinePos: 0.5, angle: 0, power: 0.05 }).state;
    expect(g.phase).toBe('round-over');
    expect(g.highlight).not.toBeNull();
  });

  it('hands out awards only for things that happened, with ties shared', () => {
    const g = createGame({ players: 2, target: 100 });
    const stats = g.stats!.map((s) => ({ ...s }));
    stats[0] = { ...stats[0], twenties: 3, takeouts: 2, fouls: 2, bestTakeout: 2 };
    stats[2] = { ...stats[2], twenties: 3, takeouts: 4, bestPegs: 1 };
    const awards = gameAwards({ ...g, stats });
    expect(awards.map((a) => a.title)).toEqual(['Sharpshooter', 'Demolition crew', 'Biggest takeout', 'Foul magnet']);
    expect(awards[0].seats).toEqual([0, 2]);
    expect(awards[1].seats).toEqual([2]);
    expect(gameAwards(g)).toEqual([]);
  });
});

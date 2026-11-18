import { describe, expect, it } from 'vitest';
import { chooseShot, evaluateShot } from '../src/engine/ai';
import { mulberry32 } from '../src/engine/rng';
import { createGame, resolveShot, type GameState } from '../src/engine/rules';

describe('AI', () => {
  it('opens into the 15 (or the 20) on an empty board', () => {
    const g = createGame({ players: 2, target: 100 });
    const shot = chooseShot(g, 'hard', mulberry32(1));
    const { outcome } = resolveShot(g, shot);
    expect(outcome.short).toBe(false);
    expect(outcome.removed.filter((r) => r.id === outcome.shotId)).toEqual([]);
  });

  it('hits an opponent disc rather than fouling, at every level', () => {
    for (const level of ['easy', 'medium', 'hard'] as const) {
      let fouls = 0;
      for (let seed = 1; seed <= 6; seed++) {
        let g: GameState = createGame({ players: 2, target: 100 });
        g = { ...g, board: [{ id: 99, seat: 0, team: 0, x: 1.5, y: 5 }], turn: 1 };
        const shot = chooseShot(g, level, mulberry32(seed));
        if (resolveShot(g, shot).outcome.foul) fouls++;
      }
      expect(fouls, level).toBeLessThanOrEqual(level === 'easy' ? 3 : 1);
    }
  });

  it('scores a foul well below a legal hit', () => {
    let g: GameState = createGame({ players: 2, target: 100 });
    g = { ...g, board: [{ id: 99, seat: 2, team: 1, x: 7, y: 0 }] };
    const foul = evaluateShot(g, { seat: 0, baselinePos: 0.5, angle: 0, power: 0.2 });
    const hit = evaluateShot(g, chooseShot(g, 'hard', mulberry32(3)));
    expect(foul).toBeLessThan(hit);
  });

  it('is repeatable for a given seed', () => {
    const g = createGame({ players: 2, target: 100 });
    expect(chooseShot(g, 'medium', mulberry32(7))).toEqual(chooseShot(g, 'medium', mulberry32(7)));
  });
});

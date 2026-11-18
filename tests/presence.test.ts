import { describe, expect, it } from 'vitest';
import { countPlayers } from '../src/net/presence';

describe('countPlayers', () => {
  it('counts people per game and skips host screens', () => {
    expect(
      countPlayers({
        a: [{ g: 'crokinole', r: 'phone' }],
        b: [{ g: 'crokinole', r: 'phone' }],
        c: [{ g: 'crokinole', r: 'host' }],
        d: [{ g: 'patch-tuesday', r: 'local' }],
        e: [],
      }),
    ).toEqual({ crokinole: 2, 'patch-tuesday': 1 });
  });
});

# Crokinole

A browser Crokinole game built as a party game. A host screen (a laptop on the TV) shows the
board and a room code, and 2–4 players join on their phones and flick discs from them.
There is also a single-device local mode: pass-and-play, or play against the computer.

Served at **https://michaelsturrup.com/crokinole/** (unlisted until it's finished).

## Status

| Milestone | State |
| --- | --- |
| 1. Physics + rules engine with unit tests | ✅ done |
| 2. Local mode: rendering, touch/mouse controls, vs. AI, pass-and-play | next |
| 3. Party mode: lobby, room codes, phone controller, host sync (Supabase Realtime) | |
| 4. Polish: sound, animations, end-of-game screen, site game picker | |

## Local development

```bash
npm install
npm test           # engine unit tests (vitest)
npm run typecheck
npm run build      # type-check + static build into dist/
```

## Rules as implemented

- **Seats and discs.** 2 players sit opposite with 12 discs each. 3 players play
  free-for-all with 8 each. 4 players play as partners sitting opposite, with 6 each.
- **Turns.** Players alternate shots; the round ends when every disc has been shot. The
  starting player rotates each round.
- **Opponent on the board.** The shot must hit an opponent's disc, directly or through your own
  (or your partner's) discs it set moving. Otherwise it's a **foul**: the shot disc and every one
  of your team's discs it touched are removed, and a 20 made on the foul doesn't count.
- **Open board.** The shot disc must end touching or inside the 15 circle, or drop in the
  20 hole. Otherwise it's removed.
- **Ditch.** A disc whose centre passes the edge of the playing surface is removed.
- **20 hole.** A slow enough disc whose centre comes near dead centre drops and is banked as a
  20 for its owner.
- **Shooting line.** After every shot, discs resting on or outside the shooting line are removed.
- **Scoring.** A disc scores the zone it sits in, and the lower zone if it touches a line. Banked
  20s are added. With two sides, only the difference counts. In 3-player games, everyone keeps
  their own total.
- **Winning.** The first side to the target (50 or 100) at the end of a round wins. A tie at the
  top plays another round.

## Engine

```
src/engine/board.ts    Board geometry in inches, every physics number, zone scoring
src/engine/physics.ts  Sim: fixed 1/240 s step, substeps, disc/peg collisions, ditch, 20 hole
src/engine/rules.ts    Game state, turns, requirements, fouls, removals, round tally, game end
tests/engine.test.ts   Unit tests
```

- **Pure and deterministic.** There's no DOM, `Math.random` or wall-clock time. Each tick is
  split into substeps so no disc moves more than a quarter of its radius per substep, which stops
  fast discs tunnelling through each other or the pegs. Same state + same shot gives the same
  result, so the AI can test candidate shots in the real physics and replays match.
- **A shot** is `{ seat, baselinePos (0–1 along the seat's arc, left to right), angle (radians off
  straight-in, + = right), power (0–1) }`. Power maps linearly onto travel distance, and full
  power travels 1.5 board widths.
- **Animating a shot** uses the same simulation the rules score:
  `beginShot` → step `live.sim` in real time → `finishShot`. `resolveShot` does it all at once.
- **State is plain JSON**, so the host can broadcast it and save it to recover from a refresh.
  `ShotOutcome` lists the fouls, 20s, removals and physics events for callouts and sound.

All tunable numbers (friction, restitution, 20-hole capture radius and speed) are in
`src/engine/board.ts`.

## Deploying

Same setup as the other games on the site. Every push to `main` runs **Tests**, and when they pass
**Deploy** publishes `dist/` to GitHub Pages (Settings → Pages → Source: GitHub Actions).

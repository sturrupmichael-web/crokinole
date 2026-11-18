# Crokinole

A browser Crokinole game built as a party game. A host screen (a laptop on the TV) shows the
board and a room code, and 2–4 players join on their phones and flick discs from them.
There is also a single-device local mode: pass-and-play, or play against the computer.

Served at **https://michaelsturrup.com/crokinole/**:

| Page | What it is |
| --- | --- |
| `/crokinole/` | Menu and local mode: vs. computer (Easy/Medium/Hard) or pass-and-play, 2–4 players |
| `/crokinole/host/` | Party-mode host screen: room code, QR, lobby, the board |
| `/crokinole/join/` | Phone controller (the QR code opens it with the room filled in) |

## Status

| Milestone | State |
| --- | --- |
| 1. Physics + rules engine with unit tests | ✅ done |
| 2. Local mode: rendering, touch/mouse controls, vs. AI, pass-and-play | ✅ done |
| 3. Party mode: lobby, room codes, phone controller, host sync (Supabase Realtime) | ✅ done |
| 4. Polish: sound, animations, end-of-game screen, site game picker | ✅ done |

## Controls

Drag your disc along the shooting line to place it. Then pull back like a slingshot (from the
disc, or from anywhere on the screen) and let go. The pull's direction aims and its length sets
the power. Drag back to where you started to cancel. On phones, the power meter shows the pull
and each 10% step gives a haptic tick where supported.

## Party mode

1. Open `/crokinole/host/` on the laptop driving the TV. It shows a room code and a QR code.
2. Players open `michaelsturrup.com/crokinole/join` (or scan) and enter the code and a name.
3. Add computer players from the lobby if you're short, pick 50 or 100, and press **Start game**.

- **The host is authoritative.** Phones send only `{ baselinePos, angle, power }` (plus a
  low-rate aim preview, drawn as a ghost on the TV). The host runs the physics and the rules,
  then broadcasts the room state. Each shot carries the turn number, so a repeated send can't
  shoot twice.
- **Rejoining.** A phone that drops reconnects on its own. A new phone or a cleared browser gets
  the same seat back by joining with the same name. Players who are away are labelled on the
  board. The host menu (☰) can hand a stuck player's turns to the computer, and give the seat
  back later.
- **Host refresh.** The host saves the room to `localStorage` after every shot and reopens the
  same room code and game when reloaded. A shot that was mid-flight is simply taken again.
- **Realtime.** Supabase Realtime broadcast only: no tables and no auth. One public channel per
  room, `crokinole:<CODE>`. The URL and publishable key live in the committed `.env`. Without them
  (for example `VITE_SUPABASE_URL= npm run dev`) the game falls back to `BroadcastChannel`, so the
  host and the "phones" must be tabs in one browser. That's handy for testing on one machine.

## Local development

```bash
npm install
npm run dev        # http://localhost:5173/crokinole/  (host: /crokinole/host/, phone: /crokinole/join/)
npm test           # engine + AI unit tests (vitest)
npm run typecheck
npm run build      # type-check + static build into dist/
```

`/crokinole/?autoplay` makes every seat a computer player at 6× speed, which is handy for checking
rounds, the tally and the end screen.

## Replays and awards

- **Shot of the round.** Every shot is scored for drama: 20s, takeouts (opponent discs knocked
  into the ditch or past the shooting line), bonus for doubles and for a takeout plus a 20, a little
  for peg hits and clacks. Fouls score nothing. At the end of a round the best shot (if it scored
  at least `REPLAY_THRESHOLD`) is replayed in slow motion before the tally. The physics is
  deterministic, so the replay re-runs the real shot from the saved state before it. Tap, Space,
  Enter or Esc skips it.
- **Awards.** At game end: Sharpshooter (most 20s), Demolition crew (most takeouts), Biggest
  takeout (2+ discs in one shot), Pinball wizard (3+ peg hits in one shot), Foul magnet (2+ fouls).
  An award only appears if someone earned it, and ties share it. Shown on the TV, in local mode and
  on every phone.
- **No spoilers.** Scoreboards (TV and phones) keep the previous scores until the tally finishes,
  and phones show the winner only once the TV does.

Stats live in `GameState.stats` (per seat) and `GameState.highlight` (this round's best shot), so
they survive a host refresh. See `src/engine/highlights.ts`.

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
src/engine/ai.ts       Computer opponent
src/game/table.ts      Animates shots with the same Sim, sound/callouts, disc-by-disc tally
src/render/            Board art (pre-rendered once) and the live view
src/ui/                Slingshot input, HUD, synthesised sound effects
src/local/ src/host/ src/phone/   The three pages
src/net/               Wire protocol and transport (Supabase Realtime / BroadcastChannel)
tests/                 Unit tests
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

## Computer opponent

The AI samples candidate shots. Some are aimed at each opponent disc or the 20 hole, and the
rest are random. It runs each one through the real physics and rules and scores the board that
results: its own points minus the best opponent's, a large penalty for fouls and short shots, and
a bonus for 20s. It then re-tests the six best with its own wobble and picks the one that holds up
best on average, so it avoids shots that only work when they're perfect. Difficulty sets the
number of candidates (40 / 150 / 400) and how much random wobble goes into the shot.

## Deploying

Same setup as the other games on the site. Every push to `main` runs **Tests**, and when they pass
**Deploy** publishes `dist/` to GitHub Pages (Settings → Pages → Source: GitHub Actions).

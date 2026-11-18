/**
 * The table: owns the authoritative GameState on this device, animates each
 * shot by stepping the real Sim in (fixed-step) real time, plays sounds and
 * callouts, and runs the disc-by-disc round tally. Used by local mode and by
 * the party-mode host.
 */
import { BOARD, PENALTY_HOLES, PHYSICS, type Seat } from '../engine/board';
import type { SimDisc } from '../engine/physics';
import {
  type GameState,
  type LiveShot,
  type RoundResult,
  type Shot,
  type ShotOutcome,
  beginShot,
  currentSeat,
  finishShot,
  nextRound,
} from '../engine/rules';
import { type Highlight, replayState } from '../engine/highlights';
import type { Sfx } from '../ui/audio';
import { type BoardView, type DrawDisc, type Frame, TEAM_COLORS, twentyHolders } from '../render/view';

interface Fx {
  disc: DrawDisc;
  start: number;
  dur: number;
  kind: 'fade' | 'hole' | 'ditch';
}

export interface TallyProgress {
  result: RoundResult;
  /** Running totals shown so far, per team. */
  shown: number[];
  done: boolean;
}

/** Slow-motion replay of the round's best shot, shown before the tally. */
export interface ReplayView {
  highlight: Highlight;
  live: LiveShot;
  /** Seconds left showing the aim before the disc goes. */
  intro: number;
  /** Seconds to hold after everything stops. */
  outro: number;
  acc: number;
  seen: number;
}

/** Replay speed (fraction of real time). */
const REPLAY_SPEED = 0.4;

export interface TableHooks {
  /** Replay started (highlight) or ended (null). */
  onReplay?(h: Highlight | null): void;
  onShotEnd?(outcome: ShotOutcome, state: GameState): void;
  onTally?(p: TallyProgress): void;
  onChange?(state: GameState): void;
}

export class Table {
  state: GameState;
  live: LiveShot | null = null;
  tally: TallyProgress | null = null;
  replay: ReplayView | null = null;
  /** Playback speed multiplier for shots (1 = real time). */
  speed = 1;
  private acc = 0;
  private fx: Fx[] = [];
  private seenEvents = 0;
  private tallyQueue: Array<() => void> = [];
  private tallyClock = 0;
  private glowIds = new Set<number>();

  constructor(
    state: GameState,
    private view: BoardView,
    private sfx: Sfx,
    private hooks: TableHooks = {},
  ) {
    this.state = state;
  }

  /** The round has ended but its tally hasn't finished, so scores shouldn't show its points yet. */
  get scoresPending(): boolean {
    return this.state.phase !== 'shooting' && !this.tally?.done;
  }

  get moving(): boolean {
    return this.live !== null;
  }

  canShoot(seat: Seat): boolean {
    return !this.live && !this.tally && !this.replay && this.state.phase === 'shooting' && currentSeat(this.state) === seat;
  }

  shoot(shot: Shot): boolean {
    if (!this.canShoot(shot.seat)) return false;
    this.live = beginShot(this.state, shot);
    this.acc = 0;
    this.seenEvents = 0;
    this.hooks.onChange?.(this.state);
    return true;
  }

  /** Replace the state wholesale (host refresh recovery). */
  load(state: GameState): void {
    this.state = state;
    this.live = null;
    this.tally = null;
    this.replay = null;
    this.fx = [];
  }

  update(dt: number): void {
    if (this.live) this.stepShot(dt);
    if (this.replay) this.stepReplay(dt);
    if (this.tally && !this.tally.done) {
      this.tallyClock -= dt;
      while (this.tallyClock <= 0 && this.tallyQueue.length) {
        this.tallyQueue.shift()!();
        this.tallyClock += 0.42;
      }
      if (!this.tallyQueue.length && this.tallyClock <= 0) {
        this.tally.done = true;
        this.hooks.onTally?.(this.tally);
      }
    }
  }

  private stepShot(dt: number): void {
    const live = this.live!;
    const sim = live.sim;
    this.acc += Math.min(dt, 0.1) * this.speed;
    while (this.acc >= PHYSICS.dt && sim.isMoving()) {
      this.acc -= PHYSICS.dt;
      this.seenEvents = this.tick(live, this.seenEvents);
    }
    if (!sim.isMoving()) this.finish();
  }

  /** One fixed physics tick plus its sounds and drop effects. Returns the new seen-events count. */
  private tick(live: LiveShot, seen: number): number {
    const sim = live.sim;
    const before = new Map<number, SimDisc>(sim.discs.map((d) => [d.id, { ...d }]));
    sim.step();
    for (; seen < sim.events.length; seen++) {
        const e = sim.events[seen];
        this.sfx.event(e);
        if (e.kind === 'penalty') {
          const h = PENALTY_HOLES[e.hole];
          const d = sim.penalties.find((x) => x.id === e.id);
          if (d && h) this.fx.push({ disc: { id: d.id, team: d.team, x: h.x, y: h.y }, start: performance.now(), dur: 500, kind: 'hole' });
          if (h) this.view.float(h.x, h.y + 1.1, '−10', '#ff6b5b', 1.8, 1.8);
        }
        if (e.kind === 'ditch' || e.kind === 'twenty') {
          const d = sim.ditched.find((x) => x.id === e.id) ?? sim.twenties.find((x) => x.id === e.id) ?? before.get(e.id);
          if (d) {
            this.fx.push({
              disc: { id: d.id, team: d.team, x: e.kind === 'twenty' ? 0 : d.x, y: e.kind === 'twenty' ? 0 : d.y },
              start: performance.now(),
              dur: e.kind === 'twenty' ? 500 : 400,
              kind: e.kind === 'twenty' ? 'hole' : 'ditch',
            });
          }
          if (e.kind === 'twenty') this.view.float(0, 1.2, '20!', '#ffe27a', 2.2, 1.8);
        }
    }
    return seen;
  }

  private startReplay(h: Highlight): void {
    const live = beginShot(replayState(this.state, h), h.shot);
    this.replay = { highlight: h, live, intro: 1.1, outro: 1.4, acc: 0, seen: 0 };
    this.fx = [];
    this.hooks.onReplay?.(h);
    this.hooks.onChange?.(this.state);
  }

  private stepReplay(dt: number): void {
    const r = this.replay!;
    dt = Math.min(dt, 0.1);
    if (r.intro > 0) {
      r.intro -= dt;
      return;
    }
    if (r.live.sim.isMoving()) {
      r.acc += dt * REPLAY_SPEED * this.speed;
      while (r.acc >= PHYSICS.dt && r.live.sim.isMoving()) {
        r.acc -= PHYSICS.dt;
        r.seen = this.tick(r.live, r.seen);
      }
      return;
    }
    r.outro -= dt * this.speed;
    if (r.outro <= 0) this.skipReplay();
  }

  /** End the replay now (tap to skip) and go on to the tally. */
  skipReplay(): void {
    if (!this.replay) return;
    this.replay = null;
    this.fx = [];
    this.hooks.onReplay?.(null);
    if (this.state.lastRound) this.startTally(this.state.lastRound);
  }

  private finish(): void {
    const live = this.live!;
    const finalDiscs = new Map(live.sim.discs.map((d) => [d.id, d]));
    const { state, outcome } = finishShot(this.state, live);
    this.live = null;
    const now = performance.now();
    for (const r of outcome.removed) {
      if (r.reason === 'ditch') continue;
      const d = finalDiscs.get(r.id);
      if (d) this.fx.push({ disc: { id: d.id, team: d.team, x: d.x, y: d.y }, start: now + 350, dur: 700, kind: 'fade' });
    }
    const shotDisc = finalDiscs.get(outcome.shotId);
    const at = shotDisc ?? { x: 0, y: -6 };
    if (outcome.foul) {
      this.view.float(at.x, at.y + 1.2, 'FOUL', '#ff6b5b', 2, 2.2);
      this.sfx.buzz();
    } else if (outcome.short) {
      this.view.float(at.x, at.y + 1.2, 'SHORT', '#ffb35b', 1.6, 1.8);
    } else if (outcome.voidedTwenties.length) {
      this.view.float(0, -1.6, 'No 20 on a foul', '#ffb35b', 1.1, 2.2);
    }
    this.state = state;
    this.hooks.onShotEnd?.(outcome, state);
    this.hooks.onChange?.(state);
    if (state.phase !== 'shooting' && state.lastRound) {
      if (state.highlight) {
        const h = state.highlight;
        setTimeout(() => {
          if (this.state === state) this.startReplay(h);
        }, 1300);
      } else this.startTally(state.lastRound);
    }
  }

  private startTally(result: RoundResult): void {
    const shown = result.tallies.map(() => 0);
    this.tally = { result, shown, done: false };
    this.tallyClock = 1.1;
    this.tallyQueue = [];
    // Interleave teams disc by disc, outside in.
    const maxLen = Math.max(...result.tallies.map((t) => t.discs.length));
    for (let i = 0; i < maxLen; i++) {
      for (const t of result.tallies) {
        const d = t.discs[i];
        if (!d) continue;
        this.tallyQueue.push(() => {
          this.glowIds.add(d.id);
          shown[t.team] += d.points;
          this.view.float(d.x, d.y + 0.9, d.points ? `+${d.points}` : '0', d.points ? TEAM_COLORS[t.team] : '#bbb', 1.1, 1.3);
          if (d.points) this.sfx.tick();
          this.hooks.onTally?.(this.tally!);
        });
      }
    }
    for (const t of result.tallies) {
      for (let k = 0; k < t.twenties; k++) {
        this.tallyQueue.push(() => {
          shown[t.team] += 20;
          this.view.float(0, 1.3 + k * 0.9, `+20`, TEAM_COLORS[t.team], 1.5, 1.4);
          this.sfx.chime();
          this.hooks.onTally?.(this.tally!);
        });
      }
    }
    this.hooks.onTally?.(this.tally);
  }

  /** After the tally: deal the next round. */
  continueRound(): void {
    if (this.state.phase !== 'round-over') return;
    this.state = nextRound(this.state);
    this.tally = null;
    this.glowIds.clear();
    this.fx = [];
    this.hooks.onChange?.(this.state);
  }

  /** Discs to draw right now, including fading/dropping effects. */
  frame(extra: Partial<Frame> = {}): Frame {
    const discs: DrawDisc[] = [];
    if (this.replay) {
      const r = this.replay;
      for (const d of r.live.sim.discs) discs.push({ id: d.id, team: d.team, x: d.x, y: d.y });
      const now = performance.now();
      this.fx = this.fx.filter((f) => now < f.start + f.dur);
      for (const f of this.fx) {
        const t = Math.max(0, (now - f.start) / f.dur);
        discs.push({ ...f.disc, alpha: 1 - t, scale: f.kind === 'hole' ? 1 - 0.6 * t : 1 });
      }
      const s = this.state;
      const b = r.highlight.before;
      return {
        ...extra,
        discs: r.intro > 0 ? discs.filter((d) => d.id !== r.live.shotId) : discs,
        state: replayState(s, r.highlight),
        activeSeat: r.intro > 0 ? r.highlight.seat : null,
        aim: r.intro > 0 ? { shot: { ...r.highlight.shot, power: r.highlight.shot.power * Math.min(1, (1.1 - r.intro) / 0.8) }, team: s.teamOfSeat[r.highlight.seat], solid: true } : null,
        stacks: s.seats.map((seat) => ({ seat, team: s.teamOfSeat[seat], count: b.discsLeft[seat] - (seat === r.highlight.seat ? 1 : 0) })),
        holders: twentyHolders(replayState(s, r.highlight), r.live.sim.twenties),
        replaying: true,
      };
    }
    if (this.live) {
      for (const d of this.live.sim.discs) discs.push({ id: d.id, team: d.team, x: d.x, y: d.y });
    } else {
      for (const d of this.state.board) discs.push({ id: d.id, team: d.team, x: d.x, y: d.y, glow: this.glowIds.has(d.id) });
    }
    const now = performance.now();
    this.fx = this.fx.filter((f) => now < f.start + f.dur);
    for (const f of this.fx) {
      const t = Math.max(0, (now - f.start) / f.dur);
      if (f.kind === 'fade') discs.push({ ...f.disc, alpha: 1 - t });
      else if (f.kind === 'hole') discs.push({ ...f.disc, scale: 1 - 0.6 * t, alpha: 1 - t });
      else {
        // Slide a little further out into the ditch and darken.
        const r = Math.hypot(f.disc.x, f.disc.y) || 1;
        const out = Math.min(BOARD.ditchR - BOARD.discR, r + 0.8 * t) / r;
        discs.push({ ...f.disc, x: f.disc.x * out, y: f.disc.y * out, alpha: 1 - 0.7 * t });
      }
    }
    const s = this.state;
    return {
      discs,
      state: s,
      activeSeat: !this.live && s.phase === 'shooting' ? currentSeat(s) : null,
      stacks: s.seats.map((seat) => ({ seat, team: s.teamOfSeat[seat], count: s.discsLeft[seat] - (this.live?.shot.seat === seat ? 1 : 0) })),
      holders: twentyHolders(s, this.live?.sim.twenties),
      ...extra,
    };
  }
}

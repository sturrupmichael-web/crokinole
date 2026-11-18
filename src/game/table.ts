/**
 * The table: owns the authoritative GameState on this device, animates each
 * shot by stepping the real Sim in (fixed-step) real time, plays sounds and
 * callouts, and runs the disc-by-disc round tally. Used by local mode and by
 * the party-mode host.
 */
import { BOARD, PHYSICS, type Seat } from '../engine/board';
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
import type { Sfx } from '../ui/audio';
import { type BoardView, type DrawDisc, type Frame, TEAM_COLORS } from '../render/view';

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

export interface TableHooks {
  onShotEnd?(outcome: ShotOutcome, state: GameState): void;
  onTally?(p: TallyProgress): void;
  onChange?(state: GameState): void;
}

export class Table {
  state: GameState;
  live: LiveShot | null = null;
  tally: TallyProgress | null = null;
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

  get moving(): boolean {
    return this.live !== null;
  }

  canShoot(seat: Seat): boolean {
    return !this.live && !this.tally && this.state.phase === 'shooting' && currentSeat(this.state) === seat;
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
    this.fx = [];
  }

  update(dt: number): void {
    if (this.live) this.stepShot(dt);
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
      const before = new Map<number, SimDisc>(sim.discs.map((d) => [d.id, { ...d }]));
      sim.step();
      this.acc -= PHYSICS.dt;
      for (; this.seenEvents < sim.events.length; this.seenEvents++) {
        const e = sim.events[this.seenEvents];
        this.sfx.event(e);
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
    }
    if (!sim.isMoving()) this.finish();
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
    if (state.phase !== 'shooting' && state.lastRound) this.startTally(state.lastRound);
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
      ...extra,
    };
  }
}

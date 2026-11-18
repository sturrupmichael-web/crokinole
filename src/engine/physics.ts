/**
 * Deterministic disc physics. Pure: no DOM, no Math.random, no wall-clock time.
 * A `Sim` advances in fixed `PHYSICS.dt` ticks, each split into enough substeps
 * that the fastest disc moves at most a quarter of its radius per substep, so
 * discs cannot tunnel through each other or the pegs.
 *
 * The renderer steps the same Sim in real time; the rules and the AI run it to
 * completion with `runToRest`. Same inputs, same floating-point operations in
 * the same order → same result, on every machine running the same JS engine.
 */
import { BOARD, PEGS, PHYSICS } from './board';

export interface SimDisc {
  id: number;
  /** Team that owns the disc (seat index in 2p/3p; 0 or 1 in 4p). */
  team: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export type SimEvent =
  | { t: number; kind: 'disc'; a: number; b: number; speed: number }
  | { t: number; kind: 'peg'; id: number; peg: number; speed: number }
  | { t: number; kind: 'ditch'; id: number }
  | { t: number; kind: 'twenty'; id: number }
  | { t: number; kind: 'penalty'; id: number; hole: number };

export class Sim {
  /** Discs still on the playing surface. */
  discs: SimDisc[];
  /** Discs that fell in the ditch, in order. */
  readonly ditched: SimDisc[] = [];
  /** Discs that dropped in the 20 hole, in order. */
  readonly twenties: SimDisc[] = [];
  /** Discs that dropped in a −10 hole (5-hole board), in order. */
  readonly penalties: SimDisc[] = [];
  /** Extra (−10) hole centres; empty on a classic board. */
  readonly holes: ReadonlyArray<{ x: number; y: number }>;
  readonly events: SimEvent[] = [];
  /** Ticks simulated so far. */
  ticks = 0;
  /** Called for every disc–disc contact (used by the rules to track the shot's chain of hits). */
  onContact: ((a: SimDisc, b: SimDisc) => void) | null = null;

  constructor(discs: SimDisc[], holes: ReadonlyArray<{ x: number; y: number }> = []) {
    this.discs = discs.map((d) => ({ ...d }));
    this.holes = holes;
  }

  get time(): number {
    return this.ticks * PHYSICS.dt;
  }

  isMoving(): boolean {
    for (const d of this.discs) if (d.vx !== 0 || d.vy !== 0) return true;
    return false;
  }

  /** Advance one fixed tick. */
  step(): void {
    const dt = PHYSICS.dt;
    let maxV = 0;
    for (const d of this.discs) {
      const v = Math.hypot(d.vx, d.vy);
      if (v > maxV) maxV = v;
    }
    if (maxV === 0) {
      this.ticks++;
      return;
    }
    const n = Math.max(1, Math.ceil((maxV * dt) / (BOARD.discR * PHYSICS.maxStepFrac)));
    const h = dt / n;
    for (let i = 0; i < n; i++) this.substep(h);
    this.applyFriction(dt);
    this.ticks++;
  }

  /** Step until nothing moves (or the safety cap). Returns this for chaining. */
  runToRest(): this {
    const cap = Math.ceil(PHYSICS.maxShotSeconds / PHYSICS.dt);
    while (this.isMoving() && this.ticks < cap) this.step();
    if (this.isMoving()) for (const d of this.discs) (d.vx = 0), (d.vy = 0);
    return this;
  }

  private substep(h: number): void {
    for (const d of this.discs) {
      d.x += d.vx * h;
      d.y += d.vy * h;
    }
    this.collideDiscs();
    this.collidePegs();
    this.checkEdges();
  }

  private collideDiscs(): void {
    const ds = this.discs;
    const minD = 2 * BOARD.discR;
    const e = PHYSICS.discRestitution;
    for (let i = 0; i < ds.length; i++) {
      const a = ds[i];
      for (let j = i + 1; j < ds.length; j++) {
        const b = ds[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= minD * minD || d2 === 0) continue;
        const dist = Math.sqrt(d2);
        const nx = dx / dist;
        const ny = dy / dist;
        // Separate the overlap equally (equal masses).
        const push = (minD - dist) / 2;
        a.x -= nx * push;
        a.y -= ny * push;
        b.x += nx * push;
        b.y += ny * push;
        // Relative velocity along the normal; > 0 means approaching.
        const vn = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
        if (vn <= 0) continue;
        const jImp = ((1 + e) * vn) / 2;
        a.vx -= jImp * nx;
        a.vy -= jImp * ny;
        b.vx += jImp * nx;
        b.vy += jImp * ny;
        this.events.push({ t: this.time, kind: 'disc', a: a.id, b: b.id, speed: vn });
        this.onContact?.(a, b);
      }
    }
  }

  private collidePegs(): void {
    const minD = BOARD.discR + BOARD.pegR;
    const e = PHYSICS.pegRestitution;
    for (const d of this.discs) {
      for (let p = 0; p < PEGS.length; p++) {
        const peg = PEGS[p];
        const dx = d.x - peg.x;
        const dy = d.y - peg.y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= minD * minD || d2 === 0) continue;
        const dist = Math.sqrt(d2);
        const nx = dx / dist;
        const ny = dy / dist;
        d.x = peg.x + nx * minD;
        d.y = peg.y + ny * minD;
        const vn = d.vx * nx + d.vy * ny;
        if (vn >= 0) continue;
        d.vx -= (1 + e) * vn * nx;
        d.vy -= (1 + e) * vn * ny;
        this.events.push({ t: this.time, kind: 'peg', id: d.id, peg: p, speed: -vn });
      }
    }
  }

  private checkEdges(): void {
    const keep: SimDisc[] = [];
    const capR2 = PHYSICS.holeCaptureR * PHYSICS.holeCaptureR;
    const edgeR2 = BOARD.surfaceR * BOARD.surfaceR;
    for (const d of this.discs) {
      const r2 = d.x * d.x + d.y * d.y;
      if (r2 > edgeR2) {
        d.vx = d.vy = 0;
        this.ditched.push(d);
        this.events.push({ t: this.time, kind: 'ditch', id: d.id });
      } else if (r2 <= capR2 && Math.hypot(d.vx, d.vy) <= PHYSICS.holeMaxSpeed) {
        d.vx = d.vy = 0;
        this.twenties.push(d);
        this.events.push({ t: this.time, kind: 'twenty', id: d.id });
      } else {
        const hole = this.penaltyHoleAt(d, capR2);
        if (hole >= 0) {
          d.vx = d.vy = 0;
          this.penalties.push(d);
          this.events.push({ t: this.time, kind: 'penalty', id: d.id, hole });
        } else keep.push(d);
      }
    }
    if (keep.length !== this.discs.length) this.discs = keep;
  }

  /** Index of the −10 hole this disc drops into now, or −1. Same capture rule as the 20 hole. */
  private penaltyHoleAt(d: SimDisc, capR2: number): number {
    for (let i = 0; i < this.holes.length; i++) {
      const dx = d.x - this.holes[i].x;
      const dy = d.y - this.holes[i].y;
      if (dx * dx + dy * dy <= capR2 && Math.hypot(d.vx, d.vy) <= PHYSICS.holeMaxSpeed) return i;
    }
    return -1;
  }

  /** Constant deceleration: speed drops by friction·dt each tick, never reversing. */
  private applyFriction(dt: number): void {
    const dv = PHYSICS.friction * dt;
    for (const d of this.discs) {
      const v = Math.hypot(d.vx, d.vy);
      if (v === 0) continue;
      const nv = v - dv;
      if (nv <= PHYSICS.stopSpeed) {
        d.vx = d.vy = 0;
      } else {
        const k = nv / v;
        d.vx *= k;
        d.vy *= k;
      }
    }
  }
}

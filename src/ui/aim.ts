/**
 * Slingshot input on a BoardView, for mouse and touch. Drag the disc along
 * the shooting line to position it; pull back (from the disc, or anywhere on
 * the screen) to aim and set power; release to shoot. Drag back to the start
 * to cancel. Used by local mode and the phone controller.
 */
import { ARC_HALF, BOARD, PHYSICS, type Seat, arcPoint, clamp, seatAngle } from '../engine/board';
import type { Shot } from '../engine/rules';
import type { BoardView } from '../render/view';

/** Screen pixels of pull for full power, scaled to the screen so phones and TVs feel alike. */
function fullPullPx(): number {
  return Math.max(150, Math.min(280, 0.46 * Math.min(window.innerWidth, window.innerHeight)));
}
const DEADZONE_PX = 12;

export interface AimHandlers {
  /** Live preview while lining up (null = nothing to show beyond the disc). */
  onPreview(shot: Shot, pulling: boolean): void;
  onShoot(shot: Shot): void;
  /** Called on each 10% power step (haptics/sound). */
  onTick?(): void;
}

export class AimInput {
  seat: Seat | null = null;
  baselinePos = 0.5;
  private mode: 'none' | 'undecided' | 'slide' | 'pull' = 'none';
  private start = { x: 0, y: 0 };
  private startPx = { x: 0, y: 0 };
  private startPos = 0.5;
  private pointerId: number | null = null;
  private lastTick = 0;
  current: Shot | null = null;

  constructor(
    private view: BoardView,
    private h: AimHandlers,
  ) {
    const el = view.canvas;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', () => this.cancel());
  }

  /** Enable for a seat (null disables). Keeps the disc's position between turns of the same seat. */
  enable(seat: Seat | null): void {
    if (seat !== this.seat) this.baselinePos = 0.5;
    this.seat = seat;
    this.cancel();
    if (seat != null) this.emit(false);
  }

  private shot(angle = 0, power = 0): Shot {
    return { seat: this.seat!, baselinePos: this.baselinePos, angle, power };
  }

  private world(e: PointerEvent): { x: number; y: number } {
    const r = this.view.canvas.getBoundingClientRect();
    return this.view.toWorld(e.clientX - r.left, e.clientY - r.top);
  }

  private down(e: PointerEvent): void {
    if (this.seat == null || this.pointerId != null) return;
    this.pointerId = e.pointerId;
    this.view.canvas.setPointerCapture(e.pointerId);
    const w = this.world(e);
    this.start = w;
    this.startPx = { x: e.clientX, y: e.clientY };
    this.startPos = this.baselinePos;
    const disc = arcPoint(this.seat, this.baselinePos);
    const onDisc = Math.hypot(w.x - disc.x, w.y - disc.y) < BOARD.discR * 2.4;
    const r = Math.hypot(w.x, w.y);
    const onArc = Math.abs(r - BOARD.r5) < 1.3 && Math.abs(this.arcOffset(w)) <= ARC_HALF + 0.08;
    if (onDisc) this.mode = 'undecided';
    else if (onArc) {
      this.mode = 'slide';
      this.slideTo(w);
    } else this.mode = 'pull';
  }

  private arcOffset(w: { x: number; y: number }): number {
    const a = Math.atan2(w.y, w.x) - seatAngle(this.seat!);
    return Math.atan2(Math.sin(a), Math.cos(a));
  }

  private slideTo(w: { x: number; y: number }): void {
    const off = clamp(this.arcOffset(w), -ARC_HALF, ARC_HALF);
    this.baselinePos = off / (2 * ARC_HALF) + 0.5;
    this.emit(false);
  }

  private move(e: PointerEvent): void {
    if (e.pointerId !== this.pointerId || this.seat == null) return;
    const w = this.world(e);
    const dx = w.x - this.start.x;
    const dy = w.y - this.start.y;
    if (this.mode === 'undecided') {
      if (Math.hypot(dx, dy) < 0.35) return;
      // Tangent to the arc at the disc vs. outward (away from centre).
      const a = Math.atan2(this.start.y, this.start.x);
      const outward = dx * Math.cos(a) + dy * Math.sin(a);
      const tangent = -dx * Math.sin(a) + dy * Math.cos(a);
      this.mode = Math.abs(tangent) > Math.abs(outward) * 1.2 ? 'slide' : 'pull';
    }
    if (this.mode === 'slide') {
      // Move by the drag along the arc, relative to where it started.
      const a0 = Math.atan2(this.start.y, this.start.x);
      const a1 = Math.atan2(w.y, w.x);
      let da = a1 - a0;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      this.baselinePos = clamp(this.startPos + da / (2 * ARC_HALF), 0, 1);
      this.emit(false);
    } else if (this.mode === 'pull') {
      this.emitPull(dx, dy, Math.hypot(e.clientX - this.startPx.x, e.clientY - this.startPx.y));
    }
  }

  private pullShot(dx: number, dy: number, px: number): Shot | null {
    if (px < DEADZONE_PX || Math.hypot(dx, dy) === 0) return null;
    const dir = Math.atan2(-dy, -dx);
    let angle = seatAngle(this.seat!) + Math.PI - dir;
    angle = Math.atan2(Math.sin(angle), Math.cos(angle));
    angle = clamp(angle, -PHYSICS.maxAimAngle, PHYSICS.maxAimAngle);
    const power = clamp((px - DEADZONE_PX) / fullPullPx(), 0, 1);
    return this.shot(angle, power);
  }

  private emitPull(dx: number, dy: number, px: number): void {
    const s = this.pullShot(dx, dy, px);
    if (!s) {
      this.emit(true);
      return;
    }
    const step = Math.floor(s.power * 10);
    if (step !== this.lastTick) {
      this.lastTick = step;
      this.h.onTick?.();
      try {
        navigator.vibrate?.(step === 10 ? 18 : 6);
      } catch {
        /* not supported */
      }
    }
    this.current = s;
    this.h.onPreview(s, true);
  }

  private emit(pulling: boolean): void {
    this.current = this.shot();
    this.h.onPreview(this.current, pulling);
  }

  private up(e: PointerEvent): void {
    if (e.pointerId !== this.pointerId) return;
    const mode = this.mode;
    this.pointerId = null;
    this.mode = 'none';
    if (mode !== 'pull' || this.seat == null) return;
    const w = this.world(e);
    const s = this.pullShot(w.x - this.start.x, w.y - this.start.y, Math.hypot(e.clientX - this.startPx.x, e.clientY - this.startPx.y));
    this.lastTick = 0;
    if (s && s.power > 0.01) this.h.onShoot(s);
    else this.emit(false);
  }

  cancel(): void {
    this.pointerId = null;
    this.mode = 'none';
    this.lastTick = 0;
  }
}

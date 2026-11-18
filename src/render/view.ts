/**
 * Live board view: draws the pre-rendered board, discs, the aim ghost, seat
 * highlights, disc stacks and floating callouts, with an optional rotation so
 * any seat can sit at the bottom.
 */
import { BOARD, type Seat, arcPoint, seatAngle } from '../engine/board';
import { type Shot, launch, type GameState } from '../engine/rules';
import { VIEW_R, renderBoardArt } from './art';

export const TEAM_COLORS = ['#c8372d', '#23885a', '#2f5fb8'];
export const TEAM_NAMES = ['Red', 'Green', 'Blue'];

export interface DrawDisc {
  id: number;
  team: number;
  x: number;
  y: number;
  /** 0–1, for fades. */
  alpha?: number;
  /** Scale (falling into the 20 or the ditch). */
  scale?: number;
  glow?: boolean;
}

interface Floater {
  x: number;
  y: number;
  text: string;
  color: string;
  born: number;
  life: number;
  size: number;
}

export interface Frame {
  discs: DrawDisc[];
  /** Seat whose arc is highlighted. */
  activeSeat?: Seat | null;
  /** Ghost of a shot being lined up. */
  aim?: { shot: Shot; team: number; solid?: boolean } | null;
  /** Discs in hand per seat, drawn as little stacks by the rail. */
  stacks?: { seat: Seat; team: number; count: number }[];
  labels?: { seat: Seat; text: string; team: number; dim?: boolean }[];
  /** Board state used to place the aim ghost (launch slides along the arc around discs). */
  state?: GameState;
}

export class BoardView {
  readonly canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private art: HTMLCanvasElement | null = null;
  private artScale = 0;
  scale = 10;
  cx = 0;
  cy = 0;
  /** Current and target rotation (radians, world → view). */
  rot = 0;
  private rotTarget = 0;
  private floaters: Floater[] = [];
  private dpr = 1;
  /** Fraction of the view radius to fit (lets the phone zoom in). */
  fit = { r: VIEW_R, offsetY: 0 };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d')!;
  }

  /** Put `seat` at the bottom of the view. */
  faceSeat(seat: Seat, instant = false): void {
    let target = -Math.PI / 2 - seatAngle(seat);
    // Turn the short way round.
    while (target - this.rot > Math.PI) target -= 2 * Math.PI;
    while (target - this.rot < -Math.PI) target += 2 * Math.PI;
    this.rotTarget = target;
    if (instant) this.rot = target;
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
    const w = rect.width;
    const h = rect.height;
    this.scale = Math.min(w, h) / (2 * this.fit.r);
    this.cx = w / 2;
    this.cy = h / 2 + this.fit.offsetY * this.scale;
    const want = this.scale * this.dpr;
    if (!this.art || Math.abs(want - this.artScale) > 0.01) {
      this.art = renderBoardArt(want);
      this.artScale = want;
    }
  }

  toScreen(x: number, y: number): [number, number] {
    const c = Math.cos(this.rot);
    const s = Math.sin(this.rot);
    const rx = x * c - y * s;
    const ry = x * s + y * c;
    return [this.cx + rx * this.scale, this.cy - ry * this.scale];
  }

  toWorld(px: number, py: number): { x: number; y: number } {
    const rx = (px - this.cx) / this.scale;
    const ry = -(py - this.cy) / this.scale;
    const c = Math.cos(-this.rot);
    const s = Math.sin(-this.rot);
    return { x: rx * c - ry * s, y: rx * s + ry * c };
  }

  float(x: number, y: number, text: string, color = '#fff', size = 1.4, life = 1.6): void {
    this.floaters.push({ x, y, text, color, born: performance.now(), life: life * 1000, size });
  }

  draw(frame: Frame, dt: number): void {
    // Ease the rotation.
    const k = 1 - Math.exp(-dt * 6);
    this.rot += (this.rotTarget - this.rot) * k;
    if (Math.abs(this.rotTarget - this.rot) < 1e-4) this.rot = this.rotTarget;

    const g = this.g;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // Static board.
    if (this.art) {
      g.save();
      g.translate(this.cx, this.cy);
      g.rotate(-this.rot);
      // Board drop shadow.
      g.shadowColor = 'rgba(0,0,0,0.55)';
      g.shadowBlur = 30;
      g.shadowOffsetY = 10;
      const size = this.art.width / this.dpr;
      g.drawImage(this.art, -size / 2, -size / 2, size, size);
      g.restore();
    }

    if (frame.activeSeat != null) this.drawArc(frame.activeSeat);
    if (frame.stacks) for (const st of frame.stacks) this.drawStack(st.seat, st.team, st.count);
    if (frame.labels) for (const l of frame.labels) this.drawLabel(l.seat, l.text, l.team, l.dim);

    for (const d of frame.discs) this.drawDisc(d);
    if (frame.aim) this.drawAim(frame.aim.shot, frame.aim.team, frame.state, frame.aim.solid);
    this.drawFloaters();
  }

  private drawArc(seat: Seat): void {
    const g = this.g;
    const a0 = seatAngle(seat);
    g.save();
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(255,236,170,0.55)';
    g.lineWidth = BOARD.discR * 1.6 * this.scale;
    g.globalAlpha = 0.45 + 0.15 * Math.sin(performance.now() / 300);
    g.beginPath();
    const steps = 24;
    for (let i = 0; i <= steps; i++) {
      const a = a0 - Math.PI / 4 + (i / steps) * (Math.PI / 2);
      const [x, y] = this.toScreen(BOARD.r5 * Math.cos(a), BOARD.r5 * Math.sin(a));
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
    g.restore();
  }

  drawDisc(d: DrawDisc): void {
    const g = this.g;
    const [x, y] = this.toScreen(d.x, d.y);
    const r = BOARD.discR * this.scale * (d.scale ?? 1);
    const col = TEAM_COLORS[d.team] ?? '#888';
    g.save();
    g.globalAlpha = d.alpha ?? 1;
    if (d.glow) {
      g.shadowColor = 'rgba(255,240,150,0.95)';
      g.shadowBlur = r * 1.6;
    } else {
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.beginPath();
      g.arc(x + r * 0.12, y + r * 0.18, r, 0, Math.PI * 2);
      g.fill();
    }
    const grad = g.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
    grad.addColorStop(0, shade(col, 0.35));
    grad.addColorStop(0.7, col);
    grad.addColorStop(1, shade(col, -0.45));
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    g.shadowBlur = 0;
    // Turned groove on the top face.
    g.strokeStyle = shade(col, -0.35);
    g.lineWidth = Math.max(1, r * 0.08);
    g.beginPath();
    g.arc(x, y, r * 0.62, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.25)';
    g.lineWidth = Math.max(0.8, r * 0.05);
    g.beginPath();
    g.arc(x, y, r * 0.88, Math.PI * 1.05, Math.PI * 1.6);
    g.stroke();
    g.restore();
  }

  private drawAim(shot: Shot, team: number, state: GameState | undefined, solid = false): void {
    const g = this.g;
    const l = state ? launch(state, shot) : (() => {
      const p = arcPoint(shot.seat, shot.baselinePos);
      const dir = seatAngle(shot.seat) + Math.PI - shot.angle;
      return { x: p.x, y: p.y, vx: Math.cos(dir), vy: Math.sin(dir) };
    })();
    const sp = Math.hypot(l.vx, l.vy) || 1;
    const ux = l.vx / sp;
    const uy = l.vy / sp;
    if (shot.power > 0.01) {
      const len = 2 + shot.power * 9;
      const [x0, y0] = this.toScreen(l.x + ux * BOARD.discR, l.y + uy * BOARD.discR);
      const [x1, y1] = this.toScreen(l.x + ux * len, l.y + uy * len);
      g.save();
      const grad = g.createLinearGradient(x0, y0, x1, y1);
      const hot = `hsl(${120 - 120 * shot.power}, 85%, 55%)`;
      grad.addColorStop(0, hot);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.strokeStyle = grad;
      g.lineWidth = Math.max(2, 0.18 * this.scale);
      g.setLineDash([0.5 * this.scale, 0.35 * this.scale]);
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
      g.restore();
    }
    this.drawDisc({ id: -1, team, x: l.x, y: l.y, alpha: solid ? 1 : 0.6, glow: true });
  }

  private seatAnchor(seat: Seat, along: number, out: number): { x: number; y: number } {
    const a = seatAngle(seat) + along;
    return { x: out * Math.cos(a), y: out * Math.sin(a) };
  }

  private drawStack(seat: Seat, team: number, count: number): void {
    // A row of small discs just outside the rail, on the seat's right-hand side.
    for (let i = 0; i < count; i++) {
      const p = this.seatAnchor(seat, 0.42 + i * 0.062, BOARD.railR + 0.95);
      this.drawDisc({ id: -2, team, x: p.x, y: p.y, scale: 0.72 });
    }
  }

  private drawLabel(seat: Seat, text: string, team: number, dim = false): void {
    const g = this.g;
    const p = this.seatAnchor(seat, -0.66, BOARD.railR + 1.0);
    const [x, y] = this.toScreen(p.x, p.y);
    g.save();
    g.font = `700 ${Math.max(12, 0.95 * this.scale)}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.globalAlpha = dim ? 0.45 : 1;
    const h = Math.max(22, 1.45 * this.scale);
    const w = g.measureText(text).width + h * 1.3;
    g.fillStyle = 'rgba(20,12,6,0.75)';
    roundRect(g, x - w / 2, y - h / 2, w, h, h / 2);
    g.fill();
    g.fillStyle = TEAM_COLORS[team];
    g.beginPath();
    g.arc(x - w / 2 + h / 2, y, h * 0.22, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fbeed3';
    g.fillText(text, x + h * 0.22, y + 1);
    g.restore();
  }

  private drawFloaters(): void {
    const g = this.g;
    const now = performance.now();
    this.floaters = this.floaters.filter((f) => now - f.born < f.life);
    for (const f of this.floaters) {
      const t = (now - f.born) / f.life;
      const [x, y] = this.toScreen(f.x, f.y);
      g.save();
      g.globalAlpha = t < 0.15 ? t / 0.15 : 1 - Math.max(0, (t - 0.6) / 0.4);
      g.font = `900 ${f.size * this.scale}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineWidth = Math.max(3, f.size * this.scale * 0.14);
      g.strokeStyle = 'rgba(20,10,4,0.85)';
      const yy = y - t * 1.2 * this.scale;
      g.strokeText(f.text, x, yy);
      g.fillStyle = f.color;
      g.fillText(f.text, x, yy);
      g.restore();
    }
  }
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Lighten (amt > 0) or darken (amt < 0) a #rrggbb colour. */
export function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) =>
    Math.round(amt >= 0 ? c + (255 - c) * amt : c * (1 + amt)),
  );
  return `rgb(${ch[0]},${ch[1]},${ch[2]})`;
}


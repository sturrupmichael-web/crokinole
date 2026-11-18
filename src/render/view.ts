/**
 * Live board view: draws the pre-rendered board, discs, the aim ghost, seat
 * highlights, disc stacks and floating callouts, with an optional rotation so
 * any seat can sit at the bottom.
 */
import { BOARD, type Seat, arcPoint, seatAngle } from '../engine/board';
import { type Shot, launch, type GameState } from '../engine/rules';
import { VIEW_R, renderBoardArt } from './art';
import type { Scene3D, Disc3D } from './scene3d';

/** 'top': the flat top-down board. 'eye': 3D, from the shooter's side of the table. */
export type CameraMode = 'top' | 'eye';
const CAMERA_KEY = 'crokinole.camera';

export function loadCameraPref(): CameraMode {
  try {
    return localStorage.getItem(CAMERA_KEY) === 'eye' ? 'eye' : 'top';
  } catch {
    return 'top';
  }
}

function saveCameraPref(m: CameraMode): void {
  try {
    localStorage.setItem(CAMERA_KEY, m);
  } catch {
    /* storage blocked */
  }
}

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
  /** 20s holders (one per team, on its first seat's rail) and how many 20s are in each this round. */
  holders?: Holder[];
  labels?: { seat: Seat; text: string; team: number; dim?: boolean }[];
  /** Draw the slow-motion replay frame (vignette + REPLAY badge). */
  replaying?: boolean;
  /** Board state used to place the aim ghost (launch slides along the arc around discs). */
  state?: GameState;
}

export interface Holder {
  seat: Seat;
  team: number;
  count: number;
}

/** Where a team's 20s holder sits: on the rail, to the seat's left (the disc stack is on the right). */
export const HOLDER_ALONG = -0.36;
export const HOLDER_OUT = BOARD.railR + 0.8;

/**
 * One 20s holder per team with this round's 20s. `moving` adds discs that
 * have dropped in during a shot still in motion (a foul can still void them).
 */
export function twentyHolders(s: GameState, moving: ReadonlyArray<{ team: number }> = []): Holder[] {
  const out: Holder[] = [];
  for (let team = 0; team < s.teamCount; team++) {
    const seat = s.seats.find((x) => s.teamOfSeat[x] === team);
    if (seat == null) continue;
    out.push({ seat, team, count: (s.twenties[team] ?? 0) + moving.filter((d) => d.team === team).length });
  }
  return out;
}

export class BoardView {
  readonly canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private art: HTMLCanvasElement | null = null;
  private artScale = 0;
  private artFive = false;
  /** Draw the 5-hole board's −10 holes. */
  fiveHole = false;
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
  /** Requested camera; the 3D view takes over once it has loaded. */
  camera: CameraMode = 'top';
  private s3: Scene3D | null = null;
  private s3Loading: Promise<void> | null = null;
  /** Called when the camera actually changes (e.g. to update a button). */
  onCameraChange?: (m: CameraMode) => void;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d')!;
  }

  /** True while the 3D player's-eye view is drawing. */
  get eye(): boolean {
    return this.camera === 'eye' && this.s3 != null;
  }

  /** Switch camera. Loads the 3D renderer the first time; falls back to top-down if WebGL fails. */
  setCamera(m: CameraMode, save = true): void {
    this.camera = m;
    if (save) saveCameraPref(m);
    if (m === 'eye' && !this.s3) {
      this.s3Loading ??= import('./scene3d')
        .then(({ Scene3D }) => {
          this.s3 = new Scene3D(this.canvas);
          this.resize();
        })
        .catch((err) => {
          console.warn('3D view unavailable', err);
          this.camera = 'top';
          this.s3Loading = null;
        })
        .finally(() => {
          this.s3?.setVisible(this.camera === 'eye');
          this.onCameraChange?.(this.camera);
        });
      return;
    }
    this.s3?.setVisible(m === 'eye');
    this.onCameraChange?.(m);
  }

  /** Switch between the classic and 5-hole board art. */
  setFiveHole(on: boolean): void {
    if (on === this.fiveHole) return;
    this.fiveHole = on;
    this.resize();
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
    if (this.s3) {
      this.s3.resize(w, h, this.dpr);
    }
    this.scale = Math.min(w, h) / (2 * this.fit.r);
    this.cx = w / 2;
    this.cy = h / 2 + this.fit.offsetY * this.scale;
    const want = this.scale * this.dpr;
    if (!this.art || Math.abs(want - this.artScale) > 0.01 || this.artFive !== this.fiveHole) {
      this.art = renderBoardArt(want, this.fiveHole);
      this.artScale = want;
      this.artFive = this.fiveHole;
    }
  }

  toScreen(x: number, y: number): [number, number] {
    if (this.eye) return this.s3!.project(x, y);
    const c = Math.cos(this.rot);
    const s = Math.sin(this.rot);
    const rx = x * c - y * s;
    const ry = x * s + y * c;
    return [this.cx + rx * this.scale, this.cy - ry * this.scale];
  }

  toWorld(px: number, py: number): { x: number; y: number } {
    if (this.eye) return this.s3!.unproject(px, py);
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

    if (this.eye) {
      this.drawEye(frame);
      return;
    }

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
    if (frame.holders) for (const h of frame.holders) this.drawHolder(h);
    if (frame.labels) for (const l of frame.labels) this.drawLabel(l.seat, l.text, l.team, l.dim);

    for (const d of frame.discs) this.drawDisc(d);
    if (frame.aim) this.drawAim(frame.aim.shot, frame.aim.team, frame.state, frame.aim.solid);
    this.drawFloaters();
    if (frame.replaying) this.drawReplayFrame();
  }

  /** 3D frame: the scene draws board and discs; this canvas only adds the overlays. */
  private drawEye(frame: Frame): void {
    const s3 = this.s3!;
    const discs: Disc3D[] = [...frame.discs];
    if (frame.stacks) {
      for (const st of frame.stacks) {
        for (let i = 0; i < st.count; i++) {
          const p = this.seatAnchor(st.seat, 0.42 + i * 0.062, BOARD.railR + 0.95);
          discs.push({ id: -2, team: st.team, x: p.x, y: p.y, scale: 0.72 });
        }
      }
    }
    for (const h of frame.holders ?? []) {
      const p = this.seatAnchor(h.seat, HOLDER_ALONG, HOLDER_OUT);
      for (let k = 0; k < Math.min(h.count, 9); k++) discs.push({ id: -3, team: h.team, x: p.x, y: p.y, scale: 0.9, level: k });
    }
    let aimLine: (() => void) | null = null;
    if (frame.aim) {
      const { shot, team, solid } = frame.aim;
      const l = this.launchOf(shot, frame.state);
      discs.push({ id: -1, team, x: l.x, y: l.y, alpha: solid ? 1 : 0.92, glow: true, ghost: !solid });
      aimLine = () => this.drawAimLine(shot, l);
    }
    // Pixels per inch at the centre, for overlay sizes.
    this.scale = s3.centerScale;
    s3.render(discs, this.rot, this.fiveHole, frame.activeSeat ?? null, frame.holders ?? []);
    if (frame.labels) for (const l of frame.labels) this.drawLabel(l.seat, l.text, l.team, l.dim);
    for (const h of frame.holders ?? []) {
      const p = this.seatAnchor(h.seat, HOLDER_ALONG, HOLDER_OUT);
      const [x, y] = s3.project(p.x, p.y, s3.holderTop);
      if (h.count > 0) this.drawCount(x, y - Math.max(12, 0.8 * this.scale), h.count, h.team);
    }
    aimLine?.();
    this.drawFloaters();
    if (frame.replaying) this.drawReplayFrame();
  }

  private drawReplayFrame(): void {
    const g = this.g;
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;
    g.save();
    const vig = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.55)');
    g.fillStyle = vig;
    g.fillRect(0, 0, w, h);
    // Blinking REC-style badge.
    const on = Math.floor(performance.now() / 600) % 2 === 0;
    const size = Math.max(14, Math.min(26, h * 0.035));
    g.font = `900 ${size}px system-ui, sans-serif`;
    g.textBaseline = 'middle';
    const label = 'REPLAY  ·  SLOW MOTION';
    const tw = g.measureText(label).width;
    const x = w / 2 - (tw + size * 1.6) / 2;
    const y = this.eye ? size * 1.6 : Math.max(size * 1.4, this.cy - 17.2 * this.scale);
    g.fillStyle = 'rgba(20,10,4,0.8)';
    roundRect(g, x - size * 0.6, y - size * 0.9, tw + size * 2.8, size * 1.8, size * 0.9);
    g.fill();
    g.fillStyle = on ? '#ff4b3e' : 'rgba(255,75,62,0.35)';
    g.beginPath();
    g.arc(x + size * 0.35, y, size * 0.35, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fbeed3';
    g.fillText(label, x + size * 1.1, y + 1);
    g.restore();
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

  private launchOf(shot: Shot, state: GameState | undefined): { x: number; y: number; vx: number; vy: number } {
    if (state) return launch(state, shot);
    const p = arcPoint(shot.seat, shot.baselinePos);
    const dir = seatAngle(shot.seat) + Math.PI - shot.angle;
    return { x: p.x, y: p.y, vx: Math.cos(dir), vy: Math.sin(dir) };
  }

  private drawAim(shot: Shot, team: number, state: GameState | undefined, solid = false): void {
    const l = this.launchOf(shot, state);
    this.drawAimLine(shot, l);
    this.drawDisc({ id: -1, team, x: l.x, y: l.y, alpha: solid ? 1 : 0.6, glow: true });
  }

  private drawAimLine(shot: Shot, l: { x: number; y: number; vx: number; vy: number }): void {
    const g = this.g;
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

  /** Top-down 20s holder: a brass-rimmed tube seen from above, the top 20 inside, the count beside it. */
  private drawHolder(h: Holder): void {
    const g = this.g;
    const p = this.seatAnchor(h.seat, HOLDER_ALONG, HOLDER_OUT);
    const [x, y] = this.toScreen(p.x, p.y);
    const r = BOARD.discR * 1.22 * this.scale;
    g.save();
    g.fillStyle = 'rgba(0,0,0,0.4)';
    g.beginPath();
    g.arc(x + r * 0.1, y + r * 0.16, r, 0, Math.PI * 2);
    g.fill();
    const rim = g.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
    rim.addColorStop(0, '#fff2cf');
    rim.addColorStop(0.55, '#d6ad62');
    rim.addColorStop(1, '#6e4a1b');
    g.fillStyle = rim;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#1a0f07';
    g.beginPath();
    g.arc(x, y, r * 0.8, 0, Math.PI * 2);
    g.fill();
    g.restore();
    if (h.count > 0) {
      this.drawDisc({ id: -3, team: h.team, x: p.x, y: p.y, scale: 0.86 });
      // The count sits on the board side of the holder.
      const a = seatAngle(h.seat) + HOLDER_ALONG;
      const tx = -Math.sin(a);
      const ty = Math.cos(a);
      const [bx, by] = this.toScreen(p.x + tx * 1.75, p.y + ty * 1.75);
      this.drawCount(bx, by, h.count, h.team);
    }
  }

  /** Small gold pill with a number in it. */
  private drawCount(x: number, y: number, n: number, team: number): void {
    const g = this.g;
    const size = Math.max(13, 0.85 * this.scale);
    const text = `${n}`;
    g.save();
    g.font = `900 ${size}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const h = size * 1.45;
    const w = Math.max(h, g.measureText(text).width + size * 0.9);
    g.fillStyle = '#ffd866';
    g.strokeStyle = TEAM_COLORS[team] ?? '#888';
    g.lineWidth = Math.max(2, size * 0.14);
    roundRect(g, x - w / 2, y - h / 2, w, h, h / 2);
    g.fill();
    g.stroke();
    g.fillStyle = '#2a1606';
    g.fillText(text, x, y + 1);
    g.restore();
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
      const sc = this.eye ? Math.max(this.scale * 0.8, this.s3!.scaleAt(f.x, f.y)) : this.scale;
      g.save();
      g.globalAlpha = t < 0.15 ? t / 0.15 : 1 - Math.max(0, (t - 0.6) / 0.4);
      g.font = `900 ${f.size * sc}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineWidth = Math.max(3, f.size * sc * 0.14);
      g.strokeStyle = 'rgba(20,10,4,0.85)';
      const yy = y - t * 1.2 * sc;
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


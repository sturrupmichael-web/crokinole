/**
 * Static board art, drawn once to an offscreen canvas: maple surface with
 * grain, crisp ring and quadrant lines, faint zone numbers, the 20 hole, pegs,
 * the dark ditch and a walnut rail. World units are inches; seat 0 is at the
 * bottom of the image.
 */
import { BOARD, PEGS } from '../engine/board';
import { mulberry32 } from '../engine/rng';

export const VIEW_R = BOARD.railR + 2.2; // margin outside the rail for seat labels and disc stacks

export function renderBoardArt(pxPerInch: number): HTMLCanvasElement {
  const size = Math.ceil(2 * BOARD.railR * pxPerInch) + 4;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const s = pxPerInch;
  g.translate(size / 2, size / 2);
  g.scale(s, s); // 1 unit = 1 inch from here on (y down; the board is symmetric so no flip needed except for text)
  const lw = (px: number) => px / s;

  // Rail (walnut) with a soft bevel.
  const rail = g.createRadialGradient(0, 0, BOARD.ditchR, 0, 0, BOARD.railR);
  rail.addColorStop(0, '#3d2210');
  rail.addColorStop(0.35, '#6b3f1d');
  rail.addColorStop(0.75, '#57311a');
  rail.addColorStop(1, '#2c170a');
  g.fillStyle = rail;
  disc(g, BOARD.railR);
  g.fill();
  grain(g, BOARD.railR, BOARD.ditchR, 'rgba(25,10,2,0.18)', 7, s);

  // Ditch: a dark recess, deeper toward the rail.
  const ditch = g.createRadialGradient(0, 0, BOARD.surfaceR, 0, 0, BOARD.ditchR);
  ditch.addColorStop(0, '#1d120a');
  ditch.addColorStop(0.5, '#2a1a0f');
  ditch.addColorStop(1, '#120a05');
  g.fillStyle = ditch;
  disc(g, BOARD.ditchR);
  g.fill();

  // Playing surface: maple, slightly warmer toward the edge.
  const maple = g.createRadialGradient(-3, -4, 1, 0, 0, BOARD.surfaceR);
  maple.addColorStop(0, '#f3d9a8');
  maple.addColorStop(0.6, '#e7c48c');
  maple.addColorStop(1, '#d5a96b');
  g.fillStyle = maple;
  disc(g, BOARD.surfaceR);
  g.fill();
  g.save();
  disc(g, BOARD.surfaceR);
  g.clip();
  grain(g, BOARD.surfaceR, 0, 'rgba(150,95,40,0.10)', 3, s);
  // Lacquer sheen.
  const sheen = g.createLinearGradient(-BOARD.surfaceR, -BOARD.surfaceR, BOARD.surfaceR, BOARD.surfaceR);
  sheen.addColorStop(0, 'rgba(255,255,255,0.16)');
  sheen.addColorStop(0.45, 'rgba(255,255,255,0)');
  sheen.addColorStop(1, 'rgba(80,40,10,0.10)');
  g.fillStyle = sheen;
  g.fillRect(-BOARD.surfaceR, -BOARD.surfaceR, 2 * BOARD.surfaceR, 2 * BOARD.surfaceR);
  g.restore();
  // Inner edge shadow of the surface into the ditch.
  g.strokeStyle = 'rgba(0,0,0,0.45)';
  g.lineWidth = lw(3);
  disc(g, BOARD.surfaceR);
  g.stroke();

  // Faint zone numbers along each seat axis.
  g.fillStyle = 'rgba(90,50,15,0.16)';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `700 1.5px Georgia, serif`;
  for (let k = 0; k < 4; k++) {
    g.save();
    g.rotate((k * Math.PI) / 2);
    for (const [r, t] of [
      [2.35, '15'],
      [6, '10'],
      [10, '5'],
    ] as const) {
      g.fillText(t, 0, r);
    }
    g.restore();
  }

  // Ring lines and quadrant lines.
  g.strokeStyle = '#3a210d';
  g.lineWidth = Math.max(lw(1.2), 0.055);
  for (const r of [BOARD.r15, BOARD.r10, BOARD.r5]) {
    disc(g, r);
    g.stroke();
  }
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2;
    g.beginPath();
    g.moveTo(BOARD.r15 * Math.cos(a), BOARD.r15 * Math.sin(a));
    g.lineTo(BOARD.r5 * Math.cos(a), BOARD.r5 * Math.sin(a));
    g.stroke();
  }

  // The 20 hole.
  const hole = g.createRadialGradient(0.15, 0.15, 0.05, 0, 0, BOARD.holeR);
  hole.addColorStop(0, '#000');
  hole.addColorStop(0.75, '#140b05');
  hole.addColorStop(1, '#4a2c12');
  g.fillStyle = hole;
  disc(g, BOARD.holeR);
  g.fill();
  g.strokeStyle = 'rgba(255,240,210,0.35)';
  g.lineWidth = lw(1);
  g.beginPath();
  g.arc(0, 0, BOARD.holeR, Math.PI * 0.1, Math.PI * 0.9);
  g.stroke();

  // Pegs (world y is up; the art is y-down, so flip y).
  for (const p of PEGS) {
    const x = p.x;
    const y = -p.y;
    g.fillStyle = 'rgba(0,0,0,0.35)';
    disc(g, BOARD.pegR * 1.05, x + 0.07, y + 0.09);
    g.fill();
    const pg = g.createRadialGradient(x - 0.06, y - 0.06, 0.01, x, y, BOARD.pegR);
    pg.addColorStop(0, '#fff6dd');
    pg.addColorStop(0.5, '#d9b26a');
    pg.addColorStop(1, '#7a5320');
    g.fillStyle = pg;
    disc(g, BOARD.pegR, x, y);
    g.fill();
  }
  return c;
}

function disc(g: CanvasRenderingContext2D, r: number, x = 0, y = 0): void {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
}

/** Concentric-ish wavy grain lines between radii, clipped by the caller. */
function grain(g: CanvasRenderingContext2D, rOuter: number, rInner: number, color: string, seed: number, s: number): void {
  const rng = mulberry32(seed);
  g.save();
  g.beginPath();
  g.arc(0, 0, rOuter, 0, Math.PI * 2);
  if (rInner > 0) g.arc(0, 0, rInner, 0, Math.PI * 2, true);
  g.clip('evenodd');
  g.strokeStyle = color;
  const lines = rInner > 0 ? 40 : 110;
  for (let i = 0; i < lines; i++) {
    g.lineWidth = (0.6 + rng() * 1.6) / s;
    const y0 = -rOuter + (2 * rOuter * i) / lines + rng() * 0.2;
    const amp = 0.15 + rng() * 0.5;
    const freq = 0.15 + rng() * 0.25;
    const ph = rng() * 10;
    g.beginPath();
    for (let x = -rOuter; x <= rOuter; x += 0.4) {
      const y = y0 + amp * Math.sin(x * freq + ph) + 0.25 * Math.sin(x * 0.9 + ph * 2);
      if (x === -rOuter) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }
  g.restore();
}

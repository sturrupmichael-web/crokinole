/**
 * Player's-eye 3D board (three.js), loaded on demand. It draws the board,
 * pegs and discs from the shooter's side of the table; BoardView keeps
 * drawing the flat overlays (aim line, labels, callouts) on its 2D canvas on
 * top, using `project` / `unproject` from here.
 *
 * World (inches, y up on the board) → three: (x, height, −y).
 */
import * as THREE from 'three';
import { BOARD, PEGS, PENALTY_HOLES, seatAngle, type Seat } from '../engine/board';
import { renderBoardArt } from './art';
import { HOLDER_ALONG, HOLDER_OUT, TEAM_COLORS, shade, type DrawDisc, type Holder } from './view';

const DISC_T = 0.38;
const DITCH_D = 0.45;
const RAIL_H = 0.9;
const TABLE_Y = -1.6;
const PEG_H = 0.55;
/** 20s holder: a clear tube on a walnut foot, standing against the rail. */
const HOLDER_H = 3.6;
const HOLDER_R = BOARD.discR * 1.12;
const ART_PX = 44;
/** Camera elevation above the board plane, seen from the board centre (higher on tall screens, which have room to spare). */
const ELEVATION_WIDE = (37 * Math.PI) / 180;
const ELEVATION_TALL = (52 * Math.PI) / 180;
const FOV = 38;

export interface Disc3D extends DrawDisc {
  /** Ghost/aim disc: glowing, see-through. */
  ghost?: boolean;
  /** Stacked in a 20s holder: 0 is the bottom disc. */
  level?: number;
}

function baseY(r: number): number {
  if (r <= BOARD.surfaceR + 0.05) return 0;
  if (r <= BOARD.ditchR) return -DITCH_D;
  if (r <= BOARD.railR) return RAIL_H;
  return TABLE_Y;
}

/** Top-face texture for a team's disc: turned grooves and a soft highlight. */
function discTopTexture(color: string): THREE.CanvasTexture {
  const n = 128;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d')!;
  const r = n / 2;
  const grad = g.createRadialGradient(r * 0.7, r * 0.6, r * 0.1, r, r, r);
  grad.addColorStop(0, shade(color, 0.3));
  grad.addColorStop(0.75, color);
  grad.addColorStop(1, shade(color, -0.35));
  g.fillStyle = grad;
  g.fillRect(0, 0, n, n);
  g.strokeStyle = shade(color, -0.4);
  g.lineWidth = n * 0.04;
  g.beginPath();
  g.arc(r, r, r * 0.62, 0, Math.PI * 2);
  g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.25)';
  g.lineWidth = n * 0.02;
  g.beginPath();
  g.arc(r, r, r * 0.86, 0, Math.PI * 2);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Planar UVs so the flat board art lines up with any horizontal mesh. */
function planarUV(geo: THREE.BufferGeometry, artInches: number): void {
  const pos = geo.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[2 * i] = 0.5 + pos.getX(i) / artInches;
    uv[2 * i + 1] = 0.5 - pos.getZ(i) / artInches;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

interface PoolDisc {
  mesh: THREE.Mesh;
  side: THREE.MeshStandardMaterial;
  top: THREE.MeshStandardMaterial;
  team: number;
}

export class Scene3D {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 400);
  private boardGroup = new THREE.Group();
  private artTex: THREE.CanvasTexture | null = null;
  private artFive: boolean | null = null;
  private artMats: THREE.Material[] = [];
  private discGeo = new THREE.CylinderGeometry(BOARD.discR, BOARD.discR, DISC_T, 48, 1);
  private topTex: THREE.CanvasTexture[] = TEAM_COLORS.map(discTopTexture);
  private pool: PoolDisc[] = [];
  private arc: THREE.Mesh;
  private arcSeat: Seat | null = null;
  private dist = 40;
  private look = 0;
  private elev = ELEVATION_WIDE;
  private w = 1;
  private h = 1;
  /** Pixels per inch at the board centre (for overlay text sizes). */
  centerScale = 10;
  private tubes: THREE.Group[] = [];
  /** Height of the top of a 20s holder tube (for the count above it). */
  readonly holderTop = TABLE_Y + HOLDER_H + 0.3;
  private ray = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  constructor(under: HTMLCanvasElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.pointerEvents = 'none';
    under.parentElement!.insertBefore(this.canvas, under);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // Lights: soft sky fill plus a warm key light that casts disc shadows.
    this.scene.add(new THREE.HemisphereLight(0xfff3e0, 0x3a2414, 1.25));
    const key = new THREE.DirectionalLight(0xfff0d8, 2.1);
    key.position.set(-14, 34, 10);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const sc = key.shadow.camera;
    sc.left = sc.bottom = -19;
    sc.right = sc.top = 19;
    sc.near = 5;
    sc.far = 80;
    key.shadow.bias = -0.0006;
    key.shadow.radius = 3;
    this.scene.add(key);

    // Table under the board.
    const table = new THREE.Mesh(
      new THREE.CircleGeometry(60, 64),
      new THREE.MeshStandardMaterial({ color: 0x24160d, roughness: 0.9 }),
    );
    table.rotation.x = -Math.PI / 2;
    table.position.y = TABLE_Y;
    table.receiveShadow = true;
    this.scene.add(table);
    this.scene.add(this.boardGroup);

    // Shooter's line highlight.
    this.arc = new THREE.Mesh(
      new THREE.RingGeometry(BOARD.r5 - BOARD.discR * 0.8, BOARD.r5 + BOARD.discR * 0.8, 40, 1, 0, Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffecaa, transparent: true, opacity: 0.4, depthWrite: false }),
    );
    this.arc.rotation.x = -Math.PI / 2;
    this.arc.position.y = 0.012;
    this.arc.visible = false;
    this.scene.add(this.arc);
  }

  private buildBoard(five: boolean): void {
    this.boardGroup.clear();
    this.artTex?.dispose();
    for (const m of this.artMats) m.dispose();
    this.artMats = [];
    const art = renderBoardArt(ART_PX, five);
    const tex = new THREE.CanvasTexture(art);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.artTex = tex;
    this.artFive = five;
    const artIn = art.width / ART_PX;
    const mat = (rough: number) => {
      const m = new THREE.MeshStandardMaterial({ map: tex, roughness: rough, metalness: 0 });
      this.artMats.push(m);
      return m;
    };
    const flat = (geo: THREE.BufferGeometry, y: number, m: THREE.Material) => {
      geo.rotateX(-Math.PI / 2);
      planarUV(geo, artIn);
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.y = y;
      mesh.receiveShadow = true;
      this.boardGroup.add(mesh);
    };
    const surface = mat(0.42);
    flat(new THREE.CircleGeometry(BOARD.surfaceR, 160), 0, surface);
    flat(new THREE.RingGeometry(BOARD.surfaceR, BOARD.ditchR, 160, 1), -DITCH_D, mat(0.85));
    const rail = mat(0.5);
    flat(new THREE.RingGeometry(BOARD.ditchR, BOARD.railR, 160, 1), RAIL_H, rail);

    const walnut = new THREE.MeshStandardMaterial({ color: 0x4a2a14, roughness: 0.55 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1a0f07, roughness: 0.9 });
    this.artMats.push(walnut, dark);
    const wall = (r: number, y0: number, y1: number, m: THREE.Material, side: THREE.Side) => {
      const geo = new THREE.CylinderGeometry(r, r, y1 - y0, 160, 1, true);
      const mesh = new THREE.Mesh(geo, m);
      (m as THREE.MeshStandardMaterial).side = side;
      mesh.position.y = (y0 + y1) / 2;
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      this.boardGroup.add(mesh);
    };
    wall(BOARD.surfaceR, -DITCH_D, 0, dark, THREE.FrontSide);
    const inner = walnut.clone();
    this.artMats.push(inner);
    wall(BOARD.ditchR, -DITCH_D, RAIL_H, inner, THREE.BackSide);
    wall(BOARD.railR, TABLE_Y, RAIL_H, walnut, THREE.FrontSide);

    // Holes: a short dark well under each so they read as holes, not paint.
    const holes = [{ x: 0, y: 0 }, ...(five ? PENALTY_HOLES : [])];
    const well = new THREE.MeshBasicMaterial({ color: 0x050302, side: THREE.BackSide });
    this.artMats.push(well);
    for (const h of holes) {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(BOARD.holeR, BOARD.holeR, 0.6, 32, 1, true), well);
      m.position.set(h.x, -0.3, -h.y);
      this.boardGroup.add(m);
    }

    // Pegs.
    const brass = new THREE.MeshStandardMaterial({ color: 0xd9b26a, metalness: 0.65, roughness: 0.3 });
    this.artMats.push(brass);
    const pegGeo = new THREE.CylinderGeometry(BOARD.pegR, BOARD.pegR * 1.08, PEG_H, 20);
    for (const p of PEGS) {
      const m = new THREE.Mesh(pegGeo, brass);
      m.position.set(p.x, PEG_H / 2, -p.y);
      m.castShadow = true;
      this.boardGroup.add(m);
    }
  }

  resize(w: number, h: number, dpr: number): void {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.renderer.setPixelRatio(Math.min(dpr, 2));
    this.renderer.setSize(this.w, this.h, false);
    this.camera.aspect = this.w / this.h;
    this.camera.updateProjectionMatrix();
    this.fitDistance();
  }

  /**
   * Bring the camera as close as it can get while the whole board still fits,
   * sliding the look-at point along the seat axis to use the space best.
   */
  private fitDistance(): void {
    const portrait = this.h > this.w;
    this.elev = portrait ? ELEVATION_TALL : ELEVATION_WIDE;
    // Leave room under the near rail to pull back on landscape screens.
    const bottom = portrait ? -0.8 : -0.6;
    const top = 0.9;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2;
      pts.push(new THREE.Vector3(BOARD.railR * Math.cos(a), RAIL_H, -BOARD.railR * Math.sin(a)));
      // The disc stacks just outside the rail on the table.
      pts.push(new THREE.Vector3((BOARD.railR + 1.4) * Math.cos(a), TABLE_Y + DISC_T, -(BOARD.railR + 1.4) * Math.sin(a)));
    }
    // Tops of the 20s holders (and the count above them) only need to clear the top edge.
    const tops: THREE.Vector3[] = [];
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2;
      tops.push(new THREE.Vector3(HOLDER_OUT * Math.cos(a), this.holderTop + 1.3, -HOLDER_OUT * Math.sin(a)));
    }
    const v = new THREE.Vector3();
    const fits = (d: number, k: number) => {
      this.place(0, d, k);
      for (let i = 0; i < pts.length; i++) {
        v.copy(pts[i]).project(this.camera);
        // Rail must fit; the disc stacks only need to clear the bottom.
        const side = i % 2 === 0 ? 0.985 : 9;
        if (v.z > 1 || v.x < -side || v.x > side || v.y > top || v.y < bottom) return false;
      }
      for (const p of tops) {
        v.copy(p).project(this.camera);
        if (v.y > 0.97) return false;
      }
      return true;
    };
    let best = { d: 60, k: 0 };
    outer: for (let d = 14; d < 160; d += 0.25) {
      for (let k = 0; k <= 10; k += 0.5) {
        for (const kk of k === 0 ? [0] : [k, -k]) {
          if (fits(d, kk)) {
            best = { d, k: kk };
            break outer;
          }
        }
      }
    }
    this.dist = best.d;
    this.look = best.k;
    this.place(0);
    const a = this.project(0, 0);
    const b = this.project(1, 0);
    this.centerScale = Math.hypot(b[0] - a[0], b[1] - a[1]);
  }

  /** Camera on the seat side: `rot` is BoardView's rotation (seat at the bottom). */
  private place(rot: number, d = this.dist, k = this.look): void {
    const th = -Math.PI / 2 - rot; // direction from centre toward the viewer's seat
    const c = Math.cos(th);
    const s = Math.sin(th);
    this.camera.position.set(d * Math.cos(this.elev) * c, d * Math.sin(this.elev), -d * Math.cos(this.elev) * s);
    // k > 0 looks past the centre (board sits lower on screen); k < 0 looks short of it.
    this.camera.lookAt(-k * c, 0, k * s);
    this.camera.updateMatrixWorld();
  }

  project(x: number, y: number, h = 0): [number, number] {
    const v = new THREE.Vector3(x, h, -y).project(this.camera);
    return [((v.x + 1) / 2) * this.w, ((1 - v.y) / 2) * this.h];
  }

  /** Pixels per inch at a board point (for text that sits on the board). */
  scaleAt(x: number, y: number): number {
    const a = this.project(x, y);
    const b = this.project(x + 0.5, y);
    const c = this.project(x, y + 0.5);
    return 2 * Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(c[0] - a[0], c[1] - a[1]));
  }

  unproject(px: number, py: number): { x: number; y: number } {
    const ndc = new THREE.Vector2((px / this.w) * 2 - 1, 1 - (py / this.h) * 2);
    this.ray.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (this.ray.ray.intersectPlane(this.plane, hit) && hit.distanceTo(this.camera.position) < 300) {
      return { x: hit.x, y: -hit.z };
    }
    // Above the horizon: a far point in that direction.
    const d = this.ray.ray.direction;
    const len = Math.hypot(d.x, d.z) || 1;
    return { x: this.camera.position.x + (d.x / len) * 200, y: -(this.camera.position.z + (d.z / len) * 200) };
  }

  private disc(i: number): PoolDisc {
    while (this.pool.length <= i) {
      const side = new THREE.MeshStandardMaterial({ roughness: 0.45, transparent: true });
      const top = new THREE.MeshStandardMaterial({ roughness: 0.35, transparent: true });
      const mesh = new THREE.Mesh(this.discGeo, [side, top, top]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      this.pool.push({ mesh, side, top, team: -1 });
    }
    return this.pool[i];
  }

  private tube(i: number): THREE.Group {
    while (this.tubes.length <= i) {
      const g = new THREE.Group();
      const glass = new THREE.Mesh(
        new THREE.CylinderGeometry(HOLDER_R, HOLDER_R, HOLDER_H, 40, 1, true),
        new THREE.MeshStandardMaterial({ color: 0xdfeeff, transparent: true, opacity: 0.22, roughness: 0.08, metalness: 0.1, side: THREE.DoubleSide, depthWrite: false }),
      );
      glass.position.y = HOLDER_H / 2 + 0.25;
      const brass = new THREE.MeshStandardMaterial({ color: 0xd9b26a, metalness: 0.65, roughness: 0.3 });
      const rim = new THREE.Mesh(new THREE.TorusGeometry(HOLDER_R, 0.06, 10, 40), brass);
      rim.rotation.x = Math.PI / 2;
      rim.position.y = HOLDER_H + 0.25;
      const foot = new THREE.Mesh(
        new THREE.CylinderGeometry(HOLDER_R * 1.25, HOLDER_R * 1.35, 0.25, 40),
        new THREE.MeshStandardMaterial({ color: 0x4a2a14, roughness: 0.55 }),
      );
      foot.position.y = 0.125;
      foot.castShadow = foot.receiveShadow = true;
      g.add(foot, glass, rim);
      g.position.y = TABLE_Y;
      this.scene.add(g);
      this.tubes.push(g);
    }
    return this.tubes[i];
  }

  render(discs: Disc3D[], rot: number, five: boolean, activeSeat: Seat | null, holders: Holder[] = []): void {
    holders.forEach((h, i) => {
      const a = seatAngle(h.seat) + HOLDER_ALONG;
      const t = this.tube(i);
      t.position.x = HOLDER_OUT * Math.cos(a);
      t.position.z = -HOLDER_OUT * Math.sin(a);
      t.visible = true;
    });
    for (let i = holders.length; i < this.tubes.length; i++) this.tubes[i].visible = false;

    if (this.artFive !== five) this.buildBoard(five);
    this.place(rot);

    if (activeSeat != null) {
      if (activeSeat !== this.arcSeat) {
        this.arc.rotation.z = seatAngle(activeSeat) - Math.PI / 4;
        this.arcSeat = activeSeat;
      }
      this.arc.visible = true;
      (this.arc.material as THREE.MeshBasicMaterial).opacity = 0.3 + 0.12 * Math.sin(performance.now() / 300);
    } else this.arc.visible = false;

    discs.forEach((d, i) => {
      const p = this.disc(i);
      const team = Math.max(0, Math.min(TEAM_COLORS.length - 1, d.team));
      if (p.team !== team) {
        p.team = team;
        p.side.color.set(shade(TEAM_COLORS[team], -0.2));
        p.top.map = this.topTex[team];
        p.top.color.set(0xffffff);
        p.top.needsUpdate = true;
      }
      const s = d.scale ?? 1;
      const r = Math.hypot(d.x, d.y);
      let y = d.level != null ? TABLE_Y + 0.25 + DISC_T * (d.level + 0.5) : baseY(r) + DISC_T / 2;
      // Falling into a hole: sink as it shrinks.
      if (s < 1 && r < BOARD.surfaceR) y -= (1 - s) * 1.2;
      p.mesh.position.set(d.x, y, -d.y);
      p.mesh.scale.set(s, 1, s);
      const glow = d.glow || d.ghost;
      const alpha = d.alpha ?? 1;
      p.side.opacity = p.top.opacity = alpha;
      p.side.depthWrite = p.top.depthWrite = alpha > 0.95;
      const em = glow ? 0x4a3c12 : 0x000000;
      p.side.emissive.setHex(em);
      p.top.emissive.setHex(em);
      p.mesh.castShadow = !d.ghost;
      p.mesh.visible = alpha > 0.01;
    });
    for (let i = discs.length; i < this.pool.length; i++) this.pool[i].mesh.visible = false;

    this.renderer.render(this.scene, this.camera);
  }

  setVisible(on: boolean): void {
    this.canvas.style.display = on ? '' : 'none';
  }
}

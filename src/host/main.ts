/**
 * Party-mode host (the TV screen). Authoritative: it owns the GameState, runs
 * every shot through the physics, applies the rules and broadcasts the room
 * state. Phones only send names, aim previews and shots.
 */
import '../styles.css';
import QRCode from 'qrcode';
import type { Seat } from '../engine/board';
import { type Difficulty, chooseShotAsync } from '../engine/ai';
import { mulberry32 } from '../engine/rng';
import { type GameState, type PlayerCount, type Shot, createGame, currentSeat, requirement } from '../engine/rules';
import { Table } from '../game/table';
import { BoardView, TEAM_COLORS } from '../render/view';
import { Sfx } from '../ui/audio';
import { Hud, REQ_TEXT, cameraButton, el, esc } from '../ui/hud';
import {
  type Envelope,
  MAX_PLAYERS,
  type RoomState,
  cleanName,
  isRoomCode,
  makeRoomCode,
  normalizeRoomCode,
  pidKey,
} from '../net/protocol';
import { createTransport, hasSupabase } from '../net/transport';
import { trackPresence } from '../net/presence';

const SAVE_KEY = 'crokinole.host.v1';
const SAVE_MAX_AGE = 6 * 3600 * 1000;
const CPU_LEVEL: Difficulty = 'medium';
const SEATS: Record<PlayerCount, Seat[]> = { 2: [0, 2], 3: [0, 1, 2], 4: [0, 1, 2, 3] };

interface Saved {
  room: string;
  rs: RoomState;
  pids: Record<string, number>;
  at: number;
}

function loadSaved(): Saved | null {
  try {
    const s = JSON.parse(localStorage.getItem(SAVE_KEY) ?? 'null') as Saved | null;
    if (s && Date.now() - s.at < SAVE_MAX_AGE && isRoomCode(s.room)) return s;
  } catch {
    /* ignore */
  }
  return null;
}

// ---- Room setup -------------------------------------------------------------
const params = new URLSearchParams(location.search);
const saved = loadSaved();
const wantRoom = normalizeRoomCode(params.get('room') ?? '');
const resume = saved && (!wantRoom || wantRoom === saved.room) && !params.has('new') ? saved : null;
const room = resume?.room ?? (isRoomCode(wantRoom) ? wantRoom : makeRoomCode());
history.replaceState(null, '', `?room=${room}`);

let rs: RoomState = resume?.rs ?? {
  v: 1,
  room,
  phase: 'lobby',
  players: [],
  seatPlayer: [null, null, null, null],
  target: 100,
  board: 'classic',
  game: null,
  moving: false,
  tallying: false,
  lastNews: '',
};
rs.moving = false;
rs.tallying = false;
/** pid → index into rs.players (pids are secret; only their hash is broadcast). */
const pids = new Map<string, number>(Object.entries(resume?.pids ?? {}));
const lastSeen = new Map<number, number>();
for (const p of rs.players) p.connected = p.cpu;

const transport = createTransport(room);
trackPresence('host');
const sfx = new Sfx();
const rng = mulberry32((Date.now() ^ 0x9e3779b9) >>> 0);

// ---- DOM --------------------------------------------------------------------
const app = document.getElementById('app')!;
const stage = el('div', 'stage');
const canvas = el('canvas');
stage.append(canvas);
app.append(stage);
const view = new BoardView(canvas);
const hud = new Hud(stage);
const lobby = el('div', 'lobby');
stage.append(lobby);
const tr = el('div', 'topright');
const soundBtn = el('button', 'iconbtn', sfx.enabled ? '🔊' : '🔇');
soundBtn.title = 'Sound';
soundBtn.addEventListener('click', () => {
  sfx.unlock();
  sfx.setEnabled(!sfx.enabled);
  soundBtn.textContent = sfx.enabled ? '🔊' : '🔇';
});
const menuBtn = el('button', 'iconbtn', '☰');
menuBtn.title = 'Room menu';
menuBtn.addEventListener('click', () => openMenu());
tr.append(cameraButton(view), soundBtn, menuBtn);
hud.root.append(tr);
document.addEventListener('pointerdown', () => sfx.unlock());
document.addEventListener('keydown', (e) => {
  sfx.unlock();
  if (e.key === ' ' || e.key === 'Enter' || e.key === 'Escape') table?.skipReplay();
});

const base = import.meta.env.BASE_URL;
const joinUrl = `${location.origin}${base}join/?room=${room}`;
const joinShort = `${location.host}${base}join`;

// ---- Table ------------------------------------------------------------------
let table: Table | null = null;
let previews = new Map<Seat, { shot: Shot; at: number }>();
let cpuBusy = false;
let tallyTimer: number | undefined;
/** The game-over screen is up on the TV, so phones may show the winner too. */
let resultShown = false;

function names(): string[] {
  const n = ['', '', '', ''];
  rs.seatPlayer.forEach((idx, seat) => {
    if (idx != null) n[seat] = rs.players[idx]?.name ?? '';
  });
  return n;
}

function makeTable(game: GameState): Table {
  return new Table(game, view, sfx, {
    onShotEnd: (o, s) => {
      rs.game = s;
      rs.lastNews = o.foul ? 'Foul!' : o.twenties.length ? '20!' : o.short ? 'Short' : '';
      if (!o.foul && o.twenties.length) hud.shout(o.twenties.length > 1 ? `${o.twenties.length}× 20!` : '20!');
    },
    onReplay: (h) => {
      hud.showReplay(h, table!.state, names(), () => table?.skipReplay());
      if (h) sfx.chime();
      broadcast();
    },
    onTally: (p) => {
      hud.showTally(p, table!.state, names(), p.done ? () => afterTally() : undefined, table!.state.phase === 'game-over' ? 'See result' : 'Next round');
      if (p.done) {
        hud.renderScores(table!.state, names());
        clearTimeout(tallyTimer);
        tallyTimer = window.setTimeout(afterTally, table!.state.phase === 'round-over' ? 9000 : 6000);
      }
      broadcast();
    },
    onChange: (s) => {
      rs.game = s;
      rs.moving = table?.moving ?? false;
      hud.renderScores(s, names(), table?.scoresPending ?? false);
      broadcast();
    },
  });
}

function afterTally(): void {
  clearTimeout(tallyTimer);
  if (!table) return;
  hud.showTally(null, table.state, names());
  if (table.state.phase === 'game-over') {
    resultShown = true;
    sfx.chime();
    hud.showModal(hud.gameOverHtml(table.state, names()), [
      ['Back to lobby', () => backToLobby()],
      ['Rematch', () => startGame(), true],
    ]);
    broadcast();
    return;
  }
  table.continueRound();
  broadcast();
}

// ---- Networking -------------------------------------------------------------
let lastBroadcast = 0;
let pendingBroadcast: number | undefined;
function broadcast(): void {
  if (table) {
    rs.game = table.state;
    rs.moving = table.moving;
    // The TV is busy with the end of a round (replay, tally) until the result has been revealed.
    rs.tallying = !resultShown && !table.moving && table.scoresPending;
  }
  const now = performance.now();
  const send = () => {
    pendingBroadcast = undefined;
    lastBroadcast = performance.now();
    transport.send('state', rs);
    save();
  };
  // Coalesce bursts (Realtime has a per-second message budget).
  if (now - lastBroadcast > 120) send();
  else if (pendingBroadcast === undefined) pendingBroadcast = window.setTimeout(send, 120);
  renderLobby();
}

function save(): void {
  if (rs.moving) return; // keep the last at-rest state; a refresh mid-shot replays the turn
  try {
    const data: Saved = { room, rs, pids: Object.fromEntries(pids), at: Date.now() };
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
  } catch {
    /* ignore */
  }
}

function error(pid: string, text: string): void {
  transport.send('err', { key: pidKey(pid), text });
}

transport.on('msg', (env: Envelope) => {
  if (!env || typeof env.pid !== 'string' || !env.m) return;
  const { pid, m } = env;
  let idx = pids.get(pid);
  if (idx !== undefined && !rs.players[idx]) {
    pids.delete(pid);
    idx = undefined;
  }
  if (idx !== undefined) {
    lastSeen.set(idx, Date.now());
    if (!rs.players[idx].connected) {
      rs.players[idx].connected = true;
      broadcast();
    }
  }
  switch (m.t) {
    case 'hello':
      broadcast();
      break;
    case 'join': {
      const name = cleanName(String(m.name ?? ''));
      if (!name) return error(pid, 'Enter a name');
      const same = rs.players.findIndex((p) => !p.cpu && p.name.toLowerCase() === name.toLowerCase());
      if (idx !== undefined && same === idx) return broadcast();
      if (same >= 0) {
        // Same name rejoins the same seat (e.g. a new phone or a cleared browser).
        // In the lobby a live player keeps their name; once playing, the name is the seat key.
        if (rs.phase === 'lobby' && rs.players[same].connected && idx !== same && Date.now() - (lastSeen.get(same) ?? 0) < 8000) {
          return error(pid, `“${name}” is already playing. Pick another name.`);
        }
        for (const [k, v] of pids) if (v === same) pids.delete(k);
        pids.set(pid, same);
        rs.players[same].key = pidKey(pid);
        rs.players[same].connected = true;
        lastSeen.set(same, Date.now());
        return broadcast();
      }
      if (idx !== undefined) {
        // Renaming in the lobby.
        if (rs.phase === 'lobby') rs.players[idx].name = name;
        return broadcast();
      }
      if (rs.phase !== 'lobby') return error(pid, 'This game has already started. Join with the same name to take back your seat.');
      if (rs.players.length >= MAX_PLAYERS) return error(pid, 'The table is full (4 players).');
      rs.players.push({ key: pidKey(pid), name, cpu: false, connected: true });
      pids.set(pid, rs.players.length - 1);
      lastSeen.set(rs.players.length - 1, Date.now());
      return broadcast();
    }
    case 'leave':
      if (idx !== undefined && rs.phase === 'lobby') removePlayer(idx);
      break;
    case 'aim': {
      const seat = idx !== undefined ? rs.seatPlayer.indexOf(idx) : -1;
      if (seat < 0 || !table || table.moving || currentSeat(table.state) !== seat) return;
      previews.set(seat as Seat, { shot: { seat: seat as Seat, ...sanitize(m.shot) }, at: performance.now() });
      break;
    }
    case 'shoot': {
      const seat = idx !== undefined ? rs.seatPlayer.indexOf(idx) : -1;
      if (seat < 0 || !table) return;
      if (m.turn !== table.state.nextId) return broadcast(); // stale or duplicate
      if (!table.canShoot(seat as Seat)) return broadcast();
      previews.delete(seat as Seat);
      shootAndTell({ seat: seat as Seat, ...sanitize(m.shot) });
      break;
    }
  }
});

/** Shoot on the table, and tell phones the shot so they can play the same (deterministic) physics live. */
function shootAndTell(shot: Shot): void {
  if (!table) return;
  const turn = table.state.nextId;
  if (table.shoot(shot)) transport.send('shot', { turn, shot });
}

function sanitize(s: { baselinePos: number; angle: number; power: number }): { baselinePos: number; angle: number; power: number } {
  const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : (lo + hi) / 2);
  return { baselinePos: num(s?.baselinePos, 0, 1), angle: num(s?.angle, -Math.PI / 2, Math.PI / 2), power: num(s?.power, 0, 1) };
}

// Presence: phones say hello every few seconds.
setInterval(() => {
  let changed = false;
  rs.players.forEach((p, i) => {
    if (p.cpu) return;
    const on = Date.now() - (lastSeen.get(i) ?? 0) < 9000;
    if (on !== p.connected) {
      p.connected = on;
      changed = true;
    }
  });
  if (changed) broadcast();
}, 2000);
// Keep late joiners and sleepy phones in sync.
setInterval(() => transport.send('state', rs), 5000);
window.addEventListener('beforeunload', () => save());

// ---- Lobby ------------------------------------------------------------------
function removePlayer(i: number): void {
  rs.players.splice(i, 1);
  const remap = new Map<string, number>();
  for (const [k, v] of pids) if (v !== i) remap.set(k, v > i ? v - 1 : v);
  pids.clear();
  for (const [k, v] of remap) pids.set(k, v);
  const seen = new Map<number, number>();
  for (const [k, v] of lastSeen) if (k !== i) seen.set(k > i ? k - 1 : k, v);
  lastSeen.clear();
  for (const [k, v] of seen) lastSeen.set(k, v);
  broadcast();
}

function addCpu(): void {
  if (rs.players.length >= MAX_PLAYERS) return;
  const taken = new Set(rs.players.map((p) => p.name));
  const pool = ['Robo Rita', 'Clank', 'Botley', 'Dot Matrix', 'Gizmo'];
  const name = pool.find((n) => !taken.has(n)) ?? `CPU ${rs.players.length + 1}`;
  rs.players.push({ key: `cpu-${Date.now().toString(36)}`, name, cpu: true, connected: true });
  broadcast();
}

/** Team of a lobby slot once seated, for the colour preview. */
function previewTeam(i: number, n: number): number {
  if (n === 4) return i % 2;
  return i;
}

let qrData = '';
void QRCode.toDataURL(joinUrl, { margin: 1, width: 360, color: { dark: '#1b120b', light: '#fbeed3' } }).then((d) => {
  qrData = d;
  renderLobby();
});

function renderLobby(): void {
  lobby.classList.toggle('hidden', rs.phase !== 'lobby');
  if (rs.phase !== 'lobby') return;
  const n = rs.players.length;
  const rows = rs.players
    .map((p, i) => {
      const team = previewTeam(i, Math.max(n, 2));
      const status = p.cpu ? 'computer' : p.connected ? '' : 'reconnecting…';
      return `<li><span class="dot" style="background:${TEAM_COLORS[team]}"></span><span class="tname">${esc(p.name)}</span><small class="muted">${status}</small><button class="btn small" data-kick="${i}" title="Remove">✕</button></li>`;
    })
    .join('');
  const empty = Array.from({ length: MAX_PLAYERS - n }, () => `<li class="empty"><span class="dot"></span><span class="muted">Waiting for a player…</span></li>`).join('');
  const teams = n === 4 ? `<p class="muted small">Partners sit opposite: ${esc(rs.players[0].name)} & ${esc(rs.players[2].name)} vs ${esc(rs.players[1].name)} & ${esc(rs.players[3].name)}.</p>` : '';
  const local = hasSupabase() ? '' : `<p class="warn">Offline test mode: phones must be tabs in this browser.</p>`;
  lobby.innerHTML = `
    <div class="lobby-card">
      <div class="join-col">
        <div class="kicker">Join on your phone</div>
        <div class="url">${esc(joinShort)}</div>
        <div class="kicker">Room code</div>
        <div class="code">${room}</div>
        ${qrData ? `<img class="qr" src="${qrData}" alt="QR code to join room ${room}" />` : ''}
      </div>
      <div class="players-col">
        <h2>Players <span class="muted">${n}/4</span></h2>
        <ul class="players">${rows}${empty}</ul>
        ${teams}
        <div class="row"><label class="muted">Game to</label>
          <div class="seg"><button data-target="50" class="${rs.target === 50 ? 'on' : ''}">50</button><button data-target="100" class="${rs.target === 100 ? 'on' : ''}">100</button></div>
        </div>
        <div class="row"><label class="muted">Board</label>
          <div class="seg"><button data-board="classic" class="${rs.board !== 'five-hole' ? 'on' : ''}">Classic</button><button data-board="five-hole" class="${rs.board === 'five-hole' ? 'on' : ''}">5-hole (−10s)</button></div>
        </div>
        <div class="lobby-actions">
          <button class="btn" data-act="cpu" ${n >= MAX_PLAYERS ? 'disabled' : ''}>Add computer player</button>
          <button class="btn primary" data-act="start" ${n < 2 ? 'disabled' : ''}>${n < 2 ? 'Need 2+ players' : 'Start game'}</button>
        </div>
        ${local}
      </div>
    </div>`;
  lobby.querySelectorAll<HTMLButtonElement>('[data-kick]').forEach((b) => b.addEventListener('click', () => removePlayer(Number(b.dataset.kick))));
  lobby.querySelectorAll<HTMLButtonElement>('[data-board]').forEach((b) =>
    b.addEventListener('click', () => {
      rs.board = b.dataset.board === 'five-hole' ? 'five-hole' : 'classic';
      view.setFiveHole(rs.board === 'five-hole');
      broadcast();
    }),
  );
  lobby.querySelectorAll<HTMLButtonElement>('[data-target]').forEach((b) =>
    b.addEventListener('click', () => {
      rs.target = Number(b.dataset.target) as 50 | 100;
      broadcast();
    }),
  );
  lobby.querySelector('[data-act=cpu]')?.addEventListener('click', addCpu);
  lobby.querySelector('[data-act=start]')?.addEventListener('click', () => startGame());
}

function startGame(): void {
  const n = rs.players.length as PlayerCount;
  if (n < 2 || n > 4) return;
  hud.hideModal();
  rs.seatPlayer = [null, null, null, null];
  SEATS[n].forEach((seat, i) => (rs.seatPlayer[seat] = i));
  const game = createGame({ players: n, target: rs.target, board: rs.board ?? 'classic' });
  view.setFiveHole(game.settings.board === 'five-hole');
  rs.phase = 'playing';
  rs.game = game;
  rs.lastNews = '';
  table = makeTable(game);
  resultShown = false;
  previews = new Map();
  hud.renderScores(game, names());
  hud.showTally(null, game, names());
  broadcast();
}

function backToLobby(): void {
  hud.hideModal();
  clearTimeout(tallyTimer);
  rs.phase = 'lobby';
  rs.game = null;
  rs.tallying = false;
  resultShown = false;
  table = null;
  hud.showTally(null, createGame({ players: 2, target: 100 }), []);
  hud.setBanner('');
  broadcast();
}

function openMenu(): void {
  const items: Array<[string, () => void, boolean?]> = [['Close', () => hud.hideModal()]];
  if (rs.phase === 'playing') {
    const seat = table ? currentSeat(table.state) : null;
    const idx = seat != null ? rs.seatPlayer[seat] : null;
    const p = idx != null ? rs.players[idx] : null;
    if (p && !p.cpu) items.push([`Computer plays for ${p.name}`, () => setCpu(idx!, true)]);
    const subs = rs.players.map((q, i) => [q, i] as const).filter(([q]) => q.cpu && !q.key.startsWith('cpu-'));
    for (const [q, i] of subs) items.push([`Give ${q.name} their seat back`, () => setCpu(i, false)]);
    items.push(['End game (back to lobby)', () => backToLobby()]);
  }
  items.push(['New room code', () => {
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch {
      /* ignore */
    }
    transport.send('closed', {});
    location.href = `${base}host/?new`;
  }]);
  hud.showModal(`<h2>Room ${room}</h2><p class="muted">Players join at ${esc(joinShort)}</p>`, items);
}

function setCpu(i: number, on: boolean): void {
  rs.players[i].cpu = on;
  rs.players[i].connected = on || Date.now() - (lastSeen.get(i) ?? 0) < 9000;
  hud.hideModal();
  broadcast();
}

// ---- Main loop --------------------------------------------------------------
if (rs.phase === 'playing' && rs.game) {
  table = makeTable(rs.game);
  hud.renderScores(rs.game, names());
  if (rs.game.phase !== 'shooting') {
    // Recovered between rounds: go straight to the next round / result.
    window.setTimeout(afterTally, 500);
  }
}

window.addEventListener('resize', () => view.resize());
view.faceSeat(0, true);
view.fiveHole = (rs.game?.settings.board ?? rs.board) === 'five-hole';
view.resize();
renderLobby();
broadcast();

let last = performance.now();
let lastTurnKey = '';
function loop(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const frameExtra: Parameters<Table['frame']>[0] = {};
  if (table) {
    table.update(dt);
    const s = table.state;
    const n = names();
    frameExtra.labels = s.seats.map((seat) => {
      const p = rs.players[rs.seatPlayer[seat] ?? -1];
      return { seat, text: p ? (p.connected ? p.name : `${p.name} (away)`) : '', team: s.teamOfSeat[seat], dim: s.phase === 'shooting' && currentSeat(s) !== seat };
    });
    // The 3D view looks from the shooter's seat; top-down keeps seat 0 at the bottom.
    if (!table.moving && s.phase === 'shooting') view.faceSeat(view.camera === 'eye' ? currentSeat(s) : 0);
    if (!table.moving && !table.tally && s.phase === 'shooting') {
      const seat = currentSeat(s);
      const p = rs.players[rs.seatPlayer[seat] ?? -1];
      const key = `${s.round}:${s.nextId}`;
      const team = s.teamOfSeat[seat];
      const who = `<span style="color:${TEAM_COLORS[team]}">●</span> ${esc(n[seat])}`;
      hud.setBanner(
        `${who} · <span class="req">${REQ_TEXT[requirement(s, seat)]}</span> · ${s.discsLeft[seat]} left${p && !p.connected && !p.cpu ? ' · <span class="muted">waiting to reconnect</span>' : ''}`,
        team,
      );
      if (p?.cpu && !cpuBusy && key !== lastTurnKey) {
        lastTurnKey = key;
        cpuBusy = true;
        void chooseShotAsync(s, CPU_LEVEL, rng).then((shot) => {
          const t0 = performance.now();
          const anim = () => {
            const k = Math.min(1, (performance.now() - t0) / 700);
            previews.set(seat, { shot: { ...shot, power: shot.power * k }, at: performance.now() });
            if (k < 1) requestAnimationFrame(anim);
            else
              setTimeout(() => {
                previews.delete(seat);
                cpuBusy = false;
                if (table && table.state === s) shootAndTell(shot);
              }, 200);
          };
          anim();
        });
      }
      const pv = previews.get(seat);
      if (pv && now - pv.at < 4000) frameExtra.aim = { shot: pv.shot, team };
    } else if (table.moving) {
      hud.setBanner('');
    } else {
      hud.setBanner('');
    }
  }
  view.draw(table ? table.frame(frameExtra) : { discs: [] }, dt);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__host = { get table() { return table; }, get rs() { return rs; }, broadcast };

// Tell phones the room is live.
void transport.ready.then(() => broadcast());

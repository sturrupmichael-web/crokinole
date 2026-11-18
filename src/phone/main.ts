/**
 * Phone controller. Joins a room by code and name, shows your seat's view of
 * the board, and turns a drag-and-pull-back into a shot for the host. Game
 * state always comes from the host; while a shot moves, the phone re-runs the
 * same deterministic physics so the discs animate there too.
 */
import '../styles.css';
import type { Seat } from '../engine/board';
import { type LiveShot, type Shot, beginShot, currentSeat, requirement } from '../engine/rules';
import { PHYSICS } from '../engine/board';
import { BoardView, TEAM_COLORS, twentyHolders } from '../render/view';
import { AimInput } from '../ui/aim';
import { REQ_TEXT, awardsHtml, cameraButton, el, esc, shownScores, teamLabel, verb } from '../ui/hud';
import { type PhoneMsg, type RoomState, cleanName, isRoomCode, normalizeRoomCode, pidKey, seatOfKey } from '../net/protocol';
import { type Transport, createTransport, hasSupabase } from '../net/transport';
import { trackPresence } from '../net/presence';

trackPresence('phone');

const app = document.getElementById('app')!;
const params = new URLSearchParams(location.search);
const store = (): Storage => (hasSupabase() ? localStorage : sessionStorage);
const LS = {
  get: (k: string) => {
    try {
      return store().getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      store().setItem(k, v);
    } catch {
      /* ignore */
    }
  },
};

function pidFor(room: string): string {
  const k = `crokinole.pid.${room}`;
  let pid = LS.get(k);
  if (!pid) {
    pid = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
    LS.set(k, pid);
  }
  return pid;
}

// ---- Join screen ------------------------------------------------------------
function showJoin(err = ''): void {
  app.innerHTML = '';
  const wrap = el('div', 'menu');
  const card = el('form', 'card');
  card.innerHTML = `<div class="disc-logo"></div><h1>Crokinole</h1><p class="tag">Join a game on the big screen</p>`;
  const code = el('input') as HTMLInputElement;
  code.placeholder = 'Room code';
  code.maxLength = 4;
  code.autocapitalize = 'characters';
  code.autocomplete = 'off';
  code.value = normalizeRoomCode(params.get('room') ?? LS.get('crokinole.lastRoom') ?? '');
  code.addEventListener('input', () => (code.value = normalizeRoomCode(code.value)));
  const name = el('input') as HTMLInputElement;
  name.placeholder = 'Your name';
  name.maxLength = 14;
  name.setAttribute('autocomplete', 'nickname');
  name.value = params.get('name') ?? localStorage.getItem('crokinole.name') ?? '';
  const go = el('button', 'btn primary', 'Join');
  go.type = 'submit';
  const box = el('div', 'actions');
  box.append(code, name, go);
  card.append(box);
  if (err) card.append(el('p', 'warn', esc(err)));
  card.append(el('p', 'howto', 'Use the same name to get your seat back if you drop out.'));
  card.addEventListener('submit', (e) => {
    e.preventDefault();
    const c = normalizeRoomCode(code.value);
    const n = cleanName(name.value);
    if (!isRoomCode(c)) return code.focus();
    if (!n) return name.focus();
    try {
      localStorage.setItem('crokinole.name', n);
    } catch {
      /* ignore */
    }
    LS.set('crokinole.lastRoom', c);
    history.replaceState(null, '', `?room=${c}`);
    play(c, n);
  });
  wrap.append(card);
  app.append(wrap);
  if (!code.value) code.focus();
  else if (!name.value) name.focus();
}

// ---- Controller -------------------------------------------------------------
function play(room: string, myName: string): void {
  const pid = pidFor(room);
  const key = pidKey(pid);
  const transport: Transport = createTransport(room);
  const send = (m: PhoneMsg) => transport.send('msg', { pid, m });

  app.innerHTML = '';
  const root = el('div', 'phone');
  const top = el('div', 'phone-top');
  const stageBox = el('div', 'phone-stage');
  const canvas = el('canvas');
  stageBox.append(canvas);
  const status = el('div', 'phone-status');
  const meter = el('div', 'meter hidden', '<div class="fill"></div><span></span>');
  const overlay = el('div', 'phone-overlay hidden');
  root.append(top, stageBox, status, meter, overlay);
  app.append(root);

  const view = new BoardView(canvas);
  stageBox.append(cameraButton(view));
  let rs: RoomState | null = null;
  let mySeat: Seat | null = null;
  let preview: Shot | null = null;
  let sentTurn = -1;
  let lastState = Date.now();
  let lastAimSent = 0;
  let errText = '';

  const aim = new AimInput(view, {
    onPreview: (shot, pulling) => {
      preview = shot;
      setMeter(pulling ? shot.power : null);
      const now = performance.now();
      if (now - lastAimSent > 110) {
        lastAimSent = now;
        send({ t: 'aim', shot: { baselinePos: shot.baselinePos, angle: shot.angle, power: shot.power } });
      }
    },
    onShoot: (shot) => {
      if (!rs?.game) return;
      sentTurn = rs.game.nextId;
      send({ t: 'shoot', shot: { baselinePos: shot.baselinePos, angle: shot.angle, power: shot.power }, turn: rs.game.nextId });
      try {
        navigator.vibrate?.([30, 40, 30]);
      } catch {
        /* ignore */
      }
      aim.enable(null);
      preview = null;
      setMeter(null);
      render();
    },
  });

  function setMeter(power: number | null): void {
    meter.classList.toggle('hidden', power == null);
    if (power == null) return;
    (meter.firstElementChild as HTMLElement).style.width = `${Math.round(power * 100)}%`;
    (meter.firstElementChild as HTMLElement).style.background = `hsl(${120 - 120 * power}, 80%, 50%)`;
    meter.querySelector('span')!.textContent = `Power ${Math.round(power * 100)}%`;
  }

  function myTurn(): boolean {
    const g = rs?.game;
    return !!g && rs!.phase === 'playing' && !rs!.moving && !rs!.tallying && g.phase === 'shooting' && mySeat != null && currentSeat(g) === mySeat && sentTurn !== g.nextId;
  }

  function render(): void {
    if (!rs) {
      top.innerHTML = `<b>Room ${room}</b><span class="muted">Connecting…</span>`;
      status.innerHTML = '';
      return;
    }
    const me = rs.players.find((p) => p.key === key);
    mySeat = seatOfKey(rs, key);
    const g = rs.game;
    const team = g && mySeat != null ? g.teamOfSeat[mySeat] : rs.players.findIndex((p) => p.key === key) % (rs.players.length === 4 ? 2 : 4);
    const color = TEAM_COLORS[team] ?? '#888';
    top.innerHTML = `<span class="dot" style="background:${color}"></span><b>${esc(me?.name ?? myName)}</b><span class="muted">Room ${room}</span>`;
    if (g) {
      const names = ['', '', '', ''];
      rs.seatPlayer.forEach((i, s) => i != null && (names[s] = rs!.players[i]?.name ?? ''));
      top.innerHTML += `<span class="scores">${shownScores(g, rs.tallying).map((s, t) => `<span><i class="dot" style="background:${TEAM_COLORS[t]}"></i>${s}</span>`).join('')}</span>`;
      if (g.phase === 'game-over' && !rs.tallying) {
        const w = g.winner ?? 0;
        const label = teamLabel(g, names, w);
        const mine = mySeat != null && g.teamOfSeat[mySeat] === w;
        overlay.innerHTML = `<div class="trophy">${mine ? '🏆' : '🎉'}</div><h2 style="color:${TEAM_COLORS[w]}">${esc(label)} ${verb(label, 'wins', 'win')}!</h2><p class="muted">Final: ${g.scores.join(' – ')}</p>${awardsHtml(g, names)}`;
        overlay.classList.remove('hidden');
      } else overlay.classList.add('hidden');
    }

    if (rs.phase === 'lobby' || !g) {
      overlay.classList.remove('hidden');
      const list = rs.players.map((p) => `<li>${esc(p.name)}${p.cpu ? ' <small class="muted">(computer)</small>' : ''}${p.key === key ? ' <small class="muted">(you)</small>' : ''}</li>`).join('');
      overlay.innerHTML = me
        ? `<h2>You're in!</h2><p class="muted">Waiting for the host to start.</p><ul class="plist">${list}</ul>`
        : `<h2>Joining…</h2>`;
      status.innerHTML = '';
      aim.enable(null);
      return;
    }
    if (mySeat == null) {
      overlay.classList.remove('hidden');
      overlay.innerHTML = `<h2>Game in progress</h2><p class="muted">You're watching. Join with the name you used before to take your seat back.</p>`;
      aim.enable(null);
      return;
    }
    if (g.phase !== 'game-over' || rs.tallying) overlay.classList.add('hidden');

    const cur = currentSeat(g);
    if (rs.moving) {
      status.innerHTML = `<b>👀 Watch the screen!</b>`;
      aim.enable(null);
    } else if (rs.tallying || g.phase !== 'shooting') {
      status.innerHTML = g.phase === 'game-over' && !rs.tallying ? '' : `<b>${g.phase === 'game-over' ? 'Final round' : `Round ${g.round}`} scoring</b><span class="muted">👀 Watch the big screen</span>`;
      aim.enable(null);
    } else if (myTurn()) {
      status.innerHTML = `<b class="go">Your turn!</b><span class="req">${REQ_TEXT[requirement(g, mySeat)]}</span><span class="muted">${g.discsLeft[mySeat]} disc${g.discsLeft[mySeat] === 1 ? '' : 's'} left · drag along the line, pull back, let go</span>`;
      if (aim.seat !== mySeat) {
        aim.enable(mySeat);
        try {
          navigator.vibrate?.(60);
        } catch {
          /* ignore */
        }
      }
    } else {
      const who = rs.players[rs.seatPlayer[cur] ?? -1]?.name ?? '…';
      const news = rs.lastNews ? `<span class="news">${esc(rs.lastNews)}</span>` : '';
      status.innerHTML = `${news}<b>${esc(who)}'s turn</b><span class="muted">${g.discsLeft[mySeat]} disc${g.discsLeft[mySeat] === 1 ? '' : 's'} left for you</span>`;
      aim.enable(null);
    }
    if (errText) status.innerHTML += `<span class="warn">${esc(errText)}</span>`;
  }

  // A shot in motion, re-simulated here from the host's shot (same deterministic physics).
  let live: LiveShot | null = null;
  let liveAcc = 0;
  transport.on('shot', (m: { turn: number; shot: Shot }) => {
    const g = rs?.game;
    if (!g || !m?.shot || g.nextId !== m.turn) return;
    try {
      live = beginShot(g, m.shot);
      liveAcc = 0;
    } catch {
      live = null;
    }
  });

  transport.on('state', (s: RoomState) => {
    if (!s || s.room !== room) return;
    // The shot has been applied (or abandoned): show the host's board from here on.
    if (live && (!s.moving || s.game?.nextId !== rs?.game?.nextId)) live = null;
    rs = s;
    lastState = Date.now();
    if (s.game && sentTurn !== -1 && s.game.nextId !== sentTurn) sentTurn = -1;
    view.setFiveHole((s.game?.settings.board ?? s.board) === 'five-hole');
    const seat = seatOfKey(s, key);
    if (seat != null && seat !== mySeat) {
      view.faceSeat(seat, true);
      view.resize();
    }
    // Not in the room yet (or the host restarted): ask to join.
    if (!s.players.some((p) => p.key === key) && (s.phase === 'lobby' || s.players.some((p) => p.name.toLowerCase() === myName.toLowerCase()))) send({ t: 'join', name: myName });
    render();
  });
  transport.on('err', (e: { key: string; text: string }) => {
    if (e?.key !== key) return;
    errText = e.text;
    if (!rs?.players.some((p) => p.key === key) && rs?.phase === 'lobby') {
      transport.close();
      showJoin(e.text);
      return;
    }
    render();
  });
  transport.on('closed', () => {
    overlay.classList.remove('hidden');
    overlay.innerHTML = `<h2>The host closed this room</h2><p class="muted">Ask for the new room code.</p>`;
    aim.enable(null);
  });

  void transport.ready.then(() => {
    send({ t: 'hello' });
    send({ t: 'join', name: myName });
  });
  const hb = setInterval(() => {
    send({ t: 'hello' });
    if (Date.now() - lastState > 10000) {
      top.innerHTML = `<b>Room ${room}</b><span class="warn">Reconnecting…</span>`;
    }
  }, 3000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') send({ t: 'hello' });
  });
  window.addEventListener('pagehide', () => clearInterval(hb));

  const resize = () => view.resize();
  window.addEventListener('resize', resize);
  view.resize();
  render();

  let last = performance.now();
  const loop = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const g = rs?.game;
    if (live) {
      liveAcc += dt;
      while (liveAcc >= PHYSICS.dt && live.sim.isMoving()) {
        liveAcc -= PHYSICS.dt;
        live.sim.step();
      }
    }
    if (g) {
      const discs = live ? live.sim.discs : g.board;
      view.draw(
        {
          discs: discs.map((d) => ({ id: d.id, team: d.team, x: d.x, y: d.y })),
          state: g,
          activeSeat: g.phase === 'shooting' && !rs!.moving ? currentSeat(g) : null,
          aim: preview && myTurn() ? { shot: preview, team: g.teamOfSeat[mySeat!] } : null,
          holders: twentyHolders(g, live?.sim.twenties),
          stacks: mySeat != null ? [{ seat: mySeat, team: g.teamOfSeat[mySeat], count: g.discsLeft[mySeat] - (live?.shot.seat === mySeat ? 1 : 0) }] : [],
        },
        dt,
      );
    } else view.draw({ discs: [] }, dt);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

// Straight in if we have everything; otherwise ask.
const r0 = normalizeRoomCode(params.get('room') ?? '');
// A refresh (or reopening the tab) with a seat already in this room rejoins straight away.
const n0 = cleanName(params.get('name') ?? (LS.get(`crokinole.pid.${r0}`) ? (localStorage.getItem('crokinole.name') ?? '') : ''));
if (isRoomCode(r0) && n0) play(r0, n0);
else showJoin();

/**
 * Landing page + local mode: one device, pass-and-play or against the
 * computer. Also links to the party-mode host and the phone join page.
 */
import '../styles.css';
import { type Seat } from '../engine/board';
import { type Difficulty, chooseShotAsync } from '../engine/ai';
import { mulberry32 } from '../engine/rng';
import { type GameState, type PlayerCount, type Shot, createGame, currentSeat, requirement } from '../engine/rules';
import { Table } from '../game/table';
import { BoardView, TEAM_COLORS } from '../render/view';
import { AimInput } from '../ui/aim';
import { Sfx } from '../ui/audio';
import { Hud, REQ_TEXT, el, esc } from '../ui/hud';
import { normalizeRoomCode } from '../net/protocol';
import { onPlayerCount, trackPresence } from '../net/presence';

type Mode = 'cpu' | 'pass';
interface Prefs {
  mode: Mode;
  players: PlayerCount;
  level: Difficulty;
  target: 50 | 100;
}

const PREFS_KEY = 'crokinole.prefs';
function loadPrefs(): Prefs {
  const d: Prefs = { mode: 'cpu', players: 2, level: 'medium', target: 100 };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') };
  } catch {
    return d;
  }
}
function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

const app = document.getElementById('app')!;
const sfx = new Sfx();

function seg<T extends string | number>(options: Array<[T, string]>, value: T, onChange: (v: T) => void): HTMLElement {
  const box = el('div', 'seg');
  for (const [v, label] of options) {
    const b = el('button', v === value ? 'on' : '', esc(label));
    b.type = 'button';
    b.addEventListener('click', () => {
      box.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      onChange(v);
    });
    box.append(b);
  }
  return box;
}

function showMenu(): void {
  trackPresence('menu');
  const prefs = loadPrefs();
  app.innerHTML = '';
  const wrap = el('div', 'menu');
  const card = el('div', 'card');
  card.innerHTML = `<div class="disc-logo"></div><h1>Crokinole</h1><p class="tag">Flick your discs at the 20 hole. Knock theirs into the ditch.</p>`;
  const live = el('p', 'live hidden');
  card.append(live);
  // "N playing now" across everyone on Crokinole (menus, local games, phones), shown from 2 up.
  const stopLive = onPlayerCount((n) => {
    if (wrap.dataset.shown && !wrap.isConnected) return void stopLive();
    live.innerHTML = `<span class="dot"></span>${n} playing now`;
    live.classList.toggle('hidden', n < 2);
  });

  const row = (label: string, control: HTMLElement) => {
    const r = el('div', 'row');
    r.append(el('label', '', esc(label)), control);
    return r;
  };
  card.append(el('h3', '', 'Play on this device'));
  const levelRow = row(
    'Computer',
    seg<Difficulty>([['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard']], prefs.level, (v) => (prefs.level = v)),
  );
  card.append(
    row(
      'Mode',
      seg<Mode>([['cpu', 'Vs computer'], ['pass', 'Pass & play']], prefs.mode, (v) => {
        prefs.mode = v;
        levelRow.classList.toggle('hidden', v !== 'cpu');
      }),
    ),
    row('Players', seg<PlayerCount>([[2, '2'], [3, '3'], [4, '4 (teams)']], prefs.players, (v) => (prefs.players = v))),
    levelRow,
    row('Game to', seg<50 | 100>([[50, '50'], [100, '100']], prefs.target, (v) => (prefs.target = v))),
  );
  levelRow.classList.toggle('hidden', prefs.mode !== 'cpu');
  const actions = el('div', 'actions');
  const start = el('button', 'btn primary', 'Start game');
  start.addEventListener('click', () => {
    sfx.unlock();
    savePrefs(prefs);
    startLocal(prefs);
  });
  actions.append(start);
  card.append(actions);

  card.append(el('div', 'divider'), el('h3', '', 'Party mode'));
  card.append(el('p', 'howto', 'Put the board on a big screen and use phones as flick controllers. 2–4 players.'));
  const host = el('a', 'btn', 'Host on this screen') as HTMLAnchorElement;
  host.href = './host/';
  host.style.display = 'block';
  host.style.textAlign = 'center';
  host.style.textDecoration = 'none';
  card.append(host);
  const join = el('form', 'join');
  join.style.marginTop = '10px';
  const code = el('input') as HTMLInputElement;
  code.placeholder = 'Room code';
  code.maxLength = 4;
  code.autocapitalize = 'characters';
  code.addEventListener('input', () => (code.value = normalizeRoomCode(code.value)));
  const name = el('input') as HTMLInputElement;
  name.placeholder = 'Your name';
  name.maxLength = 14;
  try {
    name.value = localStorage.getItem('crokinole.name') ?? '';
  } catch {
    /* ignore */
  }
  const go = el('button', 'btn primary', 'Join');
  join.append(code, name, go);
  join.addEventListener('submit', (e) => {
    e.preventDefault();
    if (code.value.length !== 4) return code.focus();
    location.href = `./join/?room=${code.value}${name.value.trim() ? `&name=${encodeURIComponent(name.value.trim())}` : ''}`;
  });
  card.append(join);

  card.append(
    el('div', 'divider'),
    el(
      'div',
      'howto',
      `<b>How to play.</b> Drag your disc along the shooting line to place it, then pull back like a slingshot and let go. If an opponent's disc is on the board, your shot must hit one, or it's a foul. On an empty board your disc must reach the 15 circle. Discs score the zone they stop in (touching a line counts the lower zone), a disc in the centre hole banks 20, and only the difference between the sides counts each round.`,
    ),
  );
  wrap.append(card);
  app.append(wrap);
  wrap.dataset.shown = '1';
}

function startLocal(prefs: Prefs): void {
  trackPresence('local');
  app.innerHTML = '';
  const stage = el('div', 'stage');
  const canvas = el('canvas');
  stage.append(canvas);
  app.append(stage);
  const view = new BoardView(canvas);
  const hud = new Hud(stage);
  const tr = el('div', 'topright');
  const soundBtn = el('button', 'iconbtn', sfx.enabled ? '🔊' : '🔇');
  soundBtn.title = 'Sound';
  soundBtn.addEventListener('click', () => {
    sfx.setEnabled(!sfx.enabled);
    soundBtn.textContent = sfx.enabled ? '🔊' : '🔇';
  });
  const meter = el('div', 'meter local-meter hidden', '<div class="fill"></div><span></span>');
  stage.append(meter);
  // Tap the board to skip a replay.
  canvas.addEventListener('pointerdown', () => table?.skipReplay());
  const exitBtn = el('button', 'iconbtn', '✕');
  exitBtn.title = 'Quit to menu';
  exitBtn.addEventListener('click', () =>
    hud.showModal('<h2>Quit this game?</h2>', [
      ['Keep playing', () => hud.hideModal()],
      ['Quit', () => stop(), true],
    ]),
  );
  tr.append(soundBtn, exitBtn);
  hud.root.append(tr);

  const game = createGame({ players: prefs.players, target: prefs.target });
  // ?autoplay (testing): every seat is the computer, shots play fast.
  const autoplay = new URLSearchParams(location.search).has('autoplay');
  const isCpu = (seat: Seat) => autoplay || (prefs.mode === 'cpu' && seat !== 0);
  const names: string[] = ['', '', '', ''];
  let cpuN = 0;
  for (const s of game.seats) {
    if (prefs.mode === 'pass') names[s] = `Player ${game.seats.indexOf(s) + 1}`;
    else names[s] = s === 0 ? 'You' : game.seats.length > 2 ? `CPU ${++cpuN}` : 'Computer';
  }
  const rng = mulberry32((Date.now() ^ 0x5bd1e995) >>> 0);

  let preview: { shot: Shot; team: number } | null = null;
  let thinking = false;
  let lastTurnKey = '';

  const table: Table = new Table(game, view, sfx, {
    onShotEnd: (o) => {
      if (!o.foul && o.twenties.length) hud.shout(o.twenties.length > 1 ? `${o.twenties.length}× 20!` : '20!', '#ffe27a');
    },
    onTally: (p) => {
      renderTally(p.done);
      if (p.done) hud.renderScores(table.state, names);
    },
    onReplay: (h) => {
      hud.showReplay(h, table.state, names, () => table.skipReplay());
      if (h) {
        hud.setBanner('', null);
        sfx.chime();
      }
    },
    onChange: () => hud.renderScores(table.state, names, table.scoresPending),
  });
  if (autoplay) table.speed = 6;
  (window as unknown as { __table: Table }).__table = table;
  const aim = new AimInput(view, {
    onPreview: (shot, pulling) => {
      preview = { shot, team: table.state.teamOfSeat[shot.seat] };
      meter.classList.toggle('hidden', !pulling);
      if (pulling) {
        const fill = meter.firstElementChild as HTMLElement;
        fill.style.width = `${Math.round(shot.power * 100)}%`;
        fill.style.background = `hsl(${120 - 120 * shot.power}, 80%, 50%)`;
        meter.querySelector('span')!.textContent = `Power ${Math.round(shot.power * 100)}%`;
      }
    },
    onShoot: (shot) => {
      meter.classList.add('hidden');
      sfx.unlock();
      preview = null;
      aim.enable(null);
      table.shoot(shot);
    },
    onTick: () => sfx.tick(),
  });

  const renderTally = (done: boolean) => {
    const s = table.state;
    const over = s.phase === 'game-over';
    hud.showTally(table.tally, s, names, done ? () => next() : undefined, over ? 'See result' : 'Next round');
    if (done && autoplay) setTimeout(next, 300);
  };
  const next = () => {
    if (table.state.phase === 'game-over') {
      hud.showTally(null, table.state, names);
      hud.renderScores(table.state, names);
      sfx.chime();
      hud.showModal(hud.gameOverHtml(table.state, names), [
        ['Menu', () => stop()],
        ['Play again', () => startLocal(prefs), true],
      ]);
      return;
    }
    table.continueRound();
    hud.showTally(null, table.state, names);
  };

  const turnText = (s: GameState, seat: Seat) => {
    const team = s.teamOfSeat[seat];
    const who = names[seat] === 'You' ? 'Your turn' : `${esc(names[seat])}'s turn`;
    return `<span style="color:${TEAM_COLORS[team]}">●</span> ${who} · <span class="req">${REQ_TEXT[requirement(s, seat)]}</span> · ${s.discsLeft[seat]} left`;
  };

  const onTurn = () => {
    const s = table.state;
    const seat = currentSeat(s);
    hud.setBanner(turnText(s, seat), s.teamOfSeat[seat]);
    if (isCpu(seat)) {
      aim.enable(null);
      preview = null;
      thinking = true;
      const level = prefs.level;
      void chooseShotAsync(s, level, rng).then((shot) => {
        if (!running) return;
        // Show the computer lining up, then shoot.
        const t0 = performance.now();
        const anim = () => {
          if (!running) return;
          const k = Math.min(1, (performance.now() - t0) / (autoplay ? 60 : 650));
          preview = { shot: { ...shot, power: shot.power * k }, team: s.teamOfSeat[seat] };
          if (k < 1) requestAnimationFrame(anim);
          else
            setTimeout(() => {
              preview = null;
              thinking = false;
              table.shoot(shot);
            }, 180);
        };
        anim();
      });
    } else {
      if (prefs.mode === 'pass') view.faceSeat(seat);
      aim.enable(seat);
    }
  };

  let running = true;
  const stop = () => {
    running = false;
    window.removeEventListener('resize', onResize);
    showMenu();
  };
  // On landscape screens, lift the board so there's room below the shooter's line to pull back.
  const fitView = () => {
    const landscape = window.innerWidth > window.innerHeight * 1.05;
    view.fit = landscape ? { r: 19, offsetY: -2 } : { r: 17.7, offsetY: 0 };
    view.resize();
  };
  const onResize = () => fitView();
  window.addEventListener('resize', onResize);
  view.faceSeat(prefs.mode === 'pass' ? currentSeat(game) : 0, true);
  fitView();
  hud.renderScores(game, names);

  let last = performance.now();
  const loop = (now: number) => {
    if (!running) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    table.update(dt);
    const s = table.state;
    if (!table.moving && !table.tally && s.phase === 'shooting') {
      const key = `${s.round}:${s.nextId}`;
      if (key !== lastTurnKey && !thinking) {
        lastTurnKey = key;
        onTurn();
      }
    } else if (table.moving || table.replay) {
      hud.setBanner('', null);
    }
    const labels = s.seats.map((seat) => ({ seat, text: names[seat], team: s.teamOfSeat[seat], dim: s.phase === 'shooting' && currentSeat(s) !== seat }));
    view.draw(table.frame({ aim: preview ? { shot: preview.shot, team: preview.team } : null, labels }), dt);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

showMenu();

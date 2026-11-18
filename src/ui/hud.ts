/**
 * DOM overlays shared by local mode and the host screen: scoreboard, turn
 * banner, big callouts, the round-tally panel and a generic modal.
 */
import type { GameState, Requirement } from '../engine/rules';
import { TEAM_COLORS, TEAM_NAMES } from '../render/view';
import type { TallyProgress } from '../game/table';
import { type Highlight, gameAwards } from '../engine/highlights';

const AWARD_ICONS: Record<string, string> = {
  Sharpshooter: '🎯',
  'Demolition crew': '💥',
  'Biggest takeout': '🧨',
  'Pinball wizard': '📍',
  'Foul magnet': '🙈',
  Sinker: '🕳️',
  Butterfingers: '🧈',
};

/** End-of-game awards as HTML (shared by the TV, local mode and phones). */
export function awardsHtml(state: GameState, names: string[]): string {
  const awards = gameAwards(state);
  if (!awards.length) return '';
  const items = awards
    .map((a, i) => {
      const who = a.seats.map((s) => `<span style="color:${TEAM_COLORS[state.teamOfSeat[s]]}">${esc(names[s] || `Seat ${s + 1}`)}</span>`).join(' & ');
      return `<li style="animation-delay:${0.25 + i * 0.35}s"><span class="aicon">${AWARD_ICONS[a.title] ?? '🏅'}</span><span class="atext"><b>${esc(a.title)}</b><span class="awho">${who}</span><small>${esc(a.blurb)}</small></span></li>`;
    })
    .join('');
  return `<h3 class="awards-h">Awards</h3><ul class="awards">${items}</ul>`;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export const REQ_TEXT: Record<Requirement, string> = {
  'hit-opponent': 'Must hit an opponent',
  'reach-15': 'Must reach the 15',
};

/** Display names per team, e.g. "Ana & Ben". */
export function teamLabel(state: GameState, names: string[], team: number): string {
  const ns = state.seats.filter((s) => state.teamOfSeat[s] === team).map((s) => names[s] || `Seat ${s + 1}`);
  return ns.join(' & ');
}

/** "wins" for one name, "win" for a pair or "You". */
export function verb(label: string, singular: string, plural: string): string {
  return label.includes('&') || label === 'You' ? plural : singular;
}

/** Game scores, minus the last round's points while its tally is still to come (no spoilers). */
export function shownScores(state: GameState, pending: boolean): number[] {
  if (!pending || state.phase === 'shooting' || !state.lastRound) return state.scores;
  return state.scores.map((s, t) => s - (state.lastRound!.tallies[t]?.awarded ?? 0));
}

export class Hud {
  readonly root: HTMLElement;
  private score = el('div', 'scoreboard');
  private banner = el('div', 'banner');
  private callout = el('div', 'callout');
  private tallyBox = el('div', 'tally hidden');
  private modal = el('div', 'modal hidden');
  private replayCap = el('div', 'replay-cap hidden');

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud');
    this.root.append(this.score, this.banner, this.callout, this.replayCap, this.tallyBox, this.modal);
    parent.append(this.root);
  }

  /** `pending`: the round just ended but its tally hasn't been shown yet, so show the scores from before it. */
  renderScores(state: GameState, names: string[], pending = false): void {
    const rows = shownScores(state, pending)
      .map((s, team) => {
        const lead = !pending && state.phase === 'game-over' && state.winner === team ? ' lead' : '';
        return `<div class="team${lead}"><span class="dot" style="background:${TEAM_COLORS[team]}"></span><span class="tname">${esc(
          teamLabel(state, names, team),
        )}</span><b>${s}</b></div>`;
      })
      .join('');
    this.score.innerHTML = `${rows}<div class="meta">Round ${state.round} · to ${state.settings.target}${state.settings.board === 'five-hole' ? ' · 5-hole' : ''}</div>`;
  }

  setBanner(html: string, team: number | null = null): void {
    this.banner.innerHTML = html;
    this.banner.style.borderColor = team == null ? 'transparent' : TEAM_COLORS[team];
    this.banner.classList.toggle('hidden', !html);
  }

  shout(text: string, color = '#ffe27a'): void {
    this.callout.textContent = text;
    this.callout.style.color = color;
    this.callout.classList.remove('pop');
    void this.callout.offsetWidth;
    this.callout.classList.add('pop');
  }

  showTally(p: TallyProgress | null, state: GameState, names: string[], onContinue?: () => void, continueLabel = 'Next round'): void {
    if (!p) {
      this.tallyBox.classList.add('hidden');
      return;
    }
    this.tallyBox.classList.remove('hidden');
    const rows = p.result.tallies
      .map((t) => {
        const extras = [t.twenties ? `${t.twenties}× 20` : '', t.penalties ? `${t.penalties}× −10` : ''].filter(Boolean).join(', ');
        const tw = extras ? ` <small>(${extras})</small>` : '';
        return `<div class="trow"><span class="dot" style="background:${TEAM_COLORS[t.team]}"></span><span class="tname">${esc(
          teamLabel(state, names, t.team),
        )}${tw}</span><b>${p.shown[t.team]}</b></div>`;
      })
      .join('');
    let footer = '';
    if (p.done) {
      const gained = p.result.tallies.filter((t) => t.awarded > 0);
      const what =
        gained.length === 0
          ? 'A tie. No points this round.'
          : state.teamCount === 2
            ? `${esc(teamLabel(state, names, gained[0].team))} ${verb(teamLabel(state, names, gained[0].team), 'scores', 'score')} <b>${gained[0].awarded}</b>`
            : gained.map((t) => `${esc(teamLabel(state, names, t.team))} +${t.awarded}`).join(' · ');
      footer = `<p class="award">${what}</p>`;
      if (onContinue) footer += `<button class="btn primary" data-act="continue">${continueLabel}</button>`;
    }
    this.tallyBox.innerHTML = `<h2>Round ${p.result.round}</h2>${rows}${footer}`;
    this.tallyBox.querySelector('[data-act=continue]')?.addEventListener('click', () => onContinue?.());
  }

  /** Caption under the board during the slow-motion replay (null hides it). */
  showReplay(h: Highlight | null, state: GameState, names: string[], onSkip?: () => void): void {
    this.replayCap.classList.toggle('hidden', !h);
    if (!h) return;
    const team = state.teamOfSeat[h.seat];
    this.replayCap.innerHTML = `<div class="kicker">Shot of the round</div><div><b style="color:${TEAM_COLORS[team]}">${esc(names[h.seat] || 'Seat')}</b> with ${esc(h.label)}</div>${onSkip ? '<button class="btn small" data-act="skip">Skip</button>' : ''}`;
    this.replayCap.querySelector('[data-act=skip]')?.addEventListener('click', () => onSkip?.());
  }

  /** Generic modal. Buttons: [label, handler, primary?]. */
  showModal(html: string, buttons: Array<[string, () => void, boolean?]> = []): void {
    this.modal.innerHTML = `<div class="card">${html}<div class="btns"></div></div>`;
    const box = this.modal.querySelector('.btns')!;
    for (const [label, fn, primary] of buttons) {
      const b = el('button', `btn${primary ? ' primary' : ''}`, esc(label));
      b.addEventListener('click', fn);
      box.append(b);
    }
    this.modal.classList.remove('hidden');
  }

  hideModal(): void {
    this.modal.classList.add('hidden');
  }

  gameOverHtml(state: GameState, names: string[]): string {
    const w = state.winner ?? 0;
    const rows = state.scores
      .map((s, t) => `<div class="trow"><span class="dot" style="background:${TEAM_COLORS[t]}"></span><span class="tname">${esc(teamLabel(state, names, t))}</span><b>${s}</b></div>`)
      .join('');
    return `<div class="trophy">🏆</div><h2 style="color:${TEAM_COLORS[w]}">${esc(teamLabel(state, names, w))} ${verb(teamLabel(state, names, w), 'wins', 'win')}!</h2>${rows}<p class="muted">${state.round} round${state.round === 1 ? '' : 's'} played</p>${awardsHtml(state, names)}`;
  }
}

export { TEAM_NAMES };

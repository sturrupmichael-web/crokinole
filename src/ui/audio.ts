/**
 * Synthesised sound effects (no audio files): disc clack, peg ping, 20-hole
 * drop, ditch thud, plus small UI blips. Muted state persists per browser.
 */
import type { SimEvent } from '../engine/physics';

const KEY = 'crokinole.sound';

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private lastAt = new Map<string, number>();
  enabled: boolean;

  constructor() {
    let on = true;
    try {
      on = localStorage.getItem(KEY) !== 'off';
    } catch {
      /* storage blocked */
    }
    this.enabled = on;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    try {
      localStorage.setItem(KEY, on ? 'on' : 'off');
    } catch {
      /* ignore */
    }
  }

  /** Call from a user gesture so browsers allow audio. */
  unlock(): void {
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.7;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  event(e: SimEvent): void {
    if (e.kind === 'disc') this.clack(Math.min(1, e.speed / 40));
    else if (e.kind === 'peg') this.ping(Math.min(1, e.speed / 35));
    else if (e.kind === 'twenty') this.drop();
    else if (e.kind === 'penalty') this.sink();
    else if (e.kind === 'ditch') this.thud();
  }

  private ready(tag: string, gapMs = 25): AudioContext | null {
    if (!this.enabled || !this.ctx || !this.master) return null;
    const now = performance.now();
    if (now - (this.lastAt.get(tag) ?? 0) < gapMs) return null;
    this.lastAt.set(tag, now);
    return this.ctx;
  }

  private noise(ctx: AudioContext, dur: number): AudioBufferSourceNode {
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 3;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    return src;
  }

  clack(v: number): void {
    const ctx = this.ready('clack');
    if (!ctx) return;
    const t = ctx.currentTime;
    const src = this.noise(ctx, 0.06);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2200 + 900 * v;
    bp.Q.value = 3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.25 + 0.75 * v, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    src.connect(bp).connect(g).connect(this.master!);
    src.start(t);
    // Wooden body knock.
    this.tone(ctx, 720, 0.05, 0.25 * (0.3 + v), 'triangle');
  }

  ping(v: number): void {
    const ctx = this.ready('ping', 40);
    if (!ctx) return;
    this.tone(ctx, 1760, 0.35, 0.18 + 0.3 * v, 'sine');
    this.tone(ctx, 2640, 0.2, 0.08 + 0.12 * v, 'sine');
  }

  drop(): void {
    const ctx = this.ready('drop', 100);
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(520, t);
    o.frequency.exponentialRampToValueAtTime(140, t + 0.25);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + 0.32);
    setTimeout(() => this.tone(ctx, 95, 0.18, 0.6, 'sine'), 260);
    setTimeout(() => this.chime(), 380);
  }

  /** A disc drops into a −10 hole: a hollow drop and a sad slide down. */
  sink(): void {
    const ctx = this.ready('sink', 100);
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(420, t);
    o.frequency.exponentialRampToValueAtTime(90, t + 0.45);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.45, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + 0.52);
    setTimeout(() => this.tone(ctx, 80, 0.2, 0.55, 'sine'), 300);
  }

  thud(): void {
    const ctx = this.ready('thud', 60);
    if (!ctx) return;
    this.tone(ctx, 85, 0.22, 0.7, 'sine');
    const src = this.noise(ctx, 0.08);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 400;
    const g = ctx.createGain();
    g.gain.value = 0.5;
    src.connect(lp).connect(g).connect(this.master!);
    src.start();
  }

  chime(): void {
    const ctx = this.ready('chime', 80);
    if (!ctx) return;
    [880, 1108.7, 1318.5].forEach((f, i) => setTimeout(() => this.tone(ctx, f, 0.4, 0.18, 'sine'), i * 70));
  }

  buzz(): void {
    const ctx = this.ready('buzz', 150);
    if (!ctx) return;
    this.tone(ctx, 140, 0.35, 0.25, 'sawtooth');
    this.tone(ctx, 147, 0.35, 0.2, 'sawtooth');
  }

  tick(): void {
    const ctx = this.ready('tick', 60);
    if (!ctx) return;
    this.tone(ctx, 1400, 0.05, 0.12, 'square');
  }

  private tone(ctx: AudioContext, freq: number, dur: number, vol: number, type: OscillatorType): void {
    if (!this.enabled || !this.master) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
}

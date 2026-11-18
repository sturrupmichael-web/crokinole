/**
 * Wire protocol between the HOST (authoritative) and PHONES (thin controllers).
 *
 *  phone → host  event "msg":    { pid, m: PhoneMsg }   (pid = random id kept per device per room)
 *  host  → all   event "state":  RoomState              (on every change, and in reply to hello)
 *  host  → all   event "aim":    { seat, shot }         (low-rate ghost, so other phones can watch too)
 *  host  → all   event "shot":   { turn, shot }         (a shot just started; phones replay it live with the same physics)
 *  host  → all   event "closed": {}                     (host ended the room)
 *
 * Phones send a shot; the host simulates it, applies the rules and broadcasts
 * the new state. Phones only re-run the physics of a shot for display while it
 * moves (it's deterministic, so it matches the TV); the host's state always wins.
 */
import type { BoardKind, Seat } from '../engine/board';
import type { GameState, Shot } from '../engine/rules';

export const ROOM_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O

export function makeRoomCode(rand: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += ROOM_LETTERS[Math.floor(rand() * ROOM_LETTERS.length)];
  return s;
}

export function normalizeRoomCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 4);
}

export function isRoomCode(s: string): boolean {
  return s.length === 4 && [...s].every((c) => ROOM_LETTERS.includes(c));
}

export type ShotInput = Omit<Shot, 'seat'>;

export type PhoneMsg =
  | { t: 'hello' }
  | { t: 'join'; name: string }
  | { t: 'leave' }
  /** Low-rate preview while lining up. */
  | { t: 'aim'; shot: ShotInput }
  /** `turn` is the GameState.nextId the phone saw, so a repeated send can't shoot twice. */
  | { t: 'shoot'; shot: ShotInput; turn: number };

export interface Envelope {
  pid: string;
  m: PhoneMsg;
}

export interface RoomPlayer {
  /** Hash of the phone's pid (the raw pid is never broadcast). */
  key: string;
  name: string;
  cpu: boolean;
  connected: boolean;
}

export interface RoomState {
  v: 1;
  room: string;
  phase: 'lobby' | 'playing';
  /** Lobby order; at the start of a game seats are assigned from this. */
  players: RoomPlayer[];
  /** Seat number → index into players (playing phase). */
  seatPlayer: Array<number | null>;
  target: 50 | 100;
  /** Board for the next game. Missing in older saves = classic. */
  board?: BoardKind;
  game: GameState | null;
  /** Discs are moving: phones show "watch the screen". */
  moving: boolean;
  /** Round tally on screen. */
  tallying: boolean;
  /** Last shot's headline for phones ("Foul!", "20!"). */
  lastNews: string;
}

export const MAX_PLAYERS = 4;
export const NAME_MAX = 14;

export function cleanName(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

/** Short stable non-reversible key for a pid (FNV-1a). */
export function pidKey(pid: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < pid.length; i++) {
    h ^= pid.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function seatOfKey(rs: RoomState, key: string): Seat | null {
  const idx = rs.players.findIndex((p) => p.key === key);
  if (idx < 0) return null;
  const seat = rs.seatPlayer.indexOf(idx);
  return seat < 0 ? null : (seat as Seat);
}

// The client ⇄ Durable Object wire protocol. Imported by both sides, so a
// change that breaks one fails to compile the other.

import type { Intent, RoomView } from '../engine/room';
import type { Player } from '../engine/types';

/**
 * Bumped whenever a message *or persisted state* shape changes incompatibly. A
 * client built against an older Worker (or a tab left open across a deploy) is
 * told to reload rather than silently misreading frames, and the Durable Object
 * discards any room it stored under an older version rather than rehydrating a
 * shape the current engine no longer understands.
 *
 * 2 — Phase 7: strategic state gained forts, initiative, victory, retreat, and
 * the free post-battle reshuffle. A Phase-5 room restored into this code is
 * missing those fields and crashes the client, so old rooms must be dropped.
 */
export const PROTOCOL_VERSION = 2;

/** Room codes are 6 chars from an alphabet with no 0/O or 1/I to mis-read aloud. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

export function generateCode(random: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Canonical form of a typed-in code, or null if it could never name a room.
 * Applied on both sides: the client so a lowercase paste still joins, the Worker
 * so `abc123` and `ABC123` cannot become two different Durable Objects.
 */
export function normalizeCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  if (code.length !== CODE_LENGTH) return null;
  if (![...code].every((c) => CODE_ALPHABET.includes(c))) return null;
  return code;
}

export type ClientMsg = { t: 'intent'; intent: Intent };

export type ServerMsg =
  /** Sent once on connect: which seat you hold and the room as it stands. */
  | { t: 'welcome'; seat: Player; seats: Player[]; room: RoomView }
  /** A new authoritative view, after someone's intent was accepted. */
  | { t: 'room'; room: RoomView }
  /** Occupancy changed — the other player arrived or dropped. */
  | { t: 'seats'; seats: Player[] }
  /** Your intent was refused. Sent only to you; nobody else's view moved. */
  | { t: 'reject'; reason: string };

/** Close codes above 4000 are application-defined. */
export const CLOSE = {
  /** Both seats are taken — the third socket is turned away. */
  ROOM_FULL: 4001,
  /** The client speaks a different PROTOCOL_VERSION. */
  VERSION_MISMATCH: 4002,
} as const;

/** The room WebSocket endpoint. Same-origin, so it inherits the page's TLS. */
export const WS_PATH = '/api/ws';

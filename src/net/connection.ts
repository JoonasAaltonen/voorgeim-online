// The client half of the socket: one room connection, with reconnect.
//
// Deliberately not a React hook — the session store owns it, and its lifetime is
// the game's, not a component's.

import type { Intent, RoomView } from '../engine/room';
import type { Player } from '../engine/types';
import {
  CLOSE,
  PROTOCOL_VERSION,
  WS_PATH,
  type ClientMsg,
  type ServerMsg,
} from './protocol';

export type ConnStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface ConnHandlers {
  onStatus: (status: ConnStatus, detail?: string) => void;
  onWelcome: (seat: Player, seats: Player[], room: RoomView) => void;
  onRoom: (room: RoomView) => void;
  onSeats: (seats: Player[]) => void;
  onReject: (reason: string) => void;
}

/** Backoff for reconnects, in ms. Caps out rather than growing forever. */
const BACKOFF = [500, 1000, 2000, 4000, 8000];

/** A refusal we must not retry: reconnecting would fail identically forever. */
const FATAL: readonly number[] = [CLOSE.ROOM_FULL, CLOSE.VERSION_MISMATCH];

function roomUrl(code: string, seat: Player | null): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = new URL(`${proto}//${location.host}${WS_PATH}`);
  url.searchParams.set('code', code);
  url.searchParams.set('v', String(PROTOCOL_VERSION));
  // Ask for the seat we held before, so a reload reclaims it rather than
  // swapping sides. The server honors it only if it is still free.
  if (seat) url.searchParams.set('seat', seat);
  return url.toString();
}

export class RoomConnection {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closedByUs = false;
  readonly code: string;
  private readonly handlers: ConnHandlers;
  /** Remembered so a reconnect asks for the same side. */
  private seat: Player | null;

  constructor(code: string, handlers: ConnHandlers, seat: Player | null = null) {
    this.code = code;
    this.handlers = handlers;
    this.seat = seat;
    this.open();
  }

  private open(): void {
    this.handlers.onStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const ws = new WebSocket(roomUrl(this.code, this.seat));
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.handlers.onStatus('open');
    };

    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      switch (msg.t) {
        case 'welcome':
          this.seat = msg.seat;
          this.handlers.onWelcome(msg.seat, msg.seats, msg.room);
          break;
        case 'room':
          this.handlers.onRoom(msg.room);
          break;
        case 'seats':
          this.handlers.onSeats(msg.seats);
          break;
        case 'reject':
          this.handlers.onReject(msg.reason);
          break;
      }
    };

    ws.onclose = (ev) => {
      this.ws = null;
      if (this.closedByUs) return;
      if (FATAL.includes(ev.code)) {
        this.handlers.onStatus('closed', ev.reason || 'The room refused the connection.');
        return;
      }
      const wait = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)];
      this.attempt++;
      this.handlers.onStatus('reconnecting', `Connection lost — retrying in ${Math.round(wait / 1000)}s.`);
      this.timer = setTimeout(() => this.open(), wait);
    };

    // An error is always followed by a close, which is where retry is decided.
    ws.onerror = () => {};
  }

  send(intent: Intent): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ t: 'intent', intent } satisfies ClientMsg));
    return true;
  }

  close(): void {
    this.closedByUs = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
    this.handlers.onStatus('closed');
  }
}

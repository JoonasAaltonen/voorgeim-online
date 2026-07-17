// The session: who is playing, over what transport, and the room they share.
//
// This store owns the authoritative game state for the client. Hotseat and
// online differ only in where an intent is resolved — in this module against a
// local room, or by the Durable Object over a socket — so the UI below dispatches
// the same intents either way and never learns which mode it is in.

import { create } from 'zustand';
import {
  applyIntent,
  createRoom,
  entitledSeat,
  type Intent,
  type RoomState,
} from '../engine/room';
import { RoomConnection, type ConnStatus } from '../net/connection';
import { generateCode, normalizeCode } from '../net/protocol';
import type { Player } from '../engine/types';

export type Mode = 'local' | 'online';

/** Hotseat's room is never a Durable Object, so its code is a label, not an id. */
const LOCAL_CODE = 'LOCAL';

/**
 * A refresh should rejoin the game rather than lose it, so the code and seat
 * outlive the page. sessionStorage (not localStorage) scopes that to the tab —
 * two tabs on one machine can hold the two seats of the same game, which is how
 * you playtest a networked build alone.
 */
const STORE_KEY = 'voorgeim.session';

interface Saved {
  code: string;
  seat: Player | null;
}

function remember(saved: Saved | null): void {
  try {
    if (saved) sessionStorage.setItem(STORE_KEY, JSON.stringify(saved));
    else sessionStorage.removeItem(STORE_KEY);
  } catch {
    // Private browsing / storage disabled — the game still works, it just will
    // not survive a refresh.
  }
}

function recall(): Saved | null {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}

interface Session {
  mode: Mode;
  /**
   * The room code, known the moment we decide to connect — deliberately *not*
   * read off `room.code`. The room is the server's answer and only arrives with
   * `welcome`, so sourcing the code from it means the code you have to read
   * aloud to someone is blank (or worse, still says LOCAL) until the server
   * replies, and stays wrong forever if it never does.
   */
  code: string;
  room: RoomState;
  /** The seat you hold online. Null in hotseat, where you hold both. */
  seat: Player | null;
  /** Seats currently occupied — online only. */
  seats: Player[];
  status: ConnStatus | null;
  /** Connection-level news ("reconnecting…"), as opposed to a refused move. */
  notice: string | null;
  error: string | null;

  dispatch: (intent: Intent) => void;
  /** Start an online game and return its code to share. */
  host: () => string;
  join: (rawCode: string) => string | null;
  /** Rejoin the game this tab was in, if any. Safe to call on every mount. */
  resume: () => void;
  leave: () => void;
  clearError: () => void;
}

let conn: RoomConnection | null = null;

export const useSession = create<Session>((set, get) => {
  /** Fall back to hotseat, keeping `why` on screen. */
  function toLocal(why: string | null): void {
    conn = null;
    remember(null);
    set({
      mode: 'local',
      code: LOCAL_CODE,
      room: createRoom(LOCAL_CODE),
      seat: null,
      seats: [],
      status: null,
      notice: null,
      error: why,
    });
  }

  function connect(code: string, seat: Player | null): void {
    conn?.close();
    remember({ code, seat });
    set({ mode: 'online', code, seats: [], error: null, notice: null });
    conn = new RoomConnection(
      code,
      {
        onStatus: (status, detail) => {
          // A close that carries a reason and never got us a seat means there is
          // no game here to wait for: the server is unreachable, or the room
          // refused us. Sitting in a dead online mode helps nobody — and leaving
          // the code in sessionStorage would have every later reload retry it.
          if (status === 'closed' && detail && !get().seat) {
            toLocal(detail);
            return;
          }
          set({ status, notice: detail ?? null });
        },
        onWelcome: (seat, seats, room) => {
          remember({ code, seat });
          set({ seat, seats, room, notice: null });
        },
        onRoom: (room) => set({ room }),
        onSeats: (seats) => set({ seats }),
        onReject: (reason) => set({ error: reason }),
      },
      seat,
    );
  }

  return {
    mode: 'local',
    code: LOCAL_CODE,
    room: createRoom(LOCAL_CODE),
    seat: null,
    seats: [],
    status: null,
    notice: null,
    error: null,

    dispatch: (intent) => {
      const { mode, room } = get();
      if (mode === 'online') {
        if (!conn?.send(intent)) set({ error: 'Not connected — that move was not sent.' });
        return;
      }
      const t = applyIntent(room, entitledSeat(room, intent), intent);
      set(t.error ? { error: t.error } : { room: t.state, error: null });
    },

    host: () => {
      const code = generateCode();
      connect(code, 'p1');
      return code;
    },

    join: (rawCode) => {
      const code = normalizeCode(rawCode);
      if (!code) {
        set({ error: 'A game code is 6 letters and numbers.' });
        return null;
      }
      connect(code, null);
      return code;
    },

    resume: () => {
      if (get().mode === 'online') return;
      const saved = recall();
      if (saved?.code) connect(saved.code, saved.seat);
    },

    leave: () => {
      conn?.close();
      toLocal(null);
    },

    clearError: () => set({ error: null }),
  };
});

/** True when this client may act for `player` — always so in hotseat. */
export function canAct(s: Session, player: Player | null): boolean {
  if (s.mode === 'local') return true;
  return !!player && s.seat === player;
}

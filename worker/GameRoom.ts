// One Durable Object per room code — the authoritative holder of a game.
//
// All the game logic lives in the pure `applyIntent` reducer; this class only
// owns the things a reducer cannot: which socket holds which seat, turning away
// a third player, surviving hibernation, and the broadcast fan-out.

import { DurableObject } from 'cloudflare:workers';
import { applyIntent, createRoom, viewFor, type Intent, type RoomState } from '../src/engine/room';
import {
  CLOSE,
  PROTOCOL_VERSION,
  normalizeCode,
  type ClientMsg,
  type ServerMsg,
} from '../src/net/protocol';
import type { Player } from '../src/engine/types';

const SEATS: readonly Player[] = ['p1', 'p2'];

/**
 * How long a room may sit untouched before it reaps itself. The alarm is pushed
 * back on every save, so an in-progress game never trips it — only a room whose
 * players have gone quiet for this long is treated as abandoned. Five hours is
 * far longer than any real game but short enough that stale rooms don't pile up
 * in storage forever (and, on a paid plan, keep costing for storage they hold).
 */
const ROOM_TTL_MS = 5 * 60 * 60 * 1000;

/**
 * What is actually written to storage: the room, stamped with the protocol it
 * was saved under. A deploy that changes the state shape bumps `PROTOCOL_VERSION`,
 * and anything stored under an older stamp is discarded on load rather than
 * rehydrated into an engine that no longer understands it. (Pre-stamp saves read
 * back with `protocol === undefined`, which likewise fails the match.)
 */
interface Persisted {
  protocol: number;
  room: RoomState;
}
const STORAGE_KEY = 'room';

/** Per-socket data. Survives hibernation on the socket's attachment. */
interface Attachment {
  seat: Player;
}

export class GameRoom extends DurableObject<Env> {
  private room: RoomState | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Hibernation evicts this object's memory while its sockets stay open, so
    // the room is rehydrated from storage rather than assumed to be in memory.
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<Persisted>(STORAGE_KEY);
      // A room saved under an older protocol is a different shape; drop it and
      // let the next connection start a fresh game rather than serve a state the
      // engine will crash on.
      this.room = stored?.protocol === PROTOCOL_VERSION ? stored.room : null;
    });
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade.', { status: 426 });
    }

    const url = new URL(req.url);
    const code = normalizeCode(url.searchParams.get('code') ?? '');
    if (!code) return new Response('Bad room code.', { status: 400 });

    const { 0: client, 1: server } = new WebSocketPair();

    // A refusal is delivered as a close code rather than an HTTP status: the
    // browser's WebSocket exposes no body or status for a failed upgrade, so
    // this is the only way the client can tell "room full" from "network down"
    // and know not to retry.
    const refuse = (reason: string, code: number): Response => {
      server.accept();
      server.close(code, reason);
      return new Response(null, { status: 101, webSocket: client });
    };

    if (url.searchParams.get('v') !== String(PROTOCOL_VERSION)) {
      return refuse('This page is out of date — reload to get the current version.', CLOSE.VERSION_MISMATCH);
    }

    const seat = this.freeSeat(url.searchParams.get('seat'));
    if (!seat) return refuse('That game already has two players.', CLOSE.ROOM_FULL);

    if (!this.room) await this.save(createRoom(code));

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ seat } satisfies Attachment);

    this.send(server, { t: 'welcome', seat, seats: this.seats(), room: viewFor(seat, this.room!) });
    // The joiner counts toward the tally but is skipped: its welcome said so.
    this.broadcastSeats({ skip: server });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const seat = this.seatOf(ws);
    if (!seat || !this.room) return;

    let msg: ClientMsg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      this.send(ws, { t: 'reject', reason: 'Malformed message.' });
      return;
    }
    if (msg?.t !== 'intent') {
      this.send(ws, { t: 'reject', reason: 'Unknown message.' });
      return;
    }

    let next: RoomState;
    try {
      // The seat comes from the socket, never from the payload — it is the one
      // claim a client must not be able to make about itself.
      //
      // The reducer rejects unknown intents, but it trusts the *fields* of a
      // known one, so a hand-crafted payload can still throw. Both players hold
      // the code to their own room, so the blast radius is their own game: catch
      // it, keep the last good state, and tell them.
      const t = applyIntent(this.room, seat, msg.intent as Intent);
      if (t.error) {
        this.send(ws, { t: 'reject', reason: t.error });
        return;
      }
      next = t.state;
    } catch {
      this.send(ws, { t: 'reject', reason: 'That action could not be applied.' });
      return;
    }

    await this.save(next);
    this.broadcastRoom();
  }

  webSocketClose(ws: WebSocket): void {
    // The room outlives the socket, so a reload finds its seat and its game
    // still here. It dies with the DO once both players are gone for good.
    this.broadcastSeats({ leaving: ws });
  }

  webSocketError(ws: WebSocket): void {
    this.broadcastSeats({ leaving: ws });
  }

  // --- seats ---------------------------------------------------------------

  private seatOf(ws: WebSocket): Player | null {
    return (ws.deserializeAttachment() as Attachment | null)?.seat ?? null;
  }

  /**
   * Seats currently held. `leaving` is a socket that is closing: it is still
   * listed by `getWebSockets()` at that point, so its seat has to be discounted
   * or the departing player would look like they were still sitting there.
   */
  private seats(leaving?: WebSocket): Player[] {
    const held = new Set<Player>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === leaving) continue;
      const s = this.seatOf(ws);
      if (s) held.add(s);
    }
    return SEATS.filter((s) => held.has(s));
  }

  /**
   * Grant a seat, preferring the one the client asks for. The request is a
   * convenience for reconnects — a reloaded tab reclaims p1 instead of swapping
   * to p2 — and is honored only when that seat is free, so it can never evict
   * the other player. Both seats held → null, and the third player is refused.
   */
  private freeSeat(requested: string | null): Player | null {
    const taken = new Set(this.seats());
    if (taken.size >= SEATS.length) return null;
    const want = SEATS.find((s) => s === requested && !taken.has(s));
    return want ?? SEATS.find((s) => !taken.has(s)) ?? null;
  }

  // --- plumbing ------------------------------------------------------------

  private async save(room: RoomState): Promise<void> {
    this.room = room;
    await this.ctx.storage.put(STORAGE_KEY, { protocol: PROTOCOL_VERSION, room } satisfies Persisted);
    // Push the reaper back. As long as moves keep arriving the alarm stays in the
    // future; once they stop, whichever was set last fires ROOM_TTL_MS later and
    // cleans up. See alarm(). Setting an alarm overwrites any earlier one, so this
    // is a refresh, not a pile-up.
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
  }

  /**
   * The reaper. Fires ROOM_TTL_MS after the last save. If anyone is still
   * connected the room isn't abandoned — just a long, quiet game — so push the
   * alarm back and leave the game alone. Otherwise both players are long gone:
   * drop the stored game so it doesn't linger in storage. deleteAll() clears the
   * alarm too, so a truly dead room leaves nothing behind.
   */
  async alarm(): Promise<void> {
    if (this.ctx.getWebSockets().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
      return;
    }
    await this.ctx.storage.deleteAll();
    this.room = null;
  }

  private send(ws: WebSocket, msg: ServerMsg): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Socket died between the lookup and the send; its close event tidies up.
    }
  }

  private broadcastRoom(): void {
    for (const ws of this.ctx.getWebSockets()) {
      const seat = this.seatOf(ws);
      if (seat) this.send(ws, { t: 'room', room: viewFor(seat, this.room!) });
    }
  }

  /**
   * Tell the room who is seated. Arriving and leaving are *not* symmetric, which
   * is worth spelling out: a joiner still counts toward the tally and only needs
   * skipping (its welcome already carried the seats), whereas a leaver must be
   * discounted from the tally as well — see `seats`.
   */
  private broadcastSeats({ skip, leaving }: { skip?: WebSocket; leaving?: WebSocket }): void {
    const seats = this.seats(leaving);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === skip || ws === leaving) continue;
      if (this.seatOf(ws)) this.send(ws, { t: 'seats', seats });
    }
  }
}

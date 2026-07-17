// The Worker: routes room sockets to their Durable Object and serves the built
// client for everything else.
//
// Client and server ship as one Worker rather than Pages + a separate Worker.
// That makes the WebSocket same-origin (no CORS, no second hostname to
// configure, no cross-origin cookie/TLS questions) and means one `wrangler
// deploy` can never leave the two halves on different versions of the protocol.

import { normalizeCode, WS_PATH } from '../src/net/protocol';

export { GameRoom } from './GameRoom';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === WS_PATH) {
      const code = normalizeCode(url.searchParams.get('code') ?? '');
      if (!code) return new Response('Bad room code.', { status: 400 });
      // The normalized code *is* the Durable Object's name, so every player who
      // types it — in any case — lands in the same room, and no lookup table is
      // needed to find a game.
      const id = env.GAME_ROOM.idFromName(code);
      return env.GAME_ROOM.get(id).fetch(req);
    }

    // Anything else is the SPA. `not_found_handling: single-page-application`
    // means a deep link (or a refresh on one) still returns index.html.
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;

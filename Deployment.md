## Running and deploying

```bash
npm install
npm run dev          # http://localhost:5173 — client only, hotseat
```

Online play needs the Worker, which Vite does not run. Two ways to get it:

```bash
npm run dev:worker   # http://localhost:8787 — client + Durable Object, as deployed
```

or keep HMR and run both — `npm run dev` proxies `/api/*` to `wrangler dev`:

```bash
npx wrangler dev     # terminal 1
npm run dev          # terminal 2 — online works, HMR still works
```

To play online solo, open the game in **two tabs**: seats are remembered per tab.
Hit "Start online game" in one, then join with the code from the other.

## Checks

```bash
npm test             # Vitest — the rules engine, hermetic
npm run lint
npx tsc -b           # typechecks the client and the worker
npm run smoke        # end-to-end sockets; needs `npm run dev:worker` running
```

## Deploying

First time only — this opens a browser, so it cannot be scripted:

```bash
npx wrangler login
npx wrangler whoami   # confirms the account you are about to publish to
```

Then, and for every release after:

```bash
npm run deploy                                        # build, then `wrangler deploy`
npm run smoke -- https://<your-worker-url>            # verify it over real sockets
```

The smoke test takes any origin, so the deployed game gets checked exactly the
way a local one does: seats, refusals, broadcast, reconnect. It plays in a room
of its own with a random code, so it is safe against production.

One Worker serves both the client and the `GameRoom` Durable Object, so there is
a single deploy and the room socket is same-origin. See §2 of `PLAN.md` for why
this is one Worker rather than Pages + a Worker.

Worth knowing about what you are publishing:

- **Anyone with the URL can start a game.** That is the design — no accounts, no
  database, nothing to leak. A room code is 6 characters from a 32-character
  alphabet (~1 billion), which is not a security boundary and is not meant to be.
- **Rooms are never garbage-collected.** Each code is a Durable Object, and its
  storage outlives the game; abandoned rooms simply sit there. At playtest volume
  this is noise, so no cleanup alarm is built. It would matter at scale.
- **Deploying mid-game restarts the Durable Objects.** Players reconnect on their
  own — that is what the backoff in `net/connection.ts` is for — and the room is
  restored from storage. If the wire format ever changes, bump
  `PROTOCOL_VERSION`: mismatched clients are then closed with a clear reason
  rather than left to misread frames.

## Layout

- `src/engine/` — the rules engine: **pure, dependency-free, no DOM**. Imported by
  both the client and the Worker, so the rules the UI shows are the ones the
  server enforces. `room.ts` adds the seat authority that networking needs.
- `src/net/` — `protocol.ts` (shared wire types) and `connection.ts` (browser only).
- `src/state/` — `sessionStore` owns the room; the view stores own local selection.
- `worker/` — the Worker and the Durable Object. May import only `src/engine/` and
  `src/net/protocol.ts`; `tsconfig.worker.json` enforces that.
- `tools/` — `extract_map.py` regenerates `src/data/map.json` from the Figma SVG
  (never hand-edit it); `make_map_check.py` renders a numbered verification page.



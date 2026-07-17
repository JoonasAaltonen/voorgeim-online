# Voorgeim Online

A playable demo of the Voorgeim board game, for playtesting the mechanics before
committing to a physical print. Two players over the network, or hotseat on one
screen.

Rules and the implementation plan live in `../Documentation/` (`VOORGEIM.md`,
`PLAN.md`) — this repo is code only.

## Running it

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

```bash
npm run deploy       # builds the client, then `wrangler deploy`
```

One Worker serves both the client and the `GameRoom` Durable Object, so there is
a single deploy and the room socket is same-origin. See §2 of `PLAN.md` for why
this is one Worker rather than Pages + a Worker.

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

## Assets

`npm run sync-assets` copies coins, boards and cards from `../Figma exports/` into
`public/assets/`.

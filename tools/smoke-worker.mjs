// End-to-end smoke test for the Worker + GameRoom Durable Object, using Node's
// native WebSocket (Node 22+).
//
//   Terminal 1:  npm run dev:worker
//   Terminal 2:  npm run smoke
//
// Covers what `room.test.ts` structurally cannot, because it needs real sockets
// and a real DO: seat assignment, turning away a third player, the broadcast
// fan-out, protocol-version refusal, and a game surviving a disconnect. It found
// a live bug on its first run (a joining socket was left out of its own seat
// tally), which is the argument for keeping it.
//
// Not part of `npm test`: it needs a server running, and Vitest should stay
// hermetic.

const BASE = 'ws://127.0.0.1:8787/api/ws';
// A fresh code per run: the code names the Durable Object, and its storage
// outlives the process, so a fixed code would replay into last run's game.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE = Array.from({ length: 6 }, () => ALPHABET[(Math.random() * 32) | 0]).join('');
const V = 1;

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

function connect(seat) {
  const url = `${BASE}?code=${CODE}&v=${V}${seat ? `&seat=${seat}` : ''}`;
  const ws = new WebSocket(url);
  ws.inbox = [];
  ws.closed = null;
  ws.addEventListener('message', (e) => ws.inbox.push(JSON.parse(e.data)));
  ws.addEventListener('close', (e) => (ws.closed = { code: e.code, reason: e.reason }));
  return ws;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for a message matching `t`, or null on timeout. */
async function next(ws, t, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const i = ws.inbox.findIndex((m) => m.t === t);
    if (i >= 0) return ws.inbox.splice(i, 1)[0];
    if (ws.closed) return null;
    await sleep(20);
  }
  return null;
}

async function waitClosed(ws, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !ws.closed) await sleep(20);
  return ws.closed;
}

const send = (ws, intent) => ws.send(JSON.stringify({ t: 'intent', intent }));

async function main() {
  // 1. First socket takes p1.
  const a = connect();
  const wa = await next(a, 'welcome');
  check(wa?.seat === 'p1', `first socket is seated p1 (got ${wa?.seat})`);
  check(wa?.room?.code === CODE, 'welcome carries the room, named by the code');

  // 2. Second socket takes p2, and the first is told.
  const b = connect();
  const wb = await next(b, 'welcome');
  check(wb?.seat === 'p2', `second socket is seated p2 (got ${wb?.seat})`);
  check(
    JSON.stringify(wb?.seats) === '["p1","p2"]',
    `the joiner's welcome counts itself (got ${JSON.stringify(wb?.seats)})`,
  );
  const seatsA = await next(a, 'seats');
  check(
    JSON.stringify(seatsA?.seats) === '["p1","p2"]',
    `p1 is told both seats are filled (got ${JSON.stringify(seatsA?.seats)})`,
  );

  // 3. p2 tries to move on p1's turn — the core authority rule, over a real socket.
  const unit = Object.values(wa.room.strategic.units).find((u) => u.owner === 'p1');
  send(b, { t: 'stratMove', unitId: unit.id, nodeId: 'n12' });
  const rej = await next(b, 'reject');
  check(rej?.reason === "It is P1 - Red's turn.", `p2 is refused on p1's turn (got ${rej?.reason})`);
  check((await next(a, 'room', 300)) === null, 'a refused move broadcasts nothing to p1');

  // 4. p1 makes the same move — both sockets see it.
  send(a, { t: 'stratMove', unitId: unit.id, nodeId: 'n12' });
  const ra = await next(a, 'room');
  const rb = await next(b, 'room');
  check(ra?.room.strategic.units[unit.id].nodeId === 'n12', 'p1 move accepted');
  check(rb?.room.strategic.units[unit.id].nodeId === 'n12', 'the move is broadcast to p2');
  check(ra?.room.version === 1, `version bumped once (got ${ra?.room.version})`);

  // 5. A third player is turned away with a readable reason.
  const c = connect();
  const closed = await waitClosed(c);
  check(closed?.code === 4001, `third socket closed with ROOM_FULL (got ${closed?.code})`);
  check(/two players/.test(closed?.reason ?? ''), `and a reason (got "${closed?.reason}")`);

  // 6. p1 drops; p2 is told the seat is empty.
  a.close();
  const seatsB = await next(b, 'seats');
  check(
    JSON.stringify(seatsB?.seats) === '["p2"]',
    `p2 sees p1 leave (got ${JSON.stringify(seatsB?.seats)})`,
  );

  // 7. p1 reconnects, reclaims its seat, and the game is still there.
  const a2 = connect('p1');
  const wa2 = await next(a2, 'welcome');
  check(wa2?.seat === 'p1', `reconnect reclaims p1 (got ${wa2?.seat})`);
  check(
    wa2?.room.strategic.units[unit.id].nodeId === 'n12',
    'the game survived the disconnect',
  );
  check(wa2?.room.version === 1, 'including its version');

  // 8. A stale client is refused rather than left to misread frames.
  const old = new WebSocket(`${BASE}?code=${CODE}&v=999`);
  old.closedInfo = null;
  old.addEventListener('close', (e) => (old.closedInfo = { code: e.code, reason: e.reason }));
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && !old.closedInfo) await sleep(20);
  check(old.closedInfo?.code === 4002, `protocol mismatch closed (got ${old.closedInfo?.code})`);

  // 9. Garbage cannot brick the room.
  send(a2, { t: 'nonsense' });
  const rej2 = await next(a2, 'reject');
  check(rej2?.reason === 'Unknown intent.', `unknown intent refused (got ${rej2?.reason})`);

  b.close();
  a2.close();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

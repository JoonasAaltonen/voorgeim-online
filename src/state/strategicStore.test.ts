// The store is where a click becomes an intent, and it holds rules the engine
// never sees: that two loose units travel together only if they are actually
// together, and that clicking the node you already stand in means "put it down"
// rather than a move the engine has to refuse.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STAGING_NODE, NODE_BY_ID } from '../engine/map';
import { armiesAt, armyUnits, looseAt, reorganize, NEW_ARMY } from '../engine/strategic';
import { useSession } from './sessionStore';
import { useStrategicStore } from './strategicStore';

const strat = () => useSession.getState().room.strategic;
const store = () => useStrategicStore.getState();

/** Rewind to a fresh local game between tests — these stores are module-level. */
beforeEach(() => {
  // Initiative is a dice roll; pin it so p1 always opens and these p1-centric
  // tests are deterministic. Must be in place before the reset below rolls it.
  let high = false;
  vi.spyOn(Math, 'random').mockImplementation(() => {
    high = !high;
    return high ? 0.99 : 0;
  });
  useStrategicStore.setState({ sel: null, inspectedNode: STAGING_NODE.p1, reorgNode: null });
  useSession.getState().dispatch({ t: 'stratReset' });
});
afterEach(() => vi.restoreAllMocks());

describe('loose selection', () => {
  it('takes a second unit standing in the same node', () => {
    const [a, b] = looseAt(strat(), STAGING_NODE.p1, 'p1');
    store().toggleLoose(a.id);
    store().toggleLoose(b.id);
    expect(store().sel).toEqual({ kind: 'loose', unitIds: [a.id, b.id] });
  });

  it('refuses a third, starting a fresh selection instead', () => {
    const [a, b, c] = looseAt(strat(), STAGING_NODE.p1, 'p1');
    store().toggleLoose(a.id);
    store().toggleLoose(b.id);
    store().toggleLoose(c.id);
    expect(store().sel).toEqual({ kind: 'loose', unitIds: [c.id] });
  });

  it('drops a unit clicked twice, and the selection with the last of them', () => {
    const [a, b] = looseAt(strat(), STAGING_NODE.p1, 'p1');
    store().toggleLoose(a.id);
    store().toggleLoose(b.id);
    store().toggleLoose(a.id);
    expect(store().sel).toEqual({ kind: 'loose', unitIds: [b.id] });
    store().toggleLoose(b.id);
    expect(store().sel).toBeNull();
  });

  it('will not pair units from different nodes', () => {
    const [a, b] = looseAt(strat(), STAGING_NODE.p1, 'p1');
    const away = NODE_BY_ID[STAGING_NODE.p1].adjacency[0];
    useSession.getState().dispatch({ t: 'stratMoveLoose', unitIds: [a.id], nodeId: away });

    store().toggleLoose(a.id); // now out at `away`
    store().toggleLoose(b.id); // still in staging
    expect(store().sel).toEqual({ kind: 'loose', unitIds: [b.id] });
  });
});

// Left-click selects and right-click commands, so the two gestures never
// compete: picking up a second army is the same click as picking up the first,
// wherever it stands.
describe('left-clicking the map', () => {
  it('opens a node and lets go of what was in hand, moving nothing', () => {
    const u = looseAt(strat(), STAGING_NODE.p1, 'p1')[0];
    const to = NODE_BY_ID[STAGING_NODE.p1].adjacency[0];
    store().toggleLoose(u.id);
    store().nodeClicked(to);
    expect(store().sel).toBeNull();
    expect(store().inspectedNode).toBe(to);
    expect(strat().units[u.id].nodeId).toBe(STAGING_NODE.p1); // stayed put
    expect(strat().actionsLeft).toBe(2); // nothing was spent
    expect(useSession.getState().error).toBeNull();
  });

  it('swaps straight to another army, wherever that army stands', () => {
    const pick = (n: number) =>
      looseAt(strat(), STAGING_NODE.p1, 'p1')
        .slice(0, n)
        .map((u) => u.id);
    const one = pick(2);
    useSession.getState().dispatch({
      t: 'stratReorganize',
      nodeId: STAGING_NODE.p1,
      assign: Object.fromEntries(one.map((id) => [id, NEW_ARMY])),
    });
    const two = pick(2);
    useSession.getState().dispatch({
      t: 'stratReorganize',
      nodeId: STAGING_NODE.p1,
      assign: Object.fromEntries(two.map((id) => [id, NEW_ARMY])),
    });
    const [a, b] = armiesAt(strat(), STAGING_NODE.p1, 'p1');
    expect(b).toBeDefined();

    store().selectArmy(a.id);
    store().selectArmy(b.id);
    expect(store().sel).toEqual({ kind: 'army', armyId: b.id });
    expect(useSession.getState().error).toBeNull(); // no rejected move on the way
  });
});

describe('right-clicking the map', () => {
  it('sends what is in hand and empties the hand', () => {
    const u = looseAt(strat(), STAGING_NODE.p1, 'p1')[0];
    const to = NODE_BY_ID[STAGING_NODE.p1].adjacency[0];
    store().toggleLoose(u.id);
    store().nodeCommanded(to);
    expect(strat().units[u.id].nodeId).toBe(to);
    expect(store().sel).toBeNull();
    expect(store().inspectedNode).toBe(to);
  });

  it('carries a whole army when the army is what is in hand', () => {
    const ids = looseAt(strat(), STAGING_NODE.p1, 'p1')
      .slice(0, 3)
      .map((u) => u.id);
    useSession.getState().dispatch({
      t: 'stratReorganize',
      nodeId: STAGING_NODE.p1,
      assign: Object.fromEntries(ids.map((id) => [id, NEW_ARMY])),
    });
    const army = armiesAt(strat(), STAGING_NODE.p1, 'p1')[0];
    expect(army).toBeDefined();

    const to = NODE_BY_ID[STAGING_NODE.p1].adjacency[0];
    store().selectArmy(army.id);
    store().nodeCommanded(to);
    expect(armyUnits(strat(), army.id).every((u) => u.nodeId === to)).toBe(true);
    expect(store().sel).toBeNull();
  });

  it('does nothing at all with an empty hand', () => {
    const to = NODE_BY_ID[STAGING_NODE.p1].adjacency[0];
    store().nodeCommanded(to);
    expect(strat().actionsLeft).toBe(2);
    expect(useSession.getState().error).toBeNull();
  });

  it('ignores an order to stay where it already is', () => {
    const u = looseAt(strat(), STAGING_NODE.p1, 'p1')[0];
    store().toggleLoose(u.id);
    store().nodeCommanded(STAGING_NODE.p1);
    expect(strat().actionsLeft).toBe(2);
    expect(useSession.getState().error).toBeNull();
    expect(store().sel).not.toBeNull(); // still in hand, not fumbled
  });
});

describe('reorganizing through the store', () => {
  it('commits the table and closes it', () => {
    const ids = looseAt(strat(), STAGING_NODE.p1, 'p1')
      .slice(0, 2)
      .map((u) => u.id);
    store().openReorg(STAGING_NODE.p1);
    expect(store().reorgNode).toBe(STAGING_NODE.p1);
    store().reorganize(Object.fromEntries(ids.map((id) => [id, NEW_ARMY])));
    expect(store().reorgNode).toBeNull();
    expect(armiesAt(strat(), STAGING_NODE.p1, 'p1')).toHaveLength(1);
  });

  // The engine is the one that says no; the store must surface it, not swallow it.
  it('surfaces a refusal from the engine', () => {
    const away = NODE_BY_ID[STAGING_NODE.p1].adjacency[0];
    const u = looseAt(strat(), STAGING_NODE.p1, 'p1')[0];
    useSession.getState().dispatch({ t: 'stratMoveLoose', unitIds: [u.id], nodeId: away });
    store().openReorg(away);
    store().reorganize({ [u.id]: NEW_ARMY });
    expect(useSession.getState().error).toMatch(/controlled location/i);
    // And the engine's own guard agrees, so this is not a UI-only rule.
    expect(reorganize(strat(), away, { [u.id]: NEW_ARMY }).error).toBeDefined();
  });
});

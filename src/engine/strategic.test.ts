// Strategic-map engine: movement (Phase 3), then armies, supply and control
// (Phase 5). `map.test.ts` next door guards the map *data*; this file guards the
// rules played on top of it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONTESTED_NODES,
  NODE_BY_ID,
  STAGING_NODE,
  arePathLinked,
  isSea,
  slotsFor,
  type NodeId,
} from './map';
import {
  ACTIONS_PER_TURN,
  MAX_ARMIES,
  NEW_ARMY,
  SEA_SUPPLY,
  HOLD_TO_WIN,
  armiesAt,
  armyCount,
  armyUnits,
  buildFort,
  canFortify,
  canFreeReorg,
  canReorganize,
  controlFor,
  createStrategic as newGame,
  dismissFreeReorg,
  doorstep,
  endRecon,
  endTurn as handOver,
  fortsAt,
  freeReorganize,
  legalArmyTargets,
  legalLooseTargets,
  looseAt,
  moveArmy,
  moveLoose,
  reconAt,
  RECON_ACTIONS,
  reconAttempt,
  reorganize,
  sideOf,
  splitUnits,
  supplyCap,
  swapSide,
  supplyUsed,
  unitsAt,
  type MapUnit,
  type StrategicState,
  type Transition,
} from './strategic';
import { playerLabel, type Player } from './types';
import { STARTING_ARMY } from './units';

// The map is real data, so tests pick nodes by the property under test rather
// than by id: an id that happens to satisfy today's graph is a trap the next
// Figma re-export springs.

/**
 * Pull `n` of a player's untouched staging units out onto `node`, still loose.
 * Never recon: recon cannot be organized or overrun, so a test that reached for
 * one by accident would be measuring something else entirely.
 */
function place(s: StrategicState, owner: Player, node: NodeId, n: number): MapUnit[] {
  const taken = Object.values(s.units)
    .filter(
      (u) => u.owner === owner && !u.armyId && u.nodeId === STAGING_NODE[owner] && u.type !== 'recon',
    )
    .slice(0, n);
  for (const u of taken) u.nodeId = node;
  return taken;
}

/** Same, but organized into a fresh army. Later calls get a later `movedAt`. */
function placeArmy(s: StrategicState, owner: Player, node: NodeId, n: number): string {
  const id = `army-${owner}-${++s.tick}`;
  s.armies[id] = { id, owner, movedAt: s.tick };
  for (const u of place(s, owner, node, n)) u.armyId = id;
  return id;
}

// Initiative is a dice roll now, so an un-pinned RNG would make "whose turn is
// it" random and half these tests flaky. Pin Math.random to a stateful stub that
// always hands p1 the win (6 then 1, so `rollUntilDifferent` never ties) — turn
// order becomes the clean p1→p2 alternation the rules tests below assume, while
// production and the online game still roll for real.
beforeEach(() => {
  let high = false;
  vi.spyOn(Math, 'random').mockImplementation(() => {
    high = !high;
    return high ? 0.99 : 0;
  });
});
afterEach(() => vi.restoreAllMocks());

/**
 * Almost every test below is about the strategic phase, so the default opening
 * skips straight past the recon phase. The recon suites call `newGame()` instead
 * when the recon phase is the thing under test.
 */
const createStrategic = (rng?: Parameters<typeof newGame>[0]): StrategicState =>
  endRecon(newGame(rng)).state;

/** Likewise: hand the turn over and drop the next player straight into strategy. */
const endTurn = (...args: Parameters<typeof handOver>): Transition => {
  const t = handOver(...args);
  return t.error || t.state.phase !== 'recon' ? t : endRecon(t.state);
};

const isPlain = (id: NodeId) => !isSea(id) && !NODE_BY_ID[id].staging;

/** A land node whose neighbours are all plain land — keeps sea's flat cap out of the way. */
const inland = CONTESTED_NODES.find((n) => !n.sea && !n.asymmetric && n.adjacency.every(isPlain))!;

describe('armies and disorganized units', () => {
  it('starts every fighting unit loose, with no armies formed', () => {
    const s = createStrategic();
    expect(Object.keys(s.armies)).toHaveLength(0);
    expect(Object.values(s.units).every((u) => !u.armyId)).toBe(true);
    // 25 units, less the 2 recon, which are never "disorganized" — see below.
    expect(looseAt(s, STAGING_NODE.p1, 'p1')).toHaveLength(23);
  });

  it('forms an army in the staging area for one action', () => {
    const s = createStrategic();
    const ids = looseAt(s, STAGING_NODE.p1, 'p1')
      .slice(0, 3)
      .map((u) => u.id);
    const t = reorganize(s, STAGING_NODE.p1, Object.fromEntries(ids.map((id) => [id, NEW_ARMY])));
    expect(t.error).toBeUndefined();
    expect(t.state.actionsLeft).toBe(ACTIONS_PER_TURN - 1);
    const armies = armiesAt(t.state, STAGING_NODE.p1, 'p1');
    expect(armies).toHaveLength(1);
    expect(
      armyUnits(t.state, armies[0].id)
        .map((u) => u.id)
        .sort(),
    ).toEqual([...ids].sort());
  });

  it('creates at most one army per reorganization, however many units are named', () => {
    const s = createStrategic();
    const ids = looseAt(s, STAGING_NODE.p1, 'p1')
      .slice(0, 6)
      .map((u) => u.id);
    const t = reorganize(s, STAGING_NODE.p1, Object.fromEntries(ids.map((id) => [id, NEW_ARMY])));
    expect(armyCount(t.state, 'p1')).toBe(1);
  });

  it(`refuses a new army once ${MAX_ARMIES} are fielded`, () => {
    const s = createStrategic();
    for (let i = 0; i < MAX_ARMIES; i++) placeArmy(s, 'p1', STAGING_NODE.p1, 1);
    expect(armyCount(s, 'p1')).toBe(MAX_ARMIES);
    const spare = looseAt(s, STAGING_NODE.p1, 'p1')[0];
    const t = reorganize(s, STAGING_NODE.p1, { [spare.id]: NEW_ARMY });
    expect(t.error).toMatch(/already field/i);
    expect(t.state).toBe(s);
  });

  it('moves units between existing armies without creating one', () => {
    const s = createStrategic();
    const a = placeArmy(s, 'p1', STAGING_NODE.p1, 3);
    const b = placeArmy(s, 'p1', STAGING_NODE.p1, 3);
    const moving = armyUnits(s, a)[0];
    const t = reorganize(s, STAGING_NODE.p1, { [moving.id]: b });
    expect(t.error).toBeUndefined();
    expect(armyCount(t.state, 'p1')).toBe(2);
    expect(armyUnits(t.state, a)).toHaveLength(2);
    expect(armyUnits(t.state, b)).toHaveLength(4);
  });

  it('drops an army that reorganizes away its last unit', () => {
    const s = createStrategic();
    const a = placeArmy(s, 'p1', STAGING_NODE.p1, 1);
    const only = armyUnits(s, a)[0];
    const t = reorganize(s, STAGING_NODE.p1, { [only.id]: null });
    expect(t.state.armies[a]).toBeUndefined();
    expect(t.state.units[only.id].armyId).toBeUndefined();
  });

  it('refuses to reorganize a unit into an army standing elsewhere', () => {
    const s = createStrategic();
    placeArmy(s, 'p1', STAGING_NODE.p1, 2);
    const away = placeArmy(s, 'p1', inland.id, 2);
    const home = looseAt(s, STAGING_NODE.p1, 'p1')[0];
    const t = reorganize(s, STAGING_NODE.p1, { [home.id]: away });
    expect(t.error).toMatch(/not in this location/i);
  });

  // "Reorganization can be also used for simply re-hiding the units without
  // moving any between other armies" — Phase 6 gives this its visible effect.
  it('accepts a reorganization that moves nobody, and still charges an action', () => {
    const s = createStrategic();
    placeArmy(s, 'p1', STAGING_NODE.p1, 3);
    const t = reorganize(s, STAGING_NODE.p1, {});
    expect(t.error).toBeUndefined();
    expect(t.state.actionsLeft).toBe(ACTIONS_PER_TURN - 1);
  });

  it('splits units out of an army for free', () => {
    const s = createStrategic();
    const a = placeArmy(s, 'p1', inland.id, 3);
    const out = armyUnits(s, a)[0];
    const t = splitUnits(s, [out.id]);
    expect(t.error).toBeUndefined();
    expect(t.state.actionsLeft).toBe(ACTIONS_PER_TURN); // free — no action spent
    expect(t.state.units[out.id].armyId).toBeUndefined();
    expect(armyUnits(t.state, a)).toHaveLength(2);
  });
});

// Recon is outside almost every system this file implements — worth pinning,
// because each of these was wrong before the rules were read closely.
describe('recon', () => {
  const reconOf = (s: StrategicState, p: Player) =>
    Object.values(s.units).filter((u) => u.owner === p && u.type === 'recon');

  it('starts as two units that are neither in an army nor disorganized', () => {
    const s = createStrategic();
    expect(reconOf(s, 'p1')).toHaveLength(2);
    expect(looseAt(s, STAGING_NODE.p1, 'p1')).toHaveLength(23); // 25 less the recon
    expect(reconAt(s, STAGING_NODE.p1, 'p1')).toHaveLength(2);
  });

  // "Recon unit can be present in a location with an army without using any
  // supplies."
  it('uses no supply, alone or beside an army', () => {
    const s = createStrategic();
    const scout = reconOf(s, 'p1')[0];
    s.units[scout.id].nodeId = inland.id;
    expect(supplyUsed(s, inland.id, 'p1')).toBe(0);

    placeArmy(s, 'p1', inland.id, 2);
    expect(supplyUsed(s, inland.id, 'p1')).toBe(2); // the army, and nothing more
  });

  it('never joins an army, even if a client asks', () => {
    const s = createStrategic();
    const scout = reconOf(s, 'p1')[0];
    const t = reorganize(s, STAGING_NODE.p1, { [scout.id]: NEW_ARMY });
    expect(t.error).toMatch(/never part of an army/i);
    expect(t.state).toBe(s);
  });

  // "Recon units can move between the locations and behind enemy lines without
  // initiating battles."
  it('walks onto an enemy army, where a fighting unit may not', () => {
    const s = newGame(); // scouts move on the recon phase's budget
    placeArmy(s, 'p2', inland.id, 2);
    const from = inland.adjacency[0];
    const scout = reconOf(s, 'p1')[0];
    s.units[scout.id].nodeId = from;
    const grunt = place(s, 'p1', from, 1)[0];

    expect(legalLooseTargets(s, scout.id)).toContain(inland.id);
    expect(legalLooseTargets(s, grunt.id)).not.toContain(inland.id);
    expect(moveLoose(s, [scout.id], inland.id).error).toBeUndefined();
  });

  it('survives an enemy army walking over it', () => {
    const s = createStrategic();
    const scout = reconOf(s, 'p2')[0];
    s.units[scout.id].nodeId = inland.id;
    const a = placeArmy(s, 'p1', inland.adjacency[0], 2);
    const t = moveArmy(s, a, inland.id);
    expect(t.error).toBeUndefined();
    expect(t.state.units[scout.id]).toBeDefined();
  });

  // Two unreplenishable scouts must not double as a permanent economic weapon:
  // a scout may walk into an enemy's rear and leave their supply untouched.
  it('contests nothing — not from next door, and not from inside the node', () => {
    const s = createStrategic();
    placeArmy(s, 'p1', inland.id, 2);
    const [a, b] = reconOf(s, 'p2');

    s.units[a.id].nodeId = inland.adjacency[0];
    expect(controlFor(s, inland.id, 'p1')).toBe('controlled');

    s.units[b.id].nodeId = inland.id; // standing in it, alongside the army
    expect(controlFor(s, inland.id, 'p1')).toBe('controlled');
    expect(supplyCap(s, inland.id, 'p1')).toBe(slotsFor(inland.id, 'p1') * 6);
  });

  it('moves on its own, taking no one with it', () => {
    const s = newGame(); // scouts move on the recon phase's budget
    const scout = reconOf(s, 'p1')[0];
    const mate = looseAt(s, STAGING_NODE.p1, 'p1')[0];
    const to = NODE_BY_ID[STAGING_NODE.p1].adjacency[0];
    expect(moveLoose(s, [scout.id, mate.id], to).error).toMatch(/on its own/i);
    expect(moveLoose(s, [scout.id], to).error).toBeUndefined();
  });
});

describe('control and supply', () => {
  it('treats staging as controlled and uncapped, whatever the neighbours do', () => {
    const s = createStrategic();
    place(s, 'p2', NODE_BY_ID[STAGING_NODE.p1].adjacency[0], 2);
    expect(controlFor(s, STAGING_NODE.p1, 'p1')).toBe('controlled');
    expect(supplyCap(s, STAGING_NODE.p1, 'p1')).toBe(Infinity);
    expect(canReorganize(s, STAGING_NODE.p1, 'p1')).toBe(true);
  });

  it('controls a node held by an army with no enemy next door', () => {
    const s = createStrategic();
    placeArmy(s, 'p1', inland.id, 2);
    expect(controlFor(s, inland.id, 'p1')).toBe('controlled');
    expect(supplyCap(s, inland.id, 'p1')).toBe(slotsFor(inland.id, 'p1') * 6);
  });

  // Doubled supply is a rear-area privilege, so *any* enemy body next door
  // revokes it — it need not be one that could fight.
  it('lets a single loose enemy unit next door revoke control', () => {
    const s = createStrategic();
    placeArmy(s, 'p1', inland.id, 2);
    place(s, 'p2', inland.adjacency[0], 1);
    expect(controlFor(s, inland.id, 'p1')).toBe('contested');
    expect(supplyCap(s, inland.id, 'p1')).toBe(slotsFor(inland.id, 'p1') * 3);
    expect(canReorganize(s, inland.id, 'p1')).toBe(false);
  });

  // Contested is the default, not a state the enemy has to create.
  it('contests a node holding only loose units of mine, enemy or no enemy', () => {
    const s = createStrategic();
    place(s, 'p1', inland.id, 3);
    expect(controlFor(s, inland.id, 'p1')).toBe('contested');
    expect(canReorganize(s, inland.id, 'p1')).toBe(false);
  });

  // The node counts alongside its neighbours — which is what makes control
  // exclusive. Without it, two armies sharing a node with nobody adjacent each
  // satisfied "army here, no enemy next door", and the node read as controlled
  // by both at once.
  it('contests a node both sides are standing in, for both of them', () => {
    const s = createStrategic();
    placeArmy(s, 'p1', inland.id, 2);
    placeArmy(s, 'p2', inland.id, 2);
    expect(controlFor(s, inland.id, 'p1')).toBe('contested');
    expect(controlFor(s, inland.id, 'p2')).toBe('contested');
    expect(canReorganize(s, inland.id, 'p1')).toBe(false);
    expect(canReorganize(s, inland.id, 'p2')).toBe(false);
  });

  it('contests a node the enemy has merely left stragglers in', () => {
    const s = createStrategic();
    placeArmy(s, 'p1', inland.id, 2);
    place(s, 'p2', inland.id, 1);
    expect(controlFor(s, inland.id, 'p1')).toBe('contested');
    expect(supplyCap(s, inland.id, 'p1')).toBe(slotsFor(inland.id, 'p1') * 3);
  });

  it('never lets both players control the same node, wherever their units are', () => {
    const s = createStrategic();
    placeArmy(s, 'p1', inland.id, 2);
    placeArmy(s, 'p2', inland.id, 2);
    place(s, 'p1', inland.adjacency[0], 1);
    place(s, 'p2', inland.adjacency[1] ?? inland.adjacency[0], 1);
    for (const n of CONTESTED_NODES) {
      const both =
        controlFor(s, n.id, 'p1') === 'controlled' && controlFor(s, n.id, 'p2') === 'controlled';
      expect(both).toBe(false);
    }
  });

  it('supplies a flat 2 at sea and never reorganizes there', () => {
    const s = createStrategic();
    const sea = CONTESTED_NODES.find((n) => n.sea)!;
    placeArmy(s, 'p1', sea.id, 1);
    expect(supplyCap(s, sea.id, 'p1')).toBe(SEA_SUPPLY);
    expect(canReorganize(s, sea.id, 'p1')).toBe(false);
  });

  it('charges any number of loose units a flat 1 supply between them', () => {
    const s = createStrategic();
    const a = placeArmy(s, 'p1', inland.id, 2);
    expect(supplyUsed(s, inland.id, 'p1')).toBe(2);
    place(s, 'p1', inland.id, 1);
    expect(supplyUsed(s, inland.id, 'p1')).toBe(3);
    place(s, 'p1', inland.id, 4); // four more loose units, still one supply
    expect(supplyUsed(s, inland.id, 'p1')).toBe(3);
    expect(armyUnits(s, a)).toHaveLength(2);
  });
});

describe('strategic movement', () => {
  it('musters both full rosters in their staging areas', () => {
    const s = createStrategic();
    const perPlayer = Object.values(STARTING_ARMY).reduce((a, b) => a + b, 0);
    expect(perPlayer).toBe(25);
    expect(Object.keys(s.units)).toHaveLength(perPlayer * 2);
    expect(unitsAt(s, STAGING_NODE.p1)).toHaveLength(perPlayer);
    expect(unitsAt(s, STAGING_NODE.p2)).toHaveLength(perPlayer);
    expect(s.turn).toBe('p1');
    expect(s.actionsLeft).toBe(ACTIONS_PER_TURN);
  });

  it('offers exactly the path-adjacent nodes as legal targets', () => {
    const s = createStrategic();
    const u = looseAt(s, STAGING_NODE.p1, 'p1')[0];
    expect(legalLooseTargets(s, u.id).sort()).toEqual([...NODE_BY_ID[u.nodeId].adjacency].sort());
    const a = placeArmy(s, 'p1', inland.id, 2);
    expect(legalArmyTargets(s, a).sort()).toEqual([...inland.adjacency].sort());
  });

  it('moves a loose unit along a path and spends one action', () => {
    const s = createStrategic();
    const u = looseAt(s, STAGING_NODE.p1, 'p1')[0];
    const to = NODE_BY_ID[u.nodeId].adjacency[0];
    const t = moveLoose(s, [u.id], to);
    expect(t.error).toBeUndefined();
    expect(t.state.units[u.id].nodeId).toBe(to);
    expect(t.state.actionsLeft).toBe(ACTIONS_PER_TURN - 1);
    expect(s.units[u.id].nodeId).toBe(STAGING_NODE.p1); // caller's state untouched
  });

  it('moves two loose units together for a single action, but not three', () => {
    const s = createStrategic();
    const [a, b, c] = looseAt(s, STAGING_NODE.p1, 'p1');
    const to = NODE_BY_ID[STAGING_NODE.p1].adjacency[0];
    const t = moveLoose(s, [a.id, b.id], to);
    expect(t.error).toBeUndefined();
    expect(t.state.actionsLeft).toBe(ACTIONS_PER_TURN - 1);
    expect(t.state.units[b.id].nodeId).toBe(to);
    expect(moveLoose(s, [a.id, b.id, c.id], to).error).toMatch(/may move together/i);
  });

  it('carries every member of an army along for one action', () => {
    const s = createStrategic();
    const a = placeArmy(s, 'p1', inland.id, 4);
    const to = inland.adjacency[0];
    const t = moveArmy(s, a, to);
    expect(t.error).toBeUndefined();
    expect(t.state.actionsLeft).toBe(ACTIONS_PER_TURN - 1);
    expect(armyUnits(t.state, a).every((u) => u.nodeId === to)).toBe(true);
  });

  it('blocks a jump to a node with no movement path', () => {
    const s = createStrategic();
    const u = looseAt(s, STAGING_NODE.p1, 'p1')[0];
    const far = CONTESTED_NODES.find((n) => n.id !== u.nodeId && !arePathLinked(u.nodeId, n.id))!;
    const t = moveLoose(s, [u.id], far.id);
    expect(t.error).toMatch(/no movement path/i);
    expect(t.state).toBe(s);
  });

  it("blocks moving the opponent's unit", () => {
    const s = createStrategic();
    const enemy = looseAt(s, STAGING_NODE.p2, 'p2')[0];
    const t = moveLoose(s, [enemy.id], NODE_BY_ID[enemy.nodeId].adjacency[0]);
    expect(t.error).toMatch(/P1 - Red's turn/);
    expect(t.state).toBe(s);
  });

  it('keeps loose units clear of a node an enemy army holds', () => {
    const s = createStrategic();
    placeArmy(s, 'p2', inland.id, 2);
    const mine = place(s, 'p1', inland.adjacency[0], 1)[0];
    expect(legalLooseTargets(s, mine.id)).not.toContain(inland.id);
    expect(moveLoose(s, [mine.id], inland.id).error).toMatch(/enemy army/i);
  });

  // Spending the budget does *not* hand over. The turn is Recon → Strategic →
  // Battle → Supply, so the player still has to be able to open a battle with
  // the army they just moved, and the supply check must wait until they say
  // they are done arranging. The turn ends when they end it.
  it('stops accepting actions after two, but holds the turn open', () => {
    let t: Transition = { state: createStrategic() };
    const [a, b] = looseAt(t.state, STAGING_NODE.p1, 'p1');
    t = moveLoose(t.state, [a.id], NODE_BY_ID[a.nodeId].adjacency[0]);
    t = moveLoose(t.state, [b.id], NODE_BY_ID[b.nodeId].adjacency[0]);
    expect(t.state.turn).toBe('p1');
    expect(t.state.actionsLeft).toBe(0);

    const c = looseAt(t.state, STAGING_NODE.p1, 'p1')[0];
    const denied = moveLoose(t.state, [c.id], NODE_BY_ID[c.nodeId].adjacency[0]);
    expect(denied.error).toMatch(/no actions left/i);

    // And it is `endTurn` that finally hands over.
    expect(endTurn(t.state).state.turn).toBe('p2');
  });

  it('counts a round only when play returns to p1', () => {
    let t: Transition = { state: createStrategic() };
    expect(t.state.round).toBe(1);
    t = endTurn(t.state);
    expect(t.state.turn).toBe('p2');
    expect(t.state.round).toBe(1);
    t = endTurn(t.state);
    expect(t.state.turn).toBe('p1');
    expect(t.state.round).toBe(2);
  });

  it('lets land units transit sea nodes', () => {
    const seaNode = CONTESTED_NODES.find((n) => n.sea)!;
    const land = seaNode.adjacency.find(isPlain)!;
    const s = createStrategic();
    const u = place(s, 'p1', land, 1)[0];
    const t = moveLoose(s, [u.id], seaNode.id);
    expect(t.error).toBeUndefined();
    expect(t.state.units[u.id].nodeId).toBe(seaNode.id);
  });
});

describe('overrun', () => {
  it('removes loose units caught in the open by an arriving army', () => {
    const s = createStrategic();
    const a = placeArmy(s, 'p1', inland.adjacency[0], 2);
    const caught = place(s, 'p2', inland.id, 3).map((u) => u.id);
    const t = moveArmy(s, a, inland.id);
    expect(t.error).toBeUndefined();
    for (const id of caught) expect(t.state.units[id]).toBeUndefined();
    expect(t.state.log.at(-1)?.text).toMatch(/overrun/i);
  });

  it('spares loose units guarded by an army of their own', () => {
    const s = createStrategic();
    const a = placeArmy(s, 'p1', inland.adjacency[0], 2);
    placeArmy(s, 'p2', inland.id, 1); // the guard
    const guarded = place(s, 'p2', inland.id, 2).map((u) => u.id);
    const t = moveArmy(s, a, inland.id);
    expect(t.error).toBeUndefined();
    for (const id of guarded) expect(t.state.units[id]).toBeDefined();
  });

  // "battles cannot commence over sea nodes even if opposing forces would meet".
  it('spares loose units at sea, where armies simply pass each other', () => {
    const s = createStrategic();
    const sea = CONTESTED_NODES.find((n) => n.sea)!;
    const a = placeArmy(s, 'p1', sea.adjacency.find(isPlain)!, 1);
    const afloat = place(s, 'p2', sea.id, 1).map((u) => u.id);
    const t = moveArmy(s, a, sea.id);
    expect(t.error).toBeUndefined();
    for (const id of afloat) expect(t.state.units[id]).toBeDefined();
  });
});

describe('end-of-turn supply check', () => {
  it('lets a node overstack mid-turn and only bites when the turn ends', () => {
    const s = createStrategic();
    place(s, 'p2', inland.adjacency[0], 1); // contests it: 3 per slot
    const a = placeArmy(s, 'p1', inland.id, slotsFor(inland.id, 'p1') * 3 + 2);
    const whole = armyUnits(s, a).length;
    expect(supplyUsed(s, inland.id, 'p1')).toBeGreaterThan(supplyCap(s, inland.id, 'p1'));
    expect(armyUnits(s, a)).toHaveLength(whole); // still whole mid-turn

    const t = endTurn(s).state;
    expect(supplyUsed(t, inland.id, 'p1')).toBeLessThanOrEqual(supplyCap(t, inland.id, 'p1'));
    expect(looseAt(t, inland.id, 'p1').length).toBeGreaterThan(0);
    expect(t.log.some((e) => /out of supply/i.test(e.text))).toBe(true);
  });

  it('sheds from the most recently moved army first', () => {
    const s = createStrategic();
    place(s, 'p2', inland.adjacency[0], 1); // contested
    const cap = slotsFor(inland.id, 'p1') * 3;
    const older = placeArmy(s, 'p1', inland.id, cap);
    const newer = placeArmy(s, 'p1', inland.id, 2);
    expect(s.armies[newer].movedAt).toBeGreaterThan(s.armies[older].movedAt);

    const t = endTurn(s).state;
    // The late arrival scatters entirely, and the loose unit it becomes costs the
    // garrison one more place — so the old army sheds exactly one, and no more.
    expect(t.armies[newer]).toBeUndefined();
    expect(armyUnits(t, older)).toHaveLength(cap - 1);
  });

  // "If a location turns from controlled to contested while holding more units
  // than can be supplied […] the player must move the excess units during their
  // next strategic turn or they become disorganized."
  it('gives a grace turn when the opponent is the one who contests the node', () => {
    const s = createStrategic();
    const full = slotsFor(inland.id, 'p1') * 6;
    const a = placeArmy(s, 'p1', inland.id, full);
    expect(controlFor(s, inland.id, 'p1')).toBe('controlled');

    // p2 walks up next door on their own turn, halving p1's cap.
    const near = inland.adjacency[0];
    const t1 = endTurn(s).state;
    const scout = place(t1, 'p2', NODE_BY_ID[near].adjacency.find((x) => x !== inland.id)!, 1)[0];
    const t2 = endTurn(moveLoose(t1, [scout.id], near).state).state;

    expect(controlFor(t2, inland.id, 'p1')).toBe('contested');
    // p2's turn has ended and p1's garrison is still intact — the supply check
    // that the halved cap now fails is p1's to face, on p1's own turn.
    expect(t2.turn).toBe('p1');
    expect(armyUnits(t2, a)).toHaveLength(full);

    const t3 = endTurn(t2).state; // now p1's turn ends, and the bill comes due
    expect(armyUnits(t3, a).length).toBeLessThan(full);
    expect(supplyUsed(t3, inland.id, 'p1')).toBeLessThanOrEqual(supplyCap(t3, inland.id, 'p1'));
  });
});

describe('asymmetric node sides', () => {
  // n01: 2 slots on the seaward side (p1), 1 slot facing n02 (p2).
  const SEA = 'n05';
  const LAND = 'n02';

  /** Walk `player`'s fresh army into n01 from `from`, on their own turn. */
  function enter(s: StrategicState, player: Player, from: NodeId, n = 1): string {
    const a = placeArmy(s, player, from, n);
    s.turn = player;
    s.phase = 'strategic';
    s.actionsLeft = ACTIONS_PER_TURN;
    const t = moveArmy(s, a, 'n01');
    expect(t.error).toBeUndefined();
    Object.assign(s, t.state);
    return a;
  }

  it('lands on the wide side from the sea and the single slot from the land route', () => {
    const bySea = createStrategic();
    enter(bySea, 'p1', SEA);
    expect(sideOf(bySea, 'n01', 'p1')).toBe('p1');
    expect(supplyCap(bySea, 'n01', 'p1')).toBe(2 * 6); // controlled, 2 slots

    const byLand = createStrategic();
    enter(byLand, 'p1', LAND);
    expect(sideOf(byLand, 'n01', 'p1')).toBe('p2'); // the single slot, not their colour
    expect(supplyCap(byLand, 'n01', 'p1')).toBe(1 * 6);
  });

  it('gives a player the same side whichever colour they wear', () => {
    const s = createStrategic();
    enter(s, 'p2', SEA);
    // p2 came off the sea, so p2 stands on the 2-slot side — which is p1's colour.
    expect(sideOf(s, 'n01', 'p2')).toBe('p1');
    expect(supplyCap(s, 'n01', 'p2')).toBe(2 * 6);
  });

  it('joins friends already there, whatever direction the newcomer came from', () => {
    const s = createStrategic();
    enter(s, 'p1', LAND); // holds the single slot
    expect(sideOf(s, 'n01', 'p1')).toBe('p2');
    const second = enter(s, 'p1', SEA); // would land on the wide side if empty
    expect(s.units[armyUnits(s, second)[0].id].side).toBe('p2'); // joined the garrison
    expect(sideOf(s, 'n01', 'p1')).toBe('p2');
  });

  it('puts an arriving enemy opposite, whichever way they came in', () => {
    const s = createStrategic();
    enter(s, 'p1', LAND); // p1 on the single slot (side p2)
    enter(s, 'p2', LAND); // same doorway, but p1 is already in it
    expect(sideOf(s, 'n01', 'p2')).toBe('p1'); // the free side
    expect(sideOf(s, 'n01', 'p1')).toBe('p2');
  });

  // "the opponent will now enter the battle from the wrong side"
  it('lets a defender cross first and force the attacker onto the wrong side', () => {
    const s = createStrategic();
    enter(s, 'p1', LAND); // p1 lands on the single slot
    expect(sideOf(s, 'n01', 'p1')).toBe('p2');

    const t = swapSide(s, 'n01'); // still p1's turn, second action
    expect(t.error).toBeUndefined();
    expect(sideOf(t.state, 'n01', 'p1')).toBe('p1'); // now on the wide side
    expect(supplyCap(t.state, 'n01', 'p1')).toBe(2 * 6);

    // p2 arrives by sea — the wide side's own doorway — and is pushed opposite,
    // onto the single slot that wears p2's own colour. The crossing has swapped
    // what each side is worth: p1 holds the 2-slot ground, p2 the 1-slot ground.
    Object.assign(s, t.state);
    enter(s, 'p2', SEA);
    expect(sideOf(s, 'n01', 'p2')).toBe('p2');
    // Both are in the node now, so it is contested for each of them: 3 a slot.
    expect(supplyCap(s, 'n01', 'p1')).toBe(2 * 3);
    expect(supplyCap(s, 'n01', 'p2')).toBe(1 * 3);
  });

  it('costs an action to cross, and takes the whole garrison along', () => {
    const s = createStrategic();
    const a = enter(s, 'p1', LAND, 3);
    s.actionsLeft = ACTIONS_PER_TURN;
    const t = swapSide(s, 'n01');
    expect(t.state.actionsLeft).toBe(ACTIONS_PER_TURN - 1);
    expect(armyUnits(t.state, a).every((u) => u.side === 'p1')).toBe(true);
  });

  it('refuses to cross onto the enemy, or in a symmetric node, or with nothing there', () => {
    const s = createStrategic();
    enter(s, 'p1', LAND);
    enter(s, 'p2', SEA); // both sides now occupied
    s.turn = 'p1';
    s.actionsLeft = ACTIONS_PER_TURN;
    expect(swapSide(s, 'n01').error).toMatch(/enemy is in that location/i);
    expect(swapSide(s, inland.id).error).toMatch(/asymmetric/i);
    expect(swapSide(s, 'n03').error).toMatch(/hold nothing there/i);
  });

  it('leaves symmetric nodes alone — each player keeps their own side', () => {
    const s = createStrategic();
    const a = placeArmy(s, 'p1', inland.adjacency[0], 2);
    const t = moveArmy(s, a, inland.id);
    expect(sideOf(t.state, inland.id, 'p1')).toBe('p1');
    expect(sideOf(t.state, inland.id, 'p2')).toBe('p2');
  });
});

// A deterministic dice sequence, to drive initiative on purpose (0 → rolls a 1,
// 0.99 → rolls a 6). The module-level `beforeEach` pins Math.random, but these
// pass an rng explicitly to steer who wins.
function seqRng(...vals: number[]) {
  let i = 0;
  return () => vals[i++ % vals.length];
}

describe('initiative', () => {
  it('hands the first turn to whoever wins the opening roll', () => {
    const p2first = createStrategic(seqRng(0, 0.99)); // a=1, b=6 → p2
    expect(p2first.turn).toBe('p2');
    expect(p2first.firstPlayer).toBe('p2');
    expect(p2first.round).toBe(1);
  });

  it('re-rolls each round, so a player can move on both sides of a round boundary', () => {
    // p1 opens round 1; the round-boundary roll then makes p2 open round 2, so p2
    // acts last in round 1 and first in round 2 — back to back.
    const rng = seqRng(0.99, 0, /* round-2 roll: */ 0, 0.99);
    let t: Transition = { state: createStrategic(rng) };
    expect(t.state.turn).toBe('p1');
    t = endTurn(t.state, rng); // p1 → p2, still round 1
    expect(t.state.turn).toBe('p2');
    expect(t.state.round).toBe(1);
    t = endTurn(t.state, rng); // round boundary re-rolls to p2
    expect(t.state.turn).toBe('p2');
    expect(t.state.round).toBe(2);
    expect(t.state.firstPlayer).toBe('p2');
  });
});

describe('fortifications', () => {
  it('can only be built on ground you hold an army in, never in staging', () => {
    const s = createStrategic();
    expect(canFortify(s, STAGING_NODE.p1, 'p1')).toBe(false); // staging excluded
    expect(canFortify(s, inland.id, 'p1')).toBe(false); // no army there
    placeArmy(s, 'p1', inland.id, 2);
    expect(canFortify(s, inland.id, 'p1')).toBe(true);
  });

  it('costs an action and leaves a fort waiting for the next battle', () => {
    const s = createStrategic();
    placeArmy(s, 'p1', inland.id, 2);
    const t = buildFort(s, inland.id);
    expect(t.error).toBeUndefined();
    expect(fortsAt(t.state, inland.id, 'p1')).toBe(1);
    expect(t.state.actionsLeft).toBe(ACTIONS_PER_TURN - 1);
  });

  it('is removed once the last army leaves the node', () => {
    const s = createStrategic();
    const a = placeArmy(s, 'p1', inland.id, 2);
    s.forts[`${inland.id}:p1`] = 1; // a fort waiting, as if built last turn
    expect(fortsAt(s, inland.id, 'p1')).toBe(1);
    const dest = NODE_BY_ID[inland.id].adjacency.find(isPlain)!;
    const t = moveArmy(s, a, dest);
    expect(fortsAt(t.state, inland.id, 'p1')).toBe(0);
  });
});

describe('victory', () => {
  it('names the ring of nodes around the enemy staging', () => {
    expect(doorstep('p2')).toEqual(NODE_BY_ID[STAGING_NODE.p2].adjacency);
    expect(doorstep('p2').length).toBeGreaterThan(0);
  });

  it('is won by holding the whole enemy doorstep for the required rounds', () => {
    const s = createStrategic();
    for (const n of doorstep('p2')) place(s, 'p1', n, 1);
    let t: Transition = { state: s };
    for (let i = 0; i < HOLD_TO_WIN * 2; i++) {
      if (t.state.winner) break;
      t = endTurn(t.state);
    }
    expect(t.state.winner).toBe('p1');
  });

  // Reported from play: p1 moved second in one round and first in the next, so
  // an own-turn counter ticked twice with p2 never having moved in between — p2
  // lost without the chance to relieve the ring that the rules promise. Scoring
  // at the round boundary makes that structural: a round is always one turn each.
  it('does not tick twice when the besieger takes back-to-back turns', () => {
    const s = createStrategic();
    for (const n of doorstep('p2')) place(s, 'p1', n, 1);
    // p2 opens the round, so p1 closes it — and p1 also opens the next one.
    s.firstPlayer = 'p2';
    s.turn = 'p2';
    const p1wins = seqRng(0.99, 0); // p1 takes every following initiative

    const afterP2 = endTurn(s, p1wins).state; // p2 moves, ignoring the siege
    expect(afterP2.turn).toBe('p1');
    expect(afterP2.hold.p1).toBe(0); // nothing scored mid-round

    const round1 = endTurn(afterP2, p1wins).state; // p1 closes the round
    expect(round1.hold.p1).toBe(1);
    expect(round1.turn).toBe('p1'); // p1 won initiative and opens the next round

    // p1's back-to-back turn. The round is not over — p2 has not moved in it —
    // so nothing is scored and nothing is won.
    const backToBack = endTurn(round1, p1wins).state;
    expect(backToBack.hold.p1).toBe(1);
    expect(backToBack.winner).toBeNull();
    expect(backToBack.turn).toBe('p2'); // p2 gets the turn they were denied

    // p2 has their chance and does not take it; the round closes and p1 wins.
    expect(endTurn(backToBack, p1wins).state.winner).toBe('p1');
  });

  it('lets the defender break the ring on the turn that decides it', () => {
    const s = createStrategic();
    const held = doorstep('p2').map((n) => place(s, 'p1', n, 1)[0]);
    s.firstPlayer = 'p1';
    s.turn = 'p1';
    const t1 = endTurn(s).state; // p1 opens, p2 to move
    const round1 = endTurn(t1).state; // round closes: p1 holds
    expect(round1.hold.p1).toBe(1);

    // Next round: p1 moves, then p2 relieves one node before the round is scored.
    const mid = endTurn(round1).state;
    mid.units[held[0].id].nodeId = STAGING_NODE.p1; // p2 retakes it
    const round2 = endTurn(mid).state;
    expect(round2.winner).toBeNull();
    expect(round2.hold.p1).toBe(0);
  });

  it('resets the count the moment the doorstep is relieved', () => {
    const s = createStrategic();
    const held = doorstep('p2').map((n) => place(s, 'p1', n, 1)[0]);
    const t1 = endTurn(s).state; // p1's turn — mid-round, nothing scored yet
    const t2 = endTurn(t1).state; // round closes, p1 holds all
    expect(t2.hold.p1).toBe(1);
    t2.units[held[0].id].nodeId = STAGING_NODE.p1; // p1 abandons a node
    const t3 = endTurn(t2).state;
    const t4 = endTurn(t3).state; // next round closes
    expect(t4.hold.p1).toBe(0);
    expect(t4.winner).toBeNull();
  });
});

describe('wounded units heal only in staging', () => {
  it('reinforces a wounded unit reorganized in the staging area', () => {
    const s = createStrategic();
    const [inf] = place(s, 'p1', STAGING_NODE.p1, 1);
    inf.wounded = true;
    inf.revealed = true;
    const t = reorganize(s, STAGING_NODE.p1, { [inf.id]: NEW_ARMY });
    expect(t.error).toBeUndefined();
    expect(t.state.units[inf.id].wounded).toBeUndefined();
    expect(t.state.units[inf.id].revealed).toBeUndefined();
  });

  it('keeps a wounded unit wounded and face-up when reorganized in the field', () => {
    const s = createStrategic();
    const a = placeArmy(s, 'p1', inland.id, 2);
    const member = armyUnits(s, a)[0];
    member.wounded = true;
    expect(canReorganize(s, inland.id, 'p1')).toBe(true);
    const t = reorganize(s, inland.id, { [member.id]: a });
    expect(t.state.units[member.id].wounded).toBe(true);
    expect(t.state.units[member.id].revealed).toBe(true);
  });
});

describe('a decided or interrupted game freezes', () => {
  it('refuses actions once someone has won', () => {
    const s = createStrategic();
    const a = placeArmy(s, 'p1', inland.id, 2);
    s.winner = 'p1';
    expect(moveArmy(s, a, NODE_BY_ID[inland.id].adjacency[0]).error).toMatch(/game is over/i);
    expect(endTurn(s).error).toMatch(/game is over/i);
  });

  it('refuses actions while a retreat is pending', () => {
    const s = createStrategic();
    const a = placeArmy(s, 'p1', inland.id, 2);
    s.pendingRetreat = { player: 'p2', from: inland.id, options: [NODE_BY_ID[inland.id].adjacency[0]], units: [] };
    expect(moveArmy(s, a, NODE_BY_ID[inland.id].adjacency[0]).error).toMatch(/must retreat/i);
  });
});

describe("the winner's free post-battle reshuffle", () => {
  it('re-sorts organized survivors between armies for no action', () => {
    const s = createStrategic();
    const a = placeArmy(s, 'p1', inland.id, 3);
    const b = placeArmy(s, 'p1', inland.id, 2);
    s.freeReorgs[inland.id] = 'p1';
    const fromA = armyUnits(s, a)[0];

    const t = freeReorganize(s, inland.id, { [fromA.id]: b });
    expect(t.error).toBeUndefined();
    expect(t.state.actionsLeft).toBe(ACTIONS_PER_TURN); // free
    expect(armyUnits(t.state, b)).toHaveLength(3);
    expect(t.state.freeReorgs[inland.id]).toBeUndefined(); // spent
  });

  it('is offered only where a win was recorded, and only to the winner', () => {
    const s = createStrategic();
    placeArmy(s, 'p1', inland.id, 2);
    expect(canFreeReorg(s, inland.id, 'p1')).toBe(false);
    s.freeReorgs[inland.id] = 'p1';
    expect(canFreeReorg(s, inland.id, 'p1')).toBe(true);
    expect(canFreeReorg(s, inland.id, 'p2')).toBe(false);
  });

  it('will not fold a withdrawn (disorganized) unit back in for free', () => {
    const s = createStrategic();
    const a = placeArmy(s, 'p1', inland.id, 2);
    const loose = place(s, 'p1', inland.id, 1)[0]; // a withdrawn unit, disorganized
    s.freeReorgs[inland.id] = 'p1';
    const t = freeReorganize(s, inland.id, { [loose.id]: a });
    expect(t.error).toMatch(/withdrawn units need a full reorganization/i);
  });

  it('leaves the survivors revealed when the node is not controlled', () => {
    const s = createStrategic();
    // Contest inland so it cannot be controlled, and mark the army revealed.
    place(s, 'p2', inland.adjacency[0], 1);
    const a = placeArmy(s, 'p1', inland.id, 2);
    const b = placeArmy(s, 'p1', inland.id, 2);
    for (const u of armyUnits(s, a)) u.revealed = true;
    s.freeReorgs[inland.id] = 'p1';
    expect(controlFor(s, inland.id, 'p1')).toBe('contested');

    const moved = armyUnits(s, a)[0];
    const t = freeReorganize(s, inland.id, { [moved.id]: b });
    expect(t.state.units[moved.id].revealed).toBe(true); // still face-up
  });

  it('can be declined, which simply clears the offer', () => {
    const s = createStrategic();
    placeArmy(s, 'p1', inland.id, 2);
    s.freeReorgs[inland.id] = 'p1';
    const t = dismissFreeReorg(s, inland.id);
    expect(t.error).toBeUndefined();
    expect(t.state.freeReorgs[inland.id]).toBeUndefined();
  });

  it('lapses once the winner marches an army off, leaving nothing to sort', () => {
    const s = createStrategic();
    placeArmy(s, 'p1', inland.id, 2);
    const b = placeArmy(s, 'p1', inland.id, 2);
    s.freeReorgs[inland.id] = 'p1';
    const dest = NODE_BY_ID[inland.id].adjacency.find(isPlain)!;
    const t = moveArmy(s, b, dest);
    expect(t.state.freeReorgs[inland.id]).toBeUndefined();
  });
});

describe('recon attempt', () => {
  // A constant rng that forces `rollD6` to land on `face`: rollD6 is
  // floor(rng()*6)+1, so the midpoint of the face's sixth lands cleanly on it.
  const d6 = (face: number) => () => (face - 0.5) / 6;
  const scoutOf = (s: StrategicState, p: Player) =>
    Object.values(s.units).find((u) => u.owner === p && u.type === 'recon')!;
  const revealedIn = (s: StrategicState, armyId: string) =>
    armyUnits(s, armyId).filter((u) => u.revealed);

  /** p1 scout and a p2 army of `n`, both standing in `inland`. Returns their ids. */
  function scene(n: number) {
    const s = newGame(); // recon happens in the recon phase, so don't skip it
    const scout = scoutOf(s, 'p1');
    s.units[scout.id].nodeId = inland.id;
    const army = placeArmy(s, 'p2', inland.id, n);
    return { s, scoutId: scout.id, army };
  }

  it('destroys the scout and reveals nothing on a 1', () => {
    const { s, scoutId, army } = scene(3);
    const t = reconAttempt(s, scoutId, army, d6(1));
    expect(t.state.units[scoutId]).toBeUndefined();
    expect(revealedIn(t.state, army)).toHaveLength(0);
  });

  it('reveals nothing but keeps the scout on a 2', () => {
    const { s, scoutId, army } = scene(3);
    const t = reconAttempt(s, scoutId, army, d6(2));
    expect(t.state.units[scoutId]).toBeDefined();
    expect(revealedIn(t.state, army)).toHaveLength(0);
  });

  it('reveals one unit on a 3, two on a 4', () => {
    const three = scene(3);
    expect(revealedIn(reconAttempt(three.s, three.scoutId, three.army, d6(3)).state, three.army))
      .toHaveLength(1);
    const four = scene(3);
    expect(revealedIn(reconAttempt(four.s, four.scoutId, four.army, d6(4)).state, four.army))
      .toHaveLength(2);
  });

  it('reveals the whole selected army on a 5', () => {
    const { s, scoutId, army } = scene(4);
    const t = reconAttempt(s, scoutId, army, d6(5));
    expect(revealedIn(t.state, army)).toHaveLength(4);
  });

  it('reveals every enemy fighting unit in the location on a 6, but not recon', () => {
    const { s, scoutId, army } = scene(2);
    const other = placeArmy(s, 'p2', inland.id, 2); // a second enemy army in the node
    const loose = place(s, 'p2', inland.id, 1)[0]; // a disorganized enemy unit
    const enemyScout = scoutOf(s, 'p2');
    s.units[enemyScout.id].nodeId = inland.id;
    const t = reconAttempt(s, scoutId, army, d6(6));
    expect(revealedIn(t.state, army)).toHaveLength(2);
    expect(revealedIn(t.state, other)).toHaveLength(2);
    expect(t.state.units[loose.id].revealed).toBe(true);
    expect(t.state.units[enemyScout.id].revealed).toBeFalsy(); // recon is never revealed
  });

  it('does not re-reveal an already-known unit — a partial reveal flips a hidden one', () => {
    const { s, scoutId, army } = scene(3);
    const known = armyUnits(s, army)[0];
    s.units[known.id].revealed = true;
    const t = reconAttempt(s, scoutId, army, d6(3)); // reveal 1
    expect(revealedIn(t.state, army)).toHaveLength(2); // the known one plus one freshly flipped
    expect(t.state.units[known.id].revealed).toBe(true);
  });

  it('leaves the caller state untouched (returns a clone)', () => {
    const { s, scoutId, army } = scene(3);
    reconAttempt(s, scoutId, army, d6(5));
    expect(revealedIn(s, army)).toHaveLength(0);
  });

  it("rejects scouting with an enemy's recon unit", () => {
    const { s, army } = scene(3);
    const enemyScout = scoutOf(s, 'p2');
    const t = reconAttempt(s, enemyScout.id, army, d6(5));
    expect(t.error).toMatch(/your recon unit/i);
  });

  it('rejects a fighting unit posing as a scout', () => {
    const { s, army } = scene(3);
    const grunt = place(s, 'p1', inland.id, 1)[0];
    const t = reconAttempt(s, grunt.id, army, d6(5));
    expect(t.error).toMatch(/recon units can scout/i);
  });

  it('rejects an army that is not in the scout’s node', () => {
    const { s, scoutId } = scene(3);
    const elsewhere = placeArmy(s, 'p2', inland.adjacency.find(isPlain)!, 2);
    const t = reconAttempt(s, scoutId, elsewhere, d6(5));
    expect(t.error).toBeDefined();
  });

  it('rejects targeting a friendly army', () => {
    const { s, scoutId } = scene(3);
    const mine = placeArmy(s, 'p1', inland.id, 2);
    const t = reconAttempt(s, scoutId, mine, d6(5));
    expect(t.error).toMatch(/no enemy army/i);
  });
});

// The manual runs a turn as Recon → Strategic. The two budgets are separate, so
// scouting never costs an army move and vice versa.
describe('the recon phase', () => {
  const scoutOf = (s: StrategicState, p: Player) =>
    Object.values(s.units).find((u) => u.owner === p && u.type === 'recon')!;
  const strip = (s: StrategicState, p: Player) => {
    for (const u of Object.values(s.units)) {
      if (u.owner === p && u.type === 'recon') delete s.units[u.id];
    }
  };

  it('opens the game, with its own budget', () => {
    const s = newGame();
    expect(s.phase).toBe('recon');
    expect(s.actionsLeft).toBe(RECON_ACTIONS);
  });

  it('holds strategic actions back until it is over', () => {
    const s = newGame();
    const grunt = looseAt(s, STAGING_NODE.p1, 'p1')[0];
    const to = NODE_BY_ID[STAGING_NODE.p1].adjacency[0];
    expect(moveLoose(s, [grunt.id], to).error).toMatch(/recon phase is not over/i);
    expect(legalLooseTargets(s, grunt.id)).toEqual([]);
  });

  it('hands the same player their strategic actions when skipped', () => {
    const s = newGame();
    const t = endRecon(s);
    expect(t.error).toBeUndefined();
    expect(t.state.turn).toBe('p1'); // still p1's turn — only the phase moved on
    expect(t.state.phase).toBe('strategic');
    expect(t.state.actionsLeft).toBe(ACTIONS_PER_TURN);
  });

  it('rolls into the strategic phase once its budget runs out, not into the opponent', () => {
    const s = newGame();
    const scout = scoutOf(s, 'p1');
    const a = NODE_BY_ID[STAGING_NODE.p1].adjacency[0];
    const t1 = moveLoose(s, [scout.id], a).state;
    expect(t1.phase).toBe('recon');
    expect(t1.actionsLeft).toBe(RECON_ACTIONS - 1);

    const t2 = moveLoose(t1, [scout.id], STAGING_NODE.p1).state;
    expect(t2.turn).toBe('p1');
    expect(t2.phase).toBe('strategic');
    expect(t2.actionsLeft).toBe(ACTIONS_PER_TURN);
  });

  it('spends the same budget on an attempt as on a move', () => {
    const s = newGame();
    const scout = scoutOf(s, 'p1');
    s.units[scout.id].nodeId = inland.id;
    const army = placeArmy(s, 'p2', inland.id, 2);
    const t = reconAttempt(s, scout.id, army, () => 0.5); // a 4, so the scout lives
    expect(t.error).toBeUndefined();
    expect(t.state.phase).toBe('recon');
    expect(t.state.actionsLeft).toBe(RECON_ACTIONS - 1);
  });

  it('is skipped by a player with no scouts left', () => {
    const s = newGame();
    strip(s, 'p2');
    const t = handOver(endRecon(s).state); // p1 skips their recon, then ends the turn
    expect(t.state.turn).toBe('p2');
    expect(t.state.phase).toBe('strategic');
    expect(t.state.actionsLeft).toBe(ACTIONS_PER_TURN);
  });

  it('keeps scouts out of the strategic phase, and refuses a second skip', () => {
    const s = endRecon(newGame()).state;
    const scout = scoutOf(s, 'p1');
    const to = NODE_BY_ID[STAGING_NODE.p1].adjacency[0];
    expect(moveLoose(s, [scout.id], to).error).toMatch(/recon phase is over/i);
    expect(legalLooseTargets(s, scout.id)).toEqual([]);
    expect(endRecon(s).error).toMatch(/recon phase is over/i);
  });
});

// The log is a single shared list, broadcast to both seats — `maskFor` fogs the
// board but not the narration. So no log line may name a unit type, or moving a
// face-down chip would announce what it is. The one exception is the overrun,
// which names units as it removes them from the board.
describe('the shared log keeps the fog', () => {
  const TYPES = ['infantry', 'artillery', 'anti-tank', 'armor', 'recon'];
  const namesAType = (text: string) => TYPES.some((t) => text.toLowerCase().includes(t));

  it('never names a unit type when a disorganized unit moves', () => {
    const s = createStrategic();
    const [a, b] = looseAt(s, STAGING_NODE.p1, 'p1');
    const to = NODE_BY_ID[STAGING_NODE.p1].adjacency[0];
    for (const ids of [[a.id], [a.id, b.id]]) {
      const t = moveLoose(createStrategic(), ids, to);
      expect(t.error).toBeUndefined();
      const line = t.state.log[t.state.log.length - 1].text;
      expect(namesAType(line)).toBe(false);
      expect(line).toContain(to);
    }
  });

  it('never names a unit type when a scout moves', () => {
    const s = newGame(); // scouts move in the recon phase
    const scout = Object.values(s.units).find((u) => u.owner === 'p1' && u.type === 'recon')!;
    const to = NODE_BY_ID[STAGING_NODE.p1].adjacency[0];
    const t = moveLoose(s, [scout.id], to);
    expect(t.error).toBeUndefined();
    // "a recon unit" is the one allowed use of the word: scouts are never fogged.
    expect(t.state.log[t.state.log.length - 1].text).toBe(
      `${playerLabel('p1')} a recon unit moves ${STAGING_NODE.p1} → ${to}.`,
    );
  });

  it('never names a unit type when supply disorganizes one', () => {
    const s = createStrategic();
    // Overfill a contested node so the end-of-turn check has to shed units.
    placeArmy(s, 'p1', inland.id, slotsFor(inland.id, 'p1') * 6);
    place(s, 'p2', inland.adjacency[0], 1);
    const t = endTurn(s).state;
    const shed = t.log.filter((l) => l.text.includes('out of supply'));
    expect(shed.length).toBeGreaterThan(0);
    for (const l of shed) expect(namesAType(l.text)).toBe(false);
  });
});

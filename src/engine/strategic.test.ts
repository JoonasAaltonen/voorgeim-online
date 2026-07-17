// Strategic-map engine: movement (Phase 3), then armies, supply and control
// (Phase 5). `map.test.ts` next door guards the map *data*; this file guards the
// rules played on top of it.

import { describe, expect, it } from 'vitest';
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
  armiesAt,
  armyCount,
  armyUnits,
  canReorganize,
  controlFor,
  createStrategic,
  endTurn,
  legalArmyTargets,
  legalLooseTargets,
  looseAt,
  moveArmy,
  moveLoose,
  reconAt,
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
import type { Player } from './types';
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
    const s = createStrategic();
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
    const s = createStrategic();
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

  it('hands over after two actions and stops accepting a third', () => {
    let t: Transition = { state: createStrategic() };
    const [a, b] = looseAt(t.state, STAGING_NODE.p1, 'p1');
    t = moveLoose(t.state, [a.id], NODE_BY_ID[a.nodeId].adjacency[0]);
    t = moveLoose(t.state, [b.id], NODE_BY_ID[b.nodeId].adjacency[0]);
    expect(t.state.turn).toBe('p2');
    expect(t.state.actionsLeft).toBe(ACTIONS_PER_TURN);

    const c = looseAt(t.state, STAGING_NODE.p1, 'p1')[0];
    const denied = moveLoose(t.state, [c.id], NODE_BY_ID[c.nodeId].adjacency[0]);
    expect(denied.error).toMatch(/P2 - Green's turn/);
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

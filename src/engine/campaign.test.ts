// The strategic ↔ battle bridge (Phase 7). Two directions to guard: assembling a
// battle from map units (createBattleAt), and posting a finished battle back onto
// the map (resolveBattle / resolveRetreat). The battle engine itself is proven in
// engine.test.ts, so here we build finished BattleStates by hand and check only
// the translation — which units come across, and what the map looks like after.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAP, NODE_BY_ID, STAGING_NODE, isSea, type NodeId } from './map';
import {
  createStrategic as newGame,
  endRecon,
  endTurn as handOver,
  armyUnits,
  buildFort,
  SEA_SUPPLY,
  supplyCap,
  supplyUsed,
  fortKey,
  MASKED,
  moveArmy,
  moveLoose,
  occupies,
  type MapUnit,
  type StrategicState,
  type Transition,
} from './strategic';

/**
 * Every test here is about battles, which happen in the strategic phase, so they
 * open a game already past the recon phase rather than repeating the skip.
 */
const createStrategic = (): StrategicState => endRecon(newGame()).state;

/** Likewise: hand the turn over and drop the next player straight into strategy. */
const endTurn = (s: StrategicState): Transition => {
  const t = handOver(s);
  return t.error || t.state.phase !== 'recon' ? t : endRecon(t.state);
};
import {
  canInitiateBattle,
  createBattleAt,
  resolveBattle,
  resolveRetreat,
  retreatOptions,
  supportGuns,
} from './campaign';
import { assembleBattle, type BattleState } from './battle';
import { otherPlayer, type BattleUnit, type Player, type UnitStatus } from './types';
import { UNIT_STATS, type UnitType } from './units';

// Initiative is a dice roll; pin it so setup is deterministic (p1 opens).
beforeEach(() => {
  let high = false;
  vi.spyOn(Math, 'random').mockImplementation(() => {
    high = !high;
    return high ? 0.99 : 0;
  });
});
afterEach(() => vi.restoreAllMocks());

/** Pull `n` of a player's staging units of a type onto `node`, in a fresh army. */
function army(s: StrategicState, owner: Player, node: NodeId, type: MapUnit['type'], n: number): MapUnit[] {
  const id = `army-${owner}-${++s.tick}`;
  s.armies[id] = { id, owner, movedAt: s.tick };
  const taken = Object.values(s.units)
    .filter((u) => u.owner === owner && !u.armyId && u.nodeId === STAGING_NODE[owner] && u.type === type)
    .slice(0, n);
  for (const u of taken) {
    u.nodeId = node;
    u.armyId = id;
  }
  return taken;
}

/** Same as `army`, but returning the army's id rather than its units. */
function armyAt(s: StrategicState, owner: Player, node: NodeId, type: MapUnit['type'], n: number): string {
  return army(s, owner, node, type, n)[0].armyId!;
}

/** Same, but left disorganized in the node — no army, as if dropped by supply. */
function loose(s: StrategicState, owner: Player, node: NodeId, type: MapUnit['type'], n: number): MapUnit[] {
  const taken = Object.values(s.units)
    .filter((u) => u.owner === owner && !u.armyId && u.nodeId === STAGING_NODE[owner] && u.type === type)
    .slice(0, n);
  for (const u of taken) u.nodeId = node;
  return taken;
}

/** A finished battle over `node`, with the listed units set to the given states. */
function finished(
  s: StrategicState,
  node: NodeId,
  attacker: Player,
  winner: Player | 'stalemate',
  states: Record<string, { status: UnitStatus; wounded?: boolean; support?: boolean }>,
): BattleState {
  // Battles are built from real state, never a fogged view, so a masked chip
  // cannot occur here — fall back to infantry alongside the missing-unit case.
  const typeOf = (id: string): UnitType => {
    const t = s.units[id]?.type;
    return t && t !== MASKED ? t : 'infantry';
  };
  const units: BattleUnit[] = Object.entries(states).map(([id, st]) => ({
    id,
    type: typeOf(id),
    owner: s.units[id]?.owner ?? attacker,
    hp: UNIT_STATS[typeOf(id)].hp,
    status: st.status,
    wounded: st.wounded,
    support: st.support,
  }));
  const b = assembleBattle({
    attacker,
    units,
    fortsLeft: { p1: 0, p2: 0 },
    firstDeployer: attacker,
    node,
  });
  b.phase = 'over';
  b.winner = winner;
  return b;
}

// A land node whose neighbours give a beaten force somewhere to run.
const BATTLE: NodeId = 'n09';

describe('opening a battle', () => {
  it('needs an enemy present, and never opens at sea or in staging', () => {
    const s = createStrategic();
    army(s, 'p1', BATTLE, 'infantry', 2);
    expect(canInitiateBattle(s, BATTLE, 'p1')).toBe(false); // no enemy yet
    army(s, 'p2', BATTLE, 'armor', 1);
    expect(canInitiateBattle(s, BATTLE, 'p1')).toBe(true);
    expect(canInitiateBattle(s, STAGING_NODE.p1, 'p1')).toBe(false);
  });

  it('brings both sides onto the board carrying their real ids, initiator attacking', () => {
    const s = createStrategic();
    const mine = army(s, 'p1', BATTLE, 'infantry', 2);
    const theirs = army(s, 'p2', BATTLE, 'armor', 1);
    const { battle, error } = createBattleAt(s, BATTLE, 'p1');
    expect(error).toBeUndefined();
    expect(battle!.attacker).toBe('p1');
    expect(battle!.node).toBe(BATTLE);
    for (const u of [...mine, ...theirs]) expect(battle!.units[u.id]).toBeDefined();
  });

  // Reported from play: ten units walk into three supply, the excess drops to
  // disorganized where it stands, and the enemy's attack dragged them in too.
  // "[Disorganized units] will need to be organized into armies to be used in
  // battles" — they sit it out.
  it('leaves disorganized units out of the battle, on both sides', () => {
    const s = createStrategic();
    const mine = army(s, 'p1', BATTLE, 'infantry', 2);
    const theirs = army(s, 'p2', BATTLE, 'armor', 1);
    const myStragglers = loose(s, 'p1', BATTLE, 'artillery', 2);
    const theirStragglers = loose(s, 'p2', BATTLE, 'infantry', 3);

    const { battle } = createBattleAt(s, BATTLE, 'p2');
    for (const u of [...mine, ...theirs]) expect(battle!.units[u.id]).toBeDefined();
    for (const u of [...myStragglers, ...theirStragglers]) {
      expect(battle!.units[u.id]).toBeUndefined();
    }
    expect(Object.keys(battle!.units)).toHaveLength(3);
  });

  it('will not open a battle over disorganized units alone — that is an overrun', () => {
    const s = createStrategic();
    army(s, 'p1', BATTLE, 'infantry', 2);
    loose(s, 'p2', BATTLE, 'infantry', 3); // enemy present, but none of it organized
    expect(canInitiateBattle(s, BATTLE, 'p1')).toBe(false);
    expect(createBattleAt(s, BATTLE, 'p1').error).toBeDefined();
  });

  it('will not let a force of stragglers attack an army either', () => {
    const s = createStrategic();
    loose(s, 'p1', BATTLE, 'infantry', 4);
    army(s, 'p2', BATTLE, 'armor', 1);
    expect(canInitiateBattle(s, BATTLE, 'p1')).toBe(false);
  });

  it('leaves recon behind — scouts never fight', () => {
    const s = createStrategic();
    army(s, 'p1', BATTLE, 'infantry', 1);
    army(s, 'p2', BATTLE, 'infantry', 1);
    const scout = Object.values(s.units).find((u) => u.owner === 'p1' && u.type === 'recon')!;
    scout.nodeId = BATTLE;
    const { battle } = createBattleAt(s, BATTLE, 'p1');
    expect(battle!.units[scout.id]).toBeUndefined();
  });

  it('sends a wounded defender in at one hitpoint, still wounded', () => {
    const s = createStrategic();
    army(s, 'p1', BATTLE, 'infantry', 1); // attacker, able-bodied
    const [inf] = army(s, 'p2', BATTLE, 'infantry', 1);
    inf.wounded = true;
    const { battle } = createBattleAt(s, BATTLE, 'p1');
    expect(battle!.units[inf.id].wounded).toBe(true);
    expect(battle!.units[inf.id].hp).toBe(1);
  });

  it("leaves the attacker's wounded behind but drags the defender's in", () => {
    const s = createStrategic();
    const [whole] = army(s, 'p1', BATTLE, 'infantry', 1);
    const [aWounded] = army(s, 'p1', BATTLE, 'infantry', 1);
    aWounded.wounded = true;
    const [dWounded] = army(s, 'p2', BATTLE, 'infantry', 1);
    dWounded.wounded = true;

    const { battle } = createBattleAt(s, BATTLE, 'p1');
    expect(battle!.units[whole.id]).toBeDefined();
    expect(battle!.units[aWounded.id]).toBeUndefined(); // cannot join an attack
    expect(battle!.units[dWounded.id]).toBeDefined(); // forced into the defence
    expect(battle!.units[dWounded.id].wounded).toBe(true);
  });

  it('will not let a force of only wounded units mount an attack', () => {
    const s = createStrategic();
    const [w] = army(s, 'p1', BATTLE, 'infantry', 1);
    w.wounded = true;
    army(s, 'p2', BATTLE, 'infantry', 1);
    expect(canInitiateBattle(s, BATTLE, 'p1')).toBe(false);
    expect(createBattleAt(s, BATTLE, 'p1').error).toBeTruthy();
  });

  it('lets the revealed side deploy first (recon advantage)', () => {
    const s = createStrategic();
    army(s, 'p1', BATTLE, 'infantry', 1); // attacker, hidden
    const [seen] = army(s, 'p2', BATTLE, 'infantry', 1);
    seen.revealed = true; // defender was reconned
    const { battle } = createBattleAt(s, BATTLE, 'p1');
    expect(battle!.deploy!.firstDeployer).toBe('p2');
  });
});

describe('indirect-fire support', () => {
  // n08 → n09 and n10 → n09 are indirect-fire arrows in the real map.
  it('offers an army artillery from a node you hold that the arrow points from', () => {
    const s = createStrategic();
    army(s, 'p1', BATTLE, 'infantry', 1);
    army(s, 'p2', BATTLE, 'infantry', 1);
    const [gun] = army(s, 'p1', 'n08', 'artillery', 1);
    const guns = supportGuns(s, BATTLE, 'p1');
    expect(guns.map((g) => g.id)).toContain(gun.id);

    const { battle } = createBattleAt(s, BATTLE, 'p1');
    expect(battle!.units[gun.id].support).toBe(true);
    expect(battle!.units[gun.id].status).toBe('reserve');
  });

  it('withholds it if the enemy is standing in the firing node', () => {
    const s = createStrategic();
    army(s, 'p1', BATTLE, 'infantry', 1);
    army(s, 'p2', BATTLE, 'infantry', 1);
    army(s, 'p1', 'n08', 'artillery', 1);
    army(s, 'p2', 'n08', 'infantry', 1); // enemy contests the gun's own node
    expect(supportGuns(s, BATTLE, 'p1')).toHaveLength(0);
  });

  it('does not offer a disorganized gun', () => {
    const s = createStrategic();
    army(s, 'p1', BATTLE, 'infantry', 1);
    army(s, 'p2', BATTLE, 'infantry', 1);
    const [gun] = army(s, 'p1', 'n08', 'artillery', 1);
    delete gun.armyId; // loose now
    expect(supportGuns(s, BATTLE, 'p1')).toHaveLength(0);
  });
});

describe('posting the result back', () => {
  it('refuses a battle that is not over, or was not fought over a node', () => {
    const s = createStrategic();
    const live = assembleBattle({
      attacker: 'p1',
      units: [],
      fortsLeft: { p1: 0, p2: 0 },
      firstDeployer: 'p1',
      node: BATTLE,
    });
    expect(resolveBattle(s, live).error).toMatch(/not finished/i);
    live.phase = 'over';
    live.winner = 'stalemate';
    live.node = undefined;
    expect(resolveBattle(s, live).error).toMatch(/not fought over a location/i);
  });

  it('removes the dead, disorganizes the withdrawn, and reveals both', () => {
    const s = createStrategic();
    const [aDead, aWith] = army(s, 'p1', BATTLE, 'infantry', 2);
    const [survivor] = army(s, 'p2', BATTLE, 'armor', 1); // p2 wins, stays
    const b = finished(s, BATTLE, 'p1', 'p2', {
      [aDead.id]: { status: 'dead' },
      [aWith.id]: { status: 'withdrawn' },
      [survivor.id]: { status: 'deployed' },
    });
    const t = resolveBattle(s, b).state;
    // p1 lost; both its units are gone from the node one way or another, but the
    // withdrawn one survives (disorganized) and the dead one does not.
    expect(t.units[aDead.id]).toBeUndefined();
    expect(t.units[aWith.id]?.armyId).toBeUndefined();
    expect(t.units[aWith.id]?.revealed).toBe(true);
    expect(t.units[survivor.id]?.revealed).toBe(true);
    expect(t.units[survivor.id]?.armyId).toBeDefined(); // winner keeps its army
  });

  it('marks a wounded survivor wounded and revealed', () => {
    const s = createStrategic();
    const [win] = army(s, 'p1', BATTLE, 'infantry', 1);
    const [lose] = army(s, 'p2', BATTLE, 'infantry', 1);
    const b = finished(s, BATTLE, 'p1', 'p1', {
      [win.id]: { status: 'deployed', wounded: true },
      [lose.id]: { status: 'dead' },
    });
    const t = resolveBattle(s, b).state;
    expect(t.units[win.id].wounded).toBe(true);
    expect(t.units[win.id].revealed).toBe(true);
  });

  it('offers the winner a free reshuffle when more than one of their armies survived', () => {
    const s = createStrategic();
    const [w1] = army(s, 'p1', BATTLE, 'infantry', 1); // two separate p1 armies
    const [w2] = army(s, 'p1', BATTLE, 'infantry', 1);
    const [foe] = army(s, 'p2', BATTLE, 'infantry', 1);
    const b = finished(s, BATTLE, 'p1', 'p1', {
      [w1.id]: { status: 'deployed' },
      [w2.id]: { status: 'deployed' },
      [foe.id]: { status: 'dead' },
    });
    const t = resolveBattle(s, b).state;
    expect(t.freeReorgs[BATTLE]).toBe('p1');
  });

  it('does not offer one when a single army came through', () => {
    const s = createStrategic();
    const [w1, w2] = army(s, 'p1', BATTLE, 'infantry', 2); // one army
    const [foe] = army(s, 'p2', BATTLE, 'infantry', 1);
    const b = finished(s, BATTLE, 'p1', 'p1', {
      [w1.id]: { status: 'deployed' },
      [w2.id]: { status: 'deployed' },
      [foe.id]: { status: 'dead' },
    });
    const t = resolveBattle(s, b).state;
    expect(t.freeReorgs[BATTLE]).toBeUndefined();
  });

  it('leaves a reserve unit organized and hidden — it never fought', () => {
    const s = createStrategic();
    const [held] = army(s, 'p1', BATTLE, 'infantry', 1);
    const [foe] = army(s, 'p2', BATTLE, 'infantry', 1);
    const b = finished(s, BATTLE, 'p1', 'p1', {
      [held.id]: { status: 'reserve' },
      [foe.id]: { status: 'dead' },
    });
    const t = resolveBattle(s, b).state;
    expect(t.units[held.id].armyId).toBeDefined();
    expect(t.units[held.id].revealed).toBeUndefined();
  });

  it('spends the node’s fortifications, whatever the outcome', () => {
    const s = createStrategic();
    const [a] = army(s, 'p1', BATTLE, 'infantry', 1);
    const [d] = army(s, 'p2', BATTLE, 'infantry', 1);
    s.forts[fortKey(BATTLE, 'p1')] = 2;
    s.forts[fortKey(BATTLE, 'p2')] = 1;
    const b = finished(s, BATTLE, 'p1', 'stalemate', {
      [a.id]: { status: 'withdrawn' },
      [d.id]: { status: 'withdrawn' },
    });
    const t = resolveBattle(s, b).state;
    expect(t.forts[fortKey(BATTLE, 'p1')]).toBeUndefined();
    expect(t.forts[fortKey(BATTLE, 'p2')]).toBeUndefined();
  });
});

describe('the retreat after a loss', () => {
  it('auto-falls-back when exactly one node is open', () => {
    const s = createStrategic();
    const [winner] = army(s, 'p1', BATTLE, 'armor', 1);
    const [loser] = army(s, 'p2', BATTLE, 'infantry', 1);
    // Block every escape but one by parking the winner's forces around the node.
    const exits = NODE_BY_ID[BATTLE].adjacency;
    for (const n of exits.slice(1)) army(s, 'p1', n, 'infantry', 1);
    const open = exits[0];

    const b = finished(s, BATTLE, 'p1', 'p1', {
      [winner.id]: { status: 'deployed' },
      [loser.id]: { status: 'withdrawn' },
    });
    const t = resolveBattle(s, b).state;
    expect(t.pendingRetreat).toBeNull();
    expect(t.units[loser.id].nodeId).toBe(open);
  });

  it('raises a choice when several nodes are open, then honours it', () => {
    const s = createStrategic();
    const [winner] = army(s, 'p1', BATTLE, 'armor', 1);
    const [loser] = army(s, 'p2', BATTLE, 'infantry', 1);
    const b = finished(s, BATTLE, 'p1', 'p1', {
      [winner.id]: { status: 'deployed' },
      [loser.id]: { status: 'withdrawn' },
    });
    const mid = resolveBattle(s, b).state;
    expect(mid.pendingRetreat?.player).toBe('p2');
    expect(mid.pendingRetreat!.options.length).toBeGreaterThan(1);

    const dest = mid.pendingRetreat!.options[1];
    const done = resolveRetreat(mid, dest).state;
    expect(done.pendingRetreat).toBeNull();
    expect(done.units[loser.id].nodeId).toBe(dest);
  });

  it('rejects a destination that was not offered', () => {
    const s = createStrategic();
    const [winner] = army(s, 'p1', BATTLE, 'armor', 1);
    const [loser] = army(s, 'p2', BATTLE, 'infantry', 1);
    const mid = resolveBattle(
      s,
      finished(s, BATTLE, 'p1', 'p1', {
        [winner.id]: { status: 'deployed' },
        [loser.id]: { status: 'withdrawn' },
      }),
    ).state;
    expect(resolveRetreat(mid, STAGING_NODE.p1).error).toMatch(/cannot fall back/i);
  });

  it('destroys an encircled force with nowhere to go', () => {
    const s = createStrategic();
    const [winner] = army(s, 'p1', BATTLE, 'armor', 1);
    const [loser] = army(s, 'p2', BATTLE, 'infantry', 1);
    for (const n of NODE_BY_ID[BATTLE].adjacency) army(s, 'p1', n, 'infantry', 1);
    expect(retreatOptions(s, BATTLE, 'p2')).toHaveLength(0);
    const t = resolveBattle(
      s,
      finished(s, BATTLE, 'p1', 'p1', {
        [winner.id]: { status: 'deployed' },
        [loser.id]: { status: 'withdrawn' },
      }),
    ).state;
    expect(t.units[loser.id]).toBeUndefined();
    expect(t.log.at(-1)?.text).toMatch(/encircled/i);
  });
});

// The manual does not cover what becomes of disorganized units left standing in
// a node the enemy has just taken. The rule adopted here: they do not ride out
// on the back of the army's defeat, and the winner's armies sweep them up at the
// start of the winner's *next* turn — which always leaves their owner one turn
// to walk them out or march a fresh army in to cover them.
describe('disorganized units left behind by a defeat', () => {
  /**
   * Hand `p` the start of a turn, which is when standing overruns land.
   * Priming `turn === firstPlayer` makes the hand-off the back half of a round,
   * so no initiative is re-rolled and the test does not depend on the dice.
   */
  function opensTurn(s: StrategicState, p: Player): StrategicState {
    const other = otherPlayer(p);
    return endTurn({ ...s, turn: other, firstPlayer: other }).state;
  }

  /** p1 defends BATTLE with an army plus stragglers; p2 attacks and wins. */
  function afterLoss() {
    const s = createStrategic();
    const held = army(s, 'p1', BATTLE, 'infantry', 1);
    const stragglers = loose(s, 'p1', BATTLE, 'artillery', 2);
    const attackers = army(s, 'p2', BATTLE, 'armor', 2);
    const b = finished(s, BATTLE, 'p2', 'p2', {
      [held[0].id]: { status: 'withdrawn' },
      [attackers[0].id]: { status: 'deployed' },
    });
    // The withdrawn defender owes the board a destination; settle it so the
    // turn can be handed over at all.
    const after = resolveBattle(s, b).state;
    const settled = after.pendingRetreat
      ? resolveRetreat(after, after.pendingRetreat.options[0]).state
      : after;
    return { s: settled, stragglers, attackers };
  }

  it('leaves the stragglers where they stand rather than retreating them free', () => {
    const { s, stragglers } = afterLoss();
    for (const u of stragglers) expect(s.units[u.id].nodeId).toBe(BATTLE);
  });

  it('still retreats the army survivors, including those the battle turned loose', () => {
    const s = createStrategic();
    const [held] = army(s, 'p1', BATTLE, 'infantry', 1);
    const [straggler] = loose(s, 'p1', BATTLE, 'artillery', 1);
    army(s, 'p2', BATTLE, 'armor', 2);
    const b = finished(s, BATTLE, 'p2', 'p2', { [held.id]: { status: 'withdrawn' } });
    const t = resolveBattle(s, b).state;
    const dest = t.pendingRetreat ? resolveRetreat(t, t.pendingRetreat.options[0]).state : t;
    // The withdrawn defender is disorganized now, but it still falls back.
    expect(dest.units[held.id].nodeId).not.toBe(BATTLE);
    expect(dest.units[straggler.id].nodeId).toBe(BATTLE);
  });

  it("does not overrun on the loser's own turn — that is their chance to react", () => {
    const { s, stragglers } = afterLoss();
    const mine = opensTurn(s, 'p1');
    expect(mine.turn).toBe('p1');
    for (const u of stragglers) expect(mine.units[u.id]).toBeDefined();
  });

  it('overruns them when the winner opens a turn still standing over them', () => {
    const { s, stragglers } = afterLoss();
    const theirs = opensTurn(s, 'p2');
    for (const u of stragglers) expect(theirs.units[u.id]).toBeUndefined();
  });

  it('spares the ones their owner walks out in time', () => {
    const { s, stragglers } = afterLoss();
    const mine = opensTurn(s, 'p1');
    const away = NODE_BY_ID[BATTLE].adjacency.find((n) => !occupies(mine, n, 'p2'))!;
    const moved = moveLoose(mine, [stragglers[0].id], away).state;
    const theirs = opensTurn(moved, 'p2');
    expect(theirs.units[stragglers[0].id]).toBeDefined(); // got out
    expect(theirs.units[stragglers[1].id]).toBeUndefined(); // did not
  });

  // An army in the node stops this exactly as it stops the moving-in kind, so a
  // relief force covers the retreat.
  it('spares them all if an army marches in to cover them', () => {
    const { s, stragglers } = afterLoss();
    const mine = opensTurn(s, 'p1');
    const from = NODE_BY_ID[BATTLE].adjacency.find((n) => !occupies(mine, n, 'p2'))!;
    const relief = armyAt(mine, 'p1', from, 'infantry', 2);
    const covered = moveArmy(mine, relief, BATTLE).state;
    const theirs = opensTurn(covered, 'p2');
    for (const u of stragglers) expect(theirs.units[u.id]).toBeDefined();
  });
});

// The reason spending the last action must not end the turn: the move that uses
// it is usually the one that creates the battle.
describe('attacking with the last action of the turn', () => {
  it('leaves the turn open to initiate the battle the move just created', () => {
    const s = createStrategic();
    const from = NODE_BY_ID[BATTLE].adjacency[0];
    army(s, 'p2', BATTLE, 'armor', 1);
    const mine = armyAt(s, 'p1', from, 'infantry', 2);

    // Burn the first action, then walk into the enemy with the second.
    const first = buildFort(s, from).state;
    expect(first.actionsLeft).toBe(1);
    const arrived = moveArmy(first, mine, BATTLE).state;

    expect(arrived.actionsLeft).toBe(0);
    expect(arrived.turn).toBe('p1'); // still theirs — the old code handed over here
    expect(canInitiateBattle(arrived, BATTLE, 'p1')).toBe(true);
    expect(createBattleAt(arrived, BATTLE, 'p1').error).toBeUndefined();
  });

  it('defers the supply check to the end of the turn, not the last action', () => {
    const s = createStrategic();
    // Sea supplies a flat 2 whatever the slots, so this is unambiguously an
    // overstack: an army walks in far too big and must not shed until turn's end.
    const sea = MAP.nodes.find((n) => n.sea)!.id;
    const beach = NODE_BY_ID[sea].adjacency.find((n) => !isSea(n))!;
    const big = armyAt(s, 'p1', beach, 'infantry', 6);
    const moved = moveArmy(buildFort(s, beach).state, big, sea).state;

    expect(moved.actionsLeft).toBe(0);
    expect(supplyCap(moved, sea, 'p1')).toBe(SEA_SUPPLY);
    expect(armyUnits(moved, big)).toHaveLength(6); // nobody shed yet

    const ended = endTurn(moved).state;
    expect(supplyUsed(ended, sea, 'p1')).toBeLessThanOrEqual(SEA_SUPPLY);
  });
});

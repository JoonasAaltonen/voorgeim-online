// The strategic ↔ battle bridge (Phase 7). Two directions to guard: assembling a
// battle from map units (createBattleAt), and posting a finished battle back onto
// the map (resolveBattle / resolveRetreat). The battle engine itself is proven in
// engine.test.ts, so here we build finished BattleStates by hand and check only
// the translation — which units come across, and what the map looks like after.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NODE_BY_ID, STAGING_NODE, type NodeId } from './map';
import {
  createStrategic,
  fortKey,
  type MapUnit,
  type StrategicState,
} from './strategic';
import {
  canInitiateBattle,
  createBattleAt,
  resolveBattle,
  resolveRetreat,
  retreatOptions,
  supportGuns,
} from './campaign';
import { assembleBattle, type BattleState } from './battle';
import type { BattleUnit, Player, UnitStatus } from './types';
import { UNIT_STATS } from './units';

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

/** A finished battle over `node`, with the listed units set to the given states. */
function finished(
  s: StrategicState,
  node: NodeId,
  attacker: Player,
  winner: Player | 'stalemate',
  states: Record<string, { status: UnitStatus; wounded?: boolean; support?: boolean }>,
): BattleState {
  const units: BattleUnit[] = Object.entries(states).map(([id, st]) => ({
    id,
    type: s.units[id]?.type ?? 'infantry',
    owner: s.units[id]?.owner ?? attacker,
    hp: UNIT_STATS[s.units[id]?.type ?? 'infantry'].hp,
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

  it('leaves recon behind — scouts never fight', () => {
    const s = createStrategic();
    army(s, 'p1', BATTLE, 'infantry', 1);
    army(s, 'p2', BATTLE, 'infantry', 1);
    const scout = Object.values(s.units).find((u) => u.owner === 'p1' && u.type === 'recon')!;
    scout.nodeId = BATTLE;
    const { battle } = createBattleAt(s, BATTLE, 'p1');
    expect(battle!.units[scout.id]).toBeUndefined();
  });

  it('sends a wounded infantry in at one hitpoint, still wounded', () => {
    const s = createStrategic();
    const [inf] = army(s, 'p1', BATTLE, 'infantry', 1);
    inf.wounded = true;
    army(s, 'p2', BATTLE, 'infantry', 1);
    const { battle } = createBattleAt(s, BATTLE, 'p1');
    expect(battle!.units[inf.id].wounded).toBe(true);
    expect(battle!.units[inf.id].hp).toBe(1);
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

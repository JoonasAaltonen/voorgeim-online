import { describe, expect, it } from 'vitest';
import {
  CONTESTED_NODES,
  MAP,
  NODE_BY_ID,
  STAGING_NODE,
  arePathLinked,
  indirectFireOrigins,
  isSea,
  slotsFor,
  spotsFor,
} from './map';
import {
  ACTIONS_PER_TURN,
  createStrategic,
  endTurn,
  legalMoveTargets,
  moveUnit,
  unitsAt,
  type StrategicState,
  type Transition,
} from './strategic';
import { STARTING_ARMY } from './units';

// These guard the extraction as much as the code: if a re-export of the Figma
// map silently changes the graph, the counts below are what will notice.
describe('map data', () => {
  it('holds the 28 contested locations plus a staging area per player', () => {
    expect(MAP.nodes).toHaveLength(30);
    expect(CONTESTED_NODES).toHaveLength(28);
    expect(CONTESTED_NODES.filter((n) => n.sea)).toHaveLength(5);
    expect(CONTESTED_NODES.filter((n) => !n.sea)).toHaveLength(23);
    expect(Object.keys(STAGING_NODE).sort()).toEqual(['p1', 'p2']);
  });

  it('gives every contested node 1-3 division slots per side', () => {
    for (const n of CONTESTED_NODES) {
      for (const p of ['p1', 'p2'] as const) {
        expect(slotsFor(n.id, p)).toBeGreaterThanOrEqual(1);
        expect(slotsFor(n.id, p)).toBeLessThanOrEqual(3);
      }
      expect(n.asymmetric).toBe(slotsFor(n.id, 'p1') !== slotsFor(n.id, 'p2'));
    }
    // The 84 division spots on the map art must all be accounted for.
    const total = CONTESTED_NODES.reduce(
      (t, n) => t + slotsFor(n.id, 'p1') + slotsFor(n.id, 'p2'),
      0,
    );
    expect(total).toBe(84);
  });

  it('keeps every division spot inside its own node and off the far side', () => {
    for (const n of CONTESTED_NODES) {
      for (const p of ['p1', 'p2'] as const) {
        for (const s of spotsFor(n.id, p)) {
          // Spots belong to the node they were assigned to, so they must sit
          // nearer its centroid than any other node's.
          const nearest = CONTESTED_NODES.reduce((best, m) =>
            Math.hypot(s.x - m.coord.x, s.y - m.coord.y) <
            Math.hypot(s.x - best.coord.x, s.y - best.coord.y)
              ? m
              : best,
          );
          expect(nearest.id, `spot of ${n.id} sits in ${nearest.id}`).toBe(n.id);
        }
      }
      // The two sides must not share a spot.
      const key = (s: { x: number; y: number }) => `${s.x},${s.y}`;
      const p1 = spotsFor(n.id, 'p1').map(key);
      const p2 = spotsFor(n.id, 'p2').map(key);
      expect(p1.filter((k) => p2.includes(k))).toEqual([]);
    }
  });

  it('keeps adjacency symmetric and free of self-links', () => {
    for (const n of MAP.nodes) {
      expect(n.adjacency).not.toContain(n.id);
      expect(new Set(n.adjacency).size).toBe(n.adjacency.length);
      for (const m of n.adjacency) {
        expect(NODE_BY_ID[m], `${n.id} -> unknown ${m}`).toBeDefined();
        expect(NODE_BY_ID[m].adjacency, `${m} should link back to ${n.id}`).toContain(n.id);
      }
    }
    const edges = MAP.nodes.reduce((t, n) => t + n.adjacency.length, 0) / 2;
    expect(edges).toBe(46);
  });

  it('connects every node to the graph, reachable from p1 staging', () => {
    const seen = new Set<string>([STAGING_NODE.p1]);
    const queue = [STAGING_NODE.p1];
    while (queue.length) {
      for (const m of NODE_BY_ID[queue.pop()!].adjacency) {
        if (!seen.has(m)) {
          seen.add(m);
          queue.push(m);
        }
      }
    }
    expect(seen.size).toBe(30);
  });

  it('reports staging as uncapped and flags the asymmetric nodes', () => {
    expect(slotsFor(STAGING_NODE.p1, 'p1')).toBe(Infinity);
    expect(spotsFor(STAGING_NODE.p1, 'p1')).toEqual([]);
    const asym = CONTESTED_NODES.filter((n) => n.asymmetric);
    expect(asym).toHaveLength(6);
    for (const n of asym) expect(slotsFor(n.id, 'p1')).not.toBe(slotsFor(n.id, 'p2'));
  });

  it('keeps indirect fire directional and separate from the path graph', () => {
    expect(MAP.indirectFire).toHaveLength(4);
    for (const l of MAP.indirectFire) {
      expect(NODE_BY_ID[l.from]).toBeDefined();
      expect(NODE_BY_ID[l.to]).toBeDefined();
      // A phantom origin is precisely one with no movement path to its target.
      expect(l.phantomOrigin).toBe(!arePathLinked(l.from, l.to));
      // Directional: the reverse link must not be implied.
      expect(indirectFireOrigins(l.from)).not.toContain(l.to);
    }
  });
});

describe('strategic movement', () => {
  const first = (s: StrategicState, owner: 'p1' | 'p2' = 'p1') =>
    Object.values(s.units).find((u) => u.owner === owner)!;

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
    const u = first(s);
    expect(legalMoveTargets(s, u.id).sort()).toEqual([...NODE_BY_ID[u.nodeId].adjacency].sort());
  });

  it('moves a unit along a path and spends one action', () => {
    const s = createStrategic();
    const u = first(s);
    const to = NODE_BY_ID[u.nodeId].adjacency[0];
    const t = moveUnit(s, u.id, to);
    expect(t.error).toBeUndefined();
    expect(t.state.units[u.id].nodeId).toBe(to);
    expect(t.state.actionsLeft).toBe(ACTIONS_PER_TURN - 1);
    expect(s.units[u.id].nodeId).toBe(STAGING_NODE.p1); // caller's state untouched
  });

  it('blocks a jump to a node with no movement path', () => {
    const s = createStrategic();
    const u = first(s);
    const far = CONTESTED_NODES.find(
      (n) => n.id !== u.nodeId && !arePathLinked(u.nodeId, n.id),
    )!;
    const t = moveUnit(s, u.id, far.id);
    expect(t.error).toMatch(/no movement path/i);
    expect(t.state).toBe(s);
  });

  it("blocks moving the opponent's unit", () => {
    const s = createStrategic();
    const enemy = first(s, 'p2');
    const t = moveUnit(s, enemy.id, NODE_BY_ID[enemy.nodeId].adjacency[0]);
    expect(t.error).toMatch(/P1 - Red's turn/);
    expect(t.state).toBe(s);
  });

  it('hands over after two actions and stops accepting a third', () => {
    let t: Transition = { state: createStrategic() };
    const [a, b] = Object.values(t.state.units).filter((u) => u.owner === 'p1');
    t = moveUnit(t.state, a.id, NODE_BY_ID[a.nodeId].adjacency[0]);
    t = moveUnit(t.state, b.id, NODE_BY_ID[b.nodeId].adjacency[0]);
    expect(t.state.turn).toBe('p2');
    expect(t.state.actionsLeft).toBe(ACTIONS_PER_TURN);

    const c = Object.values(t.state.units).find((u) => u.owner === 'p1' && u.id !== a.id)!;
    const denied = moveUnit(t.state, c.id, NODE_BY_ID[c.nodeId].adjacency[0]);
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
    const land = seaNode.adjacency.find((id) => !isSea(id))!;
    const s = createStrategic();
    const u = first(s);
    s.units[u.id].nodeId = land;
    const t = moveUnit(s, u.id, seaNode.id);
    expect(t.error).toBeUndefined();
    expect(t.state.units[u.id].nodeId).toBe(seaNode.id);
  });
});

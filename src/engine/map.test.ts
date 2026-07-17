import { describe, expect, it } from 'vitest';
import {
  ASYM_ENTRY,
  CONTESTED_NODES,
  MAP,
  NODE_BY_ID,
  STAGING_NODE,
  arePathLinked,
  entrySide,
  indirectFireOrigins,
  isAsymmetric,
  slotsFor,
  spotsFor,
} from './map';

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

// The entry table is hand-written against a drawing, so it is exactly the kind of
// data that rots silently when the map is re-exported. These check it against the
// graph rather than trusting it.
describe('asymmetric entry sides', () => {
  it('covers every asymmetric node, and only those', () => {
    const asym = CONTESTED_NODES.filter((n) => n.asymmetric).map((n) => n.id);
    expect(asym).toHaveLength(6);
    expect(Object.keys(ASYM_ENTRY).sort()).toEqual([...asym].sort());
  });

  it('names every neighbour of each asymmetric node, and nothing that is not one', () => {
    for (const [id, table] of Object.entries(ASYM_ENTRY)) {
      const adj = [...NODE_BY_ID[id].adjacency].sort();
      expect(Object.keys(table).sort()).toEqual(adj);
    }
  });

  it('uses both sides of every asymmetric node — a table that always answered the same way would be a bug', () => {
    for (const table of Object.values(ASYM_ENTRY)) {
      expect(new Set(Object.values(table)).size).toBe(2);
    }
  });

  it('gives the wide side to exactly one approach in the coastal pair', () => {
    // n01/n03: the sea lands on the 2-slot side, the land route on the single one.
    for (const id of ['n01', 'n03']) {
      const sea = NODE_BY_ID[id].adjacency.find((a) => NODE_BY_ID[a].sea)!;
      const land = NODE_BY_ID[id].adjacency.find((a) => !NODE_BY_ID[a].sea)!;
      expect(slotsFor(id, entrySide(id, sea)!)).toBe(2);
      expect(slotsFor(id, entrySide(id, land)!)).toBe(1);
    }
  });

  it('gives each big node its 3-slot side to its own staging area alone', () => {
    for (const [id, owner] of [
      ['n12', 'p1'],
      ['n18', 'p2'],
    ] as const) {
      const staging = STAGING_NODE[owner];
      expect(entrySide(id, staging)).toBe(owner);
      expect(slotsFor(id, entrySide(id, staging)!)).toBe(3);
      for (const other of NODE_BY_ID[id].adjacency.filter((a) => a !== staging)) {
        expect(slotsFor(id, entrySide(id, other)!)).toBe(2);
      }
    }
  });

  it('gives n19 and n25 their 2-slot side to the rear approach only', () => {
    for (const [id, rear] of [
      ['n19', 'n23'],
      ['n25', 'n27'],
    ] as const) {
      expect(slotsFor(id, entrySide(id, rear)!)).toBe(2);
      for (const other of NODE_BY_ID[id].adjacency.filter((a) => a !== rear)) {
        expect(slotsFor(id, entrySide(id, other)!)).toBe(1);
      }
    }
  });

  it('has nothing to say about symmetric nodes', () => {
    const sym = CONTESTED_NODES.find((n) => !n.asymmetric)!;
    expect(isAsymmetric(sym.id)).toBe(false);
    expect(entrySide(sym.id, sym.adjacency[0])).toBeNull();
  });
});

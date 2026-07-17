// The strategic node graph, extracted from `Figma exports/Strategic map Figma.svg`
// by `tools/extract_map.py`. Regenerate map.json with that script rather than
// hand-editing it — the only hand-maintained part is the indirect-fire list.
//
// Pure data + lookups, no UI/DOM imports: part of the future `shared` package
// that the client and the Durable Object both consume.

import type { Player } from './types';
import rawMap from '../data/map.json';

export type NodeId = string;

/**
 * A side of a node — the two rows of division spots the art paints, named for
 * the player whose colour they carry.
 *
 * It is the *place*, not the player: in a symmetric node each player stands on
 * their own side and the distinction never surfaces, but in an asymmetric one the
 * sides offer different numbers of slots and you take whichever your approach
 * gives you. A p1 army entering n01 from n02 stands on side `p2` and gets that
 * side's single slot. `Player` and `Side` share their values and mean different
 * things; where a function wants one, it says so.
 */
export type Side = Player;

/** A position in the map image's 2246x1684 pixel space. */
export interface Point {
  x: number;
  y: number;
}

/** A contested location (23 land + 5 sea) or one of the 2 staging areas. */
export interface MapNode {
  id: NodeId;
  /** Ids reachable by a movement path. Symmetric: if a lists b, b lists a. */
  adjacency: NodeId[];
  /** Region centroid. */
  coord: Point;
  /**
   * Sea locations are transit-only: land units may pass through but cannot
   * initiate battles there, so opposing armies can slip past each other.
   * Absent on staging areas.
   */
  sea?: boolean;
  /**
   * The division spots painted on each side of the node, ordered left to right.
   * The slot count is just the list's length, so the two can never disagree.
   * Absent on staging areas, which have no supply cap and no spots.
   *
   * Keyed by `Side`, not by owner: which side a player stands on is decided by
   * how they arrived (see `ASYM_ENTRY`), and only matches their own colour by
   * default.
   */
  spots?: Record<Side, Point[]>;
  /** The two sides offer a different number of slots. */
  asymmetric?: boolean;
  /** Set only on the two staging areas; the player who owns it. */
  staging?: Player;
}

/** A red arrow: support artillery in `from` may shell a battle in `to`. */
export interface IndirectFireLink {
  from: NodeId;
  to: NodeId;
  /** No movement path joins the two, so the link never implies adjacency. */
  phantomOrigin: boolean;
}

export interface StrategicMap {
  image: { width: number; height: number };
  nodes: MapNode[];
  indirectFire: IndirectFireLink[];
}

// The generated JSON omits fields per node kind, which widens to a union that
// TypeScript cannot narrow usefully. Assert the shape once, here at the edge.
export const MAP = rawMap as StrategicMap;

export const NODE_BY_ID: Record<NodeId, MapNode> = Object.fromEntries(
  MAP.nodes.map((n) => [n.id, n]),
);

/** Where each player's units start and reinforce from. */
export const STAGING_NODE: Record<Player, NodeId> = Object.fromEntries(
  MAP.nodes.filter((n) => n.staging).map((n) => [n.staging!, n.id]),
) as Record<Player, NodeId>;

/** The 28 locations that can be contested — everything except the staging areas. */
export const CONTESTED_NODES: MapNode[] = MAP.nodes.filter((n) => !n.staging);

export const isStaging = (id: NodeId): boolean => !!NODE_BY_ID[id]?.staging;
export const isSea = (id: NodeId): boolean => !!NODE_BY_ID[id]?.sea;
export const isAsymmetric = (id: NodeId): boolean => !!NODE_BY_ID[id]?.asymmetric;

/**
 * "Empty asymmetric nodes (1v2, 2v3) have their frontlines occupied from the
 * direction of approach" — this is that, spelled out: the side you land on in
 * each asymmetric node, coming from each of its neighbours.
 *
 * This is not arbitrary and it is not guesswork from the coordinates: the map art
 * already answers it, by routing each path to one side of the node's midline. The
 * catch is that `extract_map.py` keeps only centroids, so *where* a path meets a
 * node does not survive into map.json — the fact is in the drawing but not in the
 * data. Hence a hand-maintained table, like the indirect-fire list, rather than a
 * derivation from node centres that would be almost right (n12's sea neighbour
 * n04 sits due north of it and still meets the eastern side).
 *
 * The pattern the art encodes: each staging area is the only thing joining its
 * own 3-slot side of the big node beside it (n12, n18), and every other route
 * crosses to the 2-slot side; the sea feeds the 2-slot side of the coastal pair
 * (n01, n03) while the land route feeds the single slot; and n19/n25 give their
 * 2-slot side to the approach from the rear.
 *
 * `map.test.ts` checks the table against the graph rather than trusting it.
 */
export const ASYM_ENTRY: Record<NodeId, Record<NodeId, Side>> = {
  n01: { n05: 'p1', n02: 'p2' }, //  p1 = 2 slots (seaward), p2 = 1 slot
  n03: { n07: 'p2', n02: 'p1' }, //  mirror of n01
  n12: { 'p1-staging': 'p1', n04: 'p2', n08: 'p2', n13: 'p2' }, // p1 = 3 slots
  n18: { 'p2-staging': 'p2', n10: 'p1', n11: 'p1', n21: 'p1' }, // p2 = 3 slots
  n19: { n23: 'p2', n13: 'p1', n16: 'p1' }, //  p2 = 2 slots (rearward)
  n25: { n27: 'p1', n17: 'p2', n21: 'p2' }, //  mirror of n19
};

/**
 * The side an arriving force takes in an empty node, approaching from `from`.
 * Null where the question does not arise: symmetric nodes, staging, and the sea,
 * where each player simply stands on their own side.
 */
export function entrySide(id: NodeId, from: NodeId): Side | null {
  return ASYM_ENTRY[id]?.[from] ?? null;
}

/** Named apart from board.ts's `areAdjacent`, which is battle-board geometry. */
export function arePathLinked(a: NodeId, b: NodeId): boolean {
  return !!NODE_BY_ID[a]?.adjacency.includes(b);
}

/**
 * Division slots on a *side* of a node. Staging is uncapped, reported as
 * Infinity. Ask `sideOf` in strategic.ts which side a player is on — passing a
 * player here is only right for a symmetric node.
 */
export function slotsFor(id: NodeId, side: Side): number {
  const n = NODE_BY_ID[id];
  if (!n) return 0;
  if (n.staging) return Infinity;
  return n.spots![side].length;
}

/** The division spots on a side of a node, ordered left to right. */
export function spotsFor(id: NodeId, side: Side): Point[] {
  return NODE_BY_ID[id]?.spots?.[side] ?? [];
}

/** Origins whose support artillery may shell a battle in `target`. */
export function indirectFireOrigins(target: NodeId): NodeId[] {
  return MAP.indirectFire.filter((l) => l.to === target).map((l) => l.from);
}

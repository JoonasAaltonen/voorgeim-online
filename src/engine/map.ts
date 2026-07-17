// The strategic node graph, extracted from `Figma exports/Strategic map Figma.svg`
// by `tools/extract_map.py`. Regenerate map.json with that script rather than
// hand-editing it — the only hand-maintained part is the indirect-fire list.
//
// Pure data + lookups, no UI/DOM imports: part of the future `shared` package
// that the client and the Durable Object both consume.

import type { Player } from './types';
import rawMap from '../data/map.json';

export type NodeId = string;

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
   * The division spots painted on each side of the node, ordered left to right —
   * a player's units stand on their own side only. The slot count is just the
   * list's length, so the two can never disagree. Absent on staging areas, which
   * have no supply cap and no spots.
   */
  spots?: Record<Player, Point[]>;
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

/** Named apart from board.ts's `areAdjacent`, which is battle-board geometry. */
export function arePathLinked(a: NodeId, b: NodeId): boolean {
  return !!NODE_BY_ID[a]?.adjacency.includes(b);
}

/** Division slots a player has in a node. Staging is uncapped, reported as Infinity. */
export function slotsFor(id: NodeId, player: Player): number {
  const n = NODE_BY_ID[id];
  if (!n) return 0;
  if (n.staging) return Infinity;
  return n.spots![player].length;
}

/** Where a player's units stand in a node, ordered left to right. */
export function spotsFor(id: NodeId, player: Player): Point[] {
  return NODE_BY_ID[id]?.spots?.[player] ?? [];
}

/** Origins whose support artillery may shell a battle in `target`. */
export function indirectFireOrigins(target: NodeId): NodeId[] {
  return MAP.indirectFire.filter((l) => l.to === target).map((l) => l.from);
}

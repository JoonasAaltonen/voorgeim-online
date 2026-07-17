// Core battle model types (pure). Kept intentionally small for Phase 0; the
// combat loop, deployment, and dice resolution land in Phase 1.

import type { UnitType } from './units';

export type Player = 'p1' | 'p2';

/**
 * The result of applying an intent to a state: the next state, plus the reason
 * it was rejected. On rejection the state is returned unchanged.
 */
export interface StateTransition<S> {
  state: S;
  error?: string;
}

export const otherPlayer = (p: Player): Player => (p === 'p1' ? 'p2' : 'p1');

/** Each player's coin color. */
export const PLAYER_COLOR: Record<Player, string> = { p1: 'Red', p2: 'Green' };

/**
 * How a player is named wherever one is shown: "P1 - Red". The color is the part
 * you can actually see on the board, and online you learn your side by joining —
 * so the two travel together rather than leaving "P1" to be matched up by eye.
 */
export const playerLabel = (p: Player): string => `${p.toUpperCase()} - ${PLAYER_COLOR[p]}`;

/** Board side each player deploys on. p1 = bottom, p2 = top (matches the art). */
export const PLAYER_SIDE = { p1: 'bottom', p2: 'top' } as const;

export type UnitStatus = 'reserve' | 'deployed' | 'dead' | 'withdrawn';

export interface BattleUnit {
  id: string;
  type: UnitType;
  owner: Player;
  /** Remaining hitpoints. */
  hp: number;
  /** Infantry-only: reached 0 HP once, now fights at −1 until finished off. */
  wounded?: boolean;
  /** Cell id it currently occupies while deployed. */
  cellId?: string;
  status: UnitStatus;
}

/** True for the off-grid indirect-fire support artillery. */
export const isSupportUnit = (u: BattleUnit): boolean => u.id.endsWith('-support');

/** Coin image url for a unit, using the synced asset naming convention. */
export function coinAsset(type: UnitType | 'unknown' | 'wounded', owner: Player): string {
  const n = owner === 'p1' ? 1 : 2;
  return `/assets/coin-${type}-p${n}.png`;
}

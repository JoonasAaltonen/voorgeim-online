// Pure unit data — no UI/DOM imports. This module is part of the future
// `shared` package that the client and (later) the Durable Object both import.

export type UnitType = 'infantry' | 'artillery' | 'anti-tank' | 'armor' | 'recon';

/** A unit's own class, i.e. which of the attacker's attack values applies to it. */
export type TargetClass = 'soft' | 'hard';

export interface UnitStats {
  /** S — damage vs soft targets */
  softAttack: number;
  /** H — damage vs hard targets */
  hardAttack: number;
  /** B — number of offensive dice rolled */
  breakthrough: number;
  /** T — number of defensive dice rolled */
  toughness: number;
  /** HP before wounded/destroyed */
  hp: number;
  targetClass: TargetClass;
  /** Recon exists only on the strategic map and never fights. */
  mapOnly?: boolean;
}

// Values taken directly from the VOORGEIM.md unit table (S/H/B/T/HP).
export const UNIT_STATS: Record<UnitType, UnitStats> = {
  infantry:    { softAttack: 2, hardAttack: 1, breakthrough: 1, toughness: 3, hp: 4, targetClass: 'soft' },
  artillery:   { softAttack: 3, hardAttack: 1, breakthrough: 2, toughness: 2, hp: 2, targetClass: 'soft' },
  'anti-tank': { softAttack: 1, hardAttack: 3, breakthrough: 2, toughness: 2, hp: 2, targetClass: 'soft' },
  armor:       { softAttack: 2, hardAttack: 2, breakthrough: 3, toughness: 1, hp: 4, targetClass: 'hard' },
  recon:       { softAttack: 0, hardAttack: 0, breakthrough: 0, toughness: 0, hp: 1, targetClass: 'soft', mapOnly: true },
};

/**
 * Hitpoints of a deployed fortification. It must be levelled before the unit
 * occupying the slot takes any damage, and it never alters that unit's stats.
 */
export const FORT_HP = 2;

/** Each player's starting roster (VOORGEIM.md "Initial units"). */
export const STARTING_ARMY: Record<UnitType, number> = {
  infantry: 10,
  artillery: 5,
  'anti-tank': 4,
  armor: 4,
  recon: 2,
};

/**
 * Recon: exists only on the strategic map, never fights, never joins an army,
 * and is invisible to the supply and control system. `mapOnly` is the flag; this
 * is the question the rest of the code actually asks.
 */
export const isMapOnly = (t: UnitType): boolean => !!UNIT_STATS[t].mapOnly;

/** Attack value a unit deals against a given target class (base damage). */
export function baseDamageVs(attacker: UnitType, target: TargetClass): number {
  const s = UNIT_STATS[attacker];
  return target === 'hard' ? s.hardAttack : s.softAttack;
}

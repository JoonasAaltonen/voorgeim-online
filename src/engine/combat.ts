// Combat resolution — pure and deterministic given the two roll values.
// Encodes the attacker/defender dice tables from VOORGEIM.md and returns the
// full breakdown (base, boosts, reductions, counter) so the log can explain
// exactly how each damage number came to be.

import { UNIT_STATS, baseDamageVs } from './units';
import type { BattleUnit } from './types';

export type Tier = 'crit-fail' | 'fail' | 'partial' | 'success' | 'great' | 'crit';
const TIERS: Tier[] = ['crit-fail', 'fail', 'partial', 'success', 'great', 'crit'];
export const tierOf = (roll: number): Tier => TIERS[Math.min(6, Math.max(1, roll)) - 1];

/** A unit's effective base damage vs a target class (wounded infantry deals −1). */
function effectiveBase(u: BattleUnit, targetClass: 'soft' | 'hard'): number {
  const base = baseDamageVs(u.type, targetClass);
  return u.wounded ? Math.max(0, base - 1) : base;
}

export interface CombatResult {
  attackerRoll: number;
  defenderRoll: number;
  attackerTier: Tier;
  defenderTier: Tier;
  /** Attacker's base damage vs this defender's class. */
  attackerBase: number;
  /** Defender's base counter damage vs this attacker's class. */
  defenderBase: number;
  /** Roll boost applied to base (crit +1, partial −1, else 0). */
  attackModifier: number;
  /** Attacker damage after the roll modifier, before defender reduction. */
  dealt: number;
  /** Defender's damage reduction (great/success −1, crit −2). */
  incomingReduction: number;
  /** Defender self-damage on a fumble. */
  selfDefender: number;
  /** Defender counter before the attacker's reduction. */
  counterRaw: number;
  /** Counter reduction from an attacker great/crit. */
  counterReduction: number;
  /** Final counter dealt to the attacker. */
  counter: number;
  /** Attacker self-damage on a fumble. */
  selfAttacker: number;
  /** False for ranged fire (arc / indirect) — the target cannot strike back. */
  counterAllowed: boolean;
  damageToDefender: number;
  damageToAttacker: number;
}

/**
 * Resolve one attack given the highest attacker die (breakthrough) and highest
 * defender die (toughness). See the "Battle dice rolls" section of the manual.
 */
export function resolveCombat(
  attacker: BattleUnit,
  defender: BattleUnit,
  attackerRoll: number,
  defenderRoll: number,
  allowCounter = true,
): CombatResult {
  const attackerBase = effectiveBase(attacker, UNIT_STATS[defender.type].targetClass);
  const defenderBase = effectiveBase(defender, UNIT_STATS[attacker.type].targetClass);

  // Attacker table
  let attackModifier = 0;
  let dealt = 0;
  let selfAttacker = 0;
  let counterReduction = 0;
  switch (attackerRoll) {
    case 1: selfAttacker = 1; break;                                  // crit fail
    case 2: break;                                                    // fail
    case 3: attackModifier = -1; dealt = attackerBase - 1; break;     // partial
    case 4: dealt = attackerBase; break;                              // success
    case 5: dealt = attackerBase; counterReduction = 1; break;        // great
    case 6: attackModifier = 1; dealt = attackerBase + 1; counterReduction = 1; break; // crit
  }
  dealt = Math.max(0, dealt);

  // Defender table
  let incomingReduction = 0;
  let counterRaw = 0;
  let selfDefender = 0;
  switch (defenderRoll) {
    case 1: selfDefender = 1; break;                                  // crit fail
    case 2: break;                                                    // fail
    case 3: counterRaw = defenderBase - 1; break;                     // partial
    case 4: incomingReduction = 1; counterRaw = defenderBase - 1; break; // success
    case 5: incomingReduction = 1; counterRaw = defenderBase; break;  // great
    case 6: incomingReduction = 2; counterRaw = defenderBase; break;  // crit
  }
  counterRaw = Math.max(0, counterRaw);
  const counter = allowCounter ? Math.max(0, counterRaw - counterReduction) : 0;

  return {
    attackerRoll,
    defenderRoll,
    attackerTier: tierOf(attackerRoll),
    defenderTier: tierOf(defenderRoll),
    attackerBase,
    defenderBase,
    attackModifier,
    dealt,
    incomingReduction,
    selfDefender,
    counterRaw,
    counterReduction,
    counter,
    selfAttacker,
    counterAllowed: allowCounter,
    damageToDefender: Math.max(0, dealt - incomingReduction) + selfDefender,
    damageToAttacker: counter + selfAttacker,
  };
}

export interface DamageOutcome {
  destroyed: boolean;
  /** Infantry that just entered the wounded state this hit. */
  becameWounded: boolean;
}

/**
 * Apply damage to a unit (mutates). Infantry reaching 0 HP becomes wounded
 * rather than destroyed; any further damage while wounded destroys it.
 */
export function applyDamage(u: BattleUnit, dmg: number): DamageOutcome {
  if (dmg <= 0) return { destroyed: false, becameWounded: false };
  if (u.wounded) return { destroyed: true, becameWounded: false };
  u.hp -= dmg;
  if (u.hp <= 0) {
    if (u.type === 'infantry') {
      u.wounded = true;
      u.hp = 1;
      return { destroyed: false, becameWounded: true };
    }
    return { destroyed: true, becameWounded: false };
  }
  return { destroyed: false, becameWounded: false };
}

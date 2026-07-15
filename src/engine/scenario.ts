// A "custom battle scenario": arbitrary rosters per side plus the toggles needed
// to exercise every rule branch without a strategic map (recon advantage and an
// optional indirect-fire support artillery).

import type { UnitType } from './units';
import { UNIT_STATS } from './units';
import type { BattleUnit, Player } from './types';
import { otherPlayer } from './types';

export interface ScenarioSide {
  /** Count of each combat unit type to field. */
  roster: Partial<Record<Exclude<UnitType, 'recon'>, number>>;
  /** Whether this side has an indirect-fire support artillery available. */
  support: boolean;
  /** Whether this side's units were revealed by enemy recon (affects deploy order). */
  reconRevealed: boolean;
}

export interface Scenario {
  attacker: Player;
  sides: Record<Player, ScenarioSide>;
}

export function emptyScenario(): Scenario {
  const side = (): ScenarioSide => ({ roster: {}, support: false, reconRevealed: false });
  return { attacker: 'p1', sides: { p1: side(), p2: side() } };
}

/** Expand a scenario into concrete BattleUnits (all in reserve, no cell yet). */
export function buildUnits(sc: Scenario): BattleUnit[] {
  const units: BattleUnit[] = [];
  (['p1', 'p2'] as Player[]).forEach((owner) => {
    const side = sc.sides[owner];
    (Object.entries(side.roster) as [Exclude<UnitType, 'recon'>, number][]).forEach(
      ([type, count]) => {
        for (let i = 1; i <= (count ?? 0); i++) {
          units.push({ id: `${owner}-${type}-${i}`, type, owner, hp: UNIT_STATS[type].hp, status: 'reserve' });
        }
      },
    );
    if (side.support) {
      units.push({ id: `${owner}-support`, type: 'artillery', owner, hp: UNIT_STATS.artillery.hp, status: 'reserve' });
    }
  });
  return units;
}

/**
 * Who deploys first. Neither/both reconed → attacker; exactly one side revealed
 * → that side deploys first regardless of role.
 */
export function firstDeployer(sc: Scenario): Player {
  const aRev = sc.sides[sc.attacker].reconRevealed;
  const dRev = sc.sides[otherPlayer(sc.attacker)].reconRevealed;
  if (aRev !== dRev) return aRev ? sc.attacker : otherPlayer(sc.attacker);
  return sc.attacker;
}

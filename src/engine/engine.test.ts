import { describe, it, expect } from 'vitest';
import { resolveCombat, applyDamage } from './combat';
import { areAdjacent, neighborIds, artilleryArcCells, fortCovers } from './board';
import { emptyScenario } from './scenario';
import {
  createBattle,
  deployUnit,
  deployFort,
  passDeploy,
  attack,
  move,
  withdraw,
  indirectFire,
  stalemateLooms,
  type BattleState,
  type Transition,
} from './battle';
import type { BattleUnit } from './types';

const unit = (over: Partial<BattleUnit>): BattleUnit => ({
  id: 'x', type: 'infantry', owner: 'p1', hp: 4, status: 'deployed', ...over,
});

/** Scripted RNG that replays a fixed sequence of [0,1) values. */
const seqRng = (seq: number[]) => {
  let i = 0;
  return () => seq[i++ % seq.length];
};

describe('resolveCombat', () => {
  const inf = unit({ type: 'infantry' });

  it('success vs fail: full base damage, no counter', () => {
    const r = resolveCombat(inf, inf, 4, 2);
    expect(r.damageToDefender).toBe(2); // infantry soft attack
    expect(r.damageToAttacker).toBe(0);
  });

  it('crit vs crit: +1 damage then −2 reduction; counter −1', () => {
    const r = resolveCombat(inf, inf, 6, 6);
    expect(r.damageToDefender).toBe(1); // (2+1) − 2
    expect(r.damageToAttacker).toBe(1); // counter 2 − 1
  });

  it('attacker crit-fail: self damage plus a partial counter', () => {
    const r = resolveCombat(inf, inf, 1, 3);
    expect(r.damageToDefender).toBe(0);
    expect(r.damageToAttacker).toBe(2); // counter (2−1) + 1 self
  });

  it('defender crit-fail takes 1 regardless', () => {
    const r = resolveCombat(inf, inf, 4, 1);
    expect(r.damageToDefender).toBe(3); // 2 attack + 1 self
    expect(r.damageToAttacker).toBe(0);
  });

  it('wounded infantry deals one less', () => {
    const wounded = unit({ wounded: true });
    const r = resolveCombat(wounded, unit({}), 4, 2);
    expect(r.damageToDefender).toBe(1); // 2 − 1
  });
});

describe('applyDamage', () => {
  it('infantry becomes wounded at 0 HP, dies on the next hit', () => {
    const u = unit({ type: 'infantry', hp: 4 });
    expect(applyDamage(u, 4)).toMatchObject({ destroyed: false, becameWounded: true });
    expect(u.wounded).toBe(true);
    expect(applyDamage(u, 1)).toMatchObject({ destroyed: true });
  });

  it('a healthy infantry at 1 HP is wounded, not destroyed, by an overkill hit', () => {
    const u = unit({ type: 'infantry', hp: 1 });
    expect(applyDamage(u, 4)).toMatchObject({ destroyed: false, becameWounded: true });
    expect(u.wounded).toBe(true);
  });

  it('non-infantry is destroyed at 0 HP', () => {
    const u = unit({ type: 'armor', hp: 4 });
    expect(applyDamage(u, 4)).toMatchObject({ destroyed: true, becameWounded: false });
  });
});

describe('board adjacency', () => {
  it('front rows are adjacent across the frontline (incl. diagonals)', () => {
    expect(areAdjacent('bottom-r0-c1', 'top-r0-c1')).toBe(true);
    expect(areAdjacent('bottom-r0-c1', 'top-r0-c0')).toBe(true);
  });
  it('back rows do not reach the other side', () => {
    expect(areAdjacent('bottom-r2-c0', 'top-r0-c0')).toBe(false);
  });
  it('a mid cell has 8 neighbors', () => {
    expect(neighborIds('bottom-r1-c1')).toHaveLength(8);
  });
});

describe('battle flow', () => {
  function deployFrontAndStart() {
    const sc = emptyScenario();
    sc.attacker = 'p1';
    sc.sides.p1.roster = { armor: 1 };
    sc.sides.p2.roster = { artillery: 1 };
    let t = { state: createBattle(sc) };
    t = deployUnit(t.state, 'p1-armor-1', 'bottom-r0-c0');
    t = passDeploy(t.state);
    t = deployUnit(t.state, 'p2-artillery-1', 'top-r0-c0');
    t = passDeploy(t.state); // → row 1
    t = passDeploy(t.state);
    t = passDeploy(t.state); // → row 2
    t = passDeploy(t.state);
    t = passDeploy(t.state); // → battle
    return t.state;
  }

  it('runs deployment then resolves a killing blow into victory', () => {
    const start = deployFrontAndStart();
    expect(start.phase).toBe('battle');
    expect(start.turn).toBe('p1');

    // armor breakthrough=3 → [6,1,1] value 6; artillery toughness=2 → [2,2] value 2
    const rng = seqRng([0.9, 0, 0, 0.2, 0.2]);
    const t = attack(start, 'p1-armor-1', 'p2-artillery-1', rng);
    expect(t.error).toBeUndefined();
    expect(t.state.units['p2-artillery-1'].status).toBe('dead');
    expect(t.state.winner).toBe('p1');
    expect(t.state.phase).toBe('over');
  });

  it('records both cells of an exchange, even when a unit dies there', () => {
    const start = deployFrontAndStart();
    const from = start.units['p1-armor-1'].cellId;
    const at = start.units['p2-artillery-1'].cellId;

    const rng = seqRng([0.9, 0, 0, 0.2, 0.2]);
    const t = attack(start, 'p1-armor-1', 'p2-artillery-1', rng);

    // The defender is dead and has lost its cellId, so the log entry is now the
    // only thing that knows where it stood — which is the whole point of it.
    expect(t.state.units['p2-artillery-1'].cellId).toBeUndefined();
    const c = [...t.state.log].reverse().find((e) => e.combat)!.combat!;
    expect(c.attackerCell).toBe(from);
    expect(c.defenderCell).toBe(at);
  });

  it('artillery arc = distance-2 line of 3 in all four directions, clipped', () => {
    const arc = artilleryArcCells('bottom-r1-c1'); // gr4,gc1
    expect(arc).toContain('top-r0-c1'); // straight up 2, across the frontline
    expect(arc).toContain('bottom-r2-c3'); // right flank line
    expect(arc).not.toContain('bottom-r1-c0'); // that is adjacent, not arc
    expect(arc).toHaveLength(6); // two directions clip off the board edges
  });

  it('ranged fire draws no counter but reduction still applies', () => {
    const inf = unit({ type: 'infantry' });
    const r = resolveCombat(inf, inf, 4, 5, false);
    expect(r.counterAllowed).toBe(false);
    expect(r.damageToAttacker).toBe(0); // no counter
    expect(r.damageToDefender).toBe(1); // 2 base − 1 reduction
  });

  it('indirect fire damages a spotted enemy and never harms the support unit', () => {
    const sc = emptyScenario();
    sc.sides.p1.roster = { infantry: 1 };
    sc.sides.p1.support = true;
    sc.sides.p2.roster = { infantry: 1 };
    let t: Transition = { state: createBattle(sc) };
    t = deployUnit(t.state, 'p1-infantry-1', 'bottom-r0-c0');
    t = deployUnit(t.state, 'p1-support', 'bottom-support');
    t = passDeploy(t.state);
    t = deployUnit(t.state, 'p2-infantry-1', 'top-r0-c0'); // adjacent to the p1 infantry
    t = passDeploy(t.state);
    t = passDeploy(t.state);
    t = passDeploy(t.state);
    t = passDeploy(t.state);
    t = passDeploy(t.state);
    expect(t.state.phase).toBe('battle');

    // artillery breakthrough=2 → [4,1] value 4; infantry toughness=3 → [2,1,1] value 2
    const seq = [0.5, 0, 0.2, 0, 0];
    let i = 0;
    const res = indirectFire(t.state, 'p1-support', 'p2-infantry-1', () => seq[i++]);
    expect(res.error).toBeUndefined();
    expect(res.state.units['p2-infantry-1'].hp).toBe(1); // 4 − 3
    expect(res.state.units['p1-support'].hp).toBe(2); // untouched
    expect(res.state.turn).toBe('p2');
    const entry = res.state.log.find((e) => e.combat);
    expect(entry?.combat?.attackerRolls).toHaveLength(1); // −1 breakthrough over the frontline
    expect(entry?.combat?.result.counterAllowed).toBe(false); // infantry cannot counter
  });

  it('indirect fire against an artillery target is countered', () => {
    const sc = emptyScenario();
    sc.sides.p1.roster = { infantry: 1 };
    sc.sides.p1.support = true;
    sc.sides.p2.roster = { artillery: 1 };
    let t: Transition = { state: createBattle(sc) };
    t = deployUnit(t.state, 'p1-infantry-1', 'bottom-r0-c0');
    t = deployUnit(t.state, 'p1-support', 'bottom-support');
    t = passDeploy(t.state);
    t = deployUnit(t.state, 'p2-artillery-1', 'top-r0-c0'); // artillery target, spotted
    t = passDeploy(t.state);
    t = passDeploy(t.state);
    t = passDeploy(t.state);
    t = passDeploy(t.state);
    t = passDeploy(t.state);

    // attacker (1 die, over the line): value 2 (fail, 0 dealt);
    // defender artillery (2 dice): value 3 (partial) → counter 3−1 = 2
    const seq = [0.2, 0.4, 0];
    let i = 0;
    const res = indirectFire(t.state, 'p1-support', 'p2-artillery-1', () => seq[i++]);
    expect(res.error).toBeUndefined();
    expect(res.state.units['p2-artillery-1'].hp).toBe(2); // took no damage
    expect(res.state.units['p1-support'].status).toBe('dead'); // countered for 2, had 2 HP
  });

  it('a fortification covers the front and flanks but not the rear', () => {
    // bottom fort at gr4: attacks from gr<=4 are covered, from gr5 (behind) are not.
    expect(fortCovers('bottom-r1-c1', 3)).toBe(true); // front
    expect(fortCovers('bottom-r1-c1', 4)).toBe(true); // flank
    expect(fortCovers('bottom-r1-c1', 5)).toBe(false); // rear / rear corner
    // top forts face the other way.
    expect(fortCovers('top-r1-c1', 2)).toBe(true); // front
    expect(fortCovers('top-r1-c1', 0)).toBe(false); // rear
  });

  /** p2 attacks; p1 holds a fortified position on the front row. */
  function fortifiedDefence(p1Type: 'armor' | 'infantry', p2Type: 'infantry' | 'artillery') {
    const sc = emptyScenario();
    sc.attacker = 'p2';
    sc.sides.p1.roster = { [p1Type]: 1 };
    sc.sides.p1.fortifications = 1;
    sc.sides.p2.roster = { [p2Type]: 1 };
    let t: Transition = { state: createBattle(sc) };
    t = deployUnit(t.state, `p2-${p2Type}-1`, 'top-r0-c0');
    t = passDeploy(t.state);
    t = deployUnit(t.state, `p1-${p1Type}-1`, 'bottom-r0-c0');
    t = deployFort(t.state, 'bottom-r0-c0');
    t = passDeploy(t.state);
    for (let i = 0; i < 4; i++) t = passDeploy(t.state);
    expect(t.state.phase).toBe('battle');
    expect(t.state.turn).toBe('p2');
    return t.state;
  }

  it('a frontal hit is soaked by the fortification, not the occupant', () => {
    const start = fortifiedDefence('armor', 'infantry');
    // infantry breakthrough=1 → [4]; armor toughness=1 → [2] (fail, no counter)
    const t = attack(start, 'p2-infantry-1', 'p1-armor-1', seqRng([0.5, 0.2]));
    expect(t.error).toBeUndefined();
    expect(t.state.units['p1-armor-1'].hp).toBe(4); // untouched
    expect(t.state.forts['bottom-r0-c0'].hp).toBe(1); // 2 − 1
    expect(t.state.log.find((e) => e.combat)?.combat?.fortDefender).toMatchObject({
      absorbed: 1,
      destroyed: false,
    });
  });

  it('an overkill hit levels the fortification but still spares the occupant', () => {
    const start = fortifiedDefence('infantry', 'artillery');
    // artillery breakthrough=2 → [4,1] value 4 → 3 damage; infantry toughness=3 → [2,1,1]
    const t = attack(start, 'p2-artillery-1', 'p1-infantry-1', seqRng([0.5, 0, 0.2, 0, 0]));
    expect(t.error).toBeUndefined();
    expect(t.state.units['p1-infantry-1'].hp).toBe(4); // the fort takes all 3
    expect(t.state.forts['bottom-r0-c0']).toBeUndefined(); // levelled
    expect(t.state.log.find((e) => e.combat)?.combat?.fortDefender).toMatchObject({
      absorbed: 3,
      destroyed: true,
    });
  });

  it('a fortification seized from behind does not shelter its new occupant', () => {
    const sc = emptyScenario();
    sc.attacker = 'p2';
    sc.sides.p1.roster = { infantry: 1 };
    sc.sides.p1.support = true;
    sc.sides.p1.fortifications = 1;
    sc.sides.p2.roster = { infantry: 1 };
    let t: Transition = { state: createBattle(sc) };
    t = deployUnit(t.state, 'p2-infantry-1', 'top-r0-c1');
    t = passDeploy(t.state);
    t = deployUnit(t.state, 'p1-infantry-1', 'bottom-r0-c2'); // spotter
    t = deployUnit(t.state, 'p1-support', 'bottom-support');
    t = deployFort(t.state, 'bottom-r0-c1'); // left empty on purpose
    t = passDeploy(t.state);
    for (let i = 0; i < 4; i++) t = passDeploy(t.state);

    // p2 walks into the undefended fortification on p1's side of the line.
    t = move(t.state, 'p2-infantry-1', 'bottom-r0-c1');
    expect(t.error).toBeUndefined();

    // p1's support shells it from behind the fort's facing → no cover, and the
    // target is on p1's own side so there is no over-the-line penalty.
    const res = indirectFire(t.state, 'p1-support', 'p2-infantry-1', seqRng([0.5, 0, 0.2, 0, 0]));
    expect(res.error).toBeUndefined();
    expect(res.state.units['p2-infantry-1'].hp).toBe(1); // 4 − 3, unsheltered
    expect(res.state.forts['bottom-r0-c1'].hp).toBe(2); // fort itself untouched
    expect(res.state.log.find((e) => e.combat)?.combat?.fortDefender).toBeUndefined();
    expect(res.state.log.find((e) => e.combat)?.combat?.attackerRolls).toHaveLength(2); // full breakthrough
  });

  /** p1 attacks and pulls its only unit back to the rearmost row. */
  function disengagedAttacker() {
    const sc = emptyScenario();
    sc.attacker = 'p1';
    sc.sides.p1.roster = { infantry: 1 };
    sc.sides.p2.roster = { infantry: 1 };
    let t: Transition = { state: createBattle(sc) };
    t = passDeploy(t.state); // p1 skips row 0
    t = deployUnit(t.state, 'p2-infantry-1', 'top-r0-c3');
    t = passDeploy(t.state); // → row 1
    t = passDeploy(t.state);
    t = passDeploy(t.state); // → row 2
    t = deployUnit(t.state, 'p1-infantry-1', 'bottom-r2-c0'); // straight into the back row
    t = passDeploy(t.state);
    t = passDeploy(t.state); // → battle
    expect(t.state.phase).toBe('battle');
    return t.state;
  }

  it('warns the defender only on the turn a stalemate is one handoff away', () => {
    let t: Transition = { state: disengagedAttacker() };
    expect(stalemateLooms(t.state)).toBe(false); // attacker's turn, not the defender's
    t = move(t.state, 'p1-infantry-1', 'bottom-r2-c1');
    expect(stalemateLooms(t.state)).toBe(true); // defender's last chance
    // Contesting clears the warning rather than ending the battle.
    t = move(t.state, 'p2-infantry-1', 'bottom-r0-c3');
    expect(t.state.phase).toBe('battle');
    t = move(t.state, 'p1-infantry-1', 'bottom-r2-c0');
    expect(stalemateLooms(t.state)).toBe(false);
  });

  it('an uncontested disengagement ends the battle in a stalemate', () => {
    let t: Transition = { state: disengagedAttacker() };
    t = move(t.state, 'p1-infantry-1', 'bottom-r2-c1'); // still the back row
    expect(t.state.phase).toBe('battle'); // p2 gets a turn to answer
    t = move(t.state, 'p2-infantry-1', 'top-r0-c2'); // stays on their own side
    expect(t.state.phase).toBe('over');
    expect(t.state.winner).toBe('stalemate');
  });

  it('the defender contests a stalemate by crossing the initial frontline', () => {
    let t: Transition = { state: disengagedAttacker() };
    t = move(t.state, 'p1-infantry-1', 'bottom-r2-c1');
    t = move(t.state, 'p2-infantry-1', 'bottom-r0-c3'); // over the line
    expect(t.error).toBeUndefined();
    expect(t.state.phase).toBe('battle');
    expect(t.state.winner).toBeNull();
  });

  // Reported from play: the attacker held one unit forward and one in the back
  // row. The defender killed the forward one, which made the attacker "fully
  // withdrawn" without the attacker having chosen anything — and the battle was
  // called off on the spot. Breaking off is something the attacker *does*.
  it('does not call a stalemate when the defender shoots the attacker back', () => {
    const sc = emptyScenario();
    sc.attacker = 'p1';
    sc.sides.p1.roster = { infantry: 2 };
    sc.sides.p2.roster = { artillery: 1 };
    let t: Transition = { state: createBattle(sc) };
    // p1 takes the front row *and* the back row; p2 faces the forward one.
    t = deployUnit(t.state, 'p1-infantry-1', 'bottom-r0-c0');
    t = passDeploy(t.state);
    t = deployUnit(t.state, 'p2-artillery-1', 'top-r0-c0');
    t = passDeploy(t.state); // → row 1
    t = passDeploy(t.state);
    t = passDeploy(t.state); // → row 2
    t = deployUnit(t.state, 'p1-infantry-2', 'bottom-r2-c0');
    t = passDeploy(t.state);
    t = passDeploy(t.state); // → battle
    expect(t.state.phase).toBe('battle');

    // p1 shuffles the back unit and ends their turn with a unit still forward:
    // plainly not a withdrawal.
    t = move(t.state, 'p1-infantry-2', 'bottom-r2-c1');
    expect(t.state.attackerBrokeOff).toBe(false);

    // p2 kills the forward unit, leaving p1 entirely in the back row — by p2's
    // doing, not p1's.
    const shot: BattleState = structuredClone(t.state);
    shot.units['p1-infantry-1'] = {
      ...shot.units['p1-infantry-1'],
      status: 'dead',
      cellId: undefined,
    };
    t = move(shot, 'p2-artillery-1', 'top-r0-c1'); // p2 ends their turn

    expect(t.state.phase).toBe('battle'); // the battle goes on
    expect(t.state.winner).toBeNull();
    expect(t.state.turn).toBe('p1'); // and p1 gets their turn back

    // Now p1 chooses to stay in the back row — that *is* breaking off.
    t = move(t.state, 'p1-infantry-2', 'bottom-r2-c2');
    expect(t.state.attackerBrokeOff).toBe(true);
    expect(stalemateLooms(t.state)).toBe(true); // p2's turn to contest
    t = move(t.state, 'p2-artillery-1', 'top-r0-c2'); // they do not
    expect(t.state.winner).toBe('stalemate');
  });

  it('an attacker still holding the support unit has not disengaged', () => {
    const sc = emptyScenario();
    sc.attacker = 'p1';
    sc.sides.p1.roster = { infantry: 1 };
    sc.sides.p1.support = true;
    sc.sides.p2.roster = { infantry: 1 };
    let t: Transition = { state: createBattle(sc) };
    t = deployUnit(t.state, 'p1-support', 'bottom-support');
    t = passDeploy(t.state);
    t = deployUnit(t.state, 'p2-infantry-1', 'top-r0-c3');
    t = passDeploy(t.state);
    t = passDeploy(t.state);
    t = passDeploy(t.state);
    t = deployUnit(t.state, 'p1-infantry-1', 'bottom-r2-c0');
    t = passDeploy(t.state);
    t = passDeploy(t.state);

    t = move(t.state, 'p1-infantry-1', 'bottom-r2-c1');
    t = move(t.state, 'p2-infantry-1', 'top-r0-c2');
    expect(t.state.phase).toBe('battle'); // support still in the fight

    // Pull it out, and the next uncontested exchange settles the battle.
    t = withdraw(t.state, 'p1-support');
    t = move(t.state, 'p2-infantry-1', 'top-r0-c1');
    expect(t.state.phase).toBe('over');
    expect(t.state.winner).toBe('stalemate');
  });

  it('rejects a non-adjacent attack', () => {
    const sc = emptyScenario();
    sc.sides.p1.roster = { armor: 1 };
    sc.sides.p2.roster = { artillery: 1 };
    let t: Transition = { state: createBattle(sc) };
    t = deployUnit(t.state, 'p1-armor-1', 'bottom-r0-c0');
    t = passDeploy(t.state);
    t = deployUnit(t.state, 'p2-artillery-1', 'top-r0-c3'); // far column → not adjacent
    t = passDeploy(t.state);
    t = passDeploy(t.state);
    t = passDeploy(t.state);
    t = passDeploy(t.state);
    t = passDeploy(t.state);
    const res = attack(t.state, 'p1-armor-1', 'p2-artillery-1');
    expect(res.error).toMatch(/range/i);
    expect(res.state.phase).toBe('battle'); // unchanged
  });
});

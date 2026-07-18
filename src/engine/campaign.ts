// The strategic ↔ battle bridge (Phase 7). Pure, like everything either side of
// it: given a strategic state and a node, it assembles a battle; given a finished
// battle, it posts the result back onto the strategic map.
//
// The seam is unit identity. A battle lifted off the map carries the *strategic*
// unit ids straight through the battle engine, so when the smoke clears every
// coin can be found again and marked dead, wounded, withdrawn, or reinforced.
// Nothing here re-derives who was who.

import type { Player } from './types';
import { PLAYERS, otherPlayer, playerLabel } from './types';
import type { BattleUnit } from './types';
import { UNIT_STATS } from './units';
import type { NodeId } from './map';
import { NODE_BY_ID, indirectFireOrigins, isSea, isStaging } from './map';
import { assembleBattle, type BattleState } from './battle';
import type { MapUnit, StrategicState, Transition } from './strategic';
import {
  armiesAt,
  arrivalSide,
  fortKey,
  fortsAt,
  isRecon,
  MASKED,
  occupies,
  unitsAtFor,
} from './strategic';

const clone = (s: StrategicState): StrategicState => structuredClone(s);

function log(s: StrategicState, text: string): void {
  s.log.push({ id: s.seq++, kind: 'battle', text });
}

/** Fighting units (never recon) a player has standing in a node, organized or not. */
function fightersAt(s: StrategicState, nodeId: NodeId, player: Player): MapUnit[] {
  return unitsAtFor(s, nodeId, player).filter((u) => !isRecon(u));
}

/**
 * The units that can actually take the field here: in an army, and never recon.
 *
 * "Disorganized […] units can freely move in the strategic map […] but will need
 * to be organized into armies to be used in battles." A node can easily hold
 * both — walk ten units into three supply and the excess drops out of the army
 * where it stands — and when the enemy attacks, only the army answers. The
 * disorganized sit the fight out, sheltered by the army doing the fighting, and
 * are dealt with by the battle's outcome: they fall back with a beaten force, or
 * stay put after a stalemate, "not available for battles until reorganized."
 */
function combatantsAt(s: StrategicState, nodeId: NodeId, player: Player): MapUnit[] {
  return fightersAt(s, nodeId, player).filter((u) => u.armyId);
}

/**
 * Can `player` open a battle in this node right now? They and the enemy both need
 * a fighting unit present, and no battle is ever fought at sea — "opposing armies
 * pass each other" there.
 */
export function canInitiateBattle(s: StrategicState, nodeId: NodeId, player: Player): boolean {
  if (isSea(nodeId) || isStaging(nodeId)) return false;
  // "[Wounded units] can't participate in an attack against the enemy" — so the
  // attacker needs at least one able-bodied unit to lead the assault, not merely
  // a body in the node.
  // Only armies fight, so only armies can start or answer a battle. A node
  // holding nothing but disorganized units is overrun by an arriving army rather
  // than fought over — that is `overrun`'s job, not a battle's.
  return (
    combatantsAt(s, nodeId, player).some((u) => !u.wounded) &&
    combatantsAt(s, nodeId, otherPlayer(player)).length > 0
  );
}

/**
 * A player's eligible indirect-fire guns for a battle in `target`: an artillery
 * attached to an army in a node the red arrow points from, which the player holds
 * and the enemy is not standing in.
 *
 * Note this is a *weaker* test than `controlFor`'s rear-area control. It has to
 * be: the firing node is adjacent to the battle, and the enemy in the battle node
 * would make it "contested" under the full rule — which would leave indirect fire
 * essentially never usable, plainly not the manual's intent. So "a controlled
 * node that allows indirect fire" is read here as "a node you hold, uncontested
 * on its own square."
 *
 * Every eligible gun is offered to the board as a reserve support unit; the board
 * has a single support slot per side, so deploying one is what enforces the
 * manual's "a single artillery unit" — the rest simply go home unrevealed.
 */
export function supportGuns(s: StrategicState, nodeId: NodeId, player: Player): MapUnit[] {
  const enemy = otherPlayer(player);
  const guns: MapUnit[] = [];
  for (const origin of indirectFireOrigins(nodeId)) {
    if (occupies(s, origin, enemy)) continue;
    for (const u of unitsAtFor(s, origin, player)) {
      if (u.type === 'artillery' && u.armyId && !isRecon(u)) guns.push(u);
    }
  }
  return guns;
}

/**
 * A strategic unit as it enters the battle board, carrying its real id.
 *
 * Battles are only ever assembled from the server's own state, which never holds
 * a masked chip — masking happens on the way out, in `viewFor`. A mask reaching
 * here would mean a client's fogged copy was used as the source of truth, so it
 * is worth failing loudly rather than fielding a unit with no stats.
 */
function toBattleUnit(u: MapUnit, support = false): BattleUnit {
  if (u.type === MASKED) {
    throw new Error(`Cannot field ${u.id}: a masked view unit is not a real unit.`);
  }
  const wounded = !!u.wounded;
  return {
    id: u.id,
    type: u.type,
    owner: u.owner,
    // Wounded infantry enters with the one hitpoint it clung to; everyone else is
    // at full strength — between battles, non-fatal damage is reinforced away.
    hp: wounded ? 1 : UNIT_STATS[u.type].hp,
    wounded: wounded || undefined,
    status: 'reserve',
    support: support || undefined,
  };
}

/** Whether any of a side's committed units were already face-up (recon, or a prior fight). */
function anyRevealed(units: MapUnit[]): boolean {
  return units.some((u) => u.revealed);
}

/**
 * Build the battle for a node. The initiator is the attacker. Deployment order
 * follows the recon rule: if exactly one side comes in already revealed it
 * deploys first, otherwise the attacker does.
 */
export function createBattleAt(
  s: StrategicState,
  nodeId: NodeId,
  attacker: Player,
): { battle?: BattleState; error?: string } {
  if (!canInitiateBattle(s, nodeId, attacker)) {
    return { error: 'No enemy to attack in that location.' };
  }
  const defender = otherPlayer(attacker);
  // The attacking force leaves its wounded behind — they cannot join an assault.
  // The defender's wounded are dragged in all the same, entering face-up and
  // fighting at −1, because a defensive engagement is forced on them.
  const attackerUnits = combatantsAt(s, nodeId, attacker).filter((u) => !u.wounded);
  const defenderUnits = combatantsAt(s, nodeId, defender);
  const units: BattleUnit[] = [
    ...attackerUnits.map((u) => toBattleUnit(u)),
    ...defenderUnits.map((u) => toBattleUnit(u)),
  ];
  for (const p of PLAYERS) {
    for (const g of supportGuns(s, nodeId, p)) units.push(toBattleUnit(g, true));
  }

  // Deploy order follows recon, judged only on the units actually taking the
  // field — a wounded attacker left at home does not count as a revealed side.
  const aRev = anyRevealed(attackerUnits);
  const dRev = anyRevealed(defenderUnits);
  const firstDeployer = aRev !== dRev ? (aRev ? attacker : defender) : attacker;

  const battle = assembleBattle({
    attacker,
    units,
    fortsLeft: { p1: fortsAt(s, nodeId, 'p1'), p2: fortsAt(s, nodeId, 'p2') },
    firstDeployer,
    node: nodeId,
  });
  return { battle };
}

/**
 * Move a named beaten force to `to`. Only the units listed — recon moves on its
 * own, and disorganized units that were never in the fight hold their ground.
 */
function performRetreat(
  s: StrategicState,
  player: Player,
  from: NodeId,
  to: NodeId,
  unitIds: string[],
): void {
  const side = arrivalSide(s, to, player, from);
  for (const id of unitIds) {
    const u = s.units[id];
    if (!u || u.nodeId !== from) continue; // died in the battle, or already moved
    u.nodeId = to;
    u.side = side;
  }
}

/**
 * The loser's force that actually falls back: whoever is still in an army, plus
 * anyone the battle turned loose by withdrawing them.
 *
 * The exclusion is the point — disorganized units that were standing in the node
 * before the battle began never took part, so they do not get a free ride out on
 * the back of a defeat. They stay where they are, and the winner's armies get one
 * turn-start to overrun them (`standingOverrun`) unless their owner spends their
 * own turn rescuing them.
 */
function retreatingForce(s: StrategicState, node: NodeId, loser: Player, battle: BattleState): MapUnit[] {
  return fightersAt(s, node, loser).filter((u) => u.armyId || battle.units[u.id]);
}

/** Adjacent nodes a beaten force may fall back to: anywhere the winner is not. */
export function retreatOptions(s: StrategicState, from: NodeId, loser: Player): NodeId[] {
  const winner = otherPlayer(loser);
  return (NODE_BY_ID[from]?.adjacency ?? []).filter((n) => !occupies(s, n, winner));
}

/**
 * Post a finished battle back onto the strategic map. The result is read entirely
 * off the battle units by id:
 *
 * - dead → removed from the map
 * - withdrawn → disorganized, and revealed
 * - wounded infantry → marked wounded (and revealed), staying wherever it is
 * - a survivor still on the board → stays in its army, but revealed until re-hidden
 * - never committed (reserve) → untouched, still organized and hidden
 *
 * A decisive result then clears the node: the loser's units fall back together to
 * one adjacent node. If that choice is forced (a single option) it is taken here;
 * if it is real, a `pendingRetreat` is raised and play waits; if there is nowhere
 * to go the units are encircled and destroyed.
 */
export function resolveBattle(s0: StrategicState, battle: BattleState): Transition {
  if (battle.phase !== 'over') return { state: s0, error: 'The battle is not finished.' };
  const node = battle.node;
  if (!node) return { state: s0, error: 'That battle was not fought over a location.' };

  const s = clone(s0);
  for (const bu of Object.values(battle.units)) {
    const u = s.units[bu.id];
    if (!u) continue; // already gone (shouldn't happen), stay defensive
    if (bu.status === 'reserve') continue; // never entered → untouched
    if (bu.status === 'dead') {
      delete s.units[bu.id];
      continue;
    }
    // Anything that took the field is now known to the enemy.
    u.revealed = true;
    if (bu.wounded) u.wounded = true;
    if (bu.support) continue; // support guns stay home, in their army, just revealed
    if (bu.status === 'withdrawn') delete u.armyId; // withdrawn → disorganized
  }
  // Prepared fortifications were spent in this battle, whatever its outcome.
  for (const p of PLAYERS) delete s.forts[fortKey(node, p)];

  const winner = battle.winner;
  log(
    s,
    winner === 'stalemate' || winner === null
      ? `Battle at ${node} ends in a stalemate — both sides dig in, disorganized.`
      : `${playerLabel(winner)} wins the battle at ${node}.`,
  );

  if (winner === 'stalemate' || winner === null) {
    // Nobody moves; the withdrawn units on both sides are already disorganized.
    return { state: s };
  }

  // The winner may re-sort survivors between armies for free — but only when more
  // than one of their armies came through, since that is the case the physical
  // board cannot untangle. They spend it on their own turn.
  if (armiesAt(s, node, winner).length >= 2) {
    s.freeReorgs[node] = winner;
    log(s, `${playerLabel(winner)} may re-sort the victors at ${node} for free, on their turn.`);
  }

  const loser = otherPlayer(winner);
  const retreating = retreatingForce(s, node, loser, battle);
  if (retreating.length === 0) return { state: s };
  const ids = retreating.map((u) => u.id);

  const options = retreatOptions(s, node, loser);
  if (options.length === 0) {
    for (const id of ids) delete s.units[id];
    log(s, `${playerLabel(loser)} is encircled at ${node} — the withdrawn units are destroyed.`);
    return { state: s };
  }
  if (options.length === 1) {
    performRetreat(s, loser, node, options[0], ids);
    log(s, `${playerLabel(loser)} falls back from ${node} to ${options[0]}.`);
    return { state: s };
  }
  s.pendingRetreat = { player: loser, from: node, options, units: ids };
  log(s, `${playerLabel(loser)} must choose where to fall back from ${node}.`);
  return { state: s };
}

/** The loser names their destination, resolving a `pendingRetreat`. */
export function resolveRetreat(s0: StrategicState, to: NodeId): Transition {
  const pr = s0.pendingRetreat;
  if (!pr) return { state: s0, error: 'No retreat is pending.' };
  if (!pr.options.includes(to)) return { state: s0, error: 'Cannot fall back there.' };

  const s = clone(s0);
  performRetreat(s, pr.player, pr.from, to, pr.units);
  s.pendingRetreat = null;
  log(s, `${playerLabel(pr.player)} falls back from ${pr.from} to ${to}.`);
  return { state: s };
}

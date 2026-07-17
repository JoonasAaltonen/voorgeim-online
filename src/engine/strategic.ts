// Strategic-map state (Phase 3 movement, Phase 5 armies/supply/control). Pure —
// same shape as battle.ts, so the Durable Object hosts it unchanged.
//
// Deliberately not modelled yet: fog of war and recon (Phase 6 — `reorganize`
// is where re-hiding will hook in), and battles triggered by two armies meeting
// (Phase 7 — today they simply stand in the same node).
//
// The one structural decision worth knowing before reading on: a unit's node is
// stored on the unit and *only* on the unit. An `Army` is a bare grouping token
// with no location of its own, so an army's position is derived from its
// members. That makes "army and member disagree about where they are"
// unrepresentable rather than merely a bug we promise not to write.

import type { Player, StateTransition } from './types';
import { PLAYERS, otherPlayer, playerLabel } from './types';
import type { UnitType } from './units';
import { STARTING_ARMY, isMapOnly } from './units';
import type { NodeId, Side } from './map';
import {
  MAP,
  NODE_BY_ID,
  STAGING_NODE,
  arePathLinked,
  entrySide,
  isAsymmetric,
  isSea,
  isStaging,
  slotsFor,
} from './map';
import { defaultRng, rollUntilDifferent, type Rng } from './dice';

/** Strategic actions a player takes per turn, sequentially (VOORGEIM.md). */
export const ACTIONS_PER_TURN = 2;

/** "Players can have a total of 10 active armies." */
export const MAX_ARMIES = 10;

/**
 * A node is controlled or contested *for a given player* — the same node is
 * usually contested for both. There is no third "neutral" state: contested is
 * the default and controlled is earned.
 */
export type Control = 'controlled' | 'contested';

/**
 * Units a division slot supplies. Contested is the base rate: doubling it is a
 * rear-area privilege that a player earns by holding the node *and* its whole
 * neighbourhood — see `controlFor`.
 */
export const SUPPLY_PER_SLOT: Record<Control, number> = { controlled: 6, contested: 3 };

/** "Sea nodes can always supply only 2 unit per node" — flat, slots don't apply. */
export const SEA_SUPPLY = 2;

/** "2 Disorganized units located in the same node can be moved together as one action." */
export const MAX_LOOSE_MOVE = 2;

/** Sentinel target in a reorganization: gather these units into a brand-new army. */
export const NEW_ARMY = 'new';

/**
 * A grouping token. Armies hold no state of their own beyond identity and the
 * move stamp; membership is `MapUnit.armyId` pointing back here, and position is
 * derived from the members.
 */
export interface Army {
  id: string;
  owner: Player;
  /**
   * Monotonic stamp of the last time this army moved. The overstack rule needs
   * to name "the most recently moved army", and nothing else can answer that.
   */
  movedAt: number;
}

export interface MapUnit {
  id: string;
  type: UnitType;
  owner: Player;
  /** The node it currently stands on. */
  nodeId: NodeId;
  /** The army it belongs to. Absent means disorganized ("loose"). */
  armyId?: string;
  /**
   * Which side of the node it stands on — stamped on arrival by `arrivalSide`.
   * Absent means "your own", which is always the answer in a symmetric node, and
   * the starting answer in staging. Only asymmetric nodes make this visible, and
   * there it decides how many slots you get.
   */
  side?: Side;
  /**
   * Infantry only: hit 0 HP in a battle and survived. Fights at −1 and dies to
   * the next hit. This is the one thing a battle leaves on a unit — everything
   * else heals, because "any units that took damage but were not destroyed or
   * wounded […] are considered reinforced automatically".
   *
   * Cleared only by reorganizing in the staging area.
   */
  wounded?: boolean;
  /**
   * The enemy has seen what this is — by fighting it, or (Phase 6) by reconning
   * it. Cleared by reorganizing in a controlled node, which is the manual's only
   * way back into the fog. Nothing filters on this yet; Phase 6 is what makes it
   * bite, and until then it is honest bookkeeping the UI can already show.
   */
  revealed?: boolean;
}

/**
 * A battle has been lost and the loser owes the board a destination. Play stops
 * until they name one: this is the only time the acting seat is not `turn`,
 * because the battle happened on the winner's turn but the falling back is the
 * loser's decision to make.
 *
 * Raised only when the choice is real. One legal node resolves itself, and none
 * at all is encirclement — the units are destroyed on the spot rather than
 * parked in a prompt with no answer.
 */
export interface PendingRetreat {
  player: Player;
  from: NodeId;
  /** Adjacent nodes free of the winner: "a friendly or neutral adjacent node". */
  options: NodeId[];
}

/** Nodes to hold, and turns to hold them, to win. */
export const HOLD_TO_WIN = 2;

export type StratLogKind = 'info' | 'move' | 'turn' | 'org' | 'battle';

export interface StratLogEntry {
  id: number;
  kind: StratLogKind;
  text: string;
}

export interface StrategicState {
  turn: Player;
  /** Strategic actions the current player has left this turn. */
  actionsLeft: number;
  /** Increments when both players have taken their turn. */
  round: number;
  /**
   * Who won this round's initiative and therefore moved first. Turn order is not
   * a strict alternation — each round re-rolls — so "have both players gone yet?"
   * cannot be answered by looking at `turn` alone.
   */
  firstPlayer: Player;
  units: Record<string, MapUnit>;
  armies: Record<string, Army>;
  /**
   * Fortifications waiting for a battle, keyed by `fortKey`. They belong to a
   * node *and* a player, never to an army: "they cannot be moved along the armies
   * and they will be removed from the location if all armies are moved away".
   */
  forts: Record<string, number>;
  /**
   * Nodes where a player has just won a battle and may re-sort the survivors into
   * armies once, for free and without the usual control requirement — because on
   * the physical board the winner has to move chips between two boards and cannot
   * be expected to remember which army each was in. Keyed node → the winner, who
   * spends it on their own turn (so a defender's win waits for their next turn
   * rather than interrupting the attacker's).
   */
  freeReorgs: Record<string, Player>;
  /** Consecutive own-turns each player has held the enemy's doorstep. */
  hold: Record<Player, number>;
  winner: Player | null;
  /** Set only between a lost battle and the loser naming a destination. */
  pendingRetreat: PendingRetreat | null;
  log: StratLogEntry[];
  seq: number;
  /** Supplies army ids and `Army.movedAt` stamps. */
  tick: number;
}

export type Transition = StateTransition<StrategicState>;

const clone = (s: StrategicState): StrategicState => structuredClone(s);

function log(s: StrategicState, kind: StratLogKind, text: string): void {
  s.log.push({ id: s.seq++, kind, text });
}

/**
 * "Each turn starts with a dice roll for initiative to decide which player starts
 * the sequence. Roll until one player has a greater value."
 *
 * Consequence worth stating out loud, because it looks like a bug the first time
 * you meet it: turn order is *not* an alternation. Lose initiative one round and
 * win it the next and you move twice in a row — which is a real weapon, and the
 * reason the roll exists.
 */
function rollInitiative(rng: Rng): Player {
  const { a, b } = rollUntilDifferent(rng);
  return a > b ? 'p1' : 'p2';
}

/** Every player starts with their full roster loose in their staging area. */
export function createStrategic(rng: Rng = defaultRng): StrategicState {
  const units: Record<string, MapUnit> = {};
  for (const owner of PLAYERS) {
    for (const [type, count] of Object.entries(STARTING_ARMY) as [UnitType, number][]) {
      for (let i = 1; i <= count; i++) {
        const id = `${owner}-${type}-${i}`;
        units[id] = { id, type, owner, nodeId: STAGING_NODE[owner] };
      }
    }
  }
  const first = rollInitiative(rng);
  const s: StrategicState = {
    turn: first,
    actionsLeft: ACTIONS_PER_TURN,
    round: 1,
    firstPlayer: first,
    units,
    armies: {},
    forts: {},
    freeReorgs: {},
    hold: { p1: 0, p2: 0 },
    winner: null,
    pendingRetreat: null,
    log: [],
    seq: 0,
    tick: 0,
  };
  log(s, 'info', 'Both sides muster in their staging areas — every unit starts disorganized.');
  log(s, 'turn', `Round 1 — ${playerLabel(first)} wins initiative and has ${ACTIONS_PER_TURN} actions.`);
  return s;
}

// ---------------------------------------------------------------- queries

export function unitsAt(s: StrategicState, nodeId: NodeId): MapUnit[] {
  return Object.values(s.units).filter((u) => u.nodeId === nodeId);
}

export function unitsAtFor(s: StrategicState, nodeId: NodeId, player: Player): MapUnit[] {
  return unitsAt(s, nodeId).filter((u) => u.owner === player);
}

/** Members of an army, in stable id order. */
export function armyUnits(s: StrategicState, armyId: string): MapUnit[] {
  return Object.values(s.units)
    .filter((u) => u.armyId === armyId)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Where an army stands, read off any member. Null if it has none (i.e. is gone). */
export function armyNode(s: StrategicState, armyId: string): NodeId | null {
  return armyUnits(s, armyId)[0]?.nodeId ?? null;
}

export function armiesAt(s: StrategicState, nodeId: NodeId, player: Player): Army[] {
  return Object.values(s.armies)
    .filter((a) => a.owner === player && armyNode(s, a.id) === nodeId)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Recon is a third thing, not a loose unit — the rules take it out of nearly
 * every system this file implements:
 *
 * - "move independently from the armies and fighting units" → never in an army
 * - "present in a location with an army without using any supplies" → costs 0
 * - "move […] behind enemy lines without initiating battles" → not overrun, and
 *   not stopped by an enemy army
 *
 * Control follows from the same reading, though the manual does not say it
 * outright: a scout that revoked an enemy's rear-area supply merely by standing
 * next door would make two unreplenishable units into a permanent economic
 * weapon, which is plainly not what a recon unit is for. So recon is invisible to
 * supply and control alike.
 */
export const isRecon = (u: MapUnit): boolean => isMapOnly(u.type);

/** A player's recon units in a node. */
export function reconAt(s: StrategicState, nodeId: NodeId, player: Player): MapUnit[] {
  return unitsAtFor(s, nodeId, player).filter(isRecon);
}

/** A player's disorganized fighting units in a node. Recon is not one of these. */
export function looseAt(s: StrategicState, nodeId: NodeId, player: Player): MapUnit[] {
  return unitsAtFor(s, nodeId, player).filter((u) => !u.armyId && !isRecon(u));
}

export function armyCount(s: StrategicState, player: Player): number {
  return Object.values(s.armies).filter((a) => a.owner === player).length;
}

/** Presence that counts for control: any fighting unit, in an army or loose. */
export function occupies(s: StrategicState, nodeId: NodeId, player: Player): boolean {
  return unitsAtFor(s, nodeId, player).some((u) => !isRecon(u));
}

/**
 * Controlled needs a friendly *army* in the node, and no enemy in the node or in
 * any adjacent one; everything else is contested. Note the asymmetry in what
 * counts on each side of that rule — it is deliberate, not an oversight:
 *
 * - Your side must field an army, because loose units cannot hold ground.
 * - Their side needs only a body, because the privilege being granted is the
 *   doubled rear-area supply, and a node with any enemy near it is not rear.
 *
 * The node counts alongside its neighbours, which also makes control exclusive:
 * a location both sides stand in is the most contested kind there is, so it can
 * never read as controlled — by either of them.
 *
 * Staging is controlled unconditionally: "Staging area always allows
 * reorganizing units to armies and hiding their identity even if the nearby
 * nodes would be contested."
 */
export function controlFor(s: StrategicState, nodeId: NodeId, player: Player): Control {
  if (isStaging(nodeId)) return 'controlled';
  if (armiesAt(s, nodeId, player).length === 0) return 'contested';
  const enemy = otherPlayer(player);
  const here = [nodeId, ...(NODE_BY_ID[nodeId]?.adjacency ?? [])];
  return here.some((n) => occupies(s, n, enemy)) ? 'contested' : 'controlled';
}

/**
 * Which side of a node a player's forces stand on. All of a player's fighting
 * units in a node share one side — `arrivalSide` guarantees it by stamping every
 * arrival with the same answer — so any one of them can speak for the rest.
 * Falls back to the player's own side, which is always right for a symmetric
 * node and is where staging starts.
 */
export function sideOf(s: StrategicState, nodeId: NodeId, player: Player): Side {
  const holding = unitsAtFor(s, nodeId, player).find((u) => !isRecon(u));
  return holding?.side ?? player;
}

/**
 * The side a force takes on entering `nodeId` from `from`, in precedence order:
 *
 * 1. Join your own — friendlies already there settle it, whichever side they hold.
 * 2. Take the side opposite the enemy: "if an enemy unit moves into the
 *    asymmetric node from any connecting node regardless of the direction, they'll
 *    go to the opposing side."
 * 3. Otherwise the node is empty, so the direction of approach decides.
 *
 * Rule 1 outranking rule 3 is what lets armies end up on the "wrong" sides: a
 * defender who spent an action swapping sides pulls every later arrival of theirs
 * across with them, and the attacker then enters opposite.
 */
export function arrivalSide(
  s: StrategicState,
  nodeId: NodeId,
  player: Player,
  from: NodeId,
): Side {
  const mine = unitsAtFor(s, nodeId, player).find((u) => !isRecon(u));
  if (mine) return mine.side ?? player;
  const theirs = unitsAtFor(s, nodeId, otherPlayer(player)).find((u) => !isRecon(u));
  // Sides are named for players, so "the other side" is the same flip.
  if (theirs) return otherPlayer(theirs.side ?? otherPlayer(player));
  return entrySide(nodeId, from) ?? player;
}

/** How many of a player's units this node keeps organized. Staging is uncapped. */
export function supplyCap(s: StrategicState, nodeId: NodeId, player: Player): number {
  if (isStaging(nodeId)) return Infinity;
  if (isSea(nodeId)) return SEA_SUPPLY;
  // Slots come from the side they hold, which in an asymmetric node is not
  // necessarily the side wearing their colour.
  return slotsFor(nodeId, sideOf(s, nodeId, player)) * SUPPLY_PER_SLOT[controlFor(s, nodeId, player)];
}

/**
 * Supply a player is drawing from a node. "Any number of disorganized units in a
 * node will use 1 supply" — so loose units cost a flat 1 between them, however
 * many there are.
 */
export function supplyUsed(s: StrategicState, nodeId: NodeId, player: Player): number {
  const organized = unitsAtFor(s, nodeId, player).filter((u) => u.armyId).length;
  return organized + (looseAt(s, nodeId, player).length > 0 ? 1 : 0);
}

/** Reorganizing needs a controlled node, and never happens at sea. */
export function canReorganize(s: StrategicState, nodeId: NodeId, player: Player): boolean {
  return !isSea(nodeId) && controlFor(s, nodeId, player) === 'controlled';
}

// ------------------------------------------------------------ fortifications

/** A fortification belongs to a node and a player — one store, two owners. */
export const fortKey = (nodeId: NodeId, player: Player): string => `${nodeId}:${player}`;

/** Fortifications a player has waiting in a node for the next battle there. */
export function fortsAt(s: StrategicState, nodeId: NodeId, player: Player): number {
  return s.forts[fortKey(nodeId, player)] ?? 0;
}

/**
 * You can only fortify ground you hold an army on. Staging is excluded: you
 * cannot be attacked there, so a fort would never be deployed.
 */
export function canFortify(s: StrategicState, nodeId: NodeId, player: Player): boolean {
  return !isStaging(nodeId) && armiesAt(s, nodeId, player).length > 0;
}

/**
 * Drop a fort's claim on a node once its owner has no army left there:
 * "removed from the location if all armies are moved away". Called after any move
 * that could empty a node.
 */
function pruneForts(s: StrategicState, nodeId: NodeId): void {
  for (const player of PLAYERS) {
    if (armiesAt(s, nodeId, player).length === 0) delete s.forts[fortKey(nodeId, player)];
  }
}

/**
 * Why an action cannot be taken at all, regardless of what it is: the game is
 * decided, or the board is waiting on a loser to retreat. Both freeze play for
 * everyone, so every action asks this first.
 */
function frozen(s: StrategicState): string | null {
  if (s.winner) return 'The game is over.';
  if (s.pendingRetreat) return `${playerLabel(s.pendingRetreat.player)} must retreat first.`;
  return null;
}

// ---------------------------------------------------------------- movement

/** Nodes an army may move to now: path-adjacent, on its owner's turn, with an action in hand. */
export function legalArmyTargets(s: StrategicState, armyId: string): NodeId[] {
  const a = s.armies[armyId];
  const from = a ? armyNode(s, a.id) : null;
  if (!a || !from || a.owner !== s.turn || s.actionsLeft <= 0) return [];
  return NODE_BY_ID[from]?.adjacency ?? [];
}

/**
 * Nodes loose units may move to: as armies, minus any node held by an enemy
 * army. "These units can freely move […] to neutral or friendly nodes" — loose
 * units do not walk into their own overrun.
 */
export function legalLooseTargets(s: StrategicState, unitId: string): NodeId[] {
  const u = s.units[unitId];
  if (!u || u.armyId || u.owner !== s.turn || s.actionsLeft <= 0) return [];
  const adj = NODE_BY_ID[u.nodeId]?.adjacency ?? [];
  // Walking onto an enemy army is the whole job of a recon unit and certain
  // death for anyone else.
  if (isRecon(u)) return adj;
  const enemy = otherPlayer(u.owner);
  return adj.filter((n) => armiesAt(s, n, enemy).length === 0);
}

/**
 * Loose units caught in the open by an arriving army are removed. Two shelters
 * exist: a friendly army in the node (the fight happens instead — Phase 7 turns
 * that into a real battle), and sea nodes, where no battle can commence at all
 * and armies simply pass each other by.
 */
function overrun(s: StrategicState, nodeId: NodeId, by: Player): void {
  if (isSea(nodeId)) return;
  const victim = otherPlayer(by);
  if (armiesAt(s, nodeId, victim).length > 0) return;
  // `looseAt` excludes recon, which is what lets a scout sit behind enemy lines
  // and survive an army walking over it.
  const caught = looseAt(s, nodeId, victim);
  if (caught.length === 0) return;
  for (const u of caught) delete s.units[u.id];
  const what = caught.map((u) => u.type).join(', ');
  log(s, 'org', `${playerLabel(victim)} loses ${caught.length} overrun at ${nodeId} (${what}).`);
}

export function moveArmy(
  state: StrategicState,
  armyId: string,
  nodeId: NodeId,
  rng: Rng = defaultRng,
): Transition {
  const stop = frozen(state);
  if (stop) return { state, error: stop };
  const a = state.armies[armyId];
  if (!a) return { state, error: 'Unknown army.' };
  if (!NODE_BY_ID[nodeId]) return { state, error: 'Unknown location.' };
  if (a.owner !== state.turn) return { state, error: `It is ${playerLabel(state.turn)}'s turn.` };
  if (state.actionsLeft <= 0) return { state, error: 'No actions left this turn.' };
  const from = armyNode(state, armyId);
  if (!from) return { state, error: 'That army has no units.' };
  if (nodeId === from) return { state, error: 'Already there.' };
  if (!arePathLinked(from, nodeId)) return { state, error: 'No movement path to that location.' };

  const s = clone(state);
  // Read the side before the movers land, or they would find themselves already
  // there and answer their own question.
  const side = arrivalSide(s, nodeId, a.owner, from);
  const moved = armyUnits(s, armyId);
  for (const u of moved) {
    u.nodeId = nodeId;
    u.side = side;
  }
  s.armies[armyId].movedAt = ++s.tick;
  s.actionsLeft--;
  log(s, 'move', `${playerLabel(a.owner)} army of ${moved.length} moves ${from} → ${nodeId}.`);
  overrun(s, nodeId, a.owner);
  // Forts stay behind, so a node the army just vacated may have lost its last
  // defender and with it the right to keep them.
  pruneForts(s, from);
  // A free post-battle reshuffle needs two armies to be worth anything; once the
  // player has taken one away, drop the offer.
  if (s.freeReorgs[from] === a.owner && armiesAt(s, from, a.owner).length < 2) {
    delete s.freeReorgs[from];
  }
  if (s.actionsLeft === 0) passTurn(s, rng);
  return { state: s };
}

/** Move one loose unit, or two from the same node, for a single action. */
export function moveLoose(
  state: StrategicState,
  unitIds: string[],
  nodeId: NodeId,
  rng: Rng = defaultRng,
): Transition {
  const stop = frozen(state);
  if (stop) return { state, error: stop };
  const ids = [...new Set(unitIds)];
  if (ids.length === 0) return { state, error: 'No units chosen.' };
  if (ids.length > MAX_LOOSE_MOVE) {
    return { state, error: `Only ${MAX_LOOSE_MOVE} disorganized units may move together.` };
  }
  const us = ids.map((id) => state.units[id]);
  if (us.some((u) => !u)) return { state, error: 'Unknown unit.' };
  if (us.some((u) => u.armyId)) return { state, error: 'Those units are in an army.' };
  if (us.some((u) => u.owner !== state.turn)) {
    return { state, error: `It is ${playerLabel(state.turn)}'s turn.` };
  }
  if (!NODE_BY_ID[nodeId]) return { state, error: 'Unknown location.' };
  if (state.actionsLeft <= 0) return { state, error: 'No actions left this turn.' };
  const from = us[0].nodeId;
  if (us.some((u) => u.nodeId !== from)) return { state, error: 'Those units are not together.' };
  if (nodeId === from) return { state, error: 'Already there.' };
  if (!arePathLinked(from, nodeId)) return { state, error: 'No movement path to that location.' };
  // "move independently from the armies and fighting units": a recon unit goes
  // alone, so it cannot smuggle a rifleman through the lines alongside it.
  const recon = us.filter(isRecon);
  if (recon.length > 0 && ids.length > 1) {
    return { state, error: 'A recon unit moves on its own.' };
  }
  if (recon.length === 0 && armiesAt(state, nodeId, otherPlayer(state.turn)).length > 0) {
    return { state, error: 'Disorganized units cannot move onto an enemy army.' };
  }

  const s = clone(state);
  const side = arrivalSide(s, nodeId, us[0].owner, from);
  for (const id of ids) {
    s.units[id].nodeId = nodeId;
    // Recon holds no ground, so it takes no side with it.
    if (!isRecon(s.units[id])) s.units[id].side = side;
  }
  s.actionsLeft--;
  const what = ids.length === 1 ? us[0].type : `${ids.length} disorganized units`;
  log(s, 'move', `${playerLabel(us[0].owner)} ${what} moves ${from} → ${nodeId}.`);
  if (s.actionsLeft === 0) passTurn(s, rng);
  return { state: s };
}

/**
 * Cross to the other side of an asymmetric node, for one action.
 *
 * "A player may use their movement turn to move within the empty node to occupy
 * the other side of it instead." This is what makes entering from the poor side
 * survivable: land on the single slot, then shift onto the wide side next turn if
 * nobody has taken it. It also sets up the manual's "wrong side" case — a
 * defender who crosses early makes the attacker enter opposite them, which is not
 * where either side's colour is painted.
 */
export function swapSide(
  state: StrategicState,
  nodeId: NodeId,
  rng: Rng = defaultRng,
): Transition {
  const stop = frozen(state);
  if (stop) return { state, error: stop };
  const player = state.turn;
  if (!NODE_BY_ID[nodeId]) return { state, error: 'Unknown location.' };
  if (!isAsymmetric(nodeId)) {
    return { state, error: 'Only asymmetric locations have two different sides.' };
  }
  if (state.actionsLeft <= 0) return { state, error: 'No actions left this turn.' };
  const mine = unitsAtFor(state, nodeId, player).filter((u) => !isRecon(u));
  if (mine.length === 0) return { state, error: 'You hold nothing there to move.' };
  // "the *empty* node": the far side must be free, and only an enemy can make it
  // otherwise — your own units are the ones doing the crossing.
  if (occupies(state, nodeId, otherPlayer(player))) {
    return { state, error: 'The enemy is in that location — there is no free side to cross to.' };
  }

  const s = clone(state);
  const to = otherPlayer(sideOf(state, nodeId, player));
  for (const u of unitsAtFor(s, nodeId, player)) {
    if (!isRecon(u)) u.side = to;
  }
  s.actionsLeft--;
  log(s, 'move', `${playerLabel(player)} crosses to the other side of ${nodeId}.`);
  if (s.actionsLeft === 0) passTurn(s, rng);
  return { state: s };
}

/**
 * Build a defensive fortification, for one action. "Players can spend their
 * strategic actions to construct defensive fortifications in locations they hold
 * armies in." One per action; it waits in the node until a battle deploys it.
 */
export function buildFort(
  state: StrategicState,
  nodeId: NodeId,
  rng: Rng = defaultRng,
): Transition {
  const stop = frozen(state);
  if (stop) return { state, error: stop };
  const player = state.turn;
  if (!NODE_BY_ID[nodeId]) return { state, error: 'Unknown location.' };
  if (state.actionsLeft <= 0) return { state, error: 'No actions left this turn.' };
  if (!canFortify(state, nodeId, player)) {
    return { state, error: 'You can only fortify a location you hold an army in.' };
  }

  const s = clone(state);
  s.forts[fortKey(nodeId, player)] = fortsAt(s, nodeId, player) + 1;
  s.actionsLeft--;
  log(
    s,
    'org',
    `${playerLabel(player)} fortifies ${nodeId} (${s.forts[fortKey(nodeId, player)]} ready).`,
  );
  if (s.actionsLeft === 0) passTurn(s, rng);
  return { state: s };
}

/** "Units can be split off armies into disorganized state without spending strategic actions." */
export function splitUnits(state: StrategicState, unitIds: string[]): Transition {
  const ids = [...new Set(unitIds)];
  if (ids.length === 0) return { state, error: 'No units chosen.' };
  const us = ids.map((id) => state.units[id]);
  if (us.some((u) => !u)) return { state, error: 'Unknown unit.' };
  if (us.some((u) => u.owner !== state.turn)) {
    return { state, error: `It is ${playerLabel(state.turn)}'s turn.` };
  }
  if (us.some((u) => !u.armyId)) return { state, error: 'Those units are already disorganized.' };

  const s = clone(state);
  for (const id of ids) delete s.units[id].armyId;
  dissolveEmpty(s);
  log(s, 'org', `${playerLabel(us[0].owner)} splits ${ids.length} unit(s) off into the open.`);
  return { state: s };
}

// ---------------------------------------------------------- reorganization

/** unitId → army to join, `NEW_ARMY` for a fresh one, or null to go loose. */
export type Reassignment = Record<string, string | null>;

/**
 * The reorganization action. Every unit named must already be in the node, and
 * the node must be controlled (or be staging). Units in the node that go
 * unmentioned keep whatever they are.
 *
 * Phase 6 hooks re-hiding in here: "All units in the node where reorganization
 * is done will be hidden […] regardless of whether they actually move between
 * armies", which is why a no-op reassignment is legal and still costs an action.
 */
export function reorganize(
  state: StrategicState,
  nodeId: NodeId,
  assign: Reassignment,
  rng: Rng = defaultRng,
): Transition {
  const stop = frozen(state);
  if (stop) return { state, error: stop };
  const player = state.turn;
  if (!NODE_BY_ID[nodeId]) return { state, error: 'Unknown location.' };
  if (state.actionsLeft <= 0) return { state, error: 'No actions left this turn.' };
  if (!canReorganize(state, nodeId, player)) {
    return {
      state,
      error: isSea(nodeId)
        ? 'Armies cannot reorganize at sea.'
        : 'Reorganizing needs a controlled location — an army of yours, and no enemy next door.',
    };
  }

  const ids = Object.keys(assign);
  for (const id of ids) {
    const u = state.units[id];
    if (!u) return { state, error: 'Unknown unit.' };
    if (u.owner !== player) return { state, error: 'Those are not your units.' };
    if (u.nodeId !== nodeId) return { state, error: 'Those units are not in this location.' };
    // The board does not offer recon, but the rule belongs here: a client is not
    // where "recon never joins an army" gets to be true.
    if (isRecon(u)) return { state, error: 'Recon units are never part of an army.' };
  }

  // Targets must be armies already standing here — reorganizing cannot teleport
  // a unit into an army elsewhere on the map.
  const here = new Set(armiesAt(state, nodeId, player).map((a) => a.id));
  for (const target of Object.values(assign)) {
    if (target === null || target === NEW_ARMY) continue;
    if (!here.has(target)) return { state, error: 'That army is not in this location.' };
  }

  // "Only one new army can be created during a single reorganization action" —
  // one action buys one act of creation, so all of `forming` joins that one army.
  const forming = ids.filter((id) => assign[id] === NEW_ARMY);
  if (forming.length > 0 && armyCount(state, player) >= MAX_ARMIES) {
    return { state, error: `You already field ${MAX_ARMIES} armies.` };
  }

  const s = clone(state);
  let created: string | null = null;
  if (forming.length > 0) {
    created = `army-${player}-${++s.tick}`;
    s.armies[created] = { id: created, owner: player, movedAt: s.tick };
  }
  for (const id of ids) {
    const target = assign[id];
    if (target === null) delete s.units[id].armyId;
    else s.units[id].armyId = target === NEW_ARMY ? created! : target;
  }
  dissolveEmpty(s);
  settleReorg(s, nodeId, player, true);

  s.actionsLeft--;
  const n = armiesAt(s, nodeId, player).length;
  log(
    s,
    'org',
    `${playerLabel(player)} reorganizes at ${nodeId} — ${n} arm${n === 1 ? 'y' : 'ies'} here now.`,
  );
  if (s.actionsLeft === 0) passTurn(s, rng);
  return { state: s };
}

/**
 * The bookkeeping every reorganization ends with: heal the wounded that made it
 * home to staging, and settle who is face-up.
 *
 * "All units in the node … will be hidden … regardless of whether they actually
 * move between armies" — re-hiding is the whole point of a no-op reorganize, and
 * (with Phase 6) the only way back into the fog. But a reorganization only hides
 * when the location earns it: a free post-battle reshuffle in a still-contested
 * node leaves everyone revealed, which is why `hide` is passed rather than
 * assumed. A wounded unit stays face-up anywhere but staging, where it heals.
 */
function settleReorg(s: StrategicState, nodeId: NodeId, player: Player, hide: boolean): void {
  const inStaging = isStaging(nodeId);
  for (const u of unitsAtFor(s, nodeId, player)) {
    if (isRecon(u)) continue;
    if (u.wounded && inStaging) {
      delete u.wounded;
      delete u.revealed;
      log(s, 'org', `${playerLabel(player)} ${u.type} is reinforced to full strength.`);
    } else if (u.wounded) {
      u.revealed = true; // stays face-up outside staging
    } else if (hide) {
      delete u.revealed;
    }
  }
}

/** May `player` re-sort survivors at this node for free (they just won here)? */
export function canFreeReorg(s: StrategicState, nodeId: NodeId, player: Player): boolean {
  return s.freeReorgs[nodeId] === player;
}

/**
 * The winner's free post-battle reshuffle. Like `reorganize`, but it costs no
 * action, needs no control, and touches only units still in an army — the
 * withdrawn are disorganized and stay that way until a paid reorganization in a
 * controlled node. It re-hides only if the node happens to be controlled;
 * otherwise the survivors stay revealed, exactly as the manual says.
 */
export function freeReorganize(
  state: StrategicState,
  nodeId: NodeId,
  assign: Reassignment,
): Transition {
  const stop = frozen(state);
  if (stop) return { state, error: stop };
  const player = state.turn;
  if (!NODE_BY_ID[nodeId]) return { state, error: 'Unknown location.' };
  if (!canFreeReorg(state, nodeId, player)) {
    return { state, error: 'No free reorganization is owed here.' };
  }

  const ids = Object.keys(assign);
  for (const id of ids) {
    const u = state.units[id];
    if (!u) return { state, error: 'Unknown unit.' };
    if (u.owner !== player) return { state, error: 'Those are not your units.' };
    if (u.nodeId !== nodeId) return { state, error: 'Those units are not in this location.' };
    if (isRecon(u)) return { state, error: 'Recon units are never part of an army.' };
    // The free reshuffle is only over units that came back organized. A withdrawn
    // unit is disorganized now and needs a full reorganization to re-form.
    if (!u.armyId) {
      return { state, error: 'Withdrawn units need a full reorganization to re-form.' };
    }
  }

  const here = new Set(armiesAt(state, nodeId, player).map((a) => a.id));
  for (const target of Object.values(assign)) {
    if (target === null || target === NEW_ARMY) continue;
    if (!here.has(target)) return { state, error: 'That army is not in this location.' };
  }
  const forming = ids.filter((id) => assign[id] === NEW_ARMY);
  if (forming.length > 0 && armyCount(state, player) >= MAX_ARMIES) {
    return { state, error: `You already field ${MAX_ARMIES} armies.` };
  }

  const s = clone(state);
  let created: string | null = null;
  if (forming.length > 0) {
    created = `army-${player}-${++s.tick}`;
    s.armies[created] = { id: created, owner: player, movedAt: s.tick };
  }
  for (const id of ids) {
    const target = assign[id];
    if (target === null) delete s.units[id].armyId;
    else s.units[id].armyId = target === NEW_ARMY ? created! : target;
  }
  dissolveEmpty(s);
  settleReorg(s, nodeId, player, isStaging(nodeId) || controlFor(s, nodeId, player) === 'controlled');
  delete s.freeReorgs[nodeId];
  log(s, 'org', `${playerLabel(player)} re-sorts the victors at ${nodeId} — free after the battle.`);
  return { state: s };
}

/** Decline the free reshuffle, leaving the survivors in the armies they held. */
export function dismissFreeReorg(state: StrategicState, nodeId: NodeId): Transition {
  if (!canFreeReorg(state, nodeId, state.turn)) {
    return { state, error: 'No free reorganization is owed here.' };
  }
  const s = clone(state);
  delete s.freeReorgs[nodeId];
  return { state: s };
}

/** An army is its members; one with none has ceased to exist. */
function dissolveEmpty(s: StrategicState): void {
  for (const a of Object.values(s.armies)) {
    if (armyUnits(s, a.id).length === 0) delete s.armies[a.id];
  }
}

// ------------------------------------------------------------ supply check

/**
 * The supply-limit phase, run for the player whose turn is ending. Nodes may
 * "momentarily exceed the maximum supply capacity" mid-turn; this is the moment
 * that stops being free.
 *
 * Only the ending player's units are checked, which is exactly what gives the
 * grace turn the rules promise when *your opponent's* move flips one of your
 * nodes from controlled to contested: the cap dropped on their turn, but nothing
 * is measured until yours ends.
 */
function enforceSupply(s: StrategicState, player: Player): void {
  for (const n of MAP.nodes) {
    if (isStaging(n.id)) continue;
    // Each pass turns one organized unit loose, so the loop is bounded by the
    // node's population: with everything loose, use is 1 and every cap is ≥ 2.
    while (supplyUsed(s, n.id, player) > supplyCap(s, n.id, player)) {
      // "the excess units from the most recently moved army will enter the
      // disorganized state" — newest arrival sheds first.
      const newest = armiesAt(s, n.id, player).sort((a, b) => b.movedAt - a.movedAt)[0];
      if (!newest) break;
      const members = armyUnits(s, newest.id);
      const shed = members[members.length - 1];
      delete s.units[shed.id].armyId;
      log(
        s,
        'org',
        `${playerLabel(player)} ${shed.type} at ${n.id} is out of supply and disorganizes.`,
      );
      dissolveEmpty(s);
    }
  }
}

/**
 * Nodes adjacent to a player's staging area — the ground their opponent must
 * hold to win. Staging areas connect only to the real map through these, so
 * "occupies all locations adjacent to the enemy staging area" is exactly this
 * set.
 */
export function doorstep(player: Player): NodeId[] {
  return NODE_BY_ID[STAGING_NODE[player]]?.adjacency ?? [];
}

/**
 * The victory check, run at the end of each player's own turn. "Occupies all
 * locations adjacent to the enemy staging area for 2 turns. If any of the
 * locations are relieved by the opponent, the counter is reset."
 *
 * Measured only for the player who just moved, and only on their own turns: the
 * count is consecutive *own* turns, so it advances once per round for whoever is
 * besieging, and snaps back to zero the instant they no longer hold the whole
 * ring.
 */
function checkVictory(s: StrategicState, player: Player): void {
  const ring = doorstep(otherPlayer(player));
  const holdsAll = ring.length > 0 && ring.every((n) => occupies(s, n, player));
  if (!holdsAll) {
    if (s.hold[player] > 0) {
      log(s, 'turn', `${playerLabel(player)} no longer holds the enemy doorstep — the count resets.`);
    }
    s.hold[player] = 0;
    return;
  }
  s.hold[player] += 1;
  if (s.hold[player] >= HOLD_TO_WIN) {
    s.winner = player;
    log(s, 'turn', `${playerLabel(player)} has held the enemy doorstep — victory.`);
    return;
  }
  log(
    s,
    'turn',
    `${playerLabel(player)} holds the enemy doorstep (${s.hold[player]}/${HOLD_TO_WIN}).`,
  );
}

function passTurn(s: StrategicState, rng: Rng): void {
  enforceSupply(s, s.turn);
  checkVictory(s, s.turn);
  if (s.winner) return;
  // A round is over once the player who moved second is done — i.e. when the one
  // just finishing is not the round's first mover. Then initiative is re-rolled.
  if (s.turn === s.firstPlayer) {
    // First mover done; hand off to the other for the back half of the round.
    s.turn = otherPlayer(s.turn);
  } else {
    s.round++;
    s.firstPlayer = rollInitiative(rng);
    s.turn = s.firstPlayer;
  }
  s.actionsLeft = ACTIONS_PER_TURN;
  const how = s.turn === s.firstPlayer && s.actionsLeft === ACTIONS_PER_TURN && s.round > 1
    ? 'wins initiative and '
    : '';
  log(s, 'turn', `Round ${s.round} — ${playerLabel(s.turn)} ${how}has ${s.actionsLeft} actions.`);
}

/** End the current player's turn without spending the remaining actions. */
export function endTurn(state: StrategicState, rng: Rng = defaultRng): Transition {
  if (state.winner) return { state, error: 'The game is over.' };
  if (state.pendingRetreat) return { state, error: 'A retreat is pending.' };
  const s = clone(state);
  passTurn(s, rng);
  return { state: s };
}

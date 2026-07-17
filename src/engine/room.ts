// The room: one game session's authoritative state, plus the *seat authority*
// layer over the Phase 1–3 engines.
//
// The Phase 1–3 engines already answer "is this a legal move?" — they check that
// a unit belongs to the player whose turn it is. What they cannot answer is "is
// the person asking actually that player?", because hotseat had no such concept.
// That question is this module's whole job, and it is the one rule networking
// adds. Keeping it pure (rather than writing it inside the Durable Object) means
// every authority rule is unit-testable without a Workers runtime, and the DO
// stays a thin socket shell.
//
// Deliberately not modelled yet: fog filtering (Phase 6 fills in `viewFor`) and
// the strategic↔battle handoff (Phase 7). The room holds a battle and a
// strategic state side by side, exactly as the two hotseat stores did.

import type { Player, StateTransition } from './types';
import { playerLabel } from './types';
import type { Scenario } from './scenario';
import { defaultScenario } from './scenario';
import type { BattleState } from './battle';
import {
  attack,
  createBattle,
  currentDeployer,
  deployFort,
  deployUnit,
  indirectFire,
  move,
  passDeploy,
  withdraw,
  type Transition as BattleTransition,
} from './battle';
import type { StrategicState, Transition as StratTransition } from './strategic';
import {
  createStrategic,
  endTurn,
  moveArmy,
  moveLoose,
  reorganize,
  splitUnits,
  swapSide,
  type Reassignment,
} from './strategic';
import type { NodeId } from './map';
import { defaultRng, type Rng } from './dice';

export type View = 'battle' | 'map';

export interface RoomState {
  /** Doubles as the Durable Object name — one room per code. */
  code: string;
  view: View;
  scenario: Scenario;
  battle: BattleState | null;
  strategic: StrategicState;
  /** Bumped on every accepted intent, so clients can drop out-of-order frames. */
  version: number;
}

/** What a player is allowed to see. Fog of war narrows this in Phase 6. */
export type RoomView = RoomState;

export type RoomTransition = StateTransition<RoomState>;

// --- Intents -----------------------------------------------------------------
// One per player-initiated change. Deliberately mirrors the store actions that
// already existed, so the UI's vocabulary did not have to change to go online.

/** Table-level intents: setting up the game rather than playing it. */
type TableIntent =
  | { t: 'setView'; view: View }
  | { t: 'setScenario'; scenario: Scenario }
  | { t: 'startBattle' }
  | { t: 'newScenario' }
  | { t: 'stratReset' };

/** Acting inside a battle — only the current mover may send these. */
type BattleIntent =
  | { t: 'deploy'; unitId: string; cellId: string }
  | { t: 'deployFort'; cellId: string }
  | { t: 'passDeploy' }
  | { t: 'attack'; unitId: string; targetId: string }
  | { t: 'indirectFire'; unitId: string; targetId: string }
  | { t: 'move'; unitId: string; cellId: string }
  | { t: 'withdraw'; unitId: string };

/** Acting on the strategic map — only the player whose turn it is. */
type StratIntent =
  | { t: 'stratMoveArmy'; armyId: string; nodeId: NodeId }
  | { t: 'stratMoveLoose'; unitIds: string[]; nodeId: NodeId }
  | { t: 'stratSplit'; unitIds: string[] }
  | { t: 'stratSwapSide'; nodeId: NodeId }
  | { t: 'stratReorganize'; nodeId: NodeId; assign: Reassignment }
  | { t: 'stratEndTurn' };

export type Intent = TableIntent | BattleIntent | StratIntent;

// Runtime membership, not just types: intents arrive over a socket, so an
// unrecognised one has to be rejected rather than fall off the end of a switch
// the compiler believed was exhaustive.
const TABLE_INTENTS: ReadonlySet<string> = new Set<TableIntent['t']>([
  'setView',
  'setScenario',
  'startBattle',
  'newScenario',
  'stratReset',
]);

const BATTLE_INTENTS: ReadonlySet<string> = new Set<BattleIntent['t']>([
  'deploy',
  'deployFort',
  'passDeploy',
  'attack',
  'indirectFire',
  'move',
  'withdraw',
]);

const STRAT_INTENTS: ReadonlySet<string> = new Set<StratIntent['t']>([
  'stratMoveArmy',
  'stratMoveLoose',
  'stratSplit',
  'stratSwapSide',
  'stratReorganize',
  'stratEndTurn',
]);

const isTableIntent = (i: Intent): i is TableIntent => TABLE_INTENTS.has(i.t);
const isBattleIntent = (i: Intent): i is BattleIntent => BATTLE_INTENTS.has(i.t);
const isStratIntent = (i: Intent): i is StratIntent => STRAT_INTENTS.has(i.t);

// --- Construction ------------------------------------------------------------

export function createRoom(code: string): RoomState {
  return {
    code,
    view: 'map',
    scenario: defaultScenario(),
    battle: null,
    strategic: createStrategic(),
    version: 0,
  };
}

/**
 * The player who may act in the battle right now. Deployment alternates by a
 * row/index cursor rather than `turn`, so it has its own answer.
 */
export function battleMover(b: BattleState): Player | null {
  if (b.phase === 'over') return null;
  return b.phase === 'deployment' ? currentDeployer(b) : b.turn;
}

// --- Applying intents --------------------------------------------------------

const commit = (prev: RoomState, next: Omit<RoomState, 'version'>): RoomTransition => ({
  state: { ...next, version: prev.version + 1 },
});

/** Lift an engine transition into a room transition, leaving the room untouched on rejection. */
function liftBattle(room: RoomState, t: BattleTransition): RoomTransition {
  if (t.error) return { state: room, error: t.error };
  return commit(room, { ...room, battle: t.state });
}

function liftStrat(room: RoomState, t: StratTransition): RoomTransition {
  if (t.error) return { state: room, error: t.error };
  return commit(room, { ...room, strategic: t.state });
}

function runBattleIntent(b: BattleState, i: BattleIntent, rng: Rng): BattleTransition {
  switch (i.t) {
    case 'deploy':
      return deployUnit(b, i.unitId, i.cellId);
    case 'deployFort':
      return deployFort(b, i.cellId);
    case 'passDeploy':
      return passDeploy(b);
    case 'attack':
      return attack(b, i.unitId, i.targetId, rng);
    case 'indirectFire':
      return indirectFire(b, i.unitId, i.targetId, rng);
    case 'move':
      return move(b, i.unitId, i.cellId);
    case 'withdraw':
      return withdraw(b, i.unitId);
  }
}

/**
 * Apply `intent` on behalf of the seat `actor`.
 *
 * `actor` is the seat the *sender* holds, which is the part a client cannot be
 * trusted to assert: the Durable Object passes the seat it assigned that socket,
 * while hotseat passes whoever's turn it is (one person legitimately holds both
 * seats). Everything downstream is the same code either way.
 *
 * The dice live behind `rng` for the same reason they always did — the DO passes
 * its own, so rolls happen server-side and a client cannot fudge them.
 */
export function applyIntent(
  room: RoomState,
  actor: Player,
  intent: Intent,
  rng: Rng = defaultRng,
): RoomTransition {
  // Table intents are open to both seats: setting up the board is a shared act,
  // and there is no turn order before a game starts.
  if (isTableIntent(intent)) {
    switch (intent.t) {
      case 'setView':
        return commit(room, { ...room, view: intent.view });
      case 'setScenario':
        if (room.battle) {
          return { state: room, error: 'Clear the current battle before editing the scenario.' };
        }
        return commit(room, { ...room, scenario: intent.scenario });
      case 'startBattle':
        return commit(room, { ...room, battle: createBattle(room.scenario), view: 'battle' });
      case 'newScenario':
        return commit(room, { ...room, battle: null, view: 'battle' });
      case 'stratReset':
        return commit(room, { ...room, strategic: createStrategic() });
    }
  }

  if (isBattleIntent(intent)) {
    const b = room.battle;
    if (!b) return { state: room, error: 'No battle in progress.' };
    const mover = battleMover(b);
    if (!mover) return { state: room, error: 'The battle is over.' };
    if (actor !== mover) return { state: room, error: `It is ${playerLabel(mover)}'s turn.` };
    return liftBattle(room, runBattleIntent(b, intent, rng));
  }

  if (isStratIntent(intent)) {
    if (actor !== room.strategic.turn) {
      return { state: room, error: `It is ${playerLabel(room.strategic.turn)}'s turn.` };
    }
    switch (intent.t) {
      case 'stratMoveArmy':
        return liftStrat(room, moveArmy(room.strategic, intent.armyId, intent.nodeId));
      case 'stratMoveLoose':
        return liftStrat(room, moveLoose(room.strategic, intent.unitIds, intent.nodeId));
      case 'stratSplit':
        return liftStrat(room, splitUnits(room.strategic, intent.unitIds));
      case 'stratSwapSide':
        return liftStrat(room, swapSide(room.strategic, intent.nodeId));
      case 'stratReorganize':
        return liftStrat(room, reorganize(room.strategic, intent.nodeId, intent.assign));
      case 'stratEndTurn':
        return liftStrat(room, endTurn(room.strategic));
    }
  }

  return { state: room, error: 'Unknown intent.' };
}

/**
 * Which seat is entitled to send `intent` right now.
 *
 * This is hotseat's answer to "who is asking?", where one person legitimately
 * holds both seats and the honest answer is "whoever's turn it is". Online it is
 * never consulted: the Durable Object uses the seat it gave the socket, which is
 * the entire point — a client cannot be trusted to answer this about itself.
 */
export function entitledSeat(room: RoomState, intent: Intent): Player {
  if (isBattleIntent(intent) && room.battle) {
    return battleMover(room.battle) ?? room.battle.turn;
  }
  // Strategic intents, and table intents (which either seat may send).
  return room.strategic.turn;
}

/**
 * The slice of the room a player may see, and the only place the server filters
 * before broadcasting. Phase 6 masks unrevealed enemy units here; until then a
 * room view is the whole room, which is also what hotseat wants.
 */
export function viewFor(_player: Player, room: RoomState): RoomView {
  return room;
}

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
import { otherPlayer, playerLabel } from './types';
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
  buildFort,
  createStrategic,
  dismissFreeReorg,
  endRecon,
  endTurn,
  freeReorganize,
  maskFor,
  moveArmy,
  moveLoose,
  reconAttempt,
  reorganize,
  splitUnits,
  swapSide,
  type Reassignment,
} from './strategic';
import { callSupportAt, createBattleAt, resolveBattle, resolveRetreat } from './campaign';
import type { NodeId } from './map';
import { defaultRng, type Rng } from './dice';

export type View = 'battle' | 'map';

/**
 * A restart under negotiation.
 *
 * Restarting throws away a game both players have spent an hour on, and the
 * button sits in the panel next to buttons pressed all the time — so it is not
 * one seat's to press. The request lives in the room rather than in either
 * client because the answer has to reach the other side, and because a proposal
 * must survive a refresh: a player who reloads mid-question would otherwise
 * leave their opponent waiting on an answer that can never come.
 *
 * `declined` is the third state, not a second flag: the opponent has said no,
 * and the board is now waiting on the *proposer* to either drop it and keep
 * playing or leave. Until they do, nobody can propose again, which is what stops
 * a refused restart from being asked over and over.
 */
export interface RestartRequest {
  by: Player;
  declined?: boolean;
}

export interface RoomState {
  /** Doubles as the Durable Object name — one room per code. */
  code: string;
  view: View;
  scenario: Scenario;
  battle: BattleState | null;
  strategic: StrategicState;
  /** A restart one player has put to the other, if any. */
  restart: RestartRequest | null;
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
  | { t: 'stratReset' }
  // The three steps of a negotiated restart. Turn order does not apply to any of
  // them — a game you want to abandon is not one you should have to wait a turn
  // to ask about — but each has its own answer to "which seat may send this",
  // enforced below rather than by the mover check.
  | { t: 'proposeRestart' }
  | { t: 'answerRestart'; agree: boolean }
  | { t: 'dismissRestart' }
  // Posting a finished map battle back onto the strategic board. Open to both
  // seats: the result is fully determined by the battle, so either player may
  // press "return to the map" once it is over.
  | { t: 'resolveBattle' };

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
  | { t: 'stratFreeReorganize'; nodeId: NodeId; assign: Reassignment }
  | { t: 'stratDismissFreeReorg'; nodeId: NodeId }
  | { t: 'stratBuildFort'; nodeId: NodeId }
  | { t: 'stratInitiateBattle'; nodeId: NodeId; armyIds?: string[] }
  | { t: 'stratRecon'; reconId: string; targetArmyId: string }
  | { t: 'stratEndRecon' }
  | { t: 'stratEndTurn' };

/**
 * The one intent that is *not* sent by the player whose turn it is: after a lost
 * battle the beaten side chooses where to fall back, even though the winner's
 * turn is still running. Kept out of `StratIntent` for exactly that reason — its
 * authority answer is `pendingRetreat.player`, not `turn`.
 */
type RetreatIntent = { t: 'stratRetreat'; nodeId: NodeId };

/**
 * The other intent that ignores turn order. Both players answer the indirect-fire
 * offer during deployment, whoever is deploying at the time — see `callSupport`
 * for why waiting for your turn would leak the answer. It also needs the map,
 * which no `BattleIntent` does, so it travels on its own.
 */
type SupportIntent = { t: 'callSupport'; gunId: string | null };

export type Intent =
  | TableIntent
  | BattleIntent
  | StratIntent
  | RetreatIntent
  | SupportIntent;

// Runtime membership, not just types: intents arrive over a socket, so an
// unrecognised one has to be rejected rather than fall off the end of a switch
// the compiler believed was exhaustive.
const TABLE_INTENTS: ReadonlySet<string> = new Set<TableIntent['t']>([
  'setView',
  'setScenario',
  'startBattle',
  'newScenario',
  'stratReset',
  'proposeRestart',
  'answerRestart',
  'dismissRestart',
  'resolveBattle',
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
  'stratFreeReorganize',
  'stratDismissFreeReorg',
  'stratBuildFort',
  'stratInitiateBattle',
  'stratRecon',
  'stratEndRecon',
  'stratEndTurn',
]);

const isTableIntent = (i: Intent): i is TableIntent => TABLE_INTENTS.has(i.t);
const isBattleIntent = (i: Intent): i is BattleIntent => BATTLE_INTENTS.has(i.t);
const isStratIntent = (i: Intent): i is StratIntent => STRAT_INTENTS.has(i.t);
const isRetreatIntent = (i: Intent): i is RetreatIntent => i.t === 'stratRetreat';

// --- Construction ------------------------------------------------------------

export function createRoom(code: string): RoomState {
  return {
    code,
    view: 'map',
    scenario: defaultScenario(),
    battle: null,
    strategic: createStrategic(),
    restart: null,
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
        return commit(room, { ...room, strategic: createStrategic(rng), restart: null });

      case 'proposeRestart':
        if (room.restart) {
          return {
            state: room,
            error:
              room.restart.by === actor
                ? 'You have already asked — waiting for an answer.'
                : `${playerLabel(room.restart.by)} has already put a restart to you.`,
          };
        }
        return commit(room, { ...room, restart: { by: actor } });

      case 'answerRestart': {
        const r = room.restart;
        if (!r) return { state: room, error: 'Nobody has suggested a restart.' };
        if (r.declined) return { state: room, error: 'That restart has already been answered.' };
        // Only the seat being *asked* may answer, and never the proposer — which
        // in hotseat is the same person a moment later, but the seat they answer
        // as is still the opponent's.
        if (actor !== otherPlayer(r.by)) {
          return { state: room, error: 'That restart is not yours to answer.' };
        }
        if (!intent.agree) {
          return commit(room, { ...room, restart: { by: r.by, declined: true } });
        }
        // Agreed: a clean board, same room, same seats. Only the code survives.
        return commit(room, { ...createRoom(room.code), strategic: createStrategic(rng) });
      }

      case 'dismissRestart': {
        const r = room.restart;
        if (!r) return { state: room, error: 'Nothing to dismiss.' };
        // The proposer's to drop, whether they are withdrawing the question or
        // accepting a "no" and playing on.
        if (actor !== r.by) return { state: room, error: 'That restart is not yours to withdraw.' };
        return commit(room, { ...room, restart: null });
      }
      case 'resolveBattle': {
        if (!room.battle) return { state: room, error: 'No battle to resolve.' };
        if (room.battle.phase !== 'over') {
          return { state: room, error: 'The battle is not finished.' };
        }
        const t = resolveBattle(room.strategic, room.battle);
        if (t.error) return { state: room, error: t.error };
        return commit(room, { ...room, strategic: t.state, battle: null, view: 'map' });
      }
    }
  }

  // Before the mover check, deliberately: either player may answer the offer at
  // any point in deployment, so this one is not the current mover's to send.
  if (intent.t === 'callSupport') {
    const b = room.battle;
    if (!b) return { state: room, error: 'No battle in progress.' };
    return liftBattle(room, callSupportAt(room.strategic, b, actor, intent.gunId));
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
    // A battle lifted off the map holds the strategic phase open until it is
    // posted back — you cannot move armies while one is being fought.
    if (room.battle?.node) {
      return { state: room, error: 'Finish the battle on the board first.' };
    }
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
      case 'stratFreeReorganize':
        return liftStrat(room, freeReorganize(room.strategic, intent.nodeId, intent.assign));
      case 'stratDismissFreeReorg':
        return liftStrat(room, dismissFreeReorg(room.strategic, intent.nodeId));
      case 'stratBuildFort':
        return liftStrat(room, buildFort(room.strategic, intent.nodeId));
      case 'stratInitiateBattle': {
        const { battle, error } = createBattleAt(
          room.strategic,
          intent.nodeId,
          actor,
          intent.armyIds,
        );
        if (error || !battle) return { state: room, error: error ?? 'Cannot start that battle.' };
        return commit(room, { ...room, battle, view: 'battle' });
      }
      case 'stratRecon':
        return liftStrat(
          room,
          reconAttempt(room.strategic, intent.reconId, intent.targetArmyId, rng),
        );
      case 'stratEndRecon':
        return liftStrat(room, endRecon(room.strategic));
      case 'stratEndTurn':
        return liftStrat(room, endTurn(room.strategic, rng));
    }
  }

  // The retreat interrupt: only the beaten side, and only while one is pending.
  if (isRetreatIntent(intent)) {
    const pr = room.strategic.pendingRetreat;
    if (!pr) return { state: room, error: 'No retreat is pending.' };
    if (actor !== pr.player) {
      return { state: room, error: `Waiting for ${playerLabel(pr.player)} to fall back.` };
    }
    return liftStrat(room, resolveRetreat(room.strategic, intent.nodeId));
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
  // `callSupport` is not a BattleIntent, but hotseat still has to name a seat for
  // it, and the only sensible answer with one person at the keyboard is whoever
  // is deploying. Online this is never reached — the socket's seat decides.
  if ((isBattleIntent(intent) || intent.t === 'callSupport') && room.battle) {
    return battleMover(room.battle) ?? room.battle.turn;
  }
  // The restart negotiation names its own seats. In hotseat one person walks
  // through both halves of it, but they must do so *as* the right seat or the
  // guards above refuse them — the proposer answers as nobody, the opponent
  // answers as the opponent.
  if (intent.t === 'answerRestart' && room.restart) return otherPlayer(room.restart.by);
  if (intent.t === 'dismissRestart' && room.restart) return room.restart.by;

  // A pending retreat is the loser's to resolve, not the current mover's.
  if (isRetreatIntent(intent) && room.strategic.pendingRetreat) {
    return room.strategic.pendingRetreat.player;
  }
  // Strategic intents, and table intents (which either seat may send).
  return room.strategic.turn;
}

/**
 * The slice of the room a player may see, and the only place the server filters
 * before broadcasting. Every socket send in the Durable Object goes through it,
 * so the fog is applied once, on the way out, and the room itself stays whole.
 *
 * Only the strategic map is fogged. The battle board is not: units that have
 * taken the field are face-up by definition, and the deployment order already
 * encodes who was seen beforehand.
 *
 * Local hotseat play does not pass through here — both players share a screen,
 * so there is nothing to hide from whom.
 */
export function viewFor(player: Player, room: RoomState): RoomView {
  return { ...room, strategic: maskFor(player, room.strategic) };
}

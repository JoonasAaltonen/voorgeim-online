// Strategic-map state and movement (Phase 3): individual units standing on map
// nodes, moving one path at a time. Pure — same shape as battle.ts, so the
// Durable Object can host it unchanged later.
//
// Deliberately not modelled yet (Phase 5 owns these): armies and the army frame,
// disorganized state, supply limits and slot capacity, controlled vs contested
// derivation, and blocking movement into enemy-held nodes. Movement here is
// validated against the path graph only.

import type { Player, StateTransition } from './types';
import { otherPlayer } from './types';
import type { UnitType } from './units';
import { STARTING_ARMY } from './units';
import type { NodeId } from './map';
import { NODE_BY_ID, STAGING_NODE, arePathLinked } from './map';

/** Strategic actions a player takes per turn, sequentially (VOORGEIM.md). */
export const ACTIONS_PER_TURN = 2;

export interface MapUnit {
  id: string;
  type: UnitType;
  owner: Player;
  /** The node it currently stands on. */
  nodeId: NodeId;
}

export type StratLogKind = 'info' | 'move' | 'turn';

export interface StratLogEntry {
  id: number;
  kind: StratLogKind;
  text: string;
}

export interface StrategicState {
  turn: Player;
  /** Strategic actions the current player has left this turn. */
  actionsLeft: number;
  /** Increments each time play returns to p1. */
  round: number;
  units: Record<string, MapUnit>;
  log: StratLogEntry[];
  seq: number;
}

export type Transition = StateTransition<StrategicState>;

const clone = (s: StrategicState): StrategicState => structuredClone(s);

function log(s: StrategicState, kind: StratLogKind, text: string): void {
  s.log.push({ id: s.seq++, kind, text });
}

/** Every player starts with their full roster parked in their staging area. */
export function createStrategic(): StrategicState {
  const units: Record<string, MapUnit> = {};
  for (const owner of ['p1', 'p2'] as Player[]) {
    for (const [type, count] of Object.entries(STARTING_ARMY) as [UnitType, number][]) {
      for (let i = 1; i <= count; i++) {
        const id = `${owner}-${type}-${i}`;
        units[id] = { id, type, owner, nodeId: STAGING_NODE[owner] };
      }
    }
  }
  const s: StrategicState = {
    turn: 'p1',
    actionsLeft: ACTIONS_PER_TURN,
    round: 1,
    units,
    log: [],
    seq: 0,
  };
  log(s, 'info', 'Both sides muster in their staging areas.');
  log(s, 'turn', `Round 1 — p1 has ${ACTIONS_PER_TURN} actions.`);
  return s;
}

export function unitsAt(s: StrategicState, nodeId: NodeId): MapUnit[] {
  return Object.values(s.units).filter((u) => u.nodeId === nodeId);
}

export function unitsAtFor(s: StrategicState, nodeId: NodeId, player: Player): MapUnit[] {
  return unitsAt(s, nodeId).filter((u) => u.owner === player);
}

/**
 * Nodes a unit may move to right now: the path-adjacent ones, provided it is
 * its owner's turn and they have an action left.
 */
export function legalMoveTargets(s: StrategicState, unitId: string): NodeId[] {
  const u = s.units[unitId];
  if (!u || u.owner !== s.turn || s.actionsLeft <= 0) return [];
  return NODE_BY_ID[u.nodeId]?.adjacency ?? [];
}

export function moveUnit(state: StrategicState, unitId: string, nodeId: NodeId): Transition {
  const u = state.units[unitId];
  if (!u) return { state, error: 'Unknown unit.' };
  if (!NODE_BY_ID[nodeId]) return { state, error: 'Unknown location.' };
  if (u.owner !== state.turn) return { state, error: `It is ${state.turn}'s turn.` };
  if (state.actionsLeft <= 0) return { state, error: 'No actions left this turn.' };
  if (nodeId === u.nodeId) return { state, error: 'Already there.' };
  if (!arePathLinked(u.nodeId, nodeId)) {
    return { state, error: 'No movement path to that location.' };
  }

  const s = clone(state);
  const from = s.units[unitId].nodeId;
  s.units[unitId].nodeId = nodeId;
  s.actionsLeft--;
  log(s, 'move', `${u.owner} ${u.type} moves ${from} → ${nodeId}.`);
  if (s.actionsLeft === 0) passTurn(s);
  return { state: s };
}

function passTurn(s: StrategicState): void {
  s.turn = otherPlayer(s.turn);
  s.actionsLeft = ACTIONS_PER_TURN;
  if (s.turn === 'p1') s.round++;
  log(s, 'turn', `Round ${s.round} — ${s.turn} has ${s.actionsLeft} actions.`);
}

/** End the current player's turn without spending the remaining actions. */
export function endTurn(state: StrategicState): Transition {
  const s = clone(state);
  passTurn(s);
  return { state: s };
}

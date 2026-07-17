// Battle state machine. Pure transitions: each returns a new state (unchanged,
// with an `error`, when a move is illegal). RNG is injected so the same scenario
// + rolls always produce the same battle — the basis for the server-authoritative
// Durable Object later, and for deterministic tests now.

import {
  BACK_ROW,
  CELL_BY_ID,
  SUPPORT_ORIGIN_GR,
  areAdjacent,
  artilleryArcCells,
  fortCovers,
  neighborIds,
} from './board';
import { applyDamage, resolveCombat, type CombatResult, type DamageOutcome } from './combat';
import { rollDice, type Rng, defaultRng } from './dice';
import { FORT_HP, UNIT_STATS } from './units';
import type { BattleUnit, Player, StateTransition } from './types';
import { isSupportUnit, otherPlayer, playerLabel, PLAYER_SIDE } from './types';
import { buildUnits, firstDeployer, type Scenario } from './scenario';

export type Phase = 'deployment' | 'battle' | 'over';

export type LogKind = 'info' | 'deploy' | 'attack' | 'move' | 'withdraw' | 'result';

/** What a fortification soaked up on one exchange, for the log. */
export interface FortHit {
  absorbed: number;
  destroyed: boolean;
}

export interface CombatEntry {
  attacker: string;
  defender: string;
  attackerRolls: number[];
  defenderRolls: number[];
  result: CombatResult;
  /** True when the attack was indirect fire from the support slot. */
  indirect?: boolean;
  /** Set when a fortification sheltered the defender from the attack. */
  fortDefender?: FortHit;
  /** Set when a fortification sheltered the attacker from the counter. */
  fortAttacker?: FortHit;
}

export interface LogEntry {
  id: number;
  kind: LogKind;
  text: string;
  /** Present on 'attack' entries: the full dice + damage breakdown. */
  combat?: CombatEntry;
}

export interface DeployState {
  row: number;
  /** 0 = first deployer is acting this row, 1 = second deployer. */
  index: 0 | 1;
  firstDeployer: Player;
}

/** A fortification occupies a cell, not a unit — it shelters whoever stands in it. */
export interface Fort {
  cellId: string;
  owner: Player;
  hp: number;
}

export interface BattleState {
  phase: Phase;
  attacker: Player;
  defender: Player;
  turn: Player;
  /**
   * The strategic node this battle is being fought over, when it came from the
   * map. Absent for a free-standing scenario battle. The result flows back to
   * this node, so it has to be remembered here rather than out in the room.
   */
  node?: string;
  units: Record<string, BattleUnit>;
  /** Fortifications on the board, keyed by cell id. */
  forts: Record<string, Fort>;
  /** Fortifications each player still has to place during deployment. */
  fortsLeft: Record<Player, number>;
  deploy: DeployState | null;
  winner: Player | 'stalemate' | null;
  log: LogEntry[];
  seq: number;
}

export type Transition = StateTransition<BattleState>;

// --- helpers ---------------------------------------------------------------

const clone = (s: BattleState): BattleState => structuredClone(s);

function log(s: BattleState, kind: LogKind, text: string, extra?: Partial<LogEntry>): void {
  s.log.push({ id: s.seq++, kind, text, ...extra });
}

function label(u: BattleUnit): string {
  return `${playerLabel(u.owner)} ${u.type}${u.wounded ? ' (wounded)' : ''}`;
}

function logFort(s: BattleState, hit: FortHit | undefined, sheltered: string): void {
  if (!hit) return;
  log(
    s,
    'result',
    `Fortification absorbs ${hit.absorbed} damage for ${sheltered}${hit.destroyed ? ' and is levelled.' : '.'}`,
  );
}

/** Combat units a player has standing on the grid (support + off-board excluded). */
export function deployedCombatUnits(s: BattleState, player: Player): BattleUnit[] {
  return Object.values(s.units).filter(
    (u) => u.owner === player && u.status === 'deployed' && !isSupportUnit(u),
  );
}

export function reserveUnits(s: BattleState, player: Player): BattleUnit[] {
  return Object.values(s.units).filter((u) => u.owner === player && u.status === 'reserve');
}

export function currentDeployer(s: BattleState): Player | null {
  if (!s.deploy) return null;
  return s.deploy.index === 0 ? s.deploy.firstDeployer : otherPlayer(s.deploy.firstDeployer);
}

function occupant(s: BattleState, cellId: string): BattleUnit | undefined {
  return Object.values(s.units).find((u) => u.status === 'deployed' && u.cellId === cellId);
}

/** Global row a unit's fire originates from (support fires from behind its side). */
function originGr(u: BattleUnit): number {
  if (u.cellId) {
    const c = CELL_BY_ID[u.cellId];
    if (c && c.kind === 'grid') return c.gr;
  }
  return SUPPORT_ORIGIN_GR[PLAYER_SIDE[u.owner]];
}

/**
 * Apply one side's share of an exchange, routing the incoming attack through a
 * fortification when the attack comes from a covered direction. Self-inflicted
 * fumble damage is never absorbed — the fort shelters against the enemy, not
 * against your own mistakes.
 */
function damageUnit(
  s: BattleState,
  u: BattleUnit,
  total: number,
  self: number,
  fromGr: number,
): { out: DamageOutcome; fort?: FortHit } {
  let incoming = Math.max(0, total - self);
  const cellId = u.cellId;
  const fort = cellId ? s.forts[cellId] : undefined;
  let hit: FortHit | undefined;

  if (fort && cellId && incoming > 0 && fortCovers(cellId, fromGr)) {
    // The fortification must be levelled before its occupant takes any damage,
    // so it soaks the whole hit however large.
    fort.hp -= incoming;
    hit = { absorbed: incoming, destroyed: fort.hp <= 0 };
    incoming = 0;
    if (fort.hp <= 0) delete s.forts[cellId];
  }
  return { out: applyDamage(u, incoming + self), fort: hit };
}

// --- construction ----------------------------------------------------------

/**
 * Assemble a battle from concrete units and fort counts. The one place a
 * `BattleState` is born, so both a free-standing scenario and a battle lifted off
 * the strategic map share the same deployment machinery — and, crucially, the map
 * battle can hand in units that already carry their *strategic* ids, which is
 * what lets the result be posted back to the right units afterwards.
 */
export function assembleBattle(params: {
  attacker: Player;
  units: BattleUnit[];
  fortsLeft: Record<Player, number>;
  firstDeployer: Player;
  node?: string;
}): BattleState {
  const units: Record<string, BattleUnit> = {};
  for (const u of params.units) units[u.id] = u;
  const fd = params.firstDeployer;
  const s: BattleState = {
    phase: 'deployment',
    attacker: params.attacker,
    defender: otherPlayer(params.attacker),
    turn: fd,
    node: params.node,
    units,
    forts: {},
    fortsLeft: {
      p1: Math.max(0, params.fortsLeft.p1),
      p2: Math.max(0, params.fortsLeft.p2),
    },
    deploy: { row: 0, index: 0, firstDeployer: fd },
    winner: null,
    log: [],
    seq: 0,
  };
  log(s, 'info', `Deployment begins — ${playerLabel(fd)} deploys first, front row.`);
  return s;
}

export function createBattle(sc: Scenario): BattleState {
  return assembleBattle({
    attacker: sc.attacker,
    units: buildUnits(sc),
    fortsLeft: {
      p1: sc.sides.p1.fortifications ?? 0,
      p2: sc.sides.p2.fortifications ?? 0,
    },
    firstDeployer: firstDeployer(sc),
  });
}

// --- deployment ------------------------------------------------------------

export function deployUnit(state: BattleState, unitId: string, cellId: string): Transition {
  if (state.phase !== 'deployment') return { state, error: 'Not in deployment.' };
  const s = clone(state);
  const u = s.units[unitId];
  const cell = CELL_BY_ID[cellId];
  const mover = currentDeployer(s);
  if (!u || !cell) return { state, error: 'Unknown unit or cell.' };
  if (u.owner !== mover) return { state, error: `It is ${playerLabel(mover!)}'s deployment turn.` };
  if (u.status !== 'reserve') return { state, error: 'Unit already placed.' };
  if (cell.side !== PLAYER_SIDE[u.owner]) return { state, error: 'Wrong side of the board.' };
  if (occupant(s, cellId)) return { state, error: 'Cell occupied.' };

  if (isSupportUnit(u)) {
    if (cell.kind !== 'support') return { state, error: 'Support unit goes in the support slot.' };
  } else {
    if (cell.kind !== 'grid') return { state, error: 'Only the support unit uses the support slot.' };
    if (cell.row !== s.deploy!.row) return { state, error: `Deploy into row ${s.deploy!.row} (front-first).` };
  }

  u.status = 'deployed';
  u.cellId = cellId;
  log(s, 'deploy', `${label(u)} deploys.`);
  return { state: s };
}

/** Place one prepared fortification on a cell of the current deployer's row. */
export function deployFort(state: BattleState, cellId: string): Transition {
  if (state.phase !== 'deployment') return { state, error: 'Not in deployment.' };
  const s = clone(state);
  const cell = CELL_BY_ID[cellId];
  const mover = currentDeployer(s)!;
  if (!cell) return { state, error: 'Unknown cell.' };
  if (s.fortsLeft[mover] <= 0) return { state, error: 'No fortifications left to place.' };
  if (cell.kind !== 'grid') return { state, error: 'Fortifications go on the deployment grid.' };
  if (cell.side !== PLAYER_SIDE[mover]) return { state, error: 'Wrong side of the board.' };
  if (cell.row !== s.deploy!.row) return { state, error: `Fortify row ${s.deploy!.row} (front-first).` };
  if (s.forts[cellId]) return { state, error: 'Position is already fortified.' };

  s.forts[cellId] = { cellId, owner: mover, hp: FORT_HP };
  s.fortsLeft[mover] -= 1;
  log(s, 'deploy', `${playerLabel(mover)} fortifies a position.`);
  return { state: s };
}

/** Current deployer finishes their turn for this row. */
export function passDeploy(state: BattleState): Transition {
  if (state.phase !== 'deployment' || !state.deploy) return { state, error: 'Not in deployment.' };
  const s = clone(state);
  const d = s.deploy!;
  if (d.index === 0) {
    d.index = 1;
    s.turn = currentDeployer(s)!;
    return { state: s };
  }
  // both players have acted on this row → advance
  d.index = 0;
  d.row += 1;
  if (d.row >= 3) return beginBattle(s);
  s.turn = currentDeployer(s)!;
  log(s, 'info', `Deploying row ${d.row}.`);
  return { state: s };
}

function beginBattle(s: BattleState): Transition {
  s.deploy = null;
  s.phase = 'battle';
  s.turn = s.attacker;
  log(s, 'info', `Battle begins — ${playerLabel(s.attacker)} (attacker) acts first.`);
  const v = detectVictory(s);
  if (v) return { state: s };
  return { state: s };
}

// --- battle actions --------------------------------------------------------

/**
 * The attacker has broken off: every surviving unit sits in their rearmost row
 * and the support has left the field. Units that cannot fit the back row must
 * therefore have withdrawn — which is exactly the manual's "excess units" rule.
 */
function attackerHasDisengaged(s: BattleState): boolean {
  const units = deployedCombatUnits(s, s.attacker);
  if (units.length === 0) return false;
  if (!units.every((u) => !!u.cellId && CELL_BY_ID[u.cellId].row === BACK_ROW)) return false;
  // A map battle can offer several eligible guns (one per adjacent firing node),
  // so this asks whether *any* of them is still shelling, not whether the one
  // support unit is.
  return !Object.values(s.units).some(
    (u) => isSupportUnit(u) && u.owner === s.attacker && u.status === 'deployed',
  );
}

/** The defender contests a stalemate by pushing units over the initial frontline. */
function defenderContests(s: BattleState): boolean {
  return deployedCombatUnits(s, s.defender).some(
    (u) => !!u.cellId && CELL_BY_ID[u.cellId].side !== PLAYER_SIDE[s.defender],
  );
}

/**
 * True while the defender is on their last chance: the attacker has disengaged
 * and nothing is over the line, so ending this turn without contesting settles
 * the battle as a stalemate. Mirrors the check in `endTurn`.
 */
export function stalemateLooms(s: BattleState): boolean {
  return (
    s.phase === 'battle' &&
    s.turn === s.defender &&
    attackerHasDisengaged(s) &&
    !defenderContests(s)
  );
}

function endTurn(s: BattleState): void {
  if (s.phase === 'over') return;
  s.turn = otherPlayer(s.turn);
  // Checked as the attacker regains the initiative, so the defender has always
  // had one turn to answer the disengagement before the battle is called off.
  if (s.turn === s.attacker && attackerHasDisengaged(s) && !defenderContests(s)) {
    finish(s, 'stalemate');
  }
}

function detectVictory(s: BattleState): boolean {
  if (s.phase === 'over') return true;
  const aLeft = deployedCombatUnits(s, s.attacker).length;
  const dLeft = deployedCombatUnits(s, s.defender).length;
  // Only meaningful once the battle has started.
  if (s.phase !== 'battle') return false;
  if (dLeft === 0 && aLeft > 0) return finish(s, s.attacker);
  if (aLeft === 0 && dLeft > 0) return finish(s, s.defender);
  if (aLeft === 0 && dLeft === 0) return finish(s, 'stalemate');
  return false;
}

function finish(s: BattleState, winner: Player | 'stalemate'): boolean {
  s.winner = winner;
  s.phase = 'over';
  log(s, 'result', winner === 'stalemate' ? 'Battle ends in a stalemate.' : `${playerLabel(winner)} wins the battle.`);
  return true;
}

export function attack(
  state: BattleState,
  attackerId: string,
  defenderId: string,
  rng: Rng = defaultRng,
): Transition {
  if (state.phase !== 'battle') return { state, error: 'Not in battle.' };
  const s = clone(state);
  const a = s.units[attackerId];
  const d = s.units[defenderId];
  if (!a || !d) return { state, error: 'Unknown unit.' };
  if (a.owner !== s.turn) return { state, error: `It is ${playerLabel(s.turn)}'s turn.` };
  if (a.owner === d.owner) return { state, error: 'Cannot attack a friendly unit.' };
  if (a.status !== 'deployed' || d.status !== 'deployed') return { state, error: 'Unit not on the board.' };
  if (isSupportUnit(a)) return { state, error: 'Use indirect fire for the support unit.' };
  if (!a.cellId) return { state, error: 'Attacker not on the board.' };

  // Range: adjacent melee, artillery arc, or artillery shelling the enemy
  // support after crossing the frontline. A counter is dealt only when the
  // target can strike back — i.e. it is adjacent, or it is itself artillery.
  let allowCounter: boolean;
  if (d.cellId && areAdjacent(a.cellId, d.cellId)) {
    allowCounter = true;
  } else if (a.type === 'artillery' && d.cellId && artilleryArcCells(a.cellId).includes(d.cellId)) {
    allowCounter = d.type === 'artillery';
  } else if (a.type === 'artillery' && isSupportUnit(d) && CELL_BY_ID[a.cellId].side !== PLAYER_SIDE[a.owner]) {
    allowCounter = d.type === 'artillery';
  } else {
    return { state, error: 'Target is out of range.' };
  }

  const aRoll = rollDice(UNIT_STATS[a.type].breakthrough, rng);
  const dRoll = rollDice(UNIT_STATS[d.type].toughness, rng);
  const res = resolveCombat(a, d, aRoll.value, dRoll.value, allowCounter);

  const aLabel = label(a);
  const dLabel = label(d);
  const targetCell = d.cellId;
  // Directions are captured before anyone is removed from the board.
  const atDefender = damageUnit(s, d, res.damageToDefender, res.selfDefender, originGr(a));
  const atAttacker = damageUnit(s, a, res.damageToAttacker, res.selfAttacker, originGr(d));
  const defOut = atDefender.out;
  const attOut = atAttacker.out;

  log(s, 'attack', `${aLabel} attacks ${dLabel}.`, {
    combat: {
      attacker: aLabel,
      defender: dLabel,
      attackerRolls: aRoll.rolls,
      defenderRolls: dRoll.rolls,
      result: res,
      fortDefender: atDefender.fort,
      fortAttacker: atAttacker.fort,
    },
  });

  logFort(s, atDefender.fort, dLabel);
  logFort(s, atAttacker.fort, aLabel);
  if (defOut.becameWounded) log(s, 'result', `${playerLabel(d.owner)} ${d.type} is wounded.`);
  if (defOut.destroyed) {
    d.status = 'dead';
    d.cellId = undefined;
    log(s, 'result', `${playerLabel(d.owner)} ${d.type} is destroyed.`);
  }
  if (attOut.destroyed) {
    a.status = 'dead';
    a.cellId = undefined;
    log(s, 'result', `${a.owner} ${a.type} is destroyed by the counterattack.`);
  }
  // Frontline unit (not artillery) advances into a vacated cell.
  if (defOut.destroyed && !attOut.destroyed && a.type !== 'artillery' && allowCounter && targetCell && !occupant(s, targetCell)) {
    a.cellId = targetCell;
    log(s, 'move', `${a.owner} ${a.type} advances into the vacated position.`);
  }

  if (!detectVictory(s)) endTurn(s);
  return { state: s };
}

export function move(state: BattleState, unitId: string, cellId: string): Transition {
  if (state.phase !== 'battle') return { state, error: 'Not in battle.' };
  const s = clone(state);
  const u = s.units[unitId];
  const cell = CELL_BY_ID[cellId];
  if (!u || !cell) return { state, error: 'Unknown unit or cell.' };
  if (u.owner !== s.turn) return { state, error: `It is ${playerLabel(s.turn)}'s turn.` };
  if (u.status !== 'deployed' || !u.cellId) return { state, error: 'Unit not on the board.' };
  if (isSupportUnit(u)) return { state, error: 'The support unit does not move.' };
  if (cell.kind !== 'grid') return { state, error: 'Cannot move there.' };
  if (occupant(s, cellId)) return { state, error: 'Cell occupied.' };
  if (!areAdjacent(u.cellId, cellId)) return { state, error: 'Not an adjacent cell.' };

  u.cellId = cellId;
  log(s, 'move', `${label(u)} moves.`);
  endTurn(s);
  return { state: s };
}

export function withdraw(state: BattleState, unitId: string): Transition {
  if (state.phase !== 'battle') return { state, error: 'Not in battle.' };
  const s = clone(state);
  const u = s.units[unitId];
  if (!u) return { state, error: 'Unknown unit.' };
  if (u.owner !== s.turn) return { state, error: `It is ${playerLabel(s.turn)}'s turn.` };
  if (u.status !== 'deployed' || !u.cellId) return { state, error: 'Unit not on the board.' };
  const cell = CELL_BY_ID[u.cellId];
  if (isSupportUnit(u)) {
    // Support may withdraw from any position.
  } else if (cell.row !== BACK_ROW) {
    return { state, error: 'Only units in the back row may withdraw.' };
  }

  u.status = 'withdrawn';
  u.cellId = undefined;
  log(s, 'withdraw', `${label(u)} withdraws from the battle.`);
  if (!detectVictory(s)) endTurn(s);
  return { state: s };
}

/** Support artillery calls in indirect fire on an enemy in reach of friendly units. */
export function indirectFire(
  state: BattleState,
  supportId: string,
  targetId: string,
  rng: Rng = defaultRng,
): Transition {
  if (state.phase !== 'battle') return { state, error: 'Not in battle.' };
  const s = clone(state);
  const sup = s.units[supportId];
  const t = s.units[targetId];
  if (!sup || !t) return { state, error: 'Unknown unit.' };
  if (sup.owner !== s.turn) return { state, error: `It is ${playerLabel(s.turn)}'s turn.` };
  if (!isSupportUnit(sup) || sup.status !== 'deployed') return { state, error: 'Support unit is not in play.' };
  if (t.owner === sup.owner || t.status !== 'deployed' || isSupportUnit(t)) {
    return { state, error: 'Invalid indirect target.' };
  }
  const friendlies = deployedCombatUnits(s, sup.owner);
  if (friendlies.length === 0) return { state, error: 'No friendly units on the board to spot for indirect fire.' };
  const tc = t.cellId;
  if (!tc || !friendlies.some((f) => !!f.cellId && areAdjacent(f.cellId, tc))) {
    return { state, error: 'Target is beyond the reach of your units.' };
  }

  // −1 breakthrough when firing over the frontline into the opponent's half;
  // full values against enemies that have advanced onto the firer's own side.
  const overFrontline = CELL_BY_ID[tc].side !== PLAYER_SIDE[sup.owner];
  const breakthrough = Math.max(0, UNIT_STATS.artillery.breakthrough - (overFrontline ? 1 : 0));
  const allowCounter = t.type === 'artillery'; // only artillery can fire back

  const aRoll = rollDice(breakthrough, rng);
  const dRoll = rollDice(UNIT_STATS[t.type].toughness, rng);
  const res = resolveCombat(sup, t, aRoll.value, dRoll.value, allowCounter);

  const supLabel = label(sup);
  const tLabel = label(t);
  const atTarget = damageUnit(s, t, res.damageToDefender, res.selfDefender, originGr(sup));
  // crit-fail self-damage, or an artillery counter; the support slot is never fortified
  const atSup = damageUnit(s, sup, res.damageToAttacker, res.selfAttacker, originGr(t));
  const defOut = atTarget.out;
  const supOut = atSup.out;
  log(
    s,
    'attack',
    `${supLabel} calls in indirect fire on ${tLabel}${overFrontline ? ' (over the line, −1 breakthrough)' : ''}.`,
    {
      combat: {
        attacker: supLabel,
        defender: tLabel,
        attackerRolls: aRoll.rolls,
        defenderRolls: dRoll.rolls,
        result: res,
        indirect: true,
        fortDefender: atTarget.fort,
      },
    },
  );
  logFort(s, atTarget.fort, tLabel);
  if (defOut.becameWounded) log(s, 'result', `${playerLabel(t.owner)} ${t.type} is wounded.`);
  if (defOut.destroyed) {
    t.status = 'dead';
    t.cellId = undefined;
    log(s, 'result', `${playerLabel(t.owner)} ${t.type} is destroyed.`);
  }
  if (supOut.destroyed) {
    sup.status = 'dead';
    sup.cellId = undefined;
    log(s, 'result', `${sup.owner} support artillery is destroyed.`);
  }
  if (!detectVictory(s)) endTurn(s);
  return { state: s };
}

// --- targeting helpers (UI highlights; the actions above are authoritative) ---

/** Enemy unit ids a deployed unit can attack (adjacency, plus artillery arc). */
export function attackTargetIds(s: BattleState, unitId: string): string[] {
  const a = s.units[unitId];
  if (!a || a.status !== 'deployed' || !a.cellId || isSupportUnit(a)) return [];
  const reach = new Set<string>(neighborIds(a.cellId));
  if (a.type === 'artillery') for (const c of artilleryArcCells(a.cellId)) reach.add(c);
  const ids: string[] = [];
  for (const cid of reach) {
    const occ = occupant(s, cid);
    if (occ && occ.owner !== a.owner) ids.push(occ.id);
  }
  if (a.type === 'artillery' && CELL_BY_ID[a.cellId].side !== PLAYER_SIDE[a.owner]) {
    const sup = Object.values(s.units).find((u) => isSupportUnit(u) && u.owner !== a.owner && u.status === 'deployed');
    if (sup) ids.push(sup.id);
  }
  return ids;
}

/** Empty grid cells a deployed unit can move into. */
export function moveTargetCells(s: BattleState, unitId: string): string[] {
  const u = s.units[unitId];
  if (!u || u.status !== 'deployed' || !u.cellId || isSupportUnit(u)) return [];
  return neighborIds(u.cellId).filter((cid) => CELL_BY_ID[cid].kind === 'grid' && !occupant(s, cid));
}

/** Enemy unit ids a support unit can hit with indirect fire. */
export function indirectTargetIds(s: BattleState, supportId: string): string[] {
  const sup = s.units[supportId];
  if (!sup || !isSupportUnit(sup) || sup.status !== 'deployed') return [];
  const friendlies = deployedCombatUnits(s, sup.owner);
  if (friendlies.length === 0) return [];
  const ids: string[] = [];
  for (const t of Object.values(s.units)) {
    if (t.owner === sup.owner || t.status !== 'deployed' || isSupportUnit(t) || !t.cellId) continue;
    const tc = t.cellId;
    if (friendlies.some((f) => !!f.cellId && areAdjacent(f.cellId, tc))) ids.push(t.id);
  }
  return ids;
}

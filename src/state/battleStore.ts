// Battle *interaction* state: what this player has picked up, and the intents
// their clicks turn into. The battle itself lives in the session's room — read
// it from there, because online it is the server's answer, not this store's.

import { create } from 'zustand';
import type { Scenario } from '../engine/scenario';
import type { UnitType } from '../engine/units';
import type { BattleState } from '../engine/battle';
import type { BattleUnit, Player } from '../engine/types';
import { battleMover } from '../engine/room';
import { useSession } from './sessionStore';

type Combat = Exclude<UnitType, 'recon'>;

/** Sentinel `selectedId` meaning "a fortification is queued for placement". */
export const FORT_SELECTION = '__fortification__';

const session = () => useSession.getState();

/** Edit the scenario as a whole — it travels to the other player as one value. */
function editScenario(edit: (sc: Scenario) => void): void {
  const next = structuredClone(session().room.scenario);
  edit(next);
  session().dispatch({ t: 'setScenario', scenario: next });
}

interface Store {
  /** Reserve unit chosen to deploy, or a board unit selected to act. */
  selectedId: string | null;

  // scenario editing
  setRoster: (p: Player, type: Combat, count: number) => void;
  setForts: (p: Player, count: number) => void;
  toggleSupport: (p: Player) => void;
  toggleRecon: (p: Player) => void;
  setAttacker: (p: Player) => void;
  startBattle: () => void;
  newScenario: () => void;

  // interaction
  select: (id: string | null) => void;
  selectFort: () => void;
  deployTo: (cellId: string) => void;
  passDeploy: () => void;
  attackTarget: (defenderId: string) => void;
  indirectFire: (targetId: string) => void;
  moveTo: (cellId: string) => void;
  withdrawSelected: () => void;
}

export const useBattleStore = create<Store>((set, get) => ({
  selectedId: null,

  setRoster: (p, type, count) =>
    editScenario((sc) => {
      sc.sides[p].roster[type] = Math.max(0, count) || undefined;
    }),
  setForts: (p, count) =>
    editScenario((sc) => {
      sc.sides[p].fortifications = Math.max(0, count) || 0;
    }),
  toggleSupport: (p) =>
    editScenario((sc) => {
      sc.sides[p].support = !sc.sides[p].support;
    }),
  toggleRecon: (p) =>
    editScenario((sc) => {
      sc.sides[p].reconRevealed = !sc.sides[p].reconRevealed;
    }),
  setAttacker: (p) =>
    editScenario((sc) => {
      sc.attacker = p;
    }),

  startBattle: () => {
    set({ selectedId: null });
    session().dispatch({ t: 'startBattle' });
  },
  newScenario: () => {
    set({ selectedId: null });
    session().dispatch({ t: 'newScenario' });
  },

  select: (id) => {
    set({ selectedId: id });
    session().clearError();
  },
  selectFort: () => {
    set({ selectedId: FORT_SELECTION });
    session().clearError();
  },

  deployTo: (cellId) => {
    const { selectedId } = get();
    if (!selectedId) return;
    if (selectedId === FORT_SELECTION) {
      session().dispatch({ t: 'deployFort', cellId });
      return;
    }
    session().dispatch({ t: 'deploy', unitId: selectedId, cellId });
  },
  passDeploy: () => session().dispatch({ t: 'passDeploy' }),
  attackTarget: (targetId) => {
    const { selectedId } = get();
    if (selectedId) session().dispatch({ t: 'attack', unitId: selectedId, targetId });
  },
  indirectFire: (targetId) => {
    const { selectedId } = get();
    if (selectedId) session().dispatch({ t: 'indirectFire', unitId: selectedId, targetId });
  },
  moveTo: (cellId) => {
    const { selectedId } = get();
    if (selectedId) session().dispatch({ t: 'move', unitId: selectedId, cellId });
  },
  withdrawSelected: () => {
    const { selectedId } = get();
    if (selectedId) session().dispatch({ t: 'withdraw', unitId: selectedId });
  },
}));

/**
 * Selection is local, but the authoritative state moves underneath it — the unit
 * you had picked up gets killed, the cell you aimed at is taken. Every accepted
 * action therefore drops the selection, exactly as the hotseat store did when it
 * applied a transition. Doing it on the *room changing* rather than at dispatch
 * is what makes online behave identically, since there the answer only arrives a
 * round-trip later.
 */
useSession.subscribe((s, prev) => {
  if (s.room.version === prev.room.version) return;
  const { selectedId } = useBattleStore.getState();
  if (!selectedId) return;

  // A queued fortification stays queued, so several can be placed in a row.
  if (selectedId === FORT_SELECTION) {
    const b = s.room.battle;
    const mover = b ? battleMover(b) : null;
    if (b && mover && b.fortsLeft[mover] > 0) return;
  }
  useBattleStore.setState({ selectedId: null });
});

/** Unit currently occupying a cell (deployed only). */
export function occupantOf(battle: BattleState, cellId: string): BattleUnit | undefined {
  return Object.values(battle.units).find((u) => u.status === 'deployed' && u.cellId === cellId);
}

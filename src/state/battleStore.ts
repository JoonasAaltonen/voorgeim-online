import { create } from 'zustand';
import type { Scenario } from '../engine/scenario';
import { emptyScenario } from '../engine/scenario';
import type { UnitType } from '../engine/units';
import type { BattleUnit, Player } from '../engine/types';
import {
  createBattle,
  deployUnit,
  passDeploy,
  attack,
  move,
  withdraw,
  indirectFire as engineIndirectFire,
  type BattleState,
  type Transition,
} from '../engine/battle';

type Combat = Exclude<UnitType, 'recon'>;

function defaultScenario(): Scenario {
  const sc = emptyScenario();
  sc.sides.p1.roster = { infantry: 3, armor: 1 };
  sc.sides.p2.roster = { infantry: 3, artillery: 1 };
  return sc;
}

interface Store {
  scenario: Scenario;
  battle: BattleState | null;
  /** Reserve unit chosen to deploy, or a board unit selected to act. */
  selectedId: string | null;
  error: string | null;

  // scenario editing
  setRoster: (p: Player, type: Combat, count: number) => void;
  toggleSupport: (p: Player) => void;
  toggleRecon: (p: Player) => void;
  setAttacker: (p: Player) => void;
  startBattle: () => void;
  newScenario: () => void;

  // interaction
  select: (id: string | null) => void;
  deployTo: (cellId: string) => void;
  passDeploy: () => void;
  attackTarget: (defenderId: string) => void;
  indirectFire: (targetId: string) => void;
  moveTo: (cellId: string) => void;
  withdrawSelected: () => void;
  clearError: () => void;
}

export const useBattleStore = create<Store>((set, get) => {
  /** Apply an engine transition: on success store new state + clear selection. */
  const apply = (t: Transition, keepSelection = false) => {
    if (t.error) {
      set({ error: t.error });
    } else {
      set({ battle: t.state, error: null, selectedId: keepSelection ? get().selectedId : null });
    }
  };

  return {
    scenario: defaultScenario(),
    battle: null,
    selectedId: null,
    error: null,

    setRoster: (p, type, count) =>
      set((s) => {
        const scenario = structuredClone(s.scenario);
        scenario.sides[p].roster[type] = Math.max(0, count) || undefined;
        return { scenario };
      }),
    toggleSupport: (p) =>
      set((s) => {
        const scenario = structuredClone(s.scenario);
        scenario.sides[p].support = !scenario.sides[p].support;
        return { scenario };
      }),
    toggleRecon: (p) =>
      set((s) => {
        const scenario = structuredClone(s.scenario);
        scenario.sides[p].reconRevealed = !scenario.sides[p].reconRevealed;
        return { scenario };
      }),
    setAttacker: (p) =>
      set((s) => ({ scenario: { ...structuredClone(s.scenario), attacker: p } })),

    startBattle: () => set({ battle: createBattle(get().scenario), selectedId: null, error: null }),
    newScenario: () => set({ battle: null, selectedId: null, error: null }),

    select: (id) => set({ selectedId: id, error: null }),
    deployTo: (cellId) => {
      const { battle, selectedId } = get();
      if (!battle || !selectedId) return;
      apply(deployUnit(battle, selectedId, cellId));
    },
    passDeploy: () => {
      const { battle } = get();
      if (!battle) return;
      apply(passDeploy(battle));
    },
    attackTarget: (defenderId) => {
      const { battle, selectedId } = get();
      if (!battle || !selectedId) return;
      apply(attack(battle, selectedId, defenderId));
    },
    indirectFire: (targetId) => {
      const { battle, selectedId } = get();
      if (!battle || !selectedId) return;
      apply(engineIndirectFire(battle, selectedId, targetId));
    },
    moveTo: (cellId) => {
      const { battle, selectedId } = get();
      if (!battle || !selectedId) return;
      apply(move(battle, selectedId, cellId));
    },
    withdrawSelected: () => {
      const { battle, selectedId } = get();
      if (!battle || !selectedId) return;
      apply(withdraw(battle, selectedId));
    },
    clearError: () => set({ error: null }),
  };
});

/** Unit currently occupying a cell (deployed only). */
export function occupantOf(battle: BattleState, cellId: string): BattleUnit | undefined {
  return Object.values(battle.units).find((u) => u.status === 'deployed' && u.cellId === cellId);
}

// Strategic-map *interaction* state: what is in hand, which node is on show, and
// whether the reorganization table is open. The map itself lives in the
// session's room — read it from there, because online it is the server's answer,
// not this store's.

import { create } from 'zustand';
import type { NodeId } from '../engine/map';
import { STAGING_NODE } from '../engine/map';
import { MAX_LOOSE_MOVE, type Reassignment } from '../engine/strategic';
import { useSession } from './sessionStore';

const session = () => useSession.getState();

/**
 * What the player has picked up. Armies move whole, so an army selection is one
 * id; loose units move one or two at a time, so theirs is a small set. They are
 * separate kinds rather than one list of unit ids because the two obey different
 * movement rules and the engine takes them through different intents.
 */
export type Selection =
  | { kind: 'army'; armyId: string }
  | { kind: 'loose'; unitIds: string[] };

interface Store {
  sel: Selection | null;
  /** Node whose contents are open in the panel. */
  inspectedNode: NodeId | null;
  /** Node whose reorganization table is open, if any. */
  reorgNode: NodeId | null;

  selectArmy: (armyId: string) => void;
  /** Add or remove a loose unit from the pair in hand. */
  toggleLoose: (unitId: string) => void;
  clearSel: () => void;
  inspectNode: (id: NodeId | null) => void;
  /**
   * Left-click a location: open it, and drop whatever was in hand. Selecting is
   * the chips' job, so a click that lands on the node itself is by definition a
   * click on no one.
   */
  nodeClicked: (id: NodeId) => void;
  /** Right-click a location: send whatever is in hand there. */
  nodeCommanded: (id: NodeId) => void;
  openReorg: (id: NodeId) => void;
  closeReorg: () => void;
  reorganize: (assign: Reassignment) => void;
  /** Cross to the other side of an asymmetric node. */
  swapSide: (nodeId: NodeId) => void;
  split: (unitIds: string[]) => void;
  endTurn: () => void;
  reset: () => void;
}

export const useStrategicStore = create<Store>((set, get) => ({
  sel: null,
  inspectedNode: STAGING_NODE.p1,
  reorgNode: null,

  selectArmy: (armyId) => {
    const cur = get().sel;
    const same = cur?.kind === 'army' && cur.armyId === armyId;
    set({ sel: same ? null : { kind: 'army', armyId } });
    session().clearError();
  },

  toggleLoose: (unitId) => {
    session().clearError();
    const cur = get().sel;
    if (cur?.kind === 'loose') {
      if (cur.unitIds.includes(unitId)) {
        const rest = cur.unitIds.filter((id) => id !== unitId);
        set({ sel: rest.length ? { kind: 'loose', unitIds: rest } : null });
        return;
      }
      // A second unit joins the one in hand only if it can actually travel with
      // it: same node, and no more than the pair the rules allow.
      const units = session().room.strategic.units;
      const together = units[cur.unitIds[0]]?.nodeId === units[unitId]?.nodeId;
      if (together && cur.unitIds.length < MAX_LOOSE_MOVE) {
        set({ sel: { kind: 'loose', unitIds: [...cur.unitIds, unitId] } });
        return;
      }
    }
    set({ sel: { kind: 'loose', unitIds: [unitId] } });
  },

  clearSel: () => set({ sel: null }),

  inspectNode: (id) => {
    set({ inspectedNode: id });
    session().clearError();
  },

  nodeClicked: (id) => {
    set({ inspectedNode: id, sel: null });
    session().clearError();
  },

  nodeCommanded: (id) => {
    const { sel } = get();
    if (!sel) return;
    // Ordering a unit to the node it already stands in is a slip, not a move the
    // engine should have to reject.
    const s = session().room.strategic;
    const from =
      sel.kind === 'army'
        ? Object.values(s.units).find((u) => u.armyId === sel.armyId)?.nodeId
        : s.units[sel.unitIds[0]]?.nodeId;
    if (from === id) return;
    set({ inspectedNode: id });
    session().dispatch(
      sel.kind === 'army'
        ? { t: 'stratMoveArmy', armyId: sel.armyId, nodeId: id }
        : { t: 'stratMoveLoose', unitIds: sel.unitIds, nodeId: id },
    );
  },

  openReorg: (id) => set({ reorgNode: id, sel: null }),
  closeReorg: () => set({ reorgNode: null }),

  reorganize: (assign) => {
    const nodeId = get().reorgNode;
    if (!nodeId) return;
    set({ reorgNode: null });
    session().dispatch({ t: 'stratReorganize', nodeId, assign });
  },

  swapSide: (nodeId) => {
    set({ sel: null });
    session().dispatch({ t: 'stratSwapSide', nodeId });
  },

  split: (unitIds) => session().dispatch({ t: 'stratSplit', unitIds }),

  endTurn: () => session().dispatch({ t: 'stratEndTurn' }),
  reset: () => {
    set({ sel: null, inspectedNode: STAGING_NODE.p1, reorgNode: null });
    session().dispatch({ t: 'stratReset' });
  },
}));

/** Every accepted action drops whatever is in hand — see the note in battleStore. */
useSession.subscribe((s, prev) => {
  if (s.room.version !== prev.room.version) useStrategicStore.setState({ sel: null });
});

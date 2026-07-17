import { create } from 'zustand';
import type { NodeId } from '../engine/map';
import { STAGING_NODE } from '../engine/map';
import {
  createStrategic,
  endTurn,
  moveUnit,
  type StrategicState,
  type Transition,
} from '../engine/strategic';

interface Store {
  strategic: StrategicState;
  /** Unit picked up and awaiting a destination. */
  selectedId: string | null;
  /** Node whose contents are open in the panel. */
  inspectedNode: NodeId | null;
  error: string | null;

  selectUnit: (id: string | null) => void;
  inspectNode: (id: NodeId | null) => void;
  /** Move the selected unit, or open the node if nothing is selected. */
  nodeClicked: (id: NodeId) => void;
  endTurn: () => void;
  reset: () => void;
  clearError: () => void;
}

export const useStrategicStore = create<Store>((set, get) => {
  const apply = (t: Transition) => {
    if (t.error) set({ error: t.error });
    else set({ strategic: t.state, error: null, selectedId: null });
  };

  return {
    strategic: createStrategic(),
    selectedId: null,
    inspectedNode: STAGING_NODE.p1,
    error: null,

    selectUnit: (id) => set({ selectedId: id, error: null }),
    inspectNode: (id) => set({ inspectedNode: id, error: null }),

    nodeClicked: (id) => {
      const { strategic, selectedId } = get();
      if (selectedId) {
        const t = moveUnit(strategic, selectedId, id);
        apply(t);
        // Follow the unit so the panel keeps showing where it landed.
        if (!t.error) set({ inspectedNode: id });
        return;
      }
      set({ inspectedNode: id, error: null });
    },

    endTurn: () => apply(endTurn(get().strategic)),
    reset: () =>
      set({
        strategic: createStrategic(),
        selectedId: null,
        inspectedNode: STAGING_NODE.p1,
        error: null,
      }),
    clearError: () => set({ error: null }),
  };
});

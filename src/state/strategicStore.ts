// Strategic-map *interaction* state: the unit in hand and the node on show. The
// map itself lives in the session's room — read it from there, because online it
// is the server's answer, not this store's.

import { create } from 'zustand';
import type { NodeId } from '../engine/map';
import { STAGING_NODE } from '../engine/map';
import { useSession } from './sessionStore';

const session = () => useSession.getState();

interface Store {
  /** Unit picked up and awaiting a destination. */
  selectedId: string | null;
  /** Node whose contents are open in the panel. */
  inspectedNode: NodeId | null;

  selectUnit: (id: string | null) => void;
  inspectNode: (id: NodeId | null) => void;
  /** Move the selected unit, or open the node if nothing is selected. */
  nodeClicked: (id: NodeId) => void;
  endTurn: () => void;
  reset: () => void;
}

export const useStrategicStore = create<Store>((set, get) => ({
  selectedId: null,
  inspectedNode: STAGING_NODE.p1,

  selectUnit: (id) => {
    set({ selectedId: id });
    session().clearError();
  },
  inspectNode: (id) => {
    set({ inspectedNode: id });
    session().clearError();
  },

  nodeClicked: (id) => {
    const { selectedId } = get();
    if (selectedId) {
      session().dispatch({ t: 'stratMove', unitId: selectedId, nodeId: id });
      // Follow the unit, so the panel keeps showing where it landed. Harmless if
      // the move is refused: the panel just opens the node they aimed at.
      set({ inspectedNode: id });
      return;
    }
    set({ inspectedNode: id });
    session().clearError();
  },

  endTurn: () => session().dispatch({ t: 'stratEndTurn' }),
  reset: () => {
    set({ selectedId: null, inspectedNode: STAGING_NODE.p1 });
    session().dispatch({ t: 'stratReset' });
  },
}));

/** Every accepted action drops the unit in hand — see the note in battleStore. */
useSession.subscribe((s, prev) => {
  if (s.room.version !== prev.room.version) useStrategicStore.setState({ selectedId: null });
});

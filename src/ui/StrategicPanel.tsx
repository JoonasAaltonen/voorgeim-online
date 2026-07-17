import { NODE_BY_ID, isSea, slotsFor, type NodeId } from '../engine/map';
import { ACTIONS_PER_TURN, legalMoveTargets, unitsAtFor } from '../engine/strategic';
import { coinAsset, playerLabel, type Player } from '../engine/types';
import type { UnitType } from '../engine/units';
import { useStrategicStore } from '../state/strategicStore';
import { useSession } from '../state/sessionStore';
import './StrategicPanel.css';

const PLAYERS: Player[] = ['p1', 'p2'];

function NodeSide({ nodeId, owner }: { nodeId: NodeId; owner: Player }) {
  const s = useSession((st) => st.room.strategic);
  const selectedId = useStrategicStore((st) => st.selectedId);
  const selectUnit = useStrategicStore((st) => st.selectUnit);
  const units = unitsAtFor(s, nodeId, owner);
  const slots = slotsFor(nodeId, owner);
  const staging = !!NODE_BY_ID[nodeId].staging;

  // One chip per unit type, since units of a type are interchangeable here.
  const byType = new Map<UnitType, string[]>();
  for (const u of units) byType.set(u.type, [...(byType.get(u.type) ?? []), u.id]);

  return (
    <div className="side">
      <div className="side__head">
        <span className={`side__who side__who--${owner}`}>{playerLabel(owner)}</span>
        <span className="side__slots">
          {units.length}
          {staging ? ' units' : ` / ${slots} slot${slots === 1 ? '' : 's'}`}
        </span>
      </div>
      {units.length === 0 ? (
        <p className="side__empty">Empty</p>
      ) : (
        <div className="side__units">
          {[...byType].map(([type, ids]) => {
            const held = ids.find((id) => id === selectedId);
            return (
              <button
                key={type}
                type="button"
                className={`ustack${held ? ' ustack--sel' : ''}`}
                onClick={() => selectUnit(held ? null : ids[0])}
                title={`${type} ×${ids.length}`}
              >
                <img src={coinAsset(type, owner)} alt="" />
                <span className="ustack__n">{ids.length}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function StrategicPanel() {
  const s = useSession((st) => st.room.strategic);
  const selectedId = useStrategicStore((st) => st.selectedId);
  const inspected = useStrategicStore((st) => st.inspectedNode);
  const error = useSession((st) => st.error);
  const clearError = useSession((st) => st.clearError);
  const endTurn = useStrategicStore((st) => st.endTurn);
  const reset = useStrategicStore((st) => st.reset);

  const sel = selectedId ? s.units[selectedId] : undefined;
  const node = inspected ? NODE_BY_ID[inspected] : undefined;
  const log = [...s.log].reverse();

  return (
    <aside className="spanel">
      <div className="spanel__section">
        <div className={`sturn sturn--${s.turn}`}>
          Round {s.round} · <b>{playerLabel(s.turn)}</b> · {s.actionsLeft} of {ACTIONS_PER_TURN}{' '}
          action{s.actionsLeft === 1 ? '' : 's'} left
        </div>
        {sel ? (
          <p className="shint">
            Carrying <b>{playerLabel(sel.owner)} {sel.type}</b> from {sel.nodeId}. Click a highlighted
            location to move it, or click the coin again to put it down.
            {legalMoveTargets(s, selectedId!).length === 0 && ' No moves left this turn.'}
          </p>
        ) : (
          <p className="shint">
            Click a location to see who holds it, then pick a unit to move. Each move along a
            path costs one action.
          </p>
        )}
        <button type="button" className="sbtn" onClick={endTurn}>
          End {playerLabel(s.turn)}'s turn
        </button>
      </div>

      {error && (
        <div className="sbanner sbanner--err" onClick={clearError}>
          {error}
        </div>
      )}

      {node && (
        <div className="spanel__section">
          <div className="spanel__title">
            {node.staging ? `${playerLabel(node.staging)} staging area` : node.id}
            {node.asymmetric && <span className="tagpill">asymmetric</span>}
            {isSea(node.id) && <span className="tagpill tagpill--sea">sea</span>}
          </div>
          {node.staging ? (
            <p className="smuted">No supply cap — units wait here until they are sent forward.</p>
          ) : isSea(node.id) ? (
            <p className="smuted">Transit only: land units pass through but cannot fight here.</p>
          ) : null}
          {PLAYERS.map((p) => (
            <NodeSide key={p} nodeId={node.id} owner={p} />
          ))}
          <p className="smuted spanel__adj">Paths to {node.adjacency.join(', ')}</p>
        </div>
      )}

      <button type="button" className="sbtn sbtn--ghost" onClick={reset}>
        Restart map
      </button>

      <ol className="slog">
        {log.map((e) => (
          <li key={e.id} className={`slog__${e.kind}`}>
            {e.text}
          </li>
        ))}
      </ol>
    </aside>
  );
}

import { NODE_BY_ID, isAsymmetric, isSea, isStaging, slotsFor, type NodeId } from '../engine/map';
import {
  ACTIONS_PER_TURN,
  MAX_ARMIES,
  MAX_LOOSE_MOVE,
  armiesAt,
  armyCount,
  armyUnits,
  canReorganize,
  controlFor,
  looseAt,
  occupies,
  reconAt,
  sideOf,
  supplyCap,
  supplyUsed,
  type StrategicState,
} from '../engine/strategic';
import { coinAsset, otherPlayer, playerLabel, type Player } from '../engine/types';
import type { UnitType } from '../engine/units';
import { useStrategicStore } from '../state/strategicStore';
import { useSession } from '../state/sessionStore';
import { ReorgDialog } from './ReorgDialog';
import './StrategicPanel.css';

const PLAYERS: Player[] = ['p1', 'p2'];

const cap = (n: number) => (n === Infinity ? '∞' : n);

/** One chip per unit type, since units of a type are interchangeable here. */
function byType(units: { id: string; type: UnitType }[]): [UnitType, string[]][] {
  const m = new Map<UnitType, string[]>();
  for (const u of units) m.set(u.type, [...(m.get(u.type) ?? []), u.id]);
  return [...m];
}

/** An army: its coins, its strength, and the free split-off control. */
function ArmyRow({ s, armyId, mine }: { s: StrategicState; armyId: string; mine: boolean }) {
  const sel = useStrategicStore((st) => st.sel);
  const selectArmy = useStrategicStore((st) => st.selectArmy);
  const split = useStrategicStore((st) => st.split);
  const units = armyUnits(s, armyId);
  const held = sel?.kind === 'army' && sel.armyId === armyId;

  return (
    <div className={`army${held ? ' army--sel' : ''}`}>
      <button
        type="button"
        className="army__grab"
        onClick={() => selectArmy(armyId)}
        disabled={!mine}
        title={mine ? 'Pick this army up' : undefined}
      >
        <span className="army__n">{units.length}</span>
        <span className="army__coins">
          {byType(units).map(([type, ids]) => (
            <span key={type} className="army__coin">
              <img src={coinAsset(type, s.units[ids[0]].owner)} alt={type} title={type} />
              {ids.length > 1 && <span className="army__x">{ids.length}</span>}
            </span>
          ))}
        </span>
      </button>
      {mine && units.length > 1 && (
        // Splitting costs no action, so it is a plain control rather than
        // something the reorganization table has to be opened for.
        <button
          type="button"
          className="army__split"
          onClick={() => split([units[units.length - 1].id])}
          title="Split one unit off — free, no action"
        >
          split
        </button>
      )}
    </div>
  );
}

function NodeSide({ nodeId, owner, mine }: { nodeId: NodeId; owner: Player; mine: boolean }) {
  const s = useSession((st) => st.room.strategic);
  const sel = useStrategicStore((st) => st.sel);
  const toggleLoose = useStrategicStore((st) => st.toggleLoose);
  const armies = armiesAt(s, nodeId, owner);
  const loose = looseAt(s, nodeId, owner);
  const recon = reconAt(s, nodeId, owner);
  const control = controlFor(s, nodeId, owner);
  const used = supplyUsed(s, nodeId, owner);
  const limit = supplyCap(s, nodeId, owner);
  const over = used > limit;

  if (armies.length === 0 && loose.length === 0 && recon.length === 0) {
    return (
      <div className="side">
        <div className="side__head">
          <span className={`side__who side__who--${owner}`}>{playerLabel(owner)}</span>
        </div>
        <p className="side__empty">Empty</p>
      </div>
    );
  }

  return (
    <div className="side">
      <div className="side__head">
        <span className={`side__who side__who--${owner}`}>{playerLabel(owner)}</span>
        <span className="side__slots">
          <span className={`ctl ctl--${control}`}>{control}</span>
          <span className={over ? 'supply supply--over' : 'supply'}>
            {used} / {cap(limit)}
          </span>
        </span>
      </div>

      {armies.map((a) => (
        <ArmyRow key={a.id} s={s} armyId={a.id} mine={mine} />
      ))}

      {loose.length > 0 && (
        <div className="loose">
          <div className="loose__head">
            Disorganized · {loose.length}
            <span className="loose__cost">1 supply</span>
          </div>
          <div className="side__units">
            {byType(loose).map(([type, ids]) => {
              // Show one chip per unit, not per type: the pair you may move has
              // to be picked out individually.
              return ids.map((id) => {
                const picked = sel?.kind === 'loose' && sel.unitIds.includes(id);
                return (
                  <button
                    key={id}
                    type="button"
                    className={`ustack ustack--loose${picked ? ' ustack--sel' : ''}`}
                    onClick={() => toggleLoose(id)}
                    disabled={!mine}
                    title={type}
                  >
                    <img src={coinAsset(type, owner)} alt={type} />
                  </button>
                );
              });
            })}
          </div>
        </div>
      )}

      {recon.length > 0 && (
        <div className="loose">
          <div className="loose__head">
            Recon · {recon.length}
            <span className="loose__cost">no supply</span>
          </div>
          <div className="side__units">
            {recon.map((u) => {
              const picked = sel?.kind === 'loose' && sel.unitIds.includes(u.id);
              return (
                <button
                  key={u.id}
                  type="button"
                  className={`ustack ustack--recon${picked ? ' ustack--sel' : ''}`}
                  onClick={() => toggleLoose(u.id)}
                  disabled={!mine}
                  title="Recon — moves alone, ignores enemy armies"
                >
                  <img src={coinAsset(u.type, owner)} alt={u.type} />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function StrategicPanel() {
  const s = useSession((st) => st.room.strategic);
  const seat = useSession((st) => st.seat);
  const sel = useStrategicStore((st) => st.sel);
  const inspected = useStrategicStore((st) => st.inspectedNode);
  const reorgNode = useStrategicStore((st) => st.reorgNode);
  const openReorg = useStrategicStore((st) => st.openReorg);
  const swapSide = useStrategicStore((st) => st.swapSide);
  const error = useSession((st) => st.error);
  const clearError = useSession((st) => st.clearError);
  const endTurn = useStrategicStore((st) => st.endTurn);
  const reset = useStrategicStore((st) => st.reset);

  const node = inspected ? NODE_BY_ID[inspected] : undefined;
  const log = [...s.log].reverse();
  // Whose eyes this panel is written for: your seat online, the mover in hotseat.
  const eye: Player = seat ?? s.turn;
  const yours = eye === s.turn;
  const canOrg = node ? canReorganize(s, node.id, s.turn) && yours : false;
  const mySide = node ? sideOf(s, node.id, s.turn) : 'p1';
  // Crossing needs an asymmetric node you hold and the enemy does not — the
  // engine says the same, this only decides whether to offer the button.
  const canSwap =
    !!node &&
    yours &&
    isAsymmetric(node.id) &&
    armiesAt(s, node.id, s.turn).length + looseAt(s, node.id, s.turn).length > 0 &&
    !occupies(s, node.id, otherPlayer(s.turn));

  return (
    <aside className="spanel">
      <div className="spanel__section">
        <div className={`sturn sturn--${s.turn}`}>
          Round {s.round} · <b>{playerLabel(s.turn)}</b> · {s.actionsLeft} of {ACTIONS_PER_TURN}{' '}
          action{s.actionsLeft === 1 ? '' : 's'} left
        </div>

        {sel?.kind === 'army' ? (
          <p className="shint">
            Holding an army of <b>{armyUnits(s, sel.armyId).length}</b>. <b>Right-click</b> a
            highlighted location to send it there; left-click anywhere to let it go.
          </p>
        ) : sel?.kind === 'loose' ? (
          <p className="shint">
            Holding <b>{sel.unitIds.length}</b> disorganized unit
            {sel.unitIds.length === 1 ? '' : 's'}
            {sel.unitIds.length < MAX_LOOSE_MOVE && ` — you may take ${MAX_LOOSE_MOVE} at once`}.{' '}
            <b>Right-click</b> a highlighted location to send them; they cannot walk onto an enemy
            army.
          </p>
        ) : (
          <p className="shint">
            Left-click an army to pick it up, or a location to see who holds it. Right-click sends
            what you are holding. Armies move whole; disorganized units move {MAX_LOOSE_MOVE} at a
            time. Each move costs one action.
          </p>
        )}

        <p className="smuted spanel__armies">
          {playerLabel(s.turn)} fields {armyCount(s, s.turn)} of {MAX_ARMIES} armies.
        </p>

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

          {isStaging(node.id) ? (
            <p className="smuted">
              No supply cap, and always yours to reorganize in — however close the enemy gets.
            </p>
          ) : isSea(node.id) ? (
            <p className="smuted">
              Transit only: land units pass through, but no battle happens here and nobody
              reorganizes at sea. Supplies 2.
            </p>
          ) : null}

          {PLAYERS.map((p) => (
            <NodeSide key={p} nodeId={node.id} owner={p} mine={p === eye} />
          ))}

          {/* Node-scoped actions live here rather than on the map: the map keeps
              to two gestures, and this panel already shows what the action acts
              on. Phase 7's "attack the enemy sharing this node" joins them. */}
          {canSwap && (
            <button type="button" className="sbtn" onClick={() => swapSide(node.id)}>
              Cross to the {slotsFor(node.id, otherPlayer(mySide))}-slot side (1 action)
            </button>
          )}
          {canOrg && (
            <button type="button" className="sbtn" onClick={() => openReorg(node.id)}>
              Reorganize here (1 action)
            </button>
          )}
          {!canOrg && !isSea(node.id) && eye === s.turn && (
            <p className="smuted spanel__adj">
              Reorganizing needs an army of yours here and no enemy in an adjacent location.
            </p>
          )}

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

      {reorgNode && <ReorgDialog nodeId={reorgNode} />}
    </aside>
  );
}

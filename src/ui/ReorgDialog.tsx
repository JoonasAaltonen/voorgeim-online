// The reorganization table, as a board: one column per place a unit can end up,
// and you move units between them.
//
// The board is not a new model — `Reassignment` is already `unitId → the column
// it sits in` (an army id, `NEW_ARMY`, or null for disorganized), so columns are
// a truer rendering of the object the engine already takes. Nothing below the UI
// changes shape because of this file.
//
// Reorganizing is a strategic *action*, not a phase — one of the two things a
// turn can be spent on — so it hangs off the node the player is looking at, and
// charges on commit.

import { useState } from 'react';
import { NODE_BY_ID, isStaging, type NodeId } from '../engine/map';
import {
  MAX_ARMIES,
  NEW_ARMY,
  armiesAt,
  armyCount,
  isRecon,
  slotCap,
  supplyCap,
  armyUnits,
  unitsAtFor,
  type Reassignment,
} from '../engine/strategic';
import { coinAsset, playerLabel } from '../engine/types';
import { useSession } from '../state/sessionStore';
import { useStrategicStore } from '../state/strategicStore';
import './ReorgDialog.css';

/** Where a unit can land. Null is disorganized; `NEW_ARMY` is the army being formed. */
type Target = string | null;

interface Column {
  key: string;
  target: Target;
  label: string;
  hint?: string;
}

/** Armies have generated ids; players need a name they can hold in their head. */
const armyName = (i: number) => `Army ${i + 1}`;

/**
 * `splitArmy` turns this into the free split-off table: one army's units, and a
 * single place to put them down. Splitting is free and legal anywhere, so it must
 * *not* become a free reorganization — hence only the two columns, and no way to
 * move a unit into an army.
 */
export function ReorgDialog({
  nodeId,
  free = false,
  splitArmy,
}: {
  nodeId: NodeId;
  free?: boolean;
  splitArmy?: string;
}) {
  const s = useSession((st) => st.room.strategic);
  const closeNormal = useStrategicStore((st) => st.closeReorg);
  const closeFree = useStrategicStore((st) => st.closeFreeReorg);
  const commitNormal = useStrategicStore((st) => st.reorganize);
  const commitFree = useStrategicStore((st) => st.commitFreeReorg);
  const doSplit = useStrategicStore((st) => st.split);
  const closeSplit = useStrategicStore((st) => st.closeSplit);
  const close = splitArmy ? closeSplit : free ? closeFree : closeNormal;

  const player = s.turn;
  const armies = armiesAt(s, nodeId, player);
  // Recon never joins an army, so it is not part of this table. The free
  // post-battle reshuffle covers only units that came back organized — a
  // withdrawn unit is disorganized now and needs a full reorganization to re-form.
  const units = (splitArmy ? armyUnits(s, splitArmy) : unitsAtFor(s, nodeId, player))
    .filter((u) => !isRecon(u) && (!free || !!u.armyId))
    .sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));

  // The board opens showing the node exactly as it stands, so committing without
  // moving anything is the "just re-hide everything" case the rules call out.
  const [assign, setAssign] = useState<Reassignment>(() =>
    Object.fromEntries(units.map((u) => [u.id, u.armyId ?? null])),
  );
  /** The unit picked up — by drag, or by click, which do the same thing. */
  const [held, setHeld] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  // "Only one new army can be created during a single reorganization action", so
  // there is exactly one column for it, and none at all when the cap is reached.
  const canForm = armyCount(s, player) < MAX_ARMIES;
  const columns: Column[] = splitArmy
    ? [
        {
          key: splitArmy,
          target: splitArmy,
          label: armyName(armies.findIndex((a) => a.id === splitArmy)),
          hint: 'stays organized',
        },
        { key: 'loose', target: null, label: 'Split off', hint: 'becomes disorganized' },
      ]
    : [
        { key: 'loose', target: null, label: 'Disorganized', hint: '1 supply between them' },
        ...armies.map((a, i) => ({ key: a.id, target: a.id, label: armyName(i) })),
        ...(canForm
          ? [{ key: NEW_ARMY, target: NEW_ARMY, label: 'New army', hint: 'forming' }]
          : []),
      ];

  const drop = (target: Target, unitId = held) => {
    if (!unitId) return;
    setAssign((a) => ({ ...a, [unitId]: target }));
    setHeld(null);
    setOver(null);
  };

  const inColumn = (target: Target) => units.filter((u) => assign[u.id] === target);

  // What the node will look like if this is committed — the same arithmetic the
  // engine runs when the turn ends, shown before it costs anything.
  const looseAfter = inColumn(null).length;
  const usedAfter = units.length - looseAfter + (looseAfter > 0 ? 1 : 0);
  const limit = supplyCap(s, nodeId, player);
  const over_ = usedAfter > limit;

  // Division spots are the other limit, and the harder one: supply says how many
  // units the node feeds, spots say how many *armies* it has room to stand. Every
  // army here is represented in the table, so the columns in use are the count.
  // Splitting only ever dissolves armies, so it cannot crowd a node.
  const spots = slotCap(s, nodeId, player);
  const armiesAfter = new Set(units.map((u) => assign[u.id]).filter((t) => t !== null)).size;
  const crowded = !splitArmy && armiesAfter > spots;

  return (
    <div className="reorg" role="dialog" aria-modal="true" aria-label="Reorganize">
      <div className="reorg__box">
        <div className="reorg__head">
          <b>
            {splitArmy ? 'Split off units' : free ? 'Re-sort the victors' : 'Reorganize'} —{' '}
            {isStaging(nodeId) ? `${playerLabel(player)} staging area` : NODE_BY_ID[nodeId].id}
          </b>
          <button type="button" className="reorg__x" onClick={close} aria-label="Close">
            ✕
          </button>
        </div>

        <p className="reorg__note">
          Drag units between the columns, or click one and then click where it should go.
          {splitArmy ? (
            <>
              {' '}
              Choose which units leave the army — <b>you</b> pick, not the stack order. Free, and
              it costs no action; they become disorganized where they stand.
            </>
          ) : (
            <>
              {' '}
              It may form <b>one</b> new army — however many units join it.
              {free
                ? ' Free after the battle, and it costs no action; the survivors stay revealed unless this location is controlled.'
                : ' One action.'}
              {!canForm && ` You already field ${MAX_ARMIES} armies, so no new one can form.`}
            </>
          )}
        </p>

        <div className="reorg__board">
          {columns.map((col) => {
            const members = inColumn(col.target);
            return (
              <section
                key={col.key}
                className={`rcol${over === col.key ? ' rcol--over' : ''}${
                  held ? ' rcol--open' : ''
                }`}
                onDragOver={(e) => {
                  // Without this the drop never fires at all — the default is to
                  // refuse.
                  e.preventDefault();
                  setOver(col.key);
                }}
                onDragLeave={(e) => {
                  // The chips inside are drag sources, so crossing onto one fires
                  // a leave on the column. Only a leave that actually exits the
                  // column counts.
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  drop(col.target, e.dataTransfer.getData('text/plain') || held);
                }}
                onClick={() => drop(col.target)}
                // Reachable by keyboard only while something is in hand, so the
                // tab order stays quiet the rest of the time.
                tabIndex={held ? 0 : -1}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  e.preventDefault();
                  drop(col.target);
                }}
              >
                <header className="rcol__head">
                  <span className="rcol__name">{col.label}</span>
                  <span className="rcol__n">{members.length}</span>
                </header>
                {col.hint && <span className="rcol__hint">{col.hint}</span>}
                <div className="rcol__body">
                  {members.map((u) => (
                    // A div rather than a button on purpose: `draggable` on a
                    // <button> does not reliably start a drag in Firefox, so the
                    // role and key handling are spelled out instead.
                    <div
                      key={u.id}
                      role="button"
                      tabIndex={0}
                      aria-pressed={held === u.id}
                      className={`rchip${held === u.id ? ' rchip--held' : ''}`}
                      draggable
                      onDragStart={(e) => {
                        // Firefox starts no drag at all unless data is set here.
                        e.dataTransfer.setData('text/plain', u.id);
                        e.dataTransfer.effectAllowed = 'move';
                        setHeld(u.id);
                      }}
                      onDragEnd={() => {
                        setHeld(null);
                        setOver(null);
                      }}
                      onClick={(e) => {
                        e.stopPropagation(); // the column would otherwise drop it right back
                        setHeld(held === u.id ? null : u.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter' && e.key !== ' ') return;
                        e.preventDefault();
                        e.stopPropagation();
                        setHeld(held === u.id ? null : u.id);
                      }}
                      title={u.wounded ? `${u.type} — wounded` : u.type}
                    >
                      <img src={coinAsset(u.type, player)} alt={u.type} />
                      {u.wounded && <span className="rchip__wound" aria-hidden>✚</span>}
                    </div>
                  ))}
                  {members.length === 0 && <span className="rcol__empty">—</span>}
                </div>
              </section>
            );
          })}
        </div>

        <div className={over_ ? 'reorg__supply reorg__supply--over' : 'reorg__supply'}>
          Supply {usedAfter} / {limit === Infinity ? '∞' : limit}
          {over_ && ' — the excess disorganizes when your turn ends'}
        </div>

        {!splitArmy && (
          <div className={crowded ? 'reorg__supply reorg__supply--over' : 'reorg__supply'}>
            Division spots {armiesAfter} / {spots === Infinity ? '∞' : spots}
            {crowded && ' — there is nowhere to stand that many armies'}
          </div>
        )}

        <div className="reorg__actions">
          <button type="button" className="sbtn sbtn--ghost" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="sbtn"
            disabled={crowded}
            onClick={() =>
              splitArmy
                ? doSplit(units.filter((u) => assign[u.id] === null).map((u) => u.id))
                : (free ? commitFree : commitNormal)(assign)
            }
          >
            {splitArmy ? 'Split off (free)' : free ? 'Re-sort (free)' : 'Reorganize (1 action)'}
          </button>
        </div>
      </div>
    </div>
  );
}

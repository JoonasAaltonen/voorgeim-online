import { MAP, NODE_BY_ID, isStaging, spotsFor, type MapNode, type NodeId } from '../engine/map';
import {
  armiesAt,
  armyUnits,
  controlFor,
  legalArmyTargets,
  legalLooseTargets,
  looseAt,
  reconAt,
  sideOf,
  unitsAt,
  type StrategicState,
} from '../engine/strategic';
import { coinAsset, playerLabel, type Player } from '../engine/types';
import { useStrategicStore } from '../state/strategicStore';
import { useSession } from '../state/sessionStore';
import './StrategicMap.css';

const PLAYERS: Player[] = ['p1', 'p2'];

/**
 * Division spots sit about 52px apart, but a controlled slot supplies six units:
 * six coins will not fit one spot at any legible size. So the map draws one
 * framed chip per army carrying its strength, and leaves composition to the
 * panel — which is also the only thing that can survive Phase 6, where an enemy
 * army is face down and has no composition to show.
 */
const ARMY_R = 21;
const LOOSE_R = 14;
const RECON_R = 13;
/** Armies may outnumber a node's slots, so extras stack below the spot row. */
const ROW_H = 46;

function ArmyChips({
  s,
  node,
  owner,
  mine,
}: {
  s: StrategicState;
  node: MapNode;
  owner: Player;
  mine: boolean;
}) {
  const sel = useStrategicStore((st) => st.sel);
  const selectArmy = useStrategicStore((st) => st.selectArmy);
  const armies = armiesAt(s, node.id, owner);
  // The side they hold, which in an asymmetric node need not be their own.
  const spots = spotsFor(node.id, sideOf(s, node.id, owner));
  if (armies.length === 0 || spots.length === 0) return null;

  return (
    <>
      {armies.map((a, i) => {
        const anchor = spots[i % spots.length];
        const y = anchor.y + Math.floor(i / spots.length) * ROW_H;
        const n = armyUnits(s, a.id).length;
        const held = sel?.kind === 'army' && sel.armyId === a.id;
        return (
          <g
            key={a.id}
            className={`smap__army smap__army--${owner}${held ? ' smap__army--sel' : ''}${
              mine ? ' smap__army--mine' : ''
            }`}
            onClick={(e) => {
              // Left-click is always "select this", never "move here" — that is
              // what right-click is for. An enemy chip has nothing to select, so
              // its click falls through to the node and merely opens it.
              if (!mine) return;
              e.stopPropagation();
              selectArmy(a.id);
            }}
          >
            <rect x={anchor.x - ARMY_R} y={y - ARMY_R} width={ARMY_R * 2} height={ARMY_R * 2} rx={7} />
            <text x={anchor.x} y={y + 7}>
              {n}
            </text>
            <title>{`${playerLabel(owner)} army of ${n}`}</title>
          </g>
        );
      })}
    </>
  );
}

/**
 * The player's loose units as one dashed chip (they act as a pile), and recon
 * beside it as coins — recon is neither in an army nor disorganized, costs no
 * supply, and there are only ever two, so it is worth showing as itself.
 */
function StragglerChips({ s, node, owner }: { s: StrategicState; node: MapNode; owner: Player }) {
  const loose = looseAt(s, node.id, owner);
  const recon = reconAt(s, node.id, owner);
  const spots = spotsFor(node.id, sideOf(s, node.id, owner));
  if ((loose.length === 0 && recon.length === 0) || spots.length === 0) return null;

  const rows = Math.ceil(armiesAt(s, node.id, owner).length / spots.length);
  const x = spots[0].x;
  const y = spots[0].y + Math.max(rows, 1) * ROW_H;

  return (
    <>
      {loose.length > 0 && (
        <g className={`smap__loose smap__loose--${owner}`}>
          <circle cx={x} cy={y} r={LOOSE_R} />
          <text x={x} y={y + 5}>
            {loose.length}
          </text>
          <title>{`${playerLabel(owner)}: ${loose.length} disorganized`}</title>
        </g>
      )}
      {recon.map((u, i) => (
        <image
          key={u.id}
          className="smap__recon"
          href={coinAsset(u.type, owner)}
          x={x + (loose.length > 0 ? LOOSE_R + 4 : -RECON_R) + i * (RECON_R * 2 + 2)}
          y={y - RECON_R}
          width={RECON_R * 2}
          height={RECON_R * 2}
        >
          <title>{`${playerLabel(owner)} recon — no supply`}</title>
        </image>
      ))}
    </>
  );
}

/** A staging area holds an uncapped pile, so it shows a count rather than coins. */
function StagingStack({ s, node }: { s: StrategicState; node: MapNode }) {
  const n = unitsAt(s, node.id).length;
  const armies = armiesAt(s, node.id, node.staging!).length;
  return (
    <g className={`smap__stage smap__stage--${node.staging}`}>
      <circle cx={node.coord.x} cy={node.coord.y} r="46" />
      <text x={node.coord.x} y={node.coord.y - 8}>{node.staging!.toUpperCase()}</text>
      <text x={node.coord.x} y={node.coord.y + 16} className="smap__stagecount">{n}</text>
      <text x={node.coord.x} y={node.coord.y + 34} className="smap__stagearmies">
        {armies} {armies === 1 ? 'army' : 'armies'}
      </text>
    </g>
  );
}

export function StrategicMap() {
  const s = useSession((st) => st.room.strategic);
  const seat = useSession((st) => st.seat);
  const sel = useStrategicStore((st) => st.sel);
  const inspected = useStrategicStore((st) => st.inspectedNode);
  const nodeClicked = useStrategicStore((st) => st.nodeClicked);
  const nodeCommanded = useStrategicStore((st) => st.nodeCommanded);

  let targets: NodeId[] = [];
  let origin: NodeId | null = null;
  if (sel?.kind === 'army') {
    targets = legalArmyTargets(s, sel.armyId);
    origin = armyUnits(s, sel.armyId)[0]?.nodeId ?? null;
  } else if (sel?.kind === 'loose') {
    // Both units are in the same node by construction, so either answers for both.
    targets = legalLooseTargets(s, sel.unitIds[0]);
    origin = s.units[sel.unitIds[0]]?.nodeId ?? null;
  }
  const targetSet = new Set(targets);

  // Which armies are yours to pick up: your seat online, the mover in hotseat.
  // Control is *not* filtered this way — it is drawn for both sides, because it
  // follows from armies both players can already see, so hiding one side's would
  // only make the reader derive what the map could just show.
  const eye: Player = seat ?? s.turn;

  return (
    // Right-click is a game action here, so the native menu is suppressed — but
    // only over the map. The panel and the log keep theirs.
    <div className="smap" onContextMenu={(e) => e.preventDefault()}>
      <svg
        className="smap__svg"
        viewBox={`0 0 ${MAP.image.width} ${MAP.image.height}`}
        role="img"
        aria-label="Strategic map"
      >
        <image href="/assets/strategic-map-figma.svg" width={MAP.image.width} height={MAP.image.height} />

        {/* Trace the paths the selection may take, over the map's own path art. */}
        {origin &&
          targets.map((t) => (
            <line
              key={t}
              className="smap__path"
              x1={NODE_BY_ID[origin].coord.x}
              y1={NODE_BY_ID[origin].coord.y}
              x2={NODE_BY_ID[t].coord.x}
              y2={NODE_BY_ID[t].coord.y}
            />
          ))}

        {MAP.nodes.map((n) => {
          // At most one, always: control requires no enemy in the node either, so
          // two sides can never both hold one.
          const holder = isStaging(n.id)
            ? undefined
            : PLAYERS.find((p) => controlFor(s, n.id, p) === 'controlled');
          const cls = [
            'smap__node',
            targetSet.has(n.id) ? 'smap__node--target' : '',
            inspected === n.id ? 'smap__node--inspect' : '',
            origin === n.id ? 'smap__node--origin' : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <g
              key={n.id}
              className={cls}
              onClick={() => nodeClicked(n.id)}
              onContextMenu={() => nodeCommanded(n.id)}
            >
              {/* A generous hit area: the whole node, not just its chips. */}
              <circle className="smap__hit" cx={n.coord.x} cy={n.coord.y} r="58" />
              {holder && (
                <circle
                  className={`smap__held smap__held--${holder}`}
                  cx={n.coord.x}
                  cy={n.coord.y}
                  r="54"
                />
              )}
              {targetSet.has(n.id) && (
                <circle className="smap__ring" cx={n.coord.x} cy={n.coord.y} r="52" />
              )}
              {isStaging(n.id) ? (
                <StagingStack s={s} node={n} />
              ) : (
                PLAYERS.map((p) => (
                  <g key={p}>
                    <ArmyChips s={s} node={n} owner={p} mine={p === eye} />
                    <StragglerChips s={s} node={n} owner={p} />
                  </g>
                ))
              )}
              <text className="smap__id" x={n.coord.x} y={n.coord.y + 76}>
                {n.id}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

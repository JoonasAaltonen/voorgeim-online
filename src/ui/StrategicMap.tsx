import { MAP, NODE_BY_ID, isStaging, spotsFor, type MapNode, type NodeId } from '../engine/map';
import { legalMoveTargets, unitsAt, unitsAtFor, type StrategicState } from '../engine/strategic';
import { coinAsset, type Player } from '../engine/types';
import { useStrategicStore } from '../state/strategicStore';
import './StrategicMap.css';

/** Half the gap between neighbouring division spots, so coins sit in their slot. */
const COIN_R = 24;
const PLAYERS: Player[] = ['p1', 'p2'];

/** Units a player holds in a node, drawn on that player's own division spots. */
function NodeUnits({ s, node, owner }: { s: StrategicState; node: MapNode; owner: Player }) {
  const selectedId = useStrategicStore((st) => st.selectedId);
  const selectUnit = useStrategicStore((st) => st.selectUnit);
  const units = unitsAtFor(s, node.id, owner);
  if (units.length === 0) return null;

  const spots = spotsFor(node.id, owner);
  const shown = units.slice(0, spots.length);
  const extra = units.length - shown.length;

  return (
    <>
      {shown.map((u, i) => (
        <image
          key={u.id}
          className={`smap__coin${selectedId === u.id ? ' smap__coin--sel' : ''}`}
          href={coinAsset(u.type, u.owner)}
          x={spots[i].x - COIN_R}
          y={spots[i].y - COIN_R}
          width={COIN_R * 2}
          height={COIN_R * 2}
          onClick={(e) => {
            e.stopPropagation();
            selectUnit(selectedId === u.id ? null : u.id);
          }}
        >
          <title>{`${u.owner} ${u.type}`}</title>
        </image>
      ))}
      {extra > 0 && (
        <g className="smap__more" transform={`translate(${spots.at(-1)!.x + 16} ${spots.at(-1)!.y - 20})`}>
          <circle r="15" />
          <text dy="5">+{extra}</text>
        </g>
      )}
    </>
  );
}

/** A staging area holds an uncapped pile, so it shows a count rather than coins. */
function StagingStack({ s, node }: { s: StrategicState; node: MapNode }) {
  const n = unitsAt(s, node.id).length;
  return (
    <g className={`smap__stage smap__stage--${node.staging}`}>
      <circle cx={node.coord.x} cy={node.coord.y} r="46" />
      <text x={node.coord.x} y={node.coord.y - 4}>{node.staging!.toUpperCase()}</text>
      <text x={node.coord.x} y={node.coord.y + 22} className="smap__stagecount">{n}</text>
    </g>
  );
}

export function StrategicMap() {
  const s = useStrategicStore((st) => st.strategic);
  const selectedId = useStrategicStore((st) => st.selectedId);
  const inspected = useStrategicStore((st) => st.inspectedNode);
  const nodeClicked = useStrategicStore((st) => st.nodeClicked);

  const targets = new Set<NodeId>(selectedId ? legalMoveTargets(s, selectedId) : []);
  const origin = selectedId ? s.units[selectedId].nodeId : null;

  return (
    <div className="smap">
      <svg
        className="smap__svg"
        viewBox={`0 0 ${MAP.image.width} ${MAP.image.height}`}
        role="img"
        aria-label="Strategic map"
      >
        <image href="/assets/strategic-map-figma.svg" width={MAP.image.width} height={MAP.image.height} />

        {/* Trace the paths the selected unit may take, over the map's own path art. */}
        {origin &&
          [...targets].map((t) => (
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
          const cls = [
            'smap__node',
            targets.has(n.id) ? 'smap__node--target' : '',
            inspected === n.id ? 'smap__node--inspect' : '',
            origin === n.id ? 'smap__node--origin' : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <g key={n.id} className={cls} onClick={() => nodeClicked(n.id)}>
              {/* A generous hit area: the whole node, not just its coins. */}
              <circle className="smap__hit" cx={n.coord.x} cy={n.coord.y} r="58" />
              {targets.has(n.id) && (
                <circle className="smap__ring" cx={n.coord.x} cy={n.coord.y} r="52" />
              )}
              {isStaging(n.id) ? (
                <StagingStack s={s} node={n} />
              ) : (
                PLAYERS.map((p) => <NodeUnits key={p} s={s} node={n} owner={p} />)
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

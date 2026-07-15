import { BOARD, CELL_RADIUS, SUPPORT_RADIUS, boardCells } from '../engine/board';
import { coinAsset, isSupportUnit, PLAYER_SIDE } from '../engine/types';
import { currentDeployer, attackTargetIds, moveTargetCells, indirectTargetIds } from '../engine/battle';
import { useBattleStore, occupantOf } from '../state/battleStore';
import './BattleBoard.css';

const CELLS = boardCells();
const pct = (v: number, total: number) => `${(v / total) * 100}%`;

type Highlight = 'deploy' | 'attack' | 'move';

export function BattleBoard() {
  const battle = useBattleStore((s) => s.battle);
  const selectedId = useBattleStore((s) => s.selectedId);
  const select = useBattleStore((s) => s.select);
  const deployTo = useBattleStore((s) => s.deployTo);
  const attackTarget = useBattleStore((s) => s.attackTarget);
  const indirectFire = useBattleStore((s) => s.indirectFire);
  const moveTo = useBattleStore((s) => s.moveTo);

  const highlights: Record<string, Highlight> = {};
  const sel = battle && selectedId ? battle.units[selectedId] : undefined;

  if (battle && sel) {
    if (battle.phase === 'deployment' && sel.status === 'reserve' && sel.owner === currentDeployer(battle)) {
      if (isSupportUnit(sel)) {
        const slot = `${PLAYER_SIDE[sel.owner]}-support`;
        if (!occupantOf(battle, slot)) highlights[slot] = 'deploy';
      } else {
        for (const c of CELLS) {
          if (c.kind === 'grid' && c.side === PLAYER_SIDE[sel.owner] && c.row === battle.deploy!.row && !occupantOf(battle, c.id)) {
            highlights[c.id] = 'deploy';
          }
        }
      }
    } else if (battle.phase === 'battle' && sel.status === 'deployed' && sel.owner === battle.turn) {
      const targetIds = isSupportUnit(sel)
        ? indirectTargetIds(battle, sel.id)
        : attackTargetIds(battle, sel.id);
      for (const tid of targetIds) {
        const cid = battle.units[tid].cellId;
        if (cid) highlights[cid] = 'attack';
      }
      if (!isSupportUnit(sel)) {
        for (const cid of moveTargetCells(battle, sel.id)) highlights[cid] = 'move';
      }
    }
  }

  function onCell(cellId: string) {
    if (!battle) return;
    const occ = occupantOf(battle, cellId);
    const hl = highlights[cellId];
    if (battle.phase === 'deployment') {
      if (hl === 'deploy') deployTo(cellId);
      return;
    }
    if (battle.phase === 'battle') {
      if (occ && occ.owner === battle.turn) {
        select(occ.id);
        return;
      }
      if (sel) {
        if (occ && hl === 'attack') {
          if (isSupportUnit(sel)) indirectFire(occ.id);
          else attackTarget(occ.id);
        } else if (!occ && hl === 'move') {
          moveTo(cellId);
        }
      }
    }
  }

  return (
    <div className="battle-board">
      <img className="battle-board__bg" src="/assets/battle-board.svg" alt="Battle board" />

      {CELLS.map((cell) => {
        const occ = battle ? occupantOf(battle, cell.id) : undefined;
        const r = cell.kind === 'support' ? SUPPORT_RADIUS : CELL_RADIUS;
        const hl = highlights[cell.id];
        const isSel = occ && occ.id === selectedId;
        return (
          <button
            key={cell.id}
            type="button"
            className={`bcell${hl ? ` bcell--${hl}` : ''}${isSel ? ' bcell--selected' : ''}`}
            onClick={() => onCell(cell.id)}
            style={{
              left: pct(cell.x, BOARD.width),
              top: pct(cell.y, BOARD.height),
              width: pct(r * 2, BOARD.width),
              height: pct(r * 2, BOARD.height),
            }}
            title={occ ? `${occ.owner} ${occ.type} · ${occ.hp} HP${occ.wounded ? ' (wounded)' : ''}` : cell.id}
          >
            {occ && (
              <img
                className="bcell__coin"
                src={occ.wounded ? coinAsset('wounded', occ.owner) : coinAsset(occ.type, occ.owner)}
                alt={occ.type}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

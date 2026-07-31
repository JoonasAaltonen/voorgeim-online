import { useEffect, useRef, useState } from 'react';
import { BOARD, CELL_RADIUS, SUPPORT_RADIUS, boardCells } from '../engine/board';
import { coinAsset, isSupportUnit, PLAYER_SIDE } from '../engine/types';
import {
  currentDeployer,
  attackTargetIds,
  moveTargetCells,
  indirectTargetIds,
  type BattleState,
  type CombatEntry,
} from '../engine/battle';
import { useBattleStore, occupantOf, FORT_SELECTION } from '../state/battleStore';
import { useSession } from '../state/sessionStore';
import './BattleBoard.css';

const CELLS = boardCells();
const pct = (v: number, total: number) => `${(v / total) * 100}%`;

type Highlight = 'deploy' | 'attack' | 'move';

/** How long the two cells of the last exchange stay ringed. */
const STRIKE_MS = 2600;

/**
 * The cells of the most recent exchange, for a few seconds after it happens.
 *
 * Selection is private — only the acting player sees what they picked up — so
 * without this the opponent watches coins lose HP with no idea who shot whom.
 * The log carries the answer to *both* players identically, which is what makes
 * a purely local timer safe here: each client rings the same pair, and neither
 * needs the other to tell it to.
 *
 * The first entry seen is deliberately skipped. On a reload or a reconnect the
 * newest combat entry may be minutes old, and replaying its rings would announce
 * an attack that already happened.
 */
function useLastStrike(battle: BattleState | null): CombatEntry | null {
  const last = battle ? [...battle.log].reverse().find((e) => e.combat)?.combat : undefined;
  const lastId = battle ? [...battle.log].reverse().find((e) => e.combat)?.id : undefined;
  // Frozen at mount: whatever exchange the log already held when we started
  // watching. Held in state rather than a ref because it is read during render.
  const [baseline] = useState(lastId);
  const seen = useRef<number | undefined>(undefined);
  const [shown, setShown] = useState<CombatEntry | null>(null);

  useEffect(() => {
    if (seen.current === undefined) seen.current = baseline;
    if (lastId === undefined || lastId === seen.current) return;
    seen.current = lastId;
    setShown(last ?? null);
    const t = setTimeout(() => setShown(null), STRIKE_MS);
    return () => clearTimeout(t);
  }, [lastId, last, baseline]);

  return shown;
}

export function BattleBoard() {
  const battle = useSession((s) => s.room.battle);
  const selectedId = useBattleStore((s) => s.selectedId);
  const select = useBattleStore((s) => s.select);
  const deployTo = useBattleStore((s) => s.deployTo);
  const attackTarget = useBattleStore((s) => s.attackTarget);
  const indirectFire = useBattleStore((s) => s.indirectFire);
  const moveTo = useBattleStore((s) => s.moveTo);
  const strike = useLastStrike(battle ?? null);

  const highlights: Record<string, Highlight> = {};
  const sel = battle && selectedId ? battle.units[selectedId] : undefined;

  if (battle && battle.phase === 'deployment' && selectedId === FORT_SELECTION) {
    const p = currentDeployer(battle)!;
    for (const c of CELLS) {
      if (c.kind === 'grid' && c.side === PLAYER_SIDE[p] && c.row === battle.deploy!.row && !battle.forts[c.id]) {
        highlights[c.id] = 'deploy';
      }
    }
  } else if (battle && sel) {
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
        const fort = battle?.forts[cell.id];
        // A cell can be both ends of the same exchange when the winner advanced
        // into it; the shooter's own ring wins, since that is the coin standing
        // there now.
        const struck =
          strike?.attackerCell === cell.id ? 'shooter' : strike?.defenderCell === cell.id ? 'struck' : '';
        return (
          <button
            key={cell.id}
            type="button"
            className={`bcell${hl ? ` bcell--${hl}` : ''}${isSel ? ' bcell--selected' : ''}${struck ? ` bcell--${struck}` : ''}`}
            onClick={() => onCell(cell.id)}
            style={{
              left: pct(cell.x, BOARD.width),
              top: pct(cell.y, BOARD.height),
              width: pct(r * 2, BOARD.width),
              height: pct(r * 2, BOARD.height),
            }}
            title={
              (occ ? `${occ.owner} ${occ.type} · ${occ.hp} HP${occ.wounded ? ' (wounded)' : ''}` : cell.id) +
              (fort ? ` · fortified (${fort.hp} HP)` : '')
            }
          >
            {fort && <span className={`bcell__fort bcell__fort--${cell.side}`} data-hp={fort.hp} />}
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

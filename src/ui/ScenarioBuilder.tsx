import { playerLabel, type Player } from '../engine/types';
import type { UnitType } from '../engine/units';
import { useBattleStore } from '../state/battleStore';
import { useSession } from '../state/sessionStore';
import './ScenarioBuilder.css';

const COMBAT_TYPES: Exclude<UnitType, 'recon'>[] = ['infantry', 'artillery', 'anti-tank', 'armor'];
const PLAYERS: Player[] = ['p1', 'p2'];

function SideEditor({ player }: { player: Player }) {
  const side = useSession((s) => s.room.scenario.sides[player]);
  const attacker = useSession((s) => s.room.scenario.attacker);
  const setRoster = useBattleStore((s) => s.setRoster);
  const setForts = useBattleStore((s) => s.setForts);
  const toggleSupport = useBattleStore((s) => s.toggleSupport);
  const toggleRecon = useBattleStore((s) => s.toggleRecon);

  return (
    <div className="side-editor">
      <h3>
        {playerLabel(player)} {attacker === player ? <span className="tag tag--att">attacker</span> : <span className="tag tag--def">defender</span>}
        <span className="side-editor__where">{player === 'p1' ? 'bottom' : 'top'}</span>
      </h3>
      <div className="roster">
        {COMBAT_TYPES.map((type) => (
          <label key={type} className="roster__row">
            <span>{type}</span>
            <input
              type="number"
              min={0}
              value={side.roster[type] ?? 0}
              onChange={(e) => setRoster(player, type, Number(e.target.value))}
            />
          </label>
        ))}
        <label className="roster__row">
          <span>🛡 fortifications</span>
          <input
            type="number"
            min={0}
            value={side.fortifications}
            onChange={(e) => setForts(player, Number(e.target.value))}
          />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={side.support} onChange={() => toggleSupport(player)} />
        Indirect-fire support artillery
      </label>
      <label className="check">
        <input type="checkbox" checked={side.reconRevealed} onChange={() => toggleRecon(player)} />
        Units revealed by enemy recon
      </label>
    </div>
  );
}

export function ScenarioBuilder() {
  const attacker = useSession((s) => s.room.scenario.attacker);
  const setAttacker = useBattleStore((s) => s.setAttacker);
  const startBattle = useBattleStore((s) => s.startBattle);

  return (
    <div className="scenario">
      <div className="scenario__attacker">
        <span>Attacker:</span>
        {PLAYERS.map((p) => (
          <button
            key={p}
            type="button"
            className={attacker === p ? 'is-active' : ''}
            onClick={() => setAttacker(p)}
          >
            {playerLabel(p)}
          </button>
        ))}
      </div>
      <div className="scenario__sides">
        {PLAYERS.map((p) => (
          <SideEditor key={p} player={p} />
        ))}
      </div>
      <button type="button" className="scenario__start" onClick={startBattle}>
        Start battle
      </button>
      <p className="scenario__hint">
        Recon advantage decides who deploys first. Fortifications are placed during deployment,
        one per position, and cover the front and flanks of the cell they sit on.
      </p>
    </div>
  );
}

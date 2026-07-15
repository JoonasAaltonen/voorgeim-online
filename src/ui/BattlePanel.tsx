import { coinAsset, isSupportUnit } from '../engine/types';
import { currentDeployer, reserveUnits, type BattleState, type CombatEntry } from '../engine/battle';
import type { CombatResult } from '../engine/combat';
import { useBattleStore } from '../state/battleStore';
import './BattlePanel.css';

function attackerLine(r: CombatResult): string {
  switch (r.attackerTier) {
    case 'crit-fail': return 'misses — takes 1 self';
    case 'fail': return 'misses';
    case 'partial': return `base ${r.attackerBase} −1 = ${r.dealt}`;
    case 'success': return `base ${r.attackerBase} = ${r.dealt}`;
    case 'great': return `base ${r.attackerBase} = ${r.dealt}, counter −1`;
    case 'crit': return `base ${r.attackerBase} +1 = ${r.dealt}, counter −1`;
  }
}

function defenderLine(r: CombatResult): string {
  if (!r.counterAllowed) {
    const red = r.incomingReduction ? `−${r.incomingReduction} incoming, ` : '';
    return `${red}no counter (out of reach)`;
  }
  switch (r.defenderTier) {
    case 'crit-fail': return 'fumbles — takes 1 self, no counter';
    case 'fail': return 'no counter';
    case 'partial': return `counter ${r.defenderBase} −1 = ${r.counterRaw}`;
    case 'success': return `−1 incoming, counter ${r.defenderBase} −1 = ${r.counterRaw}`;
    case 'great': return `−1 incoming, counter ${r.counterRaw}`;
    case 'crit': return `−2 incoming, counter ${r.counterRaw}`;
  }
}

function Dice({ rolls, value }: { rolls: number[]; value: number }) {
  return (
    <span className="dice">
      {rolls.map((d, i) => (
        <b key={i} className={d === value ? 'die die--max' : 'die'}>{d}</b>
      ))}
    </span>
  );
}

function CombatLogItem({ c }: { c: CombatEntry }) {
  const r = c.result;
  return (
    <div className="clog">
      <div className="clog__head">
        {c.attacker} → {c.defender}
        {c.indirect ? <em className="clog__mode"> · indirect</em> : !r.counterAllowed ? <em className="clog__mode"> · arc</em> : null}
      </div>
      <div className="clog__row">
        <span className="clog__tag clog__tag--atk">ATK</span>
        <Dice rolls={c.attackerRolls} value={r.attackerRoll} />
        <span className="clog__calc">{attackerLine(r)}</span>
      </div>
      <div className="clog__row">
        <span className="clog__tag clog__tag--def">DEF</span>
        <Dice rolls={c.defenderRolls} value={r.defenderRoll} />
        <span className="clog__calc">{defenderLine(r)}</span>
      </div>
      <div className="clog__dmg">
        ⇒ {c.defender} −{r.damageToDefender} HP · {c.attacker} −{r.damageToAttacker} HP
      </div>
    </div>
  );
}

function DeploymentControls({ battle }: { battle: BattleState }) {
  const selectedId = useBattleStore((s) => s.selectedId);
  const select = useBattleStore((s) => s.select);
  const pass = useBattleStore((s) => s.passDeploy);
  const deployer = currentDeployer(battle)!;
  const reserves = reserveUnits(battle, deployer);

  return (
    <div className="panel__section">
      <div className="turn turn--deploy">
        Deploying: <b>{deployer.toUpperCase()}</b> · front-to-back, row {battle.deploy!.row + 1} of 3
      </div>
      <div className="reserves">
        {reserves.length === 0 && <span className="muted">No units left in reserve.</span>}
        {reserves.map((u) => (
          <button
            key={u.id}
            type="button"
            className={`chip${selectedId === u.id ? ' chip--sel' : ''}`}
            onClick={() => select(u.id)}
          >
            <img src={coinAsset(u.type, u.owner)} alt="" />
            {isSupportUnit(u) ? 'support' : u.type}
          </button>
        ))}
      </div>
      <p className="hint">Pick a unit, then click a highlighted cell. Support goes in the left slot.</p>
      <button type="button" className="btn" onClick={pass}>
        {battle.deploy!.index === 0 ? 'Done placing — pass to opponent' : 'Finish this row'}
      </button>
    </div>
  );
}

function BattleControls({ battle }: { battle: BattleState }) {
  const selectedId = useBattleStore((s) => s.selectedId);
  const withdraw = useBattleStore((s) => s.withdrawSelected);
  const sel = selectedId ? battle.units[selectedId] : undefined;

  return (
    <div className="panel__section">
      <div className={`turn turn--${battle.turn}`}>
        Turn: <b>{battle.turn.toUpperCase()}</b> — take one action
      </div>
      {sel ? (
        <div className="selinfo">
          Selected: <b>{sel.owner} {isSupportUnit(sel) ? 'support artillery' : sel.type}</b> · {sel.hp} HP{sel.wounded ? ' (wounded)' : ''}
          <button type="button" className="btn btn--sm" onClick={withdraw}>Withdraw</button>
          {isSupportUnit(sel) && (
            <p className="hint">Bombard a highlighted enemy — indirect fire draws no counter, but only hits enemies your units can reach.</p>
          )}
        </div>
      ) : (
        <p className="hint">Click one of your units to select it, then attack (red) or move (blue). Artillery also fires at range; the support unit bombards.</p>
      )}
    </div>
  );
}

export function BattlePanel() {
  const battle = useBattleStore((s) => s.battle);
  const error = useBattleStore((s) => s.error);
  const clearError = useBattleStore((s) => s.clearError);
  const newScenario = useBattleStore((s) => s.newScenario);
  if (!battle) return null;

  const log = [...battle.log].reverse();

  return (
    <aside className="panel">
      {battle.phase === 'over' && (
        <div className="banner banner--win">
          {battle.winner === 'stalemate' ? 'Stalemate' : `${String(battle.winner).toUpperCase()} wins`}
        </div>
      )}

      {battle.phase === 'deployment' && <DeploymentControls battle={battle} />}
      {battle.phase === 'battle' && <BattleControls battle={battle} />}

      {error && (
        <div className="banner banner--err" onClick={clearError}>
          {error}
        </div>
      )}

      <button type="button" className="btn btn--ghost" onClick={newScenario}>
        New scenario
      </button>

      <ol className="log">
        {log.map((e) => (
          <li key={e.id} className={`log__${e.kind}`}>
            {e.combat ? <CombatLogItem c={e.combat} /> : e.text}
          </li>
        ))}
      </ol>
    </aside>
  );
}

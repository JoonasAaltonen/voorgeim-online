import { coinAsset, isSupportUnit, playerLabel } from '../engine/types';
import {
  currentDeployer,
  reserveUnits,
  stalemateLooms,
  type BattleState,
  type CombatEntry,
} from '../engine/battle';
import type { CombatResult } from '../engine/combat';
import { supportGuns } from '../engine/campaign';
import { armiesAt } from '../engine/strategic';
import type { NodeId } from '../engine/map';
import { useBattleStore, FORT_SELECTION } from '../state/battleStore';
import { useSession } from '../state/sessionStore';
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
      {c.fortDefender && (
        <div className="clog__fort">
          🛡 Fortification soaks {c.fortDefender.absorbed} for {c.defender}
          {c.fortDefender.destroyed ? ' — levelled' : ''}
        </div>
      )}
      {c.fortAttacker && (
        <div className="clog__fort">
          🛡 Fortification soaks {c.fortAttacker.absorbed} for {c.attacker}
          {c.fortAttacker.destroyed ? ' — levelled' : ''}
        </div>
      )}
      <div className="clog__dmg">
        ⇒ {c.defender} −{r.damageToDefender - (c.fortDefender?.absorbed ?? 0)} HP · {c.attacker} −
        {r.damageToAttacker - (c.fortAttacker?.absorbed ?? 0)} HP
      </div>
    </div>
  );
}

/**
 * The indirect-fire offer, shown only to the player it belongs to.
 *
 * This is the whole point of not putting support guns on the board up front: the
 * question is asked here, on your own screen, from your own side of the map, and
 * the opponent learns nothing until you answer yes. Declining is a real answer
 * and sticks — the gun stays hidden and stays home.
 *
 * In hotseat there is no seat, so the offer follows whoever is deploying, which
 * is also the only person there to answer it.
 */
function SupportOffer({ battle }: { battle: BattleState }) {
  const strategic = useSession((s) => s.room.strategic);
  const seat = useSession((s) => s.seat);
  const dispatch = useSession((s) => s.dispatch);
  const me = seat ?? currentDeployer(battle);
  if (!me || !battle.node || battle.supportAsked.includes(me)) return null;

  const guns = supportGuns(strategic, battle.node as NodeId, me);
  if (guns.length === 0) return null;
  const origins = [...new Set(guns.map((g) => g.nodeId))];

  return (
    <div className="panel__section">
      <p className="note">
        Artillery of yours can reach {battle.node} from{' '}
        <b>{origins.join(', ')}</b>. Bringing a gun in <b>reveals it</b> on the map — and it must be
        called now, before the battle starts.
      </p>
      <div className="reserves">
        {guns.map((g) => (
          <button
            key={g.id}
            type="button"
            className="chip"
            onClick={() => dispatch({ t: 'callSupport', gunId: g.id })}
          >
            <img src={coinAsset('artillery', g.owner)} alt="" />
            fire from {g.nodeId}
          </button>
        ))}
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => dispatch({ t: 'callSupport', gunId: null })}
        >
          No support — stay hidden
        </button>
      </div>
    </div>
  );
}

function DeploymentControls({ battle }: { battle: BattleState }) {
  const selectedId = useBattleStore((s) => s.selectedId);
  const select = useBattleStore((s) => s.select);
  const pass = useBattleStore((s) => s.passDeploy);
  const selectFort = useBattleStore((s) => s.selectFort);
  const strategic = useSession((s) => s.room.strategic);
  const deployer = currentDeployer(battle)!;
  const reserves = reserveUnits(battle, deployer);
  const fortsLeft = battle.fortsLeft[deployer];

  // Armies are numbered by their order in the node, matching what the strategic
  // panel calls them, so "Army 2" means the same thing on both screens.
  const armyOrder = battle.node
    ? armiesAt(strategic, battle.node as NodeId, deployer).map((a) => a.id)
    : [];
  const reserveGroups = (() => {
    const groups = new Map<string, { key: string; label: string; units: typeof reserves }>();
    for (const u of reserves) {
      const armyId = strategic.units[u.id]?.armyId;
      const i = armyId ? armyOrder.indexOf(armyId) : -1;
      const key = armyId ?? 'none';
      const label = isSupportUnit(u)
        ? 'Indirect fire support'
        : i >= 0
          ? `Army ${i + 1}`
          : 'Unattached';
      const g = groups.get(key) ?? { key, label, units: [] };
      g.units.push(u);
      groups.set(key, g);
    }
    return [...groups.values()];
  })();

  return (
    <div className="panel__section">
      <div className="turn turn--deploy">
        Deploying: <b>{playerLabel(deployer)}</b> · front-to-back, row {battle.deploy!.row + 1} of 3
      </div>
      {reserves.length === 0 && fortsLeft === 0 && (
        <span className="muted">No units left in reserve.</span>
      )}
      {/* Grouped by the army each unit came from, which the map still knows —
          battle units carry their real map ids. On the table you move whole
          stacks onto the board and can see what came from where; without this
          the player deploys a pile of loose coins and only finds out afterwards
          that they spread damage across three armies, each of which then needs
          its own action to move. */}
      {reserveGroups.map((g) => (
        <div key={g.key} className="reserves__group">
          {reserveGroups.length > 1 && <span className="reserves__army">{g.label}</span>}
          <div className="reserves">
            {g.units.map((u) => (
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
        </div>
      ))}
      <div className="reserves">
        {fortsLeft > 0 && (
          <button
            type="button"
            className={`chip chip--fort${selectedId === FORT_SELECTION ? ' chip--sel' : ''}`}
            onClick={selectFort}
          >
            🛡 fortification ×{fortsLeft}
          </button>
        )}
      </div>
      <p className="hint">
        Pick a unit, then click a highlighted cell. Support goes in the left slot. Fortifications
        cover the front and flanks of the cell they are built on — the rear stays open.
      </p>
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
        Turn: <b>{playerLabel(battle.turn)}</b> — take one action
      </div>
      {stalemateLooms(battle) && (
        <div className="warn">
          ⚑ <b>Stalemate next turn</b> — {playerLabel(battle.attacker)} has pulled back to their
          rear row. Move a unit over the initial frontline this turn to contest it.
        </div>
      )}
      {sel ? (
        <div className="selinfo">
          Selected: <b>{playerLabel(sel.owner)} {isSupportUnit(sel) ? 'support artillery' : sel.type}</b> · {sel.hp} HP{sel.wounded ? ' (wounded)' : ''}
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
  const battle = useSession((s) => s.room.battle);
  const dispatch = useSession((s) => s.dispatch);
  const error = useSession((s) => s.error);
  const clearError = useSession((s) => s.clearError);
  const newScenario = useBattleStore((s) => s.newScenario);
  if (!battle) return null;

  const log = [...battle.log].reverse();
  // A battle carrying a node was lifted off the strategic map; it goes back there
  // rather than to the scenario builder, and its result is posted onto the map.
  const fromMap = !!battle.node;
  const over = battle.phase === 'over';

  return (
    <aside className="panel">
      {over && (
        <div className="banner banner--win">
          {battle.winner === 'stalemate' ? 'Stalemate' : `${playerLabel(battle.winner!)} wins`}
        </div>
      )}

      {fromMap && over && (
        <div className="panel__section">
          <p className="hint">
            The result is ready to carry back to <b>{battle.node}</b>: the dead are removed, the
            withdrawn scatter, survivors stay revealed until you re-hide them, and the loser falls
            back.
          </p>
          <button type="button" className="btn" onClick={() => dispatch({ t: 'resolveBattle' })}>
            Return to the map
          </button>
        </div>
      )}

      {battle.phase === 'deployment' && <SupportOffer battle={battle} />}
      {battle.phase === 'deployment' && <DeploymentControls battle={battle} />}
      {battle.phase === 'battle' && <BattleControls battle={battle} />}

      {error && (
        <div className="banner banner--err" onClick={clearError}>
          {error}
        </div>
      )}

      {!fromMap && (
        <button type="button" className="btn btn--ghost" onClick={newScenario}>
          New scenario
        </button>
      )}

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

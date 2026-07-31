import { useState } from 'react';
import { NODE_BY_ID, isAsymmetric, isSea, isStaging, slotsFor, type NodeId } from '../engine/map';
import {
  ACTIONS_PER_TURN,
  RECON_ACTIONS,
  MAX_ARMIES,
  MAX_LOOSE_MOVE,
  armiesAt,
  armyCount,
  armyNode,
  armyUnits,
  canFortify,
  canFreeReorg,
  canReorganize,
  controlFor,
  doorstep,
  fortsAt,
  HOLD_TO_WIN,
  isRecon,
  looseAt,
  LOOSE_TARGET,
  MASKED,
  occupies,
  reconAt,
  sideOf,
  supplyCap,
  supplyUsed,
  type MaskedType,
  type StrategicState,
} from '../engine/strategic';
import { canInitiateBattle } from '../engine/campaign';
import { PLAYERS, coinAsset, otherPlayer, playerLabel, type Player } from '../engine/types';
import type { UnitType } from '../engine/units';
import { useStrategicStore } from '../state/strategicStore';
import { useSession } from '../state/sessionStore';
import { ReorgDialog } from './ReorgDialog';
import './StrategicPanel.css';

const cap = (n: number) => (n === Infinity ? '∞' : n);

/**
 * Opening a battle, and choosing what to open it with.
 *
 * The attacker picks which of their armies make the assault; anything held back
 * stays in the node, organized. That is the whole point of the choice — a probing
 * attack with one army and a vanguard kept in reserve, rather than every unit in
 * the location being swept in because they happened to be standing there.
 *
 * With one army there is no choice to make, so none is offered.
 */
/**
 * "Restart map", behind a confirmation the opponent never hears about.
 *
 * The first Yes/No is deliberately local: a misclick here should cost nothing,
 * not put a question on someone else's screen. Only past it does the request
 * become a real proposal in the room — see `RestartRequest` for the rest of the
 * negotiation, which `RestartDialog` draws.
 */
function RestartButton() {
  const dispatch = useSession((st) => st.dispatch);
  const pending = useSession((st) => !!st.room.restart);
  const [asking, setAsking] = useState(false);

  // A negotiation already under way owns the screen; offering the button again
  // underneath it would only let a player stack a second request on their own.
  if (pending) return null;

  if (!asking) {
    return (
      <button type="button" className="sbtn sbtn--ghost" onClick={() => setAsking(true)}>
        Restart map
      </button>
    );
  }
  return (
    <div className="srestart">
      <p className="srestart__lead">Are you sure you want to suggest a restart?</p>
      <div className="srestart__opts">
        <button
          type="button"
          className="sbtn"
          onClick={() => {
            setAsking(false);
            dispatch({ t: 'proposeRestart' });
          }}
        >
          Yes, ask my opponent
        </button>
        <button type="button" className="sbtn sbtn--ghost" onClick={() => setAsking(false)}>
          No
        </button>
      </div>
    </div>
  );
}

function AttackControls({ nodeId }: { nodeId: NodeId }) {
  const s = useSession((st) => st.room.strategic);
  const initiateBattle = useStrategicStore((st) => st.initiateBattle);
  const armies = armiesAt(s, nodeId, s.turn);
  const [heldBack, setHeldBack] = useState<string[]>([]);

  const committed = armies.filter((a) => !heldBack.includes(a.id));
  // Wounded units cannot lead an assault, so an army of nothing but wounded
  // brings no one — say so before the engine refuses it.
  const able = committed.reduce(
    (n, a) => n + armyUnits(s, a.id).filter((u) => !u.wounded).length,
    0,
  );

  return (
    <div className="sassault">
      {armies.length > 1 && (
        <>
          <p className="smuted sassault__lead">
            Choose the assault force. Armies left out stay here, organized and hidden — beating
            them is a separate battle.
          </p>
          <div className="sassault__opts">
            {armies.map((a, i) => {
              const units = armyUnits(s, a.id);
              const wounded = units.filter((u) => u.wounded).length;
              const going = !heldBack.includes(a.id);
              return (
                <label key={a.id} className={`sarmychk${going ? ' sarmychk--on' : ''}`}>
                  <input
                    type="checkbox"
                    checked={going}
                    onChange={() =>
                      setHeldBack((h) =>
                        h.includes(a.id) ? h.filter((x) => x !== a.id) : [...h, a.id],
                      )
                    }
                  />
                  <span>
                    Army {i + 1} · {units.length} unit{units.length === 1 ? '' : 's'}
                    {wounded > 0 && ` (${wounded} wounded, staying behind)`}
                  </span>
                </label>
              );
            })}
          </div>
        </>
      )}
      <button
        type="button"
        className="sbtn sbtn--attack"
        disabled={able === 0}
        onClick={() => initiateBattle(nodeId, committed.map((a) => a.id))}
      >
        {able === 0
          ? 'Nobody able-bodied in the assault force'
          : `Attack with ${able} unit${able === 1 ? '' : 's'} — opens the battle board`}
      </button>
    </div>
  );
}

/**
 * What a coin can depict: a real unit type, or a face-down enemy chip. Masked
 * units group together like any other "type", which is right — face down, they
 * really are interchangeable to the player looking at them.
 */
type CoinType = UnitType | MaskedType;

/** What to call a coin in alt text and tooltips. */
const coinName = (t: CoinType) => (t === MASKED ? 'unidentified enemy unit' : t);

/** One chip per unit type, since units of a type are interchangeable here. */
function byType(units: { id: string; type: CoinType }[]): [CoinType, string[]][] {
  const m = new Map<CoinType, string[]>();
  for (const u of units) m.set(u.type, [...(m.get(u.type) ?? []), u.id]);
  return [...m];
}

/**
 * Army coins, grouped by type but with the wounded split out from the whole —
 * they are not interchangeable, and a wounded unit must stay face-up (it heals
 * only back in staging), so it earns its own chip and badge.
 */
interface CoinGroup {
  key: string;
  type: CoinType;
  wounded: boolean;
  ids: string[];
}
function coinGroups(units: { id: string; type: CoinType; wounded?: boolean }[]): CoinGroup[] {
  const m = new Map<string, CoinGroup>();
  for (const u of units) {
    const wounded = !!u.wounded;
    const key = `${u.type}${wounded ? ':wounded' : ''}`;
    const g = m.get(key) ?? { key, type: u.type, wounded, ids: [] };
    g.ids.push(u.id);
    m.set(key, g);
  }
  return [...m.values()];
}

/**
 * How close each side is to winning. Two things have to be legible, and they are
 * not the same thing: how much of the enemy's doorstep you hold *right now*, and
 * how many of your own turns you have held all of it. The second only starts
 * counting once the first is complete, and it snaps back to zero the moment the
 * ring is broken — so showing the turn count alone would look arbitrary.
 *
 * `eye` is the viewer's seat, so the copy can say "you" and mean it.
 */
function VictoryTrack({ s, eye }: { s: StrategicState; eye: Player | null }) {
  const rows = PLAYERS.map((p) => {
    const ring = doorstep(otherPlayer(p));
    const held = ring.filter((n) => occupies(s, n, p)).length;
    return {
      p,
      ring,
      held,
      complete: ring.length > 0 && held === ring.length,
      turns: s.hold[p],
    };
  });
  // The one case worth shouting about: someone wins on their next turn.
  const imminent = rows.find((r) => r.complete && r.turns >= HOLD_TO_WIN - 1);

  return (
    <div className="spanel__section">
      <div className="spanel__title">Victory</div>
      <p className="smuted">
        Hold every location bordering the enemy staging area at the end of {HOLD_TO_WIN} rounds.
        The count is scored once both players have moved, so the defender always gets a turn to
        break the ring.
      </p>

      {rows.map(({ p, ring, held, complete, turns }) => (
        <div key={p} className="vtrack">
          <span className={`side__who side__who--${p}`}>{playerLabel(p)}</span>
          <span
            className="vtrack__ring"
            title={`Holds ${held} of ${ring.length}: ${ring.join(', ')}`}
          >
            {ring.map((n) => (
              <i key={n} className={occupies(s, n, p) ? 'vdot vdot--on' : 'vdot'} />
            ))}
            <span className="vtrack__n">
              {held}/{ring.length}
            </span>
          </span>
          <span className={complete ? 'vtrack__turns vtrack__turns--live' : 'vtrack__turns'}>
            {complete ? `${turns}/${HOLD_TO_WIN} rounds held` : 'ring broken'}
          </span>
        </div>
      ))}

      {imminent && (
        <p className={`vwarn${imminent.p === eye ? ' vwarn--mine' : ''}`}>
          {imminent.p === eye ? (
            <>
              <b>You win at the end of this round</b> if the ring is still whole when{' '}
              {playerLabel(otherPlayer(imminent.p))} has finished their turn.
            </>
          ) : (
            <>
              <b>{playerLabel(imminent.p)} wins at the end of this round.</b> Break the ring before
              it is scored — retake any one of those locations.
            </>
          )}
        </p>
      )}
    </div>
  );
}

/**
 * An army: its coins, its strength, and the free split-off control. `scoutId` is
 * set when the viewer is holding a recon unit that shares this army's node, which
 * is exactly when scouting it is on offer.
 */
function ArmyRow({
  s,
  armyId,
  mine,
  scoutId,
}: {
  s: StrategicState;
  armyId: string;
  mine: boolean;
  scoutId?: string;
}) {
  const sel = useStrategicStore((st) => st.sel);
  const selectArmy = useStrategicStore((st) => st.selectArmy);
  const openSplit = useStrategicStore((st) => st.openSplit);
  const recon = useStrategicStore((st) => st.recon);
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
          {coinGroups(units).map((g) => (
            <span key={g.key} className={`army__coin${g.wounded ? ' army__coin--wounded' : ''}`}>
              <img
                src={coinAsset(g.type, s.units[g.ids[0]].owner)}
                alt={coinName(g.type)}
                title={
                  g.wounded
                    ? `${g.type} — wounded (heals only in staging)`
                    : coinName(g.type)
                }
              />
              {g.wounded && <span className="army__wound" aria-hidden>✚</span>}
              {g.ids.length > 1 && <span className="army__x">{g.ids.length}</span>}
            </span>
          ))}
        </span>
      </button>
      {mine && units.length > 1 && (
        // Opens the table rather than splitting a unit outright: `armyUnits`
        // sorts by id, so "the last one" was always the same type, and the
        // player never got to say which unit actually leaves.
        <button
          type="button"
          className="army__split"
          onClick={() => openSplit(armyId)}
          title="Choose units to split off — free, no action"
        >
          split
        </button>
      )}
      {scoutId && (
        <button
          type="button"
          className="army__recon"
          onClick={() => recon(scoutId, armyId)}
          title="Roll this scout against the army — 1 loses the scout, 6 reveals the whole location"
        >
          scout
        </button>
      )}
    </div>
  );
}

function NodeSide({ nodeId, owner, mine }: { nodeId: NodeId; owner: Player; mine: boolean }) {
  const s = useSession((st) => st.room.strategic);
  const sel = useStrategicStore((st) => st.sel);
  const toggleLoose = useStrategicStore((st) => st.toggleLoose);
  const doRecon = useStrategicStore((st) => st.recon);
  const armies = armiesAt(s, nodeId, owner);
  const loose = looseAt(s, nodeId, owner);
  const recon = reconAt(s, nodeId, owner);
  const control = controlFor(s, nodeId, owner);
  const used = supplyUsed(s, nodeId, owner);
  const limit = supplyCap(s, nodeId, owner);
  const over = used > limit;
  const forts = fortsAt(s, nodeId, owner);

  // Stragglers with no army of their own to shelter behind, on ground an enemy
  // army holds, are swept up when that enemy next opens a turn. The board gives
  // no other warning — they simply stop existing — so say it plainly here.
  const atRisk =
    loose.length > 0 &&
    armies.length === 0 &&
    !isSea(nodeId) &&
    !isStaging(nodeId) &&
    armiesAt(s, nodeId, otherPlayer(owner)).length > 0;

  // Scouting is on offer when the player is holding one of their own scouts, it
  // is standing in this node, this side of the node is the enemy's, and the recon
  // phase still has an action in it. The engine re-checks all of this; the point
  // here is only to not show a button that is going to be refused.
  const heldScout =
    sel?.kind === 'loose' && sel.unitIds.length === 1 ? s.units[sel.unitIds[0]] : undefined;
  const scoutId =
    !mine &&
    s.phase === 'recon' &&
    s.actionsLeft > 0 &&
    heldScout &&
    isRecon(heldScout) &&
    heldScout.owner !== owner &&
    heldScout.nodeId === nodeId
      ? heldScout.id
      : undefined;

  if (armies.length === 0 && loose.length === 0 && recon.length === 0 && forts === 0) {
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
          {forts > 0 && (
            <span className="fort" title={`${forts} fortification${forts === 1 ? '' : 's'} ready for the next battle here`}>
              ⛨ {forts}
            </span>
          )}
          <span className={`ctl ctl--${control}`}>{control}</span>
          <span className={over ? 'supply supply--over' : 'supply'}>
            {used} / {cap(limit)}
          </span>
        </span>
      </div>

      {armies.map((a) => (
        <ArmyRow key={a.id} s={s} armyId={a.id} mine={mine} scoutId={scoutId} />
      ))}

      {atRisk && (
        <p className={`overrun-warn${mine ? ' overrun-warn--mine' : ''}`}>
          {mine ? (
            <>
              <b>⚠ Overrun next enemy turn.</b> These units have no army here to
              shelter behind. Move them out, or bring an army in to cover them.
            </>
          ) : (
            <>⚠ Unsheltered — your army overruns these when you next open a turn.</>
          )}
        </p>
      )}

      {loose.length > 0 && (
        <div className="loose">
          <div className="loose__head">
            Disorganized · {loose.length}
            {scoutId ? (
              <button
                type="button"
                className="army__recon"
                onClick={() => doRecon(scoutId, LOOSE_TARGET)}
                title="Roll this scout against the disorganized units — same table as an army"
              >
                scout
              </button>
            ) : (
              <span className="loose__cost">1 supply</span>
            )}
          </div>
          <div className="side__units">
            {byType(loose).map(([type, ids]) => {
              // Show one chip per unit, not per type: the pair you may move has
              // to be picked out individually.
              return ids.map((id) => {
                const picked = sel?.kind === 'loose' && sel.unitIds.includes(id);
                const wounded = !!s.units[id]?.wounded;
                return (
                  <button
                    key={id}
                    type="button"
                    className={`ustack ustack--loose${picked ? ' ustack--sel' : ''}${wounded ? ' ustack--wounded' : ''}`}
                    onClick={() => toggleLoose(id)}
                    disabled={!mine}
                    title={wounded ? `${type} — wounded (heals only in staging)` : type}
                  >
                    <img src={coinAsset(type, owner)} alt={type} />
                    {wounded && <span className="ustack__wound" aria-hidden>✚</span>}
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
  const freeReorgNode = useStrategicStore((st) => st.freeReorgNode);
  const splitArmy = useStrategicStore((st) => st.splitArmy);
  // The table is opened by army, but rendered by node — an army's position is
  // derived from its members, so ask the board where it actually stands.
  const splitNode = splitArmy ? armyNode(s, splitArmy) : null;
  const openFreeReorg = useStrategicStore((st) => st.openFreeReorg);
  const dismissFreeReorg = useStrategicStore((st) => st.dismissFreeReorg);
  const swapSide = useStrategicStore((st) => st.swapSide);
  const fortify = useStrategicStore((st) => st.fortify);
  const retreat = useStrategicStore((st) => st.retreat);
  const error = useSession((st) => st.error);
  const clearError = useSession((st) => st.clearError);
  const endTurn = useStrategicStore((st) => st.endTurn);
  const endRecon = useStrategicStore((st) => st.endRecon);
  const recon = s.phase === 'recon';
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
  // Play is frozen while the game is decided or a beaten force still owes the
  // board a destination — no node action should be offered in either case.
  const live = !s.winner && !s.pendingRetreat;
  const canAttack = !!node && yours && live && canInitiateBattle(s, node.id, s.turn);
  const canFort = !!node && yours && live && canFortify(s, node.id, s.turn);
  // Both sides share the node and it is yours to act, yet you cannot attack: the
  // only reason left (the node is fightable and the enemy is here) is that every
  // one of your units here is wounded, and wounded units cannot lead an assault.
  const woundedCantAttack =
    !!node &&
    yours &&
    live &&
    !canAttack &&
    !isSea(node.id) &&
    !isStaging(node.id) &&
    occupies(s, node.id, s.turn) &&
    occupies(s, node.id, otherPlayer(s.turn));
  const owedFreeReorg = !!node && yours && live && canFreeReorg(s, node.id, s.turn);
  const pr = s.pendingRetreat;
  const myRetreat = !!pr && pr.player === eye;

  if (s.winner) {
    return (
      <aside className="spanel">
        <div className={`sbanner sbanner--win sbanner--${s.winner}`}>
          <b>{playerLabel(s.winner)} wins.</b> They held every location on the enemy’s doorstep
          long enough to take the game.
        </div>
        <button type="button" className="sbtn" onClick={reset}>
          Start a new game
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

  return (
    <aside className="spanel">
      {pr && (
        <div className={`spanel__section sretreat sretreat--${pr.player}`}>
          {myRetreat ? (
            <>
              <p className="sretreat__lead">
                <b>You lost the battle at {pr.from}.</b> Choose where your survivors fall back to.
              </p>
              <div className="sretreat__opts">
                {pr.options.map((n) => (
                  <button key={n} type="button" className="sbtn" onClick={() => retreat(n)}>
                    Fall back to {n}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="sretreat__lead">
              Waiting for <b>{playerLabel(pr.player)}</b> to choose where to fall back from {pr.from}.
            </p>
          )}
        </div>
      )}

      <div className="spanel__section">
        <div className={`sturn sturn--${s.turn}`}>
          Round {s.round} · <b>{playerLabel(s.turn)}</b> · {recon ? 'recon' : 'strategic'} phase ·{' '}
          {s.actionsLeft} of {recon ? RECON_ACTIONS : ACTIONS_PER_TURN} action
          {s.actionsLeft === 1 ? '' : 's'} left
        </div>

        {recon ? (
          <p className="shint">
            Scouting. Move a recon unit — it travels alone, ignores enemy armies and costs no
            supply. Armies wait until the recon phase is over.
          </p>
        ) : s.actionsLeft === 0 ? (
          // Spent, but still your turn: the battle you just walked into is the
          // reason the turn does not end itself.
          <p className="shint">
            <b>Out of actions.</b> You may still attack from a location where you meet the enemy.
            Ending your turn runs the supply check, which disorganizes anything overstacked.
          </p>
        ) : sel?.kind === 'army' ? (
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

        {recon ? (
          <button type="button" className="sbtn" onClick={endRecon}>
            Done scouting — start {playerLabel(s.turn)}'s strategic phase
          </button>
        ) : (
          <button type="button" className="sbtn" onClick={endTurn}>
            End {playerLabel(s.turn)}'s turn
          </button>
        )}
      </div>

      {error && (
        <div className="sbanner sbanner--err" onClick={clearError}>
          {error}
        </div>
      )}

      <VictoryTrack s={s} eye={eye} />

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

          {/* The free post-battle reshuffle: offered prominently, because it is a
              one-time right that is easy to forget and costs nothing. */}
          {owedFreeReorg && (
            <div className="sreorg">
              <p className="sreorg__lead">
                <b>You won here.</b> Re-sort the survivors into armies for free — the board can’t be
                assumed to remember which was which.
              </p>
              <div className="sreorg__opts">
                <button type="button" className="sbtn" onClick={() => openFreeReorg(node.id)}>
                  Re-sort the victors
                </button>
                <button
                  type="button"
                  className="sbtn sbtn--ghost"
                  onClick={() => dismissFreeReorg(node.id)}
                >
                  Leave them as they were
                </button>
              </div>
            </div>
          )}

          {/* Node-scoped actions live here rather than on the map: the map keeps
              to two gestures, and this panel already shows what the action acts
              on. */}
          {canAttack && <AttackControls nodeId={node.id} />}
          {woundedCantAttack && (
            <p className="smuted spanel__adj">
              Your units here are wounded — they cannot mount an attack, only defend.
            </p>
          )}
          {canFort && (
            <button type="button" className="sbtn" onClick={() => fortify(node.id)}>
              Build a fortification (1 action)
            </button>
          )}
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

      <RestartButton />

      <ol className="slog">
        {log.map((e) => (
          <li key={e.id} className={`slog__${e.kind}`}>
            {e.text}
          </li>
        ))}
      </ol>

      {reorgNode && <ReorgDialog nodeId={reorgNode} />}
      {freeReorgNode && <ReorgDialog nodeId={freeReorgNode} free />}
      {splitArmy && splitNode && <ReorgDialog nodeId={splitNode} splitArmy={splitArmy} />}
    </aside>
  );
}

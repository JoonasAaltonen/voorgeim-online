import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyIntent,
  entitledSeat,
  battleMover,
  createRoom,
  viewFor,
  type Intent,
  type RoomState,
  type RoomView,
} from './room';
import { STAGING_NODE } from './map';
import { MASKED, unitsAt } from './strategic';
import { otherPlayer, playerLabel, type Player } from './types';

/**
 * A fresh room, stepped past the opening recon phase — the strategic phase is
 * what these tests exercise. `rawRoom()` keeps the recon phase for the tests
 * that are about it.
 */
const room = () => applyIntent(rawRoom(), 'p1', { t: 'stratEndRecon' }).state;
const rawRoom = () => createRoom('TEST42');

// Initiative is a dice roll, so pin it: p1 always opens, and the seat-authority
// tests below can say "p1's turn" and mean it. The dice test injects its own rng
// and is unaffected.
beforeEach(() => {
  let high = false;
  vi.spyOn(Math, 'random').mockImplementation(() => {
    high = !high;
    return high ? 0.99 : 0;
  });
});
afterEach(() => vi.restoreAllMocks());

/** Front-row cell on a player's own side. p1 = bottom, p2 = top. */
const frontCell = (p: Player) => `${p === 'p1' ? 'bottom' : 'top'}-r0-c0`;

/** Drive a room through `[seat, intent]` steps, asserting each is accepted. */
function play(start: RoomState, steps: [Player, Intent][]): RoomState {
  return steps.reduce((r, [actor, i]) => {
    const t = applyIntent(r, actor, i);
    expect(t.error).toBeUndefined();
    return t.state;
  }, start);
}

describe('room construction', () => {
  it('carries the code and starts before any battle', () => {
    const r = rawRoom(); // untouched: version 0 is the point of this test
    expect(r.code).toBe('TEST42');
    expect(r.battle).toBeNull();
    expect(r.version).toBe(0);
  });

  it('musters both strategic rosters, as the hotseat store did', () => {
    expect(unitsAt(room().strategic, STAGING_NODE.p1)).toHaveLength(25);
    expect(unitsAt(room().strategic, STAGING_NODE.p2)).toHaveLength(25);
  });
});

describe('version', () => {
  it('bumps on an accepted intent', () => {
    expect(applyIntent(rawRoom(), 'p1', { t: 'setView', view: 'battle' }).state.version).toBe(1);
  });

  it('does not bump on a rejected intent, and returns the room untouched', () => {
    const r = rawRoom();
    const t = applyIntent(r, 'p2', { t: 'stratEndTurn' });
    expect(t.error).toBeDefined();
    expect(t.state.version).toBe(0);
    expect(t.state).toBe(r);
  });
});

describe('seat authority — strategic', () => {
  // Spelled out rather than built from playerLabel: this is the message a player
  // actually reads when they click on the wrong turn, so it is worth pinning.
  it('rejects a move sent by the seat whose turn it is not', () => {
    const r = room();
    const unit = unitsAt(r.strategic, STAGING_NODE.p1)[0];
    // p1's unit, p1's turn — but p2 is the one asking.
    const t = applyIntent(r, 'p2', { t: 'stratMoveLoose', unitIds: [unit.id], nodeId: 'n12' });
    expect(t.error).toBe("It is P1 - Red's turn.");
    expect(t.state.strategic.units[unit.id].nodeId).toBe(STAGING_NODE.p1);
  });

  it('accepts the same move from the seat whose turn it is', () => {
    const r = room();
    const unit = unitsAt(r.strategic, STAGING_NODE.p1)[0];
    const t = applyIntent(r, 'p1', { t: 'stratMoveLoose', unitIds: [unit.id], nodeId: 'n12' });
    expect(t.error).toBeUndefined();
    expect(t.state.strategic.units[unit.id].nodeId).toBe('n12');
  });

  it("still blocks moving the opponent's unit on your own turn", () => {
    const r = room();
    const enemy = unitsAt(r.strategic, STAGING_NODE.p2)[0];
    expect(applyIntent(r, 'p1', { t: 'stratMoveLoose', unitIds: [enemy.id], nodeId: 'n18' }).error).toBeDefined();
  });

  it('hands the seat over with the turn', () => {
    const handed = applyIntent(room(), 'p1', { t: 'stratEndTurn' }).state;
    expect(handed.strategic.turn).toBe('p2');
    // p2's turn opens on recon, same as p1's did; step past it to move a fighter.
    const r = applyIntent(handed, 'p2', { t: 'stratEndRecon' }).state;
    const unit = unitsAt(r.strategic, STAGING_NODE.p2)[0];
    expect(applyIntent(r, 'p1', { t: 'stratMoveLoose', unitIds: [unit.id], nodeId: 'n18' }).error).toBeDefined();
    expect(applyIntent(r, 'p2', { t: 'stratMoveLoose', unitIds: [unit.id], nodeId: 'n18' }).error).toBeUndefined();
  });
});

describe('seat authority — battle', () => {
  const started = () => {
    const r = applyIntent(room(), 'p1', { t: 'startBattle' }).state;
    expect(r.battle).not.toBeNull();
    return r;
  };

  it('switches the view when a battle starts', () => {
    expect(started().view).toBe('battle');
  });

  it('rejects a deployment from the seat that is not deploying', () => {
    const r = started();
    const mover = battleMover(r.battle!)!;
    const unit = Object.values(r.battle!.units).find((u) => u.owner === mover)!;
    const t = applyIntent(r, otherPlayer(mover), {
      t: 'deploy',
      unitId: unit.id,
      cellId: frontCell(mover),
    });
    expect(t.error).toBe(`It is ${playerLabel(mover)}'s turn.`);
    expect(t.state.battle!.units[unit.id].status).toBe('reserve');
  });

  it('accepts it from the seat that is deploying', () => {
    const r = started();
    const mover = battleMover(r.battle!)!;
    const unit = Object.values(r.battle!.units).find((u) => u.owner === mover)!;
    const t = applyIntent(r, mover, { t: 'deploy', unitId: unit.id, cellId: frontCell(mover) });
    expect(t.error).toBeUndefined();
    expect(t.state.battle!.units[unit.id].cellId).toBe(frontCell(mover));
  });

  it('follows the deployment cursor, which is not battle.turn', () => {
    const r = started();
    const first = battleMover(r.battle!)!;
    const next = applyIntent(r, first, { t: 'passDeploy' }).state;
    expect(battleMover(next.battle!)).toBe(otherPlayer(first));
  });

  it('rejects battle intents when no battle is in progress', () => {
    expect(applyIntent(room(), 'p1', { t: 'passDeploy' }).error).toBe('No battle in progress.');
  });

  it('lets nobody act once the battle is over', () => {
    const r = started();
    const over: RoomState = { ...r, battle: { ...r.battle!, phase: 'over', winner: 'p1' } };
    expect(battleMover(over.battle!)).toBeNull();
    for (const p of ['p1', 'p2'] as Player[]) {
      expect(applyIntent(over, p, { t: 'passDeploy' }).error).toBe('The battle is over.');
    }
  });
});

describe('table intents', () => {
  it('let either seat set up the board', () => {
    for (const p of ['p1', 'p2'] as Player[]) {
      expect(applyIntent(room(), p, { t: 'setView', view: 'map' }).error).toBeUndefined();
      expect(applyIntent(room(), p, { t: 'startBattle' }).error).toBeUndefined();
    }
  });

  it('refuse a scenario edit that would silently invalidate a live battle', () => {
    const r = applyIntent(room(), 'p1', { t: 'startBattle' }).state;
    expect(applyIntent(r, 'p1', { t: 'setScenario', scenario: r.scenario }).error).toBeDefined();
  });

  it('allow it again once the battle is cleared', () => {
    const r = play(room(), [
      ['p1', { t: 'startBattle' }],
      ['p2', { t: 'newScenario' }],
    ]);
    expect(r.battle).toBeNull();
    expect(applyIntent(r, 'p1', { t: 'setScenario', scenario: r.scenario }).error).toBeUndefined();
  });

  it('reset the strategic map back to the muster', () => {
    const r = applyIntent(room(), 'p1', { t: 'stratEndTurn' }).state;
    expect(r.strategic.turn).toBe('p2');
    const back = applyIntent(r, 'p2', { t: 'stratReset' }).state;
    expect(back.strategic.turn).toBe('p1');
    expect(unitsAt(back.strategic, STAGING_NODE.p1)).toHaveLength(25);
  });
});

describe('a restart is negotiated, not pressed', () => {
  it('does not touch the board until the opponent agrees', () => {
    const started = applyIntent(room(), 'p1', { t: 'stratEndTurn' }).state;
    const asked = applyIntent(started, 'p1', { t: 'proposeRestart' }).state;

    expect(asked.restart).toEqual({ by: 'p1' });
    expect(asked.strategic.turn).toBe('p2'); // the game carries on meanwhile

    const agreed = applyIntent(asked, 'p2', { t: 'answerRestart', agree: true }).state;
    expect(agreed.restart).toBeNull();
    expect(agreed.strategic.turn).toBe('p1');
    expect(unitsAt(agreed.strategic, STAGING_NODE.p1)).toHaveLength(25);
    // Same room, same seats — only the game is new.
    expect(agreed.code).toBe(asked.code);
  });

  it('refuses to let the proposer answer their own request', () => {
    const asked = applyIntent(room(), 'p1', { t: 'proposeRestart' }).state;
    const t = applyIntent(asked, 'p1', { t: 'answerRestart', agree: true });
    expect(t.error).toBeDefined();
    expect(t.state.restart).toEqual({ by: 'p1' });
  });

  it('hands a refusal back to the proposer rather than clearing it', () => {
    const asked = applyIntent(room(), 'p1', { t: 'proposeRestart' }).state;
    const no = applyIntent(asked, 'p2', { t: 'answerRestart', agree: false }).state;
    expect(no.restart).toEqual({ by: 'p1', declined: true });

    // And the opponent cannot then re-ask on the proposer's behalf, or twice.
    expect(applyIntent(no, 'p2', { t: 'proposeRestart' }).error).toBeDefined();
    expect(applyIntent(no, 'p2', { t: 'dismissRestart' }).error).toBeDefined();

    const on = applyIntent(no, 'p1', { t: 'dismissRestart' }).state;
    expect(on.restart).toBeNull();
  });

  it('lets the proposer withdraw an unanswered request', () => {
    const asked = applyIntent(room(), 'p2', { t: 'proposeRestart' }).state;
    expect(applyIntent(asked, 'p2', { t: 'dismissRestart' }).state.restart).toBeNull();
  });

  it('names the answering seat for hotseat, where one person holds both', () => {
    const asked = applyIntent(room(), 'p1', { t: 'proposeRestart' }).state;
    // Hotseat routes through `entitledSeat`; it must hand the answer to p2 even
    // though p1 is the one at the keyboard and p1's turn is the current one.
    expect(entitledSeat(asked, { t: 'answerRestart', agree: true })).toBe('p2');
    expect(entitledSeat(asked, { t: 'dismissRestart' })).toBe('p1');
  });
});

describe('dice belong to the server', () => {
  /**
   * Default scenario: p1 attacks and so deploys first. Each side puts one
   * infantry on its own front row, facing across the frontline, then passes out
   * the remaining two rows to reach the battle phase.
   */
  function inContact(): RoomState {
    const r = play(room(), [
      ['p1', { t: 'startBattle' }],
      ['p1', { t: 'deploy', unitId: 'p1-infantry-1', cellId: frontCell('p1') }],
      ['p1', { t: 'passDeploy' }],
      ['p2', { t: 'deploy', unitId: 'p2-infantry-1', cellId: frontCell('p2') }],
      ['p2', { t: 'passDeploy' }],
      ['p1', { t: 'passDeploy' }],
      ['p2', { t: 'passDeploy' }],
      ['p1', { t: 'passDeploy' }],
      ['p2', { t: 'passDeploy' }],
    ]);
    expect(r.battle!.phase).toBe('battle');
    return r;
  }

  it('resolve from the injected rng, so a client cannot fudge a roll', () => {
    const rolls = (rng: () => number) => {
      const t = applyIntent(
        inContact(),
        'p1',
        { t: 'attack', unitId: 'p1-infantry-1', targetId: 'p2-infantry-1' },
        rng,
      );
      expect(t.error).toBeUndefined();
      return t.state.battle!.log.find((e) => e.combat)!.combat!;
    };

    expect(rolls(() => 0).attackerRolls.every((d) => d === 1)).toBe(true);
    expect(rolls(() => 0.999).attackerRolls.every((d) => d === 6)).toBe(true);
  });
});

describe('viewFor — fog of war', () => {
  const unitsOf = (r: RoomView, owner: Player) =>
    Object.values(r.strategic.units).filter((u) => u.owner === owner);
  const p1sees = () => viewFor('p1', room());
  /** A p2 unit that fog actually applies to — scouts stay face-up. */
  const fightingP2 = (u: { owner: Player; type: string }) => u.owner === 'p2' && u.type !== 'recon';

  it('shows a player their own units in full', () => {
    for (const u of unitsOf(p1sees(), 'p1')) expect(u.type).not.toBe(MASKED);
  });

  it('masks every unrevealed enemy fighting unit', () => {
    const enemy = unitsOf(p1sees(), 'p2');
    expect(enemy.length).toBe(25); // all of them are still there to be counted
    expect(enemy.filter((u) => u.type === MASKED)).toHaveLength(23);
  });

  // The tabletop game cannot hide a scout — it moves in its own phase, in front
  // of the other player — so the online one does not pretend otherwise.
  it('leaves enemy recon face-up, since the physical game cannot hide it', () => {
    const scouts = unitsOf(p1sees(), 'p2').filter((u) => u.type === 'recon');
    expect(scouts).toHaveLength(2);
  });

  it('leaves the count, owner, node and army of a masked unit legible', () => {
    const r = room();
    const real = Object.values(r.strategic.units).find(fightingP2)!;
    const seen = viewFor('p1', r).strategic.units[real.id];
    expect(seen.owner).toBe('p2');
    expect(seen.nodeId).toBe(real.nodeId);
    expect(seen.armyId).toBe(real.armyId);
  });

  it('shows a revealed enemy unit for what it is, and hides its neighbour', () => {
    const r = room();
    const [shown, hidden] = Object.values(r.strategic.units).filter(fightingP2);
    shown.revealed = true;
    const seen = viewFor('p1', r).strategic.units;
    expect(seen[shown.id].type).toBe(shown.type);
    expect(seen[hidden.id].type).toBe(MASKED);
  });

  it('hides that an enemy is wounded, since a face-down chip cannot show it', () => {
    const r = room();
    const u = Object.values(r.strategic.units).find(fightingP2)!;
    u.wounded = true;
    expect(viewFor('p1', r).strategic.units[u.id].wounded).toBeUndefined();
  });

  it('gives the two seats genuinely different boards, and neither the whole one', () => {
    const r = room();
    expect(viewFor('p1', r)).not.toEqual(viewFor('p2', r));
    expect(viewFor('p1', r)).not.toEqual(r);
  });

  it('does not mutate the room it is filtering', () => {
    const r = room();
    const before = structuredClone(r);
    viewFor('p1', r);
    expect(r).toEqual(before);
  });
});

describe('map battles (Phase 7)', () => {
  // Put `n` of a player's staging units of a type into a fresh army on `node`.
  function garrison(r: RoomState, owner: Player, node: string, type: string, n: number): string {
    const s = r.strategic;
    const id = `army-${owner}-${++s.tick}`;
    s.armies[id] = { id, owner, movedAt: s.tick };
    Object.values(s.units)
      .filter((u) => u.owner === owner && !u.armyId && u.nodeId === STAGING_NODE[owner] && u.type === type)
      .slice(0, n)
      .forEach((u) => {
        u.nodeId = node;
        u.armyId = id;
      });
    return id;
  }

  // n09 holds both sides in contact for these.
  function contested(): RoomState {
    const r = room();
    garrison(r, 'p1', 'n09', 'infantry', 2);
    garrison(r, 'p2', 'n09', 'armor', 1);
    return r;
  }

  it('opens a battle only for the seat whose turn it is, and moves both to the board', () => {
    const r = contested();
    expect(applyIntent(r, 'p2', { t: 'stratInitiateBattle', nodeId: 'n09' }).error).toMatch(
      /P1 - Red's turn/,
    );
    const t = applyIntent(r, 'p1', { t: 'stratInitiateBattle', nodeId: 'n09' });
    expect(t.error).toBeUndefined();
    expect(t.state.battle?.node).toBe('n09');
    expect(t.state.view).toBe('battle');
  });

  it('freezes strategic play until the battle is posted back', () => {
    const r = applyIntent(contested(), 'p1', { t: 'stratInitiateBattle', nodeId: 'n09' }).state;
    const move = applyIntent(r, 'p1', { t: 'stratEndTurn' });
    expect(move.error).toMatch(/finish the battle/i);
  });

  it('will not resolve a battle that is still being fought', () => {
    const r = applyIntent(contested(), 'p1', { t: 'stratInitiateBattle', nodeId: 'n09' }).state;
    expect(applyIntent(r, 'p1', { t: 'resolveBattle' }).error).toMatch(/not finished/i);
  });

  it('posts a finished battle back, clears the board, and returns to the map', () => {
    const r = applyIntent(contested(), 'p1', { t: 'stratInitiateBattle', nodeId: 'n09' }).state;
    // Force the board to a decided state, as the battle engine would.
    r.battle!.phase = 'over';
    r.battle!.winner = 'p1';
    for (const u of Object.values(r.battle!.units)) {
      u.status = u.owner === 'p2' ? 'dead' : 'deployed';
    }
    const t = applyIntent(r, 'p2', { t: 'resolveBattle' }); // either seat may
    expect(t.error).toBeUndefined();
    expect(t.state.battle).toBeNull();
    expect(t.state.view).toBe('map');
    // p2's armor was destroyed; p1 holds the node.
    expect(unitsAt(t.state.strategic, 'n09').every((u) => u.owner === 'p1')).toBe(true);
  });

  it('builds a fortification on ground the moving seat holds', () => {
    const r = room();
    garrison(r, 'p1', 'n09', 'infantry', 2);
    const t = applyIntent(r, 'p1', { t: 'stratBuildFort', nodeId: 'n09' });
    expect(t.error).toBeUndefined();
    expect(t.state.strategic.forts['n09:p1']).toBe(1);
  });

  it('lets the winning seat spend a free post-battle reshuffle, and decline it', () => {
    const r = room();
    const a = garrison(r, 'p1', 'n09', 'infantry', 2);
    const b = garrison(r, 'p1', 'n09', 'infantry', 2);
    r.strategic.freeReorgs['n09'] = 'p1';
    const mover = Object.values(r.strategic.units).find((u) => u.armyId === a)!;

    // The wrong seat cannot, since a free reshuffle is still the mover's own turn.
    expect(
      applyIntent(r, 'p2', { t: 'stratFreeReorganize', nodeId: 'n09', assign: { [mover.id]: b } })
        .error,
    ).toMatch(/P1 - Red's turn/);

    const t = applyIntent(r, 'p1', {
      t: 'stratFreeReorganize',
      nodeId: 'n09',
      assign: { [mover.id]: b },
    });
    expect(t.error).toBeUndefined();
    expect(t.state.strategic.actionsLeft).toBe(2); // free
    expect(t.state.strategic.freeReorgs['n09']).toBeUndefined();

    // And declining simply clears the offer.
    const d = applyIntent(r, 'p1', { t: 'stratDismissFreeReorg', nodeId: 'n09' });
    expect(d.state.strategic.freeReorgs['n09']).toBeUndefined();
  });

  it('lets only the beaten seat resolve a pending retreat', () => {
    const r = room();
    garrison(r, 'p1', 'n09', 'armor', 1);
    r.strategic.pendingRetreat = { player: 'p2', from: 'n09', options: ['n08', 'n10'], units: [] };
    expect(applyIntent(r, 'p1', { t: 'stratRetreat', nodeId: 'n08' }).error).toMatch(/waiting/i);
    const t = applyIntent(r, 'p2', { t: 'stratRetreat', nodeId: 'n08' });
    expect(t.error).toBeUndefined();
    expect(t.state.strategic.pendingRetreat).toBeNull();
  });
});

describe('recon through the room', () => {
  /** p1's first scout, moved to `node`, with a p2 army of `n` waiting there. */
  function scouted(node: string, n: number) {
    const r = rawRoom(); // the recon phase is the point, so keep it
    const s = r.strategic;
    const scout = Object.values(s.units).find((u) => u.owner === 'p1' && u.type === 'recon')!;
    scout.nodeId = node as typeof scout.nodeId;
    const armyId = `army-p2-${++s.tick}`;
    s.armies[armyId] = { id: armyId, owner: 'p2', movedAt: s.tick };
    Object.values(s.units)
      .filter((u) => u.owner === 'p2' && !u.armyId && u.type !== 'recon')
      .slice(0, n)
      .forEach((u) => {
        u.nodeId = node as typeof u.nodeId;
        u.armyId = armyId;
      });
    return { r, scoutId: scout.id, armyId };
  }

  it('reveals the enemy to the scouting seat, and only what the roll earned', () => {
    const { r, scoutId, armyId } = scouted('n09', 4);
    // A constant rng lands rollD6 (floor(rng*6)+1) on 3 — reveal one unit.
    const t = applyIntent(r, 'p1', { t: 'stratRecon', reconId: scoutId, targetArmyId: armyId }, () => 2.5 / 6);
    expect(t.error).toBeUndefined();
    const revealed = Object.values(t.state.strategic.units).filter((u) => u.owner === 'p2' && u.revealed);
    expect(revealed).toHaveLength(1);
    // And the fog now lets p1 see exactly that one fighter. (p2's scouts are
    // face-up regardless — the tabletop game cannot hide them.)
    const seen = Object.values(viewFor('p1', t.state).strategic.units).filter(
      (u) => u.owner === 'p2' && u.type !== MASKED && u.type !== 'recon',
    );
    expect(seen.map((u) => u.id)).toEqual(revealed.map((u) => u.id));
  });

  it('refuses a scout the sending seat does not own', () => {
    const { r, scoutId, armyId } = scouted('n09', 2);
    const t = applyIntent(r, 'p2', { t: 'stratRecon', reconId: scoutId, targetArmyId: armyId });
    expect(t.error).toBeDefined();
    expect(t.state).toBe(r);
  });

  it('refuses once the recon phase is over', () => {
    const { r, scoutId, armyId } = scouted('n09', 2);
    const after = applyIntent(r, 'p1', { t: 'stratEndRecon' }).state;
    const t = applyIntent(after, 'p1', { t: 'stratRecon', reconId: scoutId, targetArmyId: armyId });
    expect(t.error).toMatch(/recon phase is over/i);
  });
});

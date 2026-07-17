import { describe, expect, it } from 'vitest';
import {
  applyIntent,
  battleMover,
  createRoom,
  viewFor,
  type Intent,
  type RoomState,
} from './room';
import { STAGING_NODE } from './map';
import { unitsAt } from './strategic';
import { otherPlayer, playerLabel, type Player } from './types';

const room = () => createRoom('TEST42');

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
    const r = room();
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
    expect(applyIntent(room(), 'p1', { t: 'setView', view: 'battle' }).state.version).toBe(1);
  });

  it('does not bump on a rejected intent, and returns the room untouched', () => {
    const r = room();
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
    const r = applyIntent(room(), 'p1', { t: 'stratEndTurn' }).state;
    expect(r.strategic.turn).toBe('p2');
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

describe('viewFor', () => {
  it('is the whole room until fog lands in Phase 6', () => {
    const r = room();
    expect(viewFor('p1', r)).toEqual(viewFor('p2', r));
  });
});

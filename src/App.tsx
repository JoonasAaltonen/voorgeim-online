import { useEffect } from 'react';
import { BattleBoard } from './ui/BattleBoard';
import { BattlePanel } from './ui/BattlePanel';
import { Lobby } from './ui/Lobby';
import { ScenarioBuilder } from './ui/ScenarioBuilder';
import { StrategicMap } from './ui/StrategicMap';
import { StrategicPanel } from './ui/StrategicPanel';
import { useSession } from './state/sessionStore';
import type { View } from './engine/room';
import './App.css';

const VIEWS: { id: View; label: string; phase: string }[] = [
  { id: 'battle', label: 'Battle scenario', phase: 'Phases 1–2 · scenario builder + combat loop' },
  { id: 'map', label: 'Strategic map', phase: 'Phases 3–7 · armies, supply, battles, victory' },
];

function App() {
  // The view is part of the room, not of this browser: two players at one table
  // should be looking at the same thing, and starting a battle moves both.
  const view = useSession((s) => s.room.view);
  const battle = useSession((s) => s.room.battle);
  const dispatch = useSession((s) => s.dispatch);
  const resume = useSession((s) => s.resume);
  const current = VIEWS.find((v) => v.id === view)!;

  // A refresh rejoins the game this tab was in, rather than losing it.
  useEffect(() => resume(), [resume]);

  return (
    <div className={`app${view === 'map' ? ' app--wide' : ''}`}>
      <header className="app__header">
        <h1>
          Voorgeim <span>— {current.label.toLowerCase()}</span>
        </h1>
        <nav className="app__views">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              className={`app__view${view === v.id ? ' app__view--on' : ''}`}
              aria-pressed={view === v.id}
              onClick={() => dispatch({ t: 'setView', view: v.id })}
            >
              {v.label}
            </button>
          ))}
        </nav>
        <p className="app__phase">{current.phase}</p>
        <Lobby />
      </header>

      {view === 'map' ? (
        <main className="app__battle">
          <StrategicMap />
          <StrategicPanel />
        </main>
      ) : battle ? (
        <main className="app__battle">
          <BattleBoard />
          <BattlePanel />
        </main>
      ) : (
        <main>
          <ScenarioBuilder />
        </main>
      )}
    </div>
  );
}

export default App;

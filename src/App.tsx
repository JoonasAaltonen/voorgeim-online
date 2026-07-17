import { useState } from 'react';
import { BattleBoard } from './ui/BattleBoard';
import { BattlePanel } from './ui/BattlePanel';
import { ScenarioBuilder } from './ui/ScenarioBuilder';
import { StrategicMap } from './ui/StrategicMap';
import { StrategicPanel } from './ui/StrategicPanel';
import { useBattleStore } from './state/battleStore';
import './App.css';

type View = 'battle' | 'map';

const VIEWS: { id: View; label: string; phase: string }[] = [
  { id: 'battle', label: 'Battle scenario', phase: 'Phase 1–2 · scenario builder + combat loop' },
  { id: 'map', label: 'Strategic map', phase: 'Phase 3 · node graph + movement' },
];

function App() {
  const [view, setView] = useState<View>('battle');
  const battle = useBattleStore((s) => s.battle);
  const current = VIEWS.find((v) => v.id === view)!;

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
              onClick={() => setView(v.id)}
            >
              {v.label}
            </button>
          ))}
        </nav>
        <p className="app__phase">{current.phase}</p>
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

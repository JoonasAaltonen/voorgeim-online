import { BattleBoard } from './ui/BattleBoard';
import { BattlePanel } from './ui/BattlePanel';
import { ScenarioBuilder } from './ui/ScenarioBuilder';
import { useBattleStore } from './state/battleStore';
import './App.css';

function App() {
  const battle = useBattleStore((s) => s.battle);

  return (
    <div className="app">
      <header className="app__header">
        <h1>
          Voorgeim <span>— battle scenario</span>
        </h1>
        <p className="app__phase">Phase 1 · scenario builder + combat loop</p>
      </header>

      {battle ? (
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

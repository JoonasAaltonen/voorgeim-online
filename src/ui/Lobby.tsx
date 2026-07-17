import { useState } from 'react';
import { playerLabel } from '../engine/types';
import { useSession } from '../state/sessionStore';
import './Lobby.css';

/** Small status line: which seat you hold, whether the opponent has arrived. */
function OnlineStatus() {
  const code = useSession((s) => s.code);
  const seat = useSession((s) => s.seat);
  const seats = useSession((s) => s.seats);
  const status = useSession((s) => s.status);
  const notice = useSession((s) => s.notice);
  const leave = useSession((s) => s.leave);
  const [copied, setCopied] = useState(false);

  const opponentHere = seats.length === 2;
  const live = status === 'open';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="lobby lobby--online">
      <button type="button" className="lobby__code" onClick={copy} title="Copy the game code">
        {code}
        <span className="lobby__copy">{copied ? 'copied' : 'copy'}</span>
      </button>

      <span className={`lobby__dot lobby__dot--${live ? 'live' : 'down'}`} aria-hidden="true" />
      <span className="lobby__status">
        {live && seat ? (
          <>
            You are <b>{playerLabel(seat)}</b>
            {opponentHere ? ' — both players connected.' : ' — waiting for the other player.'}
          </>
        ) : (
          (notice ?? 'Connecting…')
        )}
      </span>

      <button type="button" className="lobby__btn" onClick={leave}>
        Leave
      </button>
    </div>
  );
}

function LocalControls() {
  const host = useSession((s) => s.host);
  const join = useSession((s) => s.join);
  const [code, setCode] = useState('');
  const [joining, setJoining] = useState(false);

  return (
    <div className="lobby">
      <span className="lobby__label">Hotseat — both sides on this screen.</span>

      <button type="button" className="lobby__btn lobby__btn--go" onClick={() => host()}>
        Start online game
      </button>

      {joining ? (
        <form
          className="lobby__join"
          onSubmit={(e) => {
            e.preventDefault();
            if (join(code)) setJoining(false);
          }}
        >
          <input
            className="lobby__input"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABC123"
            maxLength={6}
            aria-label="Game code"
            autoFocus
          />
          <button type="submit" className="lobby__btn lobby__btn--go">
            Join
          </button>
          <button type="button" className="lobby__btn" onClick={() => setJoining(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <button type="button" className="lobby__btn" onClick={() => setJoining(true)}>
          Join with a code
        </button>
      )}
    </div>
  );
}

export function Lobby() {
  const mode = useSession((s) => s.mode);
  return mode === 'online' ? <OnlineStatus /> : <LocalControls />;
}

// The three-step restart negotiation, drawn over whichever board is up.
//
// It lives at the top of the app rather than in the strategic panel because the
// question can arrive while you are looking at something else entirely — you can
// be halfway through deploying a battle when your opponent asks to start over —
// and an answer that only appears on one of the two screens is an answer nobody
// gives.

import { otherPlayer, playerLabel } from '../engine/types';
import { useSession } from '../state/sessionStore';
import './RestartDialog.css';

export function RestartDialog() {
  const restart = useSession((s) => s.room.restart);
  const seat = useSession((s) => s.seat);
  const dispatch = useSession((s) => s.dispatch);
  const leave = useSession((s) => s.leave);
  if (!restart) return null;

  // Hotseat has one person holding both seats, so they walk through both halves
  // of the negotiation themselves. That is not a degenerate case to work around
  // — asking, then agreeing, is exactly the double-check this whole flow exists
  // to impose on a button that throws away an hour of play.
  const hot = seat === null;
  const asked = hot || seat !== restart.by;
  const proposer = hot || seat === restart.by;

  if (restart.declined && proposer) {
    return (
      <Prompt lead={<><b>{playerLabel(otherPlayer(restart.by))} doesn’t want to restart.</b> Leave the game?</>}>
        <button type="button" className="rbtn rbtn--warn" onClick={leave}>
          Yes, leave
        </button>
        <button type="button" className="rbtn" onClick={() => dispatch({ t: 'dismissRestart' })}>
          No, keep playing
        </button>
      </Prompt>
    );
  }
  if (restart.declined) return null;

  if (asked) {
    return (
      <Prompt lead={<><b>{playerLabel(restart.by)} wants to restart.</b> Agree?</>}>
        <button
          type="button"
          className="rbtn rbtn--warn"
          onClick={() => dispatch({ t: 'answerRestart', agree: true })}
        >
          Yes, start over
        </button>
        <button
          type="button"
          className="rbtn"
          onClick={() => dispatch({ t: 'answerRestart', agree: false })}
        >
          No, carry on
        </button>
      </Prompt>
    );
  }

  // Online proposer, waiting. Withdrawable, so a question asked to an opponent
  // who has wandered off does not wedge the board for the person who asked it.
  return (
    <Prompt lead={<>Waiting for <b>{playerLabel(otherPlayer(restart.by))}</b> to answer your restart.</>}>
      <button type="button" className="rbtn" onClick={() => dispatch({ t: 'dismissRestart' })}>
        Withdraw
      </button>
    </Prompt>
  );
}

function Prompt({ lead, children }: { lead: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rdialog" role="dialog" aria-modal="true">
      <div className="rdialog__box">
        <p className="rdialog__lead">{lead}</p>
        <div className="rdialog__opts">{children}</div>
      </div>
    </div>
  );
}

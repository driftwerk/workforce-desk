import { useRef, useState } from "react";
import type { Board, TicketState } from "../hub/types";
import { useModal } from "../ui/Dialog";
import { plainError } from "../ui/plainError";
import { COLUMNS } from "./board";
import { useBoard } from "./store";

/** A new ticket on `board`: its title, what it's about, and its column. */
export function NewTicket({ board, onClose }: { board: Board; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [state, setState] = useState<TicketState>("backlog");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const sheet = useRef<HTMLFormElement>(null);
  const keys = useModal(sheet, onClose);
  const make = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setProblem(null);
    try {
      const t = await useBoard.getState().createTicket({ board: board.id, title: title.trim(), body: body.trim(), state });
      useBoard.getState().openTicket(t.id);
      onClose();
    } catch (err) {
      setProblem(plainError(err));
      setBusy(false);
    }
  };
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={keys}>
      <form ref={sheet} className="sheet" onSubmit={make} aria-label="New ticket" tabIndex={-1}>
        <h2 className="display-lg">New ticket</h2>
        <label className="field">
          <span>Title</span>
          <input data-autofocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Hash every partner key at rest" required />
        </label>
        <label className="field">
          <span>What it's about</span>
          <textarea className="board-textarea" rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="What done looks like, and anything a session should know" />
        </label>
        <div className="field">
          <span>Column</span>
          <div className="seg" role="radiogroup" aria-label="Column">
            {COLUMNS.filter((c) => c.state !== "done").map((c) => (
              <button key={c.state} type="button" role="radio" aria-checked={state === c.state} onClick={() => setState(c.state)}>
                {c.title}
              </button>
            ))}
          </div>
        </div>
        {problem && (
          <p className="small state-blocked" role="alert">
            {problem}
          </p>
        )}
        <footer className="sheet-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-signal" disabled={busy || !title.trim()}>
            Add ticket
          </button>
        </footer>
      </form>
    </div>
  );
}

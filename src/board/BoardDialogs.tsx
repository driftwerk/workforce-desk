import { useRef, useState } from "react";
import { useDesk } from "../hub/store";
import type { Board } from "../hub/types";
import { Confirm } from "../ui/Confirm";
import { useModal } from "../ui/Dialog";
import { plainError } from "../ui/plainError";
import { useBoard } from "./store";

/** A new board (its name, and the prefix its keys start with), or a
 *  board's new name and prefix. */
export function BoardDialog({ board, onClose, onMade }: { board?: Board; onClose: () => void; /** A new board was made (and is shown). */ onMade?: (b: Board) => void }) {
  const [name, setName] = useState(board?.name ?? "");
  const [prefix, setPrefix] = useState(board?.prefix ?? "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const sheet = useRef<HTMLFormElement>(null);
  const keys = useModal(sheet, onClose);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setProblem(null);
    try {
      const p = prefix.trim().toUpperCase();
      if (board) {
        const hub = useDesk.getState().hub;
        if (!hub) throw new Error("Desk isn't ready yet. Try again in a moment.");
        const changed = await hub.updateBoard(board.id, { name: name.trim(), ...(p && p !== board.prefix ? { prefix: p } : {}) });
        useBoard.setState((s) => ({ boards: { ...s.boards, [changed.id]: changed } }));
      } else onMade?.(await useBoard.getState().createBoard(name.trim(), p || undefined));
      onClose();
    } catch (err) {
      setProblem(plainError(err));
      setBusy(false);
    }
  };
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={keys}>
      <form ref={sheet} className="sheet" onSubmit={save} aria-label={board ? "Rename board" : "New board"} tabIndex={-1}>
        <h2 className="display-lg">{board ? "Rename board" : "New board"}</h2>
        <label className="field">
          <span>Name</span>
          <input data-autofocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme" required />
        </label>
        <label className="field">
          <span>Keys start with</span>
          <input className="mono" value={prefix} onChange={(e) => setPrefix(e.target.value.toUpperCase())} placeholder="From its name, like ACM" maxLength={6} />
        </label>
        <p className="faint small">Tickets are numbered from 1: ACM-1, ACM-2. Once a board has tickets its keys stay as they are.</p>
        {problem && (
          <p className="small state-blocked" role="alert">
            {problem}
          </p>
        )}
        <footer className="sheet-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-signal" disabled={busy || !name.trim()}>
            {board ? "Save" : "Make board"}
          </button>
        </footer>
      </form>
    </div>
  );
}

/** Asks before deleting a board and its tickets. */
export function DeleteBoard({ board, count, onClose }: { board: Board; count: number; onClose: () => void }) {
  return (
    <Confirm
      title={`Delete “${board.name}”?`}
      action="Delete board"
      onConfirm={async () => {
        const hub = useDesk.getState().hub;
        if (!hub) throw new Error("Desk isn't ready yet. Try again in a moment.");
        await hub.deleteBoard(board.id);
        useBoard.setState((s) => {
          const { [board.id]: _, ...boards } = s.boards;
          return { boards, tickets: Object.fromEntries(Object.entries(s.tickets).filter(([, t]) => t.board !== board.id)), shown: null };
        });
      }}
      onClose={onClose}
    >
      <p className="muted">
        {count ? `Its ${count} ticket${count === 1 ? "" : "s"} go with it. ` : ""}Sessions working on them keep running; what they did stays in their history.
      </p>
    </Confirm>
  );
}

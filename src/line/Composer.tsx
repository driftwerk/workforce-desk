import { useState } from "react";
import { hubFor } from "../hub/store";
import type { Session } from "../hub/types";
import { plainError } from "../ui/plainError";
import { steerOf } from "./rows";
import { useLine } from "./store";
import { machineOf } from "../hub/machines";

/** Writing to a session on its line: Send waits for its turn to end (it
 *  goes in at its prompt, never over what it is doing); Send now, where its
 *  engine can take one, goes into the turn it is on. */
export function Composer({ session }: { session: Session }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const name = session.displayName ?? session.name;
  const steer = steerOf(session);
  const working = session.state === "working" || session.state === "blocked";
  const send = async (when: "queue" | "now") => {
    const hub = hubFor(session);
    if (!hub || !text.trim() || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const m = await hub.postLine(session.id, text.trim(), when);
      useLine.getState().heard(m, false, machineOf(session));
      setText("");
    } catch (e) {
      setProblem(plainError(e));
    }
    setBusy(false);
  };
  return (
    <form
      className="line-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void send("queue");
      }}
    >
      <textarea
        rows={1}
        value={text}
        placeholder={`Message ${name}`}
        aria-label={`Message ${name}`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send(e.metaKey && steer ? "now" : "queue");
          }
        }}
      />
      <span className="line-composer-buttons">
        {steer && (
          <button type="button" className="btn btn-sm" disabled={busy || !text.trim()} title={`Into ${name}’s turn now (⌘↩)`} onClick={() => void send("now")}>
            {steer.label}
          </button>
        )}
        <button type="submit" className="btn btn-signal btn-sm" disabled={busy || !text.trim()} title={working ? `It goes in once ${name}’s turn ends` : undefined}>
          {working ? "Send when done" : "Send"}
        </button>
      </span>
      {problem && (
        <span className="small state-blocked line-composer-problem" role="alert">
          {problem}
        </span>
      )}
    </form>
  );
}

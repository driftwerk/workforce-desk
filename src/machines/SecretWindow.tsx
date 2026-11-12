// Desk's own field for a machine's password or an SSH key's passphrase: the
// whole of the `machine-secret` window, which the native side opens when it
// needs one (src-tauri/src/machine_secret.rs). Nothing of the main window's
// page runs here, and its capability grants only these three commands and
// what painting the theme needs. What is typed goes straight to the native
// side and is cleared here; it is never in a store, a log or an event.

import { useEffect, useId, useRef, useState } from "react";
import { deskReady, invoke } from "../platform";
import { useTheme } from "../theme/store";
import "../styles/settings.css";

/** The window's label: its capability names it. */
export const SECRET_WINDOW = "machine-secret";

interface Question {
  kind: "password" | "passphrase" | "linger";
  name: string;
  target: string;
  user?: string;
  key?: string;
  problem?: string;
}

const words = (q: Question) => {
  const account = q.user ? `${q.user}’s` : "the account’s";
  switch (q.kind) {
    case "password":
      return {
        title: `Sign in to ${q.name} once`,
        body: `Desk uses ${account} password on ${q.name} once to put its own key there, then forgets it. If keeping Desk running after ${q.name} restarts needs an administrator, it uses the password once more for that (sudo).`,
        label: q.user ? `${q.user}’s password on ${q.name}` : `Password on ${q.name}`,
        go: "Sign in",
      };
    case "passphrase":
      return {
        title: "Unlock your SSH key",
        body: "Desk adds your key to your SSH agent until you sign out. It doesn’t keep the passphrase.",
        label: "Passphrase",
        go: "Unlock",
      };
    case "linger":
      return {
        title: `Keep Desk running on ${q.name}`,
        body: `Desk runs sudo loginctl enable-linger there once with ${account} password, so Desk starts when ${q.name} boots. Then it forgets the password.`,
        label: q.user ? `${q.user}’s password on ${q.name}` : `Password on ${q.name}`,
        go: "Turn it on",
      };
  }
};

export function SecretWindow() {
  const [question, setQuestion] = useState<Question | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const { bg } = useTheme().colors;
  const first = useRef(bg);

  useEffect(() => {
    invoke<Question>("machine_secret_request")
      .then((q) => {
        setQuestion(q);
        setProblem(q.problem ?? null);
      })
      .catch(() => setProblem("Nothing is asked for now. You can close this window."))
      .finally(() => void deskReady(first.current).catch(() => undefined));
  }, []);

  const send = () => {
    const field = input.current;
    if (!field || !field.value) return setProblem("Type it first.");
    const secret = field.value;
    // Out of the page at once: the field, then the variable.
    field.value = "";
    setSending(true);
    invoke<void>("machine_secret_submit", { secret }).catch((e: unknown) => {
      setSending(false);
      setProblem(e instanceof Error ? e.message : String(e));
    });
  };
  const cancel = () => void invoke<void>("machine_secret_cancel").catch(() => undefined);

  const w = question && words(question);
  return (
    <form
      className="secret-window"
      aria-label={w?.title ?? "Desk"}
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
      onKeyDown={(e) => e.key === "Escape" && cancel()}
    >
      <div className="secret-drag" data-tauri-drag-region />
      {w && question ? (
        <>
          <h1 className="display-md">{w.title}</h1>
          <span className="mono small muted secret-target">{question.target}</span>
          {question.key && <span className="mono small muted secret-target">{question.key}</span>}
          <p className="small">{w.body}</p>
          <div className="field">
            <label htmlFor={id} className="ov-label muted">
              {w.label}
            </label>
            <input
              id={id}
              ref={input}
              className="field-text"
              type="password"
              autoFocus
              autoComplete={question.kind === "passphrase" ? "off" : "current-password"}
              spellCheck={false}
              disabled={sending}
              aria-invalid={problem ? true : undefined}
              aria-describedby={problem ? `${id}-problem` : undefined}
              onChange={() => problem && setProblem(null)}
            />
            {problem && (
              <span id={`${id}-problem`} className="small state-blocked" role="alert">
                {problem}
              </span>
            )}
          </div>
          <footer className="sheet-foot">
            <button type="button" className="btn" onClick={cancel}>
              Cancel
            </button>
            <button type="submit" className="btn btn-signal" disabled={sending}>
              {sending ? "Checking…" : w.go}
            </button>
          </footer>
        </>
      ) : (
        problem && <p className="small muted">{problem}</p>
      )}
    </form>
  );
}

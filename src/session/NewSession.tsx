import { useState } from "react";
import { useDesk } from "../hub/store";
import type { Engine } from "../hub/types";
import { pickFolder } from "../platform";

const nameFrom = (path: string): string => path.split("/").filter(Boolean).pop() ?? "session";

export function NewSession({ onClose }: { onClose: () => void }) {
  const { hub, fail, open } = useDesk();
  const [engine, setEngine] = useState<Engine>("claude");
  const [cwd, setCwd] = useState("");
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [worktree, setWorktree] = useState("");
  const [approvals, setApprovals] = useState<"desk" | "terminal">("desk");
  const [busy, setBusy] = useState(false);

  const choose = async () => {
    const dir = await pickFolder();
    if (!dir) return;
    setCwd(dir);
    if (!name) setName(nameFrom(dir));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hub || !cwd) return;
    setBusy(true);
    try {
      const s = await hub.start({
        engine,
        cwd,
        name: name || nameFrom(cwd),
        goal,
        approvals,
        worktree: worktree.trim() || undefined,
      });
      open(s.id);
      onClose();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="sheet" onSubmit={submit} aria-label="New session">
        <h2 className="display-md">New session</h2>
        <div className="seg" role="radiogroup" aria-label="Engine">
          {(["claude", "codex"] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={engine === k} onClick={() => setEngine(k)}>
              {k === "claude" ? "Claude Code" : "Codex"}
            </button>
          ))}
        </div>
        <label className="field">
          <span>Folder</span>
          <span className="field-row">
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/path/to/repo" required />
            <button type="button" className="btn btn-ghost" onClick={choose}>
              Choose…
            </button>
          </span>
        </label>
        <label className="field">
          <span>Name</span>
          <input className="mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="auth-fix" />
        </label>
        <label className="field">
          <span>Goal</span>
          <input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="What should this session get done?" />
        </label>
        <label className="field">
          <span>New worktree (optional branch name)</span>
          <input className="mono" value={worktree} onChange={(e) => setWorktree(e.target.value)} placeholder="desk/auth-fix" />
        </label>
        <div className="field">
          <span>Approvals</span>
          <div className="seg" role="radiogroup" aria-label="Approvals">
            <button type="button" role="radio" aria-checked={approvals === "desk"} onClick={() => setApprovals("desk")}>
              In Desk
            </button>
            <button type="button" role="radio" aria-checked={approvals === "terminal"} onClick={() => setApprovals("terminal")}>
              In the terminal
            </button>
          </div>
        </div>
        <footer className="sheet-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-signal" disabled={busy || !cwd}>
            Start
          </button>
        </footer>
      </form>
    </div>
  );
}

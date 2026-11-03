import { useEffect, useState } from "react";
import { OWN_SIGN_IN, OWN_SIGN_IN_LABEL, accountOfChoice, accountsOf, defaultChoice, hasAccounts, useAccounts } from "../engines/accounts";
import { ENGINE_TITLE, answersInDesk, defaultCaps, startable } from "../engines/engines";
import { pluginEnv } from "../grids/terminals";
import { useDesk } from "../hub/store";
import type { Engine, EngineInfo } from "../hub/types";
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
  const [approveForMe, setApproveForMe] = useState(false);
  const [busy, setBusy] = useState(false);
  const [engines, setEngines] = useState<EngineInfo[] | null>(null);
  const allAccounts = useAccounts((s) => s.accounts);
  // The person's pick, by engine; until they pick, the engine's default.
  const [picked, setPicked] = useState<Partial<Record<Engine, string>>>({});
  useEffect(() => {
    let live = true;
    hub
      ?.engines()
      .then((e) => live && setEngines(e))
      .catch(() => live && setEngines(null));
    return () => {
      live = false;
    };
  }, [hub]);
  const offered = startable(engines);
  const caps = defaultCaps(engines?.find((e) => e.engine === engine));
  const inDesk = answersInDesk(engine, caps);
  const canApproveForMe = !!caps?.approveForMe;
  const accounts = hasAccounts(caps) ? accountsOf(allAccounts, engine) : [];
  const account = picked[engine] ?? defaultChoice(allAccounts, engine);
  useEffect(() => {
    void useAccounts.getState().load();
  }, [hub]);

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
        approvals: inDesk ? approvals : undefined,
        approveForMe: canApproveForMe && approveForMe ? true : undefined,
        account: accounts.length > 0 ? accountOfChoice(account) : undefined,
        worktree: worktree.trim() || undefined,
        env: await pluginEnv(),
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
          {offered.map((k) => (
            <button key={k} type="button" role="radio" aria-checked={engine === k} onClick={() => setEngine(k)}>
              {ENGINE_TITLE[k]}
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
        {accounts.length > 0 && (
          <div className="field">
            <span>Account</span>
            <div className="seg" role="radiogroup" aria-label="Account">
              {accounts.map((a) => (
                <button key={a.id} type="button" role="radio" aria-checked={account === a.id} onClick={() => setPicked((p) => ({ ...p, [engine]: a.id }))}>
                  {a.name}
                </button>
              ))}
              <button type="button" role="radio" aria-checked={account === OWN_SIGN_IN} onClick={() => setPicked((p) => ({ ...p, [engine]: OWN_SIGN_IN }))}>
                {OWN_SIGN_IN_LABEL}
              </button>
            </div>
          </div>
        )}
        {caps?.notes.map((n) => (
          <p key={n} className="muted small">
            {n}
          </p>
        ))}
        {inDesk && (
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
        )}
        {canApproveForMe && (
          <div className="field">
            <span>Approvals</span>
            <div className="seg" role="radiogroup" aria-label="Approvals">
              <button type="button" role="radio" aria-checked={!approveForMe} onClick={() => setApproveForMe(false)}>
                Ask me
              </button>
              <button type="button" role="radio" aria-checked={approveForMe} onClick={() => setApproveForMe(true)}>
                Approve for me
              </button>
            </div>
            {approveForMe && (
              <p className="muted small">Codex’s own reviewer answers what it asks, inside the workspace sandbox. You can still stop its turn.</p>
            )}
          </div>
        )}
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

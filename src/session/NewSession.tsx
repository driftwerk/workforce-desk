import { useEffect, useState } from "react";
import { OWN_SIGN_IN, OWN_SIGN_IN_LABEL, accountOfChoice, accountsOf, accountsOn, defaultChoice, hasAccounts } from "../engines/accounts";
import { ENGINE_TITLE, answersInDesk, defaultCaps, startable } from "../engines/engines";
import { pluginEnv } from "../grids/terminals";
import { useChat } from "../chat/store";
import { groupOf, sessionItem, UNGROUPED, type ItemKey, type Layout } from "../groups/model";
import { moveItem, useLayout } from "../groups/store";
import { useDesk } from "../hub/store";
import type { Engine, EngineInfo } from "../hub/types";
import { keyOf, LOCAL, useHubOf, useMachines, type MachineId } from "../machines/engines";
import { native as machineNative, type MachineNative } from "../machines/native";
import { MachineFolder, RunOn } from "../machines/RunOn";
import { nameOfMachine } from "../machines/words";
import { pickFolder } from "../platform";
import { useHost } from "../shell/host";

const nameFrom = (path: string): string => path.split("/").filter(Boolean).pop() ?? "session";

/** A machine's plugin folder, for its sessions' Claude Code. */
const machineEnv = async (native: Pick<MachineNative, "pluginDir">, machine: MachineId): Promise<Record<string, string>> => {
  const dir = await native.pluginDir(machine).catch(() => null);
  return dir ? { CLAUDE_CODE_PLUGIN_DIRS: dir } : {};
};

/** The group a new session starts in unless another is chosen: the one it
 *  was started from (a group's menu), else the open session's or agent's,
 *  else Ungrouped. */
export const startingGroup = (layout: Layout, given: string | undefined, open: ItemKey | null): string => {
  if (given && (given === UNGROUPED || layout.groups.some((g) => g.id === given))) return given;
  return open ? groupOf(layout, open) : UNGROUPED;
};

/** What New session says of where the session will show. */
export const groupSays = (group: string, startedIn: string, name: string, machine: string | null): string => {
  const tag = machine ? ` with a ${machine} tag` : "";
  if (group !== UNGROUPED && group === startedIn) return `${name}, where you started it.${machine ? ` It shows in ${name}${tag}.` : ""}`;
  return `It shows in ${group === UNGROUPED ? "Ungrouped" : name}${tag}.`;
};

export function NewSession({
  onClose,
  group: given,
  native = machineNative,
  on = LOCAL,
}: {
  onClose: () => void;
  group?: string;
  native?: MachineNative;
  /** The computer it runs on, until another is chosen. */
  on?: MachineId;
}) {
  const { fail, open } = useDesk();
  const layout = useLayout();
  // Where it shows: the group it was started from, unless another is chosen.
  const [startedIn] = useState(() => {
    const { openId, view, activeRoom } = useDesk.getState();
    const agent = useChat.getState().activeAgent;
    const shown = openId ? sessionItem(openId) : view === "rooms" && !activeRoom && agent ? `agent:${agent}` : null;
    return startingGroup(layout, given, shown);
  });
  const [group, setGroup] = useState(startedIn);
  // Where it runs: this computer, or a machine once there's one.
  const [runOn, setRunOn] = useState<MachineId>(on);
  const remote = runOn !== LOCAL;
  const hub = useHubOf(runOn);
  const machines = useMachines((s) => s.machines);
  const platform = useHost((h) => h.platform);
  const where = nameOfMachine(runOn, machines, platform);
  const [engine, setEngine] = useState<Engine>("claude");
  const [cwd, setCwd] = useState("");
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [worktree, setWorktree] = useState("");
  const [approvals, setApprovals] = useState<"desk" | "terminal">("desk");
  const [approveForMe, setApproveForMe] = useState(false);
  const [busy, setBusy] = useState(false);
  const [engines, setEngines] = useState<EngineInfo[] | null>(null);
  const accountStore = accountsOn(runOn);
  const allAccounts = accountStore((s) => s.accounts);
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
  // An engine the chosen computer doesn't have gives way to one it has.
  useEffect(() => {
    if (offered.length && !offered.includes(engine)) setEngine(offered[0]!);
  }, [offered.join(" "), engine]);
  const caps = defaultCaps(engines?.find((e) => e.engine === engine));
  const inDesk = answersInDesk(engine, caps);
  const canApproveForMe = !!caps?.approveForMe;
  // A machine's accounts are its own: its sessions start on one of them.
  const accounts = hasAccounts(caps) ? accountsOf(allAccounts, engine) : [];
  const missing = engines?.filter((e) => e.installed === false).map((e) => e.title) ?? [];
  const account = picked[engine] ?? defaultChoice(allAccounts, engine);
  useEffect(() => {
    void accountStore.getState().load();
  }, [hub, accountStore]);

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
        env: remote ? await machineEnv(native, runOn) : await pluginEnv(),
      });
      const key = keyOf(runOn, s.id);
      // In its group whichever computer it runs on; Ungrouped takes it as it comes.
      if (group !== UNGROUPED && layout.groups.some((g) => g.id === group)) moveItem([], sessionItem(key), group, null);
      open(key);
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
        <RunOn
          value={runOn}
          onChange={(m) => {
            if (m === runOn) return;
            setRunOn(m);
            // A folder here isn't one there.
            setCwd("");
            setEngines(null);
          }}
        />
        <div className="seg" role="radiogroup" aria-label="Engine">
          {offered.map((k) => (
            <button key={k} type="button" role="radio" aria-checked={engine === k} onClick={() => setEngine(k)}>
              {ENGINE_TITLE[k]}
            </button>
          ))}
        </div>
        {remote && missing.length > 0 && (
          <p className="muted small">
            {missing.join(" and ")} {missing.length === 1 ? "isn’t" : "aren’t"} installed on {where}.
          </p>
        )}
        {remote ? (
          <MachineFolder
            machine={runOn}
            name={where}
            native={native}
            value={cwd}
            onChange={setCwd}
          />
        ) : (
          <label className="field">
            <span>Folder</span>
            <span className="field-row">
              <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/path/to/repo" required />
              <button type="button" className="btn btn-ghost" onClick={choose}>
                Choose…
              </button>
            </span>
          </label>
        )}
        {layout.groups.length > 0 && (
          <div className="field">
            <span className="ov-label muted">Group</span>
            <div className="chip-row" role="radiogroup" aria-label="Group">
              {[...layout.groups, { id: UNGROUPED, name: "Ungrouped" }].map((g) => (
                <button
                  key={g.id}
                  type="button"
                  role="radio"
                  className="chip-btn"
                  aria-checked={group === g.id}
                  aria-pressed={group === g.id}
                  onClick={() => setGroup(g.id)}
                >
                  {g.name}
                </button>
              ))}
            </div>
            <span className="muted small">
              {groupSays(group, startedIn, layout.groups.find((g) => g.id === group)?.name ?? "Ungrouped", remote ? where : null)}
            </span>
          </div>
        )}
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
          <button type="submit" className="btn btn-signal" disabled={busy || !cwd || !hub}>
            {remote ? `Start on ${where}` : "Start"}
          </button>
        </footer>
      </form>
    </div>
  );
}

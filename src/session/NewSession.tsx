import { useEffect, useMemo, useRef, useState } from "react";
import { idsNow, mayHaveHappened, reconcile } from "../ui/reconcile";
import { OWN_SIGN_IN, OWN_SIGN_IN_LABEL, accountOfChoice, accountsOf, accountsOn, defaultChoice, hasAccounts, ownSignInWorks } from "../engines/accounts";
import { ENGINE_TITLE, answersInDesk, defaultCaps, startable } from "../engines/engines";
import { pluginEnv } from "../grids/terminals";
import { useChat } from "../chat/store";
import { GroupChoice } from "./GroupChoice";
import { groupOf, sessionItem, UNGROUPED, type ItemKey, type Layout } from "../groups/model";
import { moveItem, useLayout } from "../groups/store";
import { pairedHub } from "../hub/net";
import { useDesk } from "../hub/store";
import type { Engine, EngineInfo } from "../hub/types";
import { keyOf, LOCAL, useHubOf, useMachines, type MachineId } from "../machines/engines";
import { native as machineNative, type MachineNative } from "../machines/native";
import { RunOn } from "../machines/RunOn";
import { FolderPicker, useRecentFolders } from "../machines/FolderPicker";
import { folderInfo, homeWithin, makeFolder, onMachine, type FolderInfo } from "../machines/folders";
import { nameOfMachine, thisComputerLower } from "../machines/words";
import { machineHome, pickFolder } from "../platform";
import { useHost } from "../shell/host";
import { NEW_SESSION_LINE } from "../shell/newLines";
import { CodexSigningIn, InstallEngine } from "../settings/EngineBlocks";
import { SignInClaude } from "../settings/Accounts";
import { useCodexSignIn } from "../engines/signIn";
import { openSettingsAt, type Problem } from "../ui/problem";
import { ProblemNote } from "../ui/ProblemNote";
import { branchFor, choicesFor, lastFolder, nameFromGoal, remember, type Choices } from "./remembered";

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

/** What Fast mode does, as OpenAI's catalogue words it: Codex asks
 *  ChatGPT's faster tier (1.5x to 2x speed) on models that have one, and on
 *  most of them it uses more of the plan. */
const FAST_NOTE =
  "Codex asks ChatGPT for its faster tier where your model has one: up to twice the speed, and on most models it uses up your plan’s limits sooner.";

/** Why Start can't be pressed yet, in a line, with what puts it right. */
export interface Blocked {
  words: string;
  fix?: { label: string; run: () => void };
}

/** The first thing Start waits on, or none. */
export const whyNotStart = (o: {
  hub: boolean;
  folder: string;
  remote: boolean;
  where: string;
  noFolder: boolean;
  cantSignIn: string | null;
  starting: boolean;
  /** No engine there to start on; the one chosen isn't signed in (both
   *  said above, with their fix). */
  noEngine?: boolean;
  signedOut?: string | null;
}): Blocked | null => {
  if (o.starting) return null;
  if (!o.hub) return { words: `Desk can’t reach ${o.remote ? o.where : "this computer’s helper"} right now: it starts sessions once it’s back.` };
  if (o.noEngine) return { words: "Install Claude Code or Codex above, then start." };
  if (o.signedOut) return { words: `Sign ${o.signedOut} in above, then start.` };
  if (!o.folder && !o.remote) return { words: "Pick the folder it works in." };
  if (o.remote && o.noFolder) return { words: `That folder isn’t on ${o.where}: make it, or pick one that is.` };
  if (o.cantSignIn) return { words: `${o.cantSignIn} isn’t signed in on ${o.where}.`, fix: { label: `Sign in to ${o.cantSignIn}`, run: () => openSettingsAt("providers") } };
  return null;
};

/** What a start that failed means, when New session can put it right
 *  itself; none leaves it to Desk's usual error. */
export const startProblem = (raw: string, o: { copy: boolean; offCopy: () => void; makeIt: (() => void) | null }): Problem | null => {
  if (o.copy && /isn.t in a git repository/i.test(raw))
    return { plain: "That folder isn’t a git project, so Desk can’t make a separate copy of it.", fix: { label: "Start without a copy", run: o.offCopy }, details: raw, what: "starting a session" };
  if (/is not a folder/i.test(raw))
    return {
      plain: "That folder isn’t there.",
      ...(o.makeIt ? { fix: { label: "Make it and start", run: o.makeIt } } : {}),
      details: raw,
      what: "starting a session",
    };
  if (/every name from .* is taken/i.test(raw)) return { plain: "Desk ran out of names for a separate copy: there are already many copies for this goal.", details: raw, what: "starting a session" };
  return null;
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
  // Mid-sentence: this computer, or the machine by name.
  const whereSaid = runOn === LOCAL ? thisComputerLower(platform) : where;
  const localHub = useChat((s) => s.hubs.find((h) => h.local) ?? null);
  // The folder: the last one started in here, else the open session's.
  const [cwd, setCwdRaw] = useState(() => {
    if (runOn !== LOCAL) return "";
    const { openId, sessions } = useDesk.getState();
    return lastFolder(runOn) ?? (openId ? (sessions[openId]?.cwd ?? "") : "");
  });
  /** The folder typed is one the machine says isn't there. */
  const [noFolder, setNoFolder] = useState(false);
  const [goal, setGoal] = useState("");
  const [name, setName] = useState("");
  const [engine, setEngine] = useState<Engine>("claude");
  const [copy, setCopy] = useState(false);
  const [approvals, setApprovals] = useState<"desk" | "terminal">("desk");
  const [approveForMe, setApproveForMe] = useState(false);
  const [fast, setFast] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [engines, setEngines] = useState<EngineInfo[] | null>(null);
  const accountStore = accountsOn(runOn);
  const allAccounts = accountStore((s) => s.accounts);
  // The person's pick, by engine; until they pick, the engine's default.
  const [picked, setPicked] = useState<Partial<Record<Engine, string>>>({});

  /** What was chosen in a folder before comes back with it. */
  const recall = (folder: string) => {
    const c = choicesFor(runOn, folder);
    if (c.engine) setEngine(c.engine);
    if (c.account && c.engine) setPicked((p) => ({ ...p, [c.engine!]: c.account }));
    if (c.group && (c.group === UNGROUPED || layout.groups.some((g) => g.id === c.group)) && !given) setGroup(c.group);
    if (c.approvals) setApprovals(c.approvals);
    if (c.approveForMe !== undefined) setApproveForMe(c.approveForMe);
    if (c.fast !== undefined) setFast(c.fast);
    if (c.copy !== undefined) setCopy(c.copy);
  };
  const setCwd = (folder: string) => {
    setCwdRaw(folder);
    setProblem(null);
    if (folder) recall(folder);
  };
  // The folder it opened with brings its choices too.
  const recalled = useRef(false);
  useEffect(() => {
    if (recalled.current || !cwd) return;
    recalled.current = true;
    recall(cwd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** What the hub there can do; null until it says. */
  const [features, setFeatures] = useState<string[] | null>(null);
  // Read as it is now: Desk may just have installed or signed one in.
  const [readAt, setReadAt] = useState(0);
  useEffect(() => {
    let live = true;
    (readAt ? hub?.enginesNow() : hub?.engines())
      ?.then((e) => live && setEngines(e))
      .catch(() => live && setEngines(null));
    return () => {
      live = false;
    };
  }, [hub, readAt]);
  const readAgain = () => {
    setReadAt(Date.now());
    void accountStore.getState().load();
  };
  useEffect(() => {
    let live = true;
    setFeatures(null);
    hub
      ?.features?.()
      .then((f) => live && setFeatures(f))
      .catch(() => live && setFeatures([]));
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
  const canRunFast = !!caps?.fast;
  // A machine's accounts are its own: its sessions start on one of them.
  const accounts = hasAccounts(caps) ? accountsOf(allAccounts, engine) : [];
  const missing = engines?.filter((e) => e.installed === false).map((e) => e.title) ?? [];
  // Where the CLI was never signed in, its own sign-in is no choice: the
  // session starts on an account, never at a login prompt.
  const ownWorks = ownSignInWorks(engines?.find((e) => e.engine === engine)?.signIn);
  const account = picked[engine] ?? defaultChoice(allAccounts, engine, ownWorks);
  const cantSignIn = accounts.length > 0 && !ownWorks && !accounts.some((a) => a.signedIn);
  // A choice of account only where there is one to make.
  const accountChoices = accounts.length + (ownWorks ? 1 : 0);
  // Nothing to start on: no engine there, or the one chosen never signed in
  // (and no account of its). Said, with the fix in place, and Start waits.
  const engineInfo = engines?.find((e) => e.engine === engine);
  const noEngine = engines !== null && offered.length === 0;
  const signedOut = !noEngine && engineInfo?.installed === true && engineInfo.signIn.state === "out" && accounts.length === 0;
  useEffect(() => {
    void accountStore.getState().load();
  }, [hub, accountStore]);

  // What the folder is: a git project (so a separate copy can be made) and
  // where it comes from, as its hub says.
  const fetchOn = useMemo(
    () =>
      remote
        ? (path: string) => native.transport(runOn).fetch("GET", path)
        : localHub
          ? (path: string) => pairedHub(localHub).fetch("GET", path)
          : null,
    [remote, runOn, native, localHub],
  );
  const [info, setInfo] = useState<{ folder: string; info: FolderInfo } | null>(null);
  const folder = cwd.trim().replace(/\/+$/, "");
  useEffect(() => {
    if (!folder || !fetchOn) return;
    let live = true;
    const t = setTimeout(() => void folderInfo(fetchOn, folder).then((i) => live && setInfo({ folder, info: i })), 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [folder, fetchOn]);
  const here = info?.folder === folder ? info.info : {};
  // A folder the hub says isn't a git project has no separate copy; one it
  // doesn't say of may, and the hub says so if not.
  const noCopy = here.git === false;
  // Only a hub that always makes the copy a new branch is asked for one: an
  // older one would take an existing branch of that name.
  const copyOld = features !== null && !features.includes("fresh-worktree");
  const useCopy = copy && !noCopy && !copyOld && features !== null;

  // Recent folders here, each with where its project comes from.
  const recent = useRecentFolders(runOn, null);
  const [remotes, setRemotes] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!fetchOn || remote) return;
    let live = true;
    for (const r of recent)
      if (!(r.path in remotes))
        void folderInfo(fetchOn, r.path).then((i) => live && setRemotes((m) => ({ ...m, [r.path]: i.remote ?? "" })));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recent.map((r) => r.path).join("\n"), fetchOn]);

  const choose = async () => {
    const dir = await pickFolder();
    if (dir) setCwd(dir);
  };

  const shownName = name.trim() || nameFromGoal(goal) || (folder ? nameFrom(folder) : "");
  const branch = branchFor(goal, shownName);

  const working = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // What a second go runs: the form as it is then, not as it was when it failed.
  const again = useRef<(o?: { copy?: boolean }) => Promise<void>>(async () => {});
  const submit = async (e?: React.FormEvent, o: { copy?: boolean } = {}) => {
    e?.preventDefault();
    if (!hub || (!folder && !remote) || working.current) return;
    working.current = true;
    setBusy(true);
    setProblem(null);
    const withCopy = o.copy ?? useCopy;
    const before = await idsNow(() => hub.sessions());
    let startedAs = { cwd: "", name: "" };
    try {
      // On a machine, its own path: `~` (and nothing typed) is its home.
      const at = remote ? onMachine(folder || "~", await homeWithin(() => machineHome(runOn), runOn)) : folder;
      const sessionName = shownName || nameFrom(at);
      startedAs = { cwd: at, name: sessionName };
      const s = await hub.start({
        engine,
        cwd: at,
        name: sessionName,
        goal,
        approvals: inDesk ? approvals : undefined,
        approveForMe: canApproveForMe && approveForMe ? true : undefined,
        fast: canRunFast && fast ? true : undefined,
        account: accounts.length > 0 ? accountOfChoice(account) : undefined,
        ...(withCopy ? { worktree: branch, freshWorktree: true } : {}),
        env: remote ? await machineEnv(native, runOn) : await pluginEnv(),
      });
      const choices: Choices = { engine, group, approvals, approveForMe, fast, copy: withCopy, ...(account ? { account } : {}) };
      remember(runOn, folder || "~", choices);
      const key = keyOf(runOn, s.id);
      // In its group whichever computer it runs on; Ungrouped takes it as it comes.
      if (group !== UNGROUPED && layout.groups.some((g) => g.id === group)) moveItem([], sessionItem(key), group, null);
      open(key);
      onClose();
    } catch (err) {
      // A start whose answer never came may have happened: look before offering it again.
      const seen =
        startedAs.cwd && mayHaveHappened(err) ? await reconcile(() => hub.sessions(), before, (x) => x.name === startedAs.name && (x.cwd === startedAs.cwd || x.cwd.startsWith(`${startedAs.cwd}/.worktrees/`))) : null;
      if (seen?.kind === "made") {
        const key = keyOf(runOn, seen.made.id);
        if (group !== UNGROUPED && layout.groups.some((g) => g.id === group)) moveItem([], sessionItem(key), group, null);
        open(key);
        onClose();
      } else {
        const raw = err instanceof Error ? err.message : String(err);
        // Inside the home, a missing folder can be made: then it starts.
        const make = !remote && fetchOn && localHub ? async () => {
          const made = await makeFolder(pairedHub(localHub), folder);
          if (!made.ok) return setProblem({ plain: "Desk couldn’t make that folder.", details: made.why, what: "making a folder" });
          void again.current();
        } : null;
        const own = startProblem(raw, {
          copy: withCopy,
          offCopy: () => {
            setCopy(false);
            void again.current({ copy: false });
          },
          makeIt: make ? () => void make() : null,
        });
        if (own) setProblem(own);
        else {
          const safe = !mayHaveHappened(err) || seen?.kind === "absent";
          fail(err, { what: "starting a session", ...(safe ? { retry: () => mounted.current && void again.current() } : {}) });
        }
      }
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  again.current = (o) => submit(undefined, o);

  const blocked = whyNotStart({
    hub: !!hub,
    folder,
    remote,
    where,
    noFolder,
    cantSignIn: cantSignIn ? ENGINE_TITLE[engine] : null,
    starting: busy,
    noEngine,
    signedOut: signedOut && engineInfo ? engineInfo.title : null,
  });
  const groupName = group === UNGROUPED ? "Ungrouped" : (layout.groups.find((g) => g.id === group)?.name ?? "Ungrouped");
  const accountName = accounts.length > 0 ? (account === OWN_SIGN_IN ? OWN_SIGN_IN_LABEL : accounts.find((a) => a.id === account)?.name) : null;
  const summary = [
    offered.length > 1 || remote ? ENGINE_TITLE[engine] : null,
    accountChoices > 1 ? accountName : null,
    inDesk ? (approvals === "desk" ? "asks in Desk" : "asks in its terminal") : null,
    canApproveForMe && approveForMe ? "approves for you" : null,
    canRunFast && fast ? "Fast" : null,
    layout.groups.length > 0 ? groupName : null,
    shownName ? `named ${shownName}` : null,
  ].filter(Boolean);

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="sheet new-session" onSubmit={(e) => void submit(e)} aria-label="New session">
        <div className="dialog-title">
          <h2 className="display-md">New session</h2>
          <p className="small">{NEW_SESSION_LINE}</p>
        </div>
        <RunOn
          value={runOn}
          onChange={(m) => {
            if (m === runOn) return;
            setRunOn(m);
            // A folder here isn't one there.
            setCwdRaw(m === LOCAL ? (lastFolder(m) ?? "") : "");
            setEngines(null);
            setProblem(null);
          }}
        />
        <label className="field">
          <span>Goal</span>
          <input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="What should it get done?" autoFocus />
        </label>
        {noEngine && engines && <NothingToStart engines={engines} machine={runOn} where={whereSaid} native={native} onFixed={readAgain} />}
        {signedOut && engineInfo && <NotSignedIn engine={engineInfo} machine={runOn} where={whereSaid} native={native} onFixed={readAgain} />}
        {remote && missing.length > 0 && !noEngine && (
          <p className="muted small">
            {missing.join(" and ")} {missing.length === 1 ? "isn’t" : "aren’t"} installed on {where}.
          </p>
        )}
        {remote ? (
          <FolderPicker key={runOn} machine={runOn} name={where} native={native} value={cwd} onChange={setCwd} always onMissing={setNoFolder} />
        ) : (
          <div className="field">
            <span>
              <label htmlFor="new-session-folder">Folder</label>
            </span>
            <span className="field-row">
              <input id="new-session-folder" className="mono" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="~/src/project" spellCheck={false} autoComplete="off" />
              <button type="button" className="btn btn-ghost" onClick={() => void choose()}>
                Choose…
              </button>
            </span>
            {here.remote && <span className="muted small ns-remote">{here.remote}</span>}
            {recent.filter((r) => r.path !== folder).length > 0 && (
              <div className="ns-recent" role="group" aria-label="Recent folders">
                {recent
                  .filter((r) => r.path !== folder)
                  .map((r) => (
                    <button key={r.path} type="button" className="ns-recent-row" onClick={() => setCwd(r.path)}>
                      <span className="mono ns-recent-path">{r.path}</span>
                      <span className="faint small">{remotes[r.path] || r.when}</span>
                    </button>
                  ))}
              </div>
            )}
          </div>
        )}
        <label className={`ns-copy${noCopy || copyOld ? " ns-copy-off" : ""}`}>
          <input type="checkbox" checked={useCopy} disabled={noCopy || copyOld || features === null} onChange={(e) => setCopy(e.target.checked)} />
          <span className="ns-copy-main">
            <span>Work on a separate copy</span>
            <span className="muted small">
              {copyOld
                ? `Desk on ${where} needs an update before it can make a separate copy.`
                : noCopy
                ? "That folder isn’t a git project, so there’s no separate copy to make."
                : useCopy
                  ? `Desk makes a new branch, ${branch}, and works there; the folder stays as it is.`
                  : "It works in the folder itself. Tick this to give it a branch of its own, and leave the folder as it is."}
            </span>
          </span>
        </label>
        {cantSignIn && (
          <p className="small state-blocked" role="alert">
            {ENGINE_TITLE[engine]} isn’t signed in on {where}, and none of its accounts there can sign in.{" "}
            <button type="button" className="link" onClick={() => openSettingsAt("providers")}>
              Sign in to {ENGINE_TITLE[engine]}
            </button>
          </p>
        )}
        <details className="ns-options">
          <summary>
            <span className="ov-label muted">Options</span>
            <span className="muted small">{summary.join(" · ") || "As usual"}</span>
          </summary>
          <div className="ns-options-body">
            {offered.length > 0 && (
              <div className="field">
                <span className="ov-label muted">Engine</span>
                <div className="seg" role="radiogroup" aria-label="Engine">
                  {offered.map((k) => (
                    <button key={k} type="button" role="radio" aria-checked={engine === k} onClick={() => setEngine(k)}>
                      {ENGINE_TITLE[k]}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {accountChoices > 1 && (
              <div className="field">
                <span className="ov-label muted">Account</span>
                <div className="seg" role="radiogroup" aria-label="Account">
                  {accounts.map((a) => (
                    <button key={a.id} type="button" role="radio" aria-checked={account === a.id} onClick={() => setPicked((p) => ({ ...p, [engine]: a.id }))}>
                      {a.name}
                    </button>
                  ))}
                  {ownWorks && (
                    <button type="button" role="radio" aria-checked={account === OWN_SIGN_IN} onClick={() => setPicked((p) => ({ ...p, [engine]: OWN_SIGN_IN }))}>
                      {OWN_SIGN_IN_LABEL}
                    </button>
                  )}
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
                <span className="ov-label muted">Approvals</span>
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
                <span className="ov-label muted">Approvals</span>
                <div className="seg" role="radiogroup" aria-label="Approvals">
                  <button type="button" role="radio" aria-checked={!approveForMe} onClick={() => setApproveForMe(false)}>
                    Ask me
                  </button>
                  <button type="button" role="radio" aria-checked={approveForMe} onClick={() => setApproveForMe(true)}>
                    Approve for me
                  </button>
                </div>
                {approveForMe && <p className="muted small">Codex’s own reviewer answers what it asks, inside the workspace sandbox. You can still stop its turn.</p>}
              </div>
            )}
            {canRunFast && (
              <div className="field">
                <span className="ov-label muted">Speed</span>
                <div className="seg" role="radiogroup" aria-label="Speed">
                  <button type="button" role="radio" aria-checked={!fast} onClick={() => setFast(false)}>
                    Standard
                  </button>
                  <button type="button" role="radio" aria-checked={fast} onClick={() => setFast(true)}>
                    Fast
                  </button>
                </div>
                {fast && <p className="muted small">{FAST_NOTE}</p>}
              </div>
            )}
            {layout.groups.length > 0 && (
              <div className="field">
                <span className="ov-label muted">Group</span>
                <GroupChoice group={group} onPick={setGroup} groups={layout.groups} />
                <span className="muted small">{groupSays(group, startedIn, groupName, remote ? where : null)}</span>
              </div>
            )}
            <label className="field">
              <span className="ov-label muted">Name</span>
              <input className="mono" value={name} onChange={(e) => setName(e.target.value)} placeholder={nameFromGoal(goal) || (folder ? nameFrom(folder) : "named from the goal")} />
            </label>
          </div>
        </details>
        {problem && <ProblemNote problem={problem} onDone={() => setProblem(null)} />}
        <footer className="sheet-foot ns-foot">
          <span className="ns-why small" role={blocked ? "status" : undefined}>
            {blocked?.words}
            {blocked?.fix && (
              <>
                {" "}
                <button type="button" className="link" onClick={blocked.fix.run}>
                  {blocked.fix.label}
                </button>
              </>
            )}
          </span>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-signal" disabled={busy || !!blocked}>
            {busy ? "Starting…" : remote ? `Start in ${folder || "~"}` : "Start"}
          </button>
        </footer>
      </form>
    </div>
  );
}

/** No engine to start a session with there: what isn't installed, each
 *  with Install. */
export function NothingToStart({ engines, machine, where, native, onFixed }: { engines: EngineInfo[]; machine: MachineId; where: string; native: MachineNative; onFixed: () => void }) {
  const absent = engines.filter((e) => e.installed === false && (e.engine === "claude" || e.engine === "codex"));
  return (
    <div className="new-fix" role="group" aria-label="Nothing to start a session with">
      <p className="small state-blocked">
        {absent.length
          ? `Neither Claude Code nor Codex is installed on ${where}, so there’s nothing to start a session with yet.`
          : `Nothing on ${where} can start a session yet.`}
      </p>
      <span>
        {/* A machine's installs both at once. */}
        {(machine === LOCAL ? absent : absent.slice(0, 1)).map((e) => (
          <InstallEngine key={e.engine} engine={e} machine={machine} where={where} native={native} onInstalled={onFixed} />
        ))}
      </span>
    </div>
  );
}

/** The engine chosen is installed but never signed in, and has no account:
 *  sign it in here (Claude to an account, Codex to ChatGPT). */
function NotSignedIn({ engine, machine, where, native, onFixed }: { engine: EngineInfo; machine: MachineId; where: string; native: MachineNative; onFixed: () => void }) {
  const [signing, setSigning] = useState(false);
  const codex = useCodexSignIn(machine, where, native, onFixed);
  if (engine.engine === "claude" && signing)
    return (
      <SignInClaude
        machine={machine}
        where={where}
        native={native}
        onDone={() => {
          setSigning(false);
          onFixed();
        }}
      />
    );
  if (engine.engine === "codex" && codex.run.at !== "idle") return <CodexSigningIn codex={codex} machine={machine} where={where} />;
  return (
    <div className="new-fix" role="group" aria-label={`${engine.title} isn’t signed in`}>
      <p className="small state-blocked">
        {engine.title} isn’t signed in on {where}, so a session would stop at its sign-in.
      </p>
      <span>
        <button type="button" className="btn btn-sm btn-signal" onClick={() => (engine.engine === "codex" ? void codex.begin() : setSigning(true))}>
          {engine.engine === "codex" ? "Sign in to ChatGPT…" : "Sign in to Claude…"}
        </button>
      </span>
    </div>
  );
}

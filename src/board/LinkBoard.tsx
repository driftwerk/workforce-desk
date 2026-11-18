import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useChat } from "../chat/store";
import { openSettingsAt } from "../ui/problem";
import { HubError } from "../hub/client";
import { useDesk } from "../hub/store";
import { isGithubProject, looksLikeToken, mintSyncToken, ownerOk, SYSTEM_TITLE, targetOk, targetWords, type Checked } from "../hub/boardSync";
import type { Board, LinkCheck, SyncAssignee, SyncFilter, SyncSystem, SyncVia, TicketState } from "../hub/types";
import { openUrl } from "../platform";
import { CloseButton, Dialog } from "../ui/Dialog";
import { STATE_TITLE } from "./board";
import { ChooseMe } from "./ChooseMe";
import { useBoard } from "./store";
import { localHubRef, localSync, syncChoices, useSyncHubs, type SyncChoice } from "./syncStore";
import { NoAgent, ThisComputerSetup } from "./syncSetup";

/** What a hub (or this computer) said when asked whether it offers the
 *  system's tools. */
type Probe =
  | { state: "checking" }
  | { state: "offered"; teams: Team[]; projects: Project[]; repos: Repo[]; owner: string | null; projectsWhy: string | null; agent: string | null; workspaces: string[]; workspace: string | null; why: string | null }
  | { state: "no"; error: string; noToken: boolean; noAgent: boolean }
  | { state: "needsToken" };
type Team = { id: string; key: string; name: string };
type Project = { key: string; name: string; id?: string };
type Repo = { key: string; name: string };

type FilterKind = SyncFilter["kind"];

/** The filters each system's sync can import by: the whole project or
 *  team first, then narrower ones. Linear's tools can't list a cycle, so it
 *  has none. */
const FILTERS: Record<SyncSystem, { kind: FilterKind; label: string; sub: string }[]> = {
  jira: [
    { kind: "all", label: "Whole project", sub: "every open issue, whoever has it: pick up work and see who has what" },
    { kind: "assignedToMe", label: "Assigned to me", sub: "issues assigned to you in the project" },
    { kind: "currentCycle", label: "The current sprint", sub: "issues in the sprint that is open now" },
    { kind: "label", label: "A label", sub: "issues with one label" },
    { kind: "query", label: "A Jira search", sub: "a search you wrote in Jira’s issue search, kept inside the project" },
  ],
  github: [
    { kind: "all", label: "Whole board", sub: "every open issue, whoever has it: pick up work and see who has what" },
    { kind: "assignedToMe", label: "Assigned to me", sub: "issues assigned to you" },
    { kind: "label", label: "A label", sub: "issues with one label" },
    { kind: "milestone", label: "A milestone", sub: "issues in one milestone" },
    { kind: "query", label: "A project filter", sub: "a filter written as in the project’s own filter box, like label:bug -status:Done" },
  ],
  linear: [
    { kind: "all", label: "Whole team", sub: "every open issue, whoever has it: pick up work and see who has what" },
    { kind: "assignedToMe", label: "Assigned to me", sub: "your issues in the team" },
    { kind: "label", label: "A label", sub: "issues with one label" },
    { kind: "query", label: "An advanced filter", sub: "a filter written for Linear, kept inside the team" },
  ],
};

/** The filters a link to `system` offers: a GitHub repository has no
 *  project filter to write. */
const filtersFor = (system: SyncSystem, project: boolean) => FILTERS[system].filter((f) => system !== "github" || project || f.kind !== "query");

/** A remote state as the state map names it: GitHub's `label:x` as "Label x". */
const stateName = (r: string): string => (r.startsWith("label:") ? `Label ${r.slice(6)}` : r);

/** A GitHub login, as the hub checks one. */
const githubLogin = (s: string): boolean => /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(s);

/** The columns a remote state can be mapped from, left to right. */
const MAPPED: TicketState[] = ["backlog", "todo", "doing", "review", "done", "dropped"];

/** What a person's several instances of a system are called. */
const WORKSPACE: Record<SyncSystem, string> = { jira: "Jira site", linear: "Linear workspace", github: "GitHub account" };

/** A check's answer as a probe says it. */
const probeOf = (r: Checked): Probe =>
  r.ok
    ? {
        state: "offered",
        teams: r.check.teams ?? [],
        projects: r.check.projects ?? [],
        repos: r.check.repos ?? [],
        owner: r.check.owner ?? null,
        projectsWhy: r.check.projectsWhy ?? null,
        agent: r.check.agent?.name ?? null,
        workspaces: r.check.workspaces ?? [],
        workspace: r.check.workspace ?? null,
        why: r.check.workspaceWhy ?? null,
      }
    : { state: "no", error: r.error, noToken: r.paused?.kind === "noToken", noAgent: r.paused?.kind === "missing" };

/** A Linear id (a member's), as the hub takes one. */
const linearId = (s: string): boolean => /^[0-9a-fA-F-]{1,64}$/.test(s);

/** A refusal in the hub's words, or why it couldn't be asked. */
const saidOf = (e: unknown): string =>
  e instanceof HubError ? plainLinkError(e.message) : e instanceof TypeError ? "Desk isn't ready right now. Try again in a moment." : e instanceof Error ? e.message : String(e);

/** A hub's refusal of a search, in words that don't need JQL. */
const plainLinkError = (said: string): string => (/ORDER BY/i.test(said) && /JQL/i.test(said) ? "A Jira search here can’t sort the issues: leave out its “order by” part." : said);

/** A board made for a link that failed: taken away again, here and on the
 *  hub, and the original shown. If the failure was a lost answer and the
 *  link did apply, the board is kept (`linked`) instead. `stuck`: the hub
 *  wouldn't delete it. */
const undoMade = async (made: string, original: string): Promise<"removed" | "linked" | "stuck"> => {
  const hub = useDesk.getState().hub;
  if (!hub) return "stuck";
  const now = await hub.boards().catch(() => null);
  const there = now?.find((b) => b.id === made);
  if (there?.sync) {
    useBoard.setState((st) => ({ boards: { ...st.boards, [made]: there }, shown: made }));
    return "linked";
  }
  try {
    await hub.deleteBoard(made);
  } catch {
    return "stuck";
  }
  useBoard.setState((st) => {
    const { [made]: _, ...boards } = st.boards;
    return { boards, tickets: Object.fromEntries(Object.entries(st.tickets).filter(([, t]) => t.board !== made)), shown: original };
  });
  return "removed";
};

/** The link dialog, from a board's menu: the system, then a hub that offers
 *  it (or this computer), then the project or team, the import filter with
 *  how many issues it matches, and the state map. A hub with no token for
 *  the board's sync gets one made there by Desk where the hub allows it;
 *  otherwise the person pastes one made on that hub, once. Laid out as the
 *  Move and Continue-in dialogs are (.move-*). */
export function LinkBoardDialog({ board, tickets, onClose }: { board: Board; tickets: number; onClose: () => void }) {
  const ids = useId();
  const paired = useChat((s) => s.hubs);
  const kept = useSyncHubs((s) => s.hubs);
  const choices = useMemo(() => syncChoices(paired, kept), [paired, kept]);
  const [system, setSystem] = useState<SyncSystem | null>(null);
  const [viaKey, setViaKey] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, Probe>>({});
  const [target, setTarget] = useState("");
  /** The project key typed though the hub lists projects. */
  const [typedKey, setTypedKey] = useState(false);
  const [teamId, setTeamId] = useState("");
  /** GitHub: a project (preferred) or a repository's issues. */
  const [ghKind, setGhKind] = useState<"project" | "repo">("project");
  /** GitHub: the owner typed, once the person changes it from the account listed. */
  const [ownerTyped, setOwnerTyped] = useState<string | null>(null);
  /** GitHub project boards: the repo tickets made here become issues in. */
  const [newRepo, setNewRepo] = useState("");
  const [filterKind, setFilterKind] = useState<FilterKind>("all");
  const [filterValue, setFilterValue] = useState("");
  const [includeDone, setIncludeDone] = useState(false);
  const [me, setMe] = useState("");
  /** Who the hub says the person is on the target's system (null: it
   *  can't say), by the system, hub and target it was asked for. */
  const [heardMe, setHeardMe] = useState<{ key: string; me: SyncAssignee | null; why?: string; by?: "email" | "slack" | "chosen" } | null>(null);
  /** Choosing who they are on a shared key. */
  const [choosing, setChoosing] = useState(false);
  /** The person said the hub's answer isn't them: it isn't kept. */
  const [notMe, setNotMe] = useState(false);
  /** Bumped to ask the hub again. */
  const [asked, setAsked] = useState(0);
  const [checked, setChecked] = useState<{ key: string; result: Checked } | null>(null);
  const [states, setStates] = useState<Partial<Record<TicketState, string>>>({});
  const prefilledFor = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    void useSyncHubs.getState().load();
  }, []);

  // ── Which hubs offer the system ─────────────────────────────────────────
  const probeRun = useRef(0);
  /** Bumped once this computer has the system turned on: asked again. */
  const [reprobe, setReprobe] = useState(0);
  const keptKey = (kept ?? []).map((h) => `${h.id}:${h.hasToken}`).join(",");
  useEffect(() => {
    if (!system) return;
    const run = ++probeRun.current;
    const sync = localSync();
    const ask = async (key: string, via: SyncVia) => {
      if (!sync) return;
      const said: Probe = await sync
        .check({ system, via })
        .then(probeOf)
        .catch((e: unknown): Probe => ({ state: "no", error: saidOf(e), noToken: false, noAgent: false }));
      if (probeRun.current === run) setProbes((p) => ({ ...p, [key]: said }));
    };
    const next: Record<string, Probe> = {};
    for (const c of choices) next[c.id] = c.kept?.hasToken ? { state: "checking" } : { state: "needsToken" };
    next[THIS] = { state: "checking" };
    setProbes(next);
    for (const c of choices) if (c.kept?.hasToken) void ask(c.id, { kind: "hub", hub: c.id });
    void ask(THIS, { kind: "thisHub" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [system, keptKey, choices.length, reprobe]);

  const choice = choices.find((c) => c.id === viaKey) ?? null;
  const via: SyncVia | null = viaKey === THIS ? { kind: "thisHub" } : choice ? { kind: "hub", hub: choice.id } : null;
  const probe = viaKey ? probes[viaKey] : undefined;
  const offered = probe?.state === "offered";
  const hubOffers = choices.find((c) => probes[c.id]?.state === "offered");
  const viaName = viaKey === THIS ? "This computer" : (choice?.name ?? "");

  // ── Which of the person's workspaces there ──────────────────────────────
  // Where they have several Jira sites or Linear workspaces on the hub, one
  // is picked (the one their calls go to when none is named, to start
  // with), and its own teams or projects are asked for.
  const workspaces = probe?.state === "offered" ? probe.workspaces : [];
  const several = workspaces.length > 1;
  const [workspaceFor, setWorkspaceFor] = useState<Record<string, string>>({});
  const pickKey = `${system}:${viaKey}`;
  const picked = viaKey ? workspaceFor[pickKey] : undefined;
  const workspace: string | null = !several || probe?.state !== "offered" ? null : picked && workspaces.includes(picked) ? picked : probe.workspace && workspaces.includes(probe.workspace) ? probe.workspace : null;
  const [inWorkspace, setInWorkspace] = useState<Record<string, Probe>>({});
  // Asked again whenever the hubs are (a new token, a turned-on system).
  const wsKey = viaKey && workspace ? `${system}:${viaKey}:${workspace}:${keptKey}:${reprobe}` : null;
  const wsProbe = wsKey ? inWorkspace[wsKey] : undefined;
  useEffect(() => {
    if (!system || !via || !wsKey || !workspace || inWorkspace[wsKey]) return;
    const sync = localSync();
    if (!sync) return;
    setInWorkspace((p) => ({ ...p, [wsKey]: { state: "checking" } }));
    void sync
      .check({ system, via, workspace })
      .then(probeOf)
      .catch((e: unknown): Probe => ({ state: "no", error: saidOf(e), noToken: false, noAgent: false }))
      .then((said) => setInWorkspace((p) => ({ ...p, [wsKey]: said })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsKey]);
  /** The probe the teams and projects come from: the workspace's own,
   *  where there are several. */
  const baseListed = several ? wsProbe : probe;
  // GitHub: another owner's projects and repos, asked for once typed.
  const ownerAsk = ownerTyped !== null && ownerOk(ownerTyped.trim()) ? ownerTyped.trim() : null;
  const ownerKey = viaKey && ownerAsk ? `${viaKey}:${ownerAsk.toLowerCase()}:${keptKey}:${reprobe}` : null;
  const [ofOwner, setOfOwner] = useState<Record<string, Probe>>({});
  const ownerProbe = ownerKey ? ofOwner[ownerKey] : undefined;
  useEffect(() => {
    if (system !== "github" || !via || !ownerKey || !ownerAsk || !offered) return;
    const run = ownerKey;
    const sync = localSync();
    if (!sync) return;
    const t = setTimeout(() => {
      setOfOwner((p) => (p[run] ? p : { ...p, [run]: { state: "checking" } }));
      void sync
        .check({ system, via, owner: ownerAsk })
        .then(probeOf)
        .catch((e: unknown): Probe => ({ state: "no", error: saidOf(e), noToken: false, noAgent: false }))
        .then((said) => setOfOwner((p) => ({ ...p, [run]: said })));
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerKey, offered]);
  const listed = system === "github" && ownerAsk ? ownerProbe : baseListed;
  /** Teams or projects may be picked: the hub offers the system, and the
   *  workspace (where there are several) is picked and answered. */
  const ready = offered && listed?.state === "offered" && !listed.why;
  const pickWorkspace = (w: string) => {
    if (!viaKey) return;
    setWorkspaceFor((m) => ({ ...m, [pickKey]: w }));
    setTarget("");
    setTeamId("");
    setMe("");
    setNotMe(false);
    setChecked(null);
  };
  /** GitHub: a project or a repository: what was picked is dropped. */
  const pickGhKind = (k: "project" | "repo") => {
    setGhKind(k);
    setTarget("");
    setTypedKey(false);
    setNewRepo("");
    setChecked(null);
    if (k === "repo" && filterKind === "query") setFilterKind("all");
  };
  const pickOwner = (v: string) => {
    setOwnerTyped(v.trim() === "" ? null : v.replace(/\s/g, ""));
    setTarget("");
    setNewRepo("");
    setChecked(null);
  };

  // ── The target, the filter and what they match ──────────────────────────
  const teams = ready && listed?.state === "offered" ? listed.teams : [];
  const projects = ready && listed?.state === "offered" ? listed.projects : [];
  const repos = ready && listed?.state === "offered" ? listed.repos : [];
  const projectsWhy = ready && listed?.state === "offered" ? listed.projectsWhy : null;
  /** GitHub: the account listed (what the hub said, until another is typed). */
  const ownerShown = ownerTyped ?? (listed?.state === "offered" ? (listed.owner ?? "") : (probe?.state === "offered" ? (probe.owner ?? "") : ""));
  const asProject = system === "github" && ghKind === "project";
  const project = asProject ? (projects.find((p) => p.key === target) ?? null) : null;
  const team = teams.find((t) => t.id === teamId) ?? null;
  const targetKey = system === "linear" ? (team?.key ?? "") : target;
  const targetGood = !!system && !!targetKey && targetOk(system, targetKey) && (system !== "github" || isGithubProject(targetKey) === asProject);
  const filter: SyncFilter | null =
    filterKind === "all"
      ? { kind: "all", value: { includeDone } }
      : filterKind === "assignedToMe" || filterKind === "currentCycle"
        ? { kind: filterKind }
        : filterValue.trim()
          ? { kind: filterKind, value: filterValue.trim() }
          : null;
  // Who the person is there comes from the hub; only where it can't say is
  // a Linear member id asked for, for "assigned to me".
  const meKey = `${system}:${viaKey}:${workspace}:${targetKey}`;
  const heard = heardMe?.key === meKey ? heardMe : null;
  const knownMe = notMe ? null : heard ? heard.me : undefined;
  const idOk = system === "github" ? githubLogin : linearId;
  const meNeeded = (system === "linear" || system === "github") && filterKind === "assignedToMe" && knownMe === null;
  const filterReady = !!filter && (!meNeeded || idOk(me.trim()));
  const meBad = !!me.trim() && !idOk(me.trim());
  const checkKey = JSON.stringify([system, viaKey, workspace, ownerTyped, targetKey, team?.id, project?.id, filterReady ? filter : null, meNeeded ? me.trim() : null, asked]);
  const checkRun = useRef(0);
  useEffect(() => {
    if (!system || !via || !ready || !targetGood) return;
    const run = ++checkRun.current;
    const sync = localSync();
    if (!sync) return;
    const t = setTimeout(() => {
      void sync
        .check({
          system,
          via,
          ...(workspace ? { workspace } : {}),
          ...(system === "github" && ownerAsk ? { owner: ownerAsk } : {}),
          target: targetKey,
          ...(team ? { targetId: team.id } : {}),
          ...(project?.id ? { targetId: project.id } : {}),
          ...(filterReady && filter ? { filter } : {}),
          ...(meNeeded && filterReady ? { me: me.trim() } : {}),
        })
        .catch((e: unknown): Checked => ({ ok: false, error: saidOf(e), paused: null, status: 0 }))
        .then((result) => {
          if (checkRun.current === run) setChecked({ key: checkKey, result });
        });
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkKey, ready, targetGood]);
  const now = checked?.key === checkKey ? checked.result : null;
  const found: LinkCheck | null = now?.ok ? now.check : null;
  // What the hub said of who the person is, kept for the target: an older
  // hub that wants the id says so as a refusal.
  useEffect(() => {
    if (!now || !targetKey) return;
    if (now.ok && now.check.me !== undefined) setHeardMe({ key: meKey, me: now.check.me, why: now.check.meWhy, by: now.check.meBy });
    else if (!now.ok && now.status === 400 && (system === "linear" || system === "github") && filterKind === "assignedToMe" && /member|login/i.test(now.error)) setHeardMe({ key: meKey, me: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now]);
  const remoteStates = found?.states ?? null;
  // The state map starts from what the hub's states mean, once per target.
  useEffect(() => {
    const k = `${system}:${viaKey}:${workspace}:${targetKey}`;
    if (!found?.prefill || prefilledFor.current === k) return;
    prefilledFor.current = k;
    setStates(found.prefill);
  }, [found, system, viaKey, workspace, targetKey]);

  const hasTickets = tickets > 0;
  /** What happens to the board's own tickets: kept beside the issues, or
   *  cleared first. */
  const [own, setOwn] = useState<"keep" | "clear" | "new" | null>(null);
  const canLink = (!hasTickets || !!own) && !!system && !!via && ready && targetGood && filterReady && !!found && found.matches !== undefined && !busy;
  /** Why Link can't be pressed yet: the first thing missing, in plain words. */
  const waitingOn: { words: string; failed: boolean } | null = (() => {
    if (busy) return null;
    if (hasTickets && !own) return { words: `Say what happens to ${board.name}’s ${tickets === 1 ? "ticket" : `${tickets} tickets`}.`, failed: false };
    if (!system) return { words: "Pick Jira, Linear or GitHub.", failed: false };
    if (!localSync()) return { words: "Desk isn’t ready yet, so nothing can be checked or linked. Try again in a moment.", failed: true };
    if (!via) return { words: `Pick where ${SYSTEM_TITLE[system]} is reached through.`, failed: false };
    if (!offered) {
      if (!probe || probe.state === "checking") return { words: `Waiting for ${viaName} to say whether it offers ${SYSTEM_TITLE[system]}…`, failed: false };
      if (probe.state === "needsToken") return { words: `${viaName} needs a token first.`, failed: false };
      if (probe.state === "no") return { words: probe.noToken ? `${viaName} needs a new token.` : probe.error, failed: true };
    }
    if (several && !workspace) return { words: (probe?.state === "offered" && probe.why) || `Pick which ${WORKSPACE[system]}.`, failed: false };
    if (several && workspace) {
      if (!wsProbe || wsProbe.state === "checking") return { words: `Asking ${viaName} for ${workspace}’s ${system === "jira" ? "projects" : "teams"}…`, failed: false };
      if (wsProbe.state === "no") return { words: wsProbe.error, failed: true };
      if (wsProbe.state === "offered" && wsProbe.why) return { words: wsProbe.why, failed: true };
    }
    // What the hub says stops the list, whatever it is.
    if (listed?.state === "offered" && listed.why) return { words: listed.why, failed: true };
    if (system === "github" && ownerAsk && (!ownerProbe || ownerProbe.state === "checking")) return { words: `Asking ${viaName} for ${ownerAsk}’s projects and repositories…`, failed: false };
    if (system === "github" && ownerProbe?.state === "no") return { words: ownerProbe.error, failed: true };
    if (!targetGood)
      return {
        words:
          system === "linear"
            ? "Pick a team."
            : system === "github"
              ? asProject
                ? projects.length > 0 && !typedKey
                  ? "Pick a project."
                  : "Enter the project as owner/projects/7."
                : repos.length > 0 && !typedKey
                  ? "Pick a repository."
                  : "Enter the repository as owner/name."
              : projects.length > 0 && !typedKey
                ? "Pick a project."
                : "Enter the Jira project key.",
        failed: false,
      };
    if (!filterReady) return { words: meNeeded ? (system === "github" ? "Enter your GitHub login." : "Enter your Linear member id.") : "Say what to import.", failed: false };
    if (!now) return { words: "Waiting for the match count…", failed: false };
    if (!now.ok) return { words: `The match check failed: ${plainLinkError(now.error)}`, failed: true };
    if (now.check.matches === undefined) return { words: "Waiting for the match count…", failed: false };
    return null;
  })();
  const footNote = problem ? { words: problem, failed: true } : waitingOn;
  const link = async () => {
    const sync = localSync();
    if (!canLink || !sync || !system || !via || !filter) return;
    setBusy(true);
    setProblem(null);
    let made: Board | null = null;
    try {
      // Cleared first: they're Desk's own, and nothing there changes.
      if (hasTickets && own === "clear") {
        const mine = Object.values(useBoard.getState().tickets).filter((t) => t.board === board.id);
        for (const t of mine) await useBoard.getState().remove(t.id);
      }
      const mapped = Object.fromEntries(Object.entries(states).filter(([, v]) => !!v));
      // A new board takes the link and this one stays as it is.
      let into = board;
      if (hasTickets && own === "new") {
        made = await useBoard.getState().createBoard(`${board.name} · ${SYSTEM_TITLE[system]}`);
        into = made;
        if (board.group) {
          const hub = useDesk.getState().hub;
          if (hub) {
            made = await hub.updateBoard(made.id, { group: board.group }).catch(() => made as Board);
            useBoard.setState((s) => ({ boards: { ...s.boards, [made!.id]: made! } }));
          }
        }
      }
      const b = await sync.link(into.id, {
        system,
        target: targetKey,
        ...(team ? { targetId: team.id } : {}),
        ...(project?.id ? { targetId: project.id } : {}),
        ...(asProject && newRepo ? { repo: newRepo } : {}),
        via,
        ...(workspace ? { workspace } : {}),
        filter,
        ...(meNeeded ? { me: me.trim() } : {}),
        ...(notMe ? { notMe: true } : {}),
        ...(hasTickets && own === "keep" ? { keepTickets: true } : {}),
        states: mapped,
      });
      useBoard.setState((s) => ({ boards: { ...s.boards, [b.id]: b } }));
      void sync.syncNow(b.id).catch(() => {});
      onClose();
    } catch (e) {
      let words = saidOf(e);
      if (made) {
        const outcome = await undoMade(made.id, board.id);
        if (outcome === "linked") {
          void sync.syncNow(made.id).catch(() => {});
          onClose();
          return;
        }
        if (outcome === "stuck") words = `${words} The new board “${made.name}” couldn’t be removed either: delete it from its menu.`;
      }
      setProblem(words);
      setBusy(false);
    }
  };

  const pick = (key: string) => {
    setViaKey(key);
    setTarget("");
    setTeamId("");
    setOwnerTyped(null);
    setNewRepo("");
    setChecked(null);
  };

  return (
    <Dialog
      onClose={onClose}
      title={(id) => (
        <header className="dialog-head">
          <span className="dialog-title">
            <h1 id={id} className="display-lg">
              Link “{board.name}” to Jira, Linear or GitHub
            </h1>
            <p className="small">Its tickets become the project’s issues: what you move here goes out, what changes there comes in.</p>
          </span>
          <CloseButton onClose={onClose} />
        </header>
      )}
    >
      <div className="dialog-scroll move-body sync-link">
        {hasTickets && (
          <fieldset className="move-field">
            <legend>
              Its {tickets === 1 ? "ticket" : `${tickets} tickets`}
            </legend>
            <div className="move-opts" role="radiogroup" aria-label={`${board.name}’s tickets`}>
              <label className="move-opt">
                <input type="radio" name={`${ids}-own`} checked={own === "keep"} disabled={busy} onChange={() => setOwn("keep")} />
                <span className="move-opt-main">
                  <span>Keep {tickets === 1 ? "it" : "them"} beside the issues</span>
                  <span className="move-opt-sub">{tickets === 1 ? "It stays" : "They stay"} on Desk only, with {tickets === 1 ? "its" : "their"} own keys; the project’s issues come in alongside.</span>
                </span>
              </label>
              <label className="move-opt">
                <input type="radio" name={`${ids}-own`} checked={own === "new"} disabled={busy} onChange={() => setOwn("new")} />
                <span className="move-opt-main">
                  <span>Make a new board and link it</span>
                  <span className="move-opt-sub">{board.name} stays as it is, with {tickets === 1 ? "its ticket" : "its tickets"}; the project’s issues go on the new board.</span>
                </span>
              </label>
              <label className="move-opt">
                <input type="radio" name={`${ids}-own`} checked={own === "clear"} disabled={busy} onChange={() => setOwn("clear")} />
                <span className="move-opt-main">
                  <span>Clear {tickets === 1 ? "it" : "them"} first</span>
                  <span className="move-opt-sub">Deleted from this board before it links. Nothing in {system ? SYSTEM_TITLE[system] : "Jira, Linear or GitHub"} changes.</span>
                </span>
              </label>
            </div>
          </fieldset>
        )}

        <fieldset className="move-field">
          <legend>System</legend>
          <div className="seg handoff-seg" role="radiogroup" aria-label="System">
            {(["jira", "linear", "github"] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={system === s}
                disabled={busy}
                onClick={() => {
                  setSystem(s);
                  setViaKey(null);
                  setFilterKind("all");
                  setFilterValue("");
                  setGhKind("project");
                  setOwnerTyped(null);
                  setNewRepo("");
                  setTarget("");
                  setTypedKey(false);
                  setChecked(null);
                }}
              >
                {SYSTEM_TITLE[s]}
              </button>
            ))}
          </div>
        </fieldset>

        {system && (
          <fieldset className="move-field">
            <legend>Through</legend>
            <div className="move-opts" role="radiogroup" aria-label="Through">
              {choices.map((c) => (
                <HubRow key={c.id} name={`${ids}-via`} choice={c} system={system} probe={probes[c.id]} picked={viaKey === c.id} disabled={busy} onPick={() => pick(c.id)} />
              ))}
              <ThisComputer name={`${ids}-via`} system={system} probe={probes[THIS]} hubOffers={hubOffers?.name ?? null} picked={viaKey === THIS} disabled={busy} onPick={() => pick(THIS)} />
            </div>
            {choices.map((c) => {
              const p = probes[c.id];
              return p?.state === "no" && p.noAgent ? <NoAgent key={c.id} choice={c} system={system} words={p.error} /> : null;
            })}
            {probes[THIS]?.state === "no" && !hubOffers && !choices.some((c) => probes[c.id]?.state === "checking") && (
              <ThisComputerSetup key={system} system={system} disabled={busy} onReady={() => setReprobe((n) => n + 1)} />
            )}
            {choices.length === 0 && <span className="move-opt-sub">No workspace is connected to Desk: link one in Settings → Workspaces to sync through its {SYSTEM_TITLE[system]}.</span>}
            {choice && (probe?.state === "needsToken" || (probe?.state === "no" && probe.noToken)) && (
              <TokenPanel key={choice.id} choice={choice} again={probe.state === "no"} />
            )}
          </fieldset>
        )}

        {system && via && offered && several && (
          <fieldset className="move-field">
            <legend>{system === "jira" ? "Site" : "Workspace"}</legend>
            <div className="move-opts" role="radiogroup" aria-label={WORKSPACE[system]}>
              {workspaces.map((w) => (
                <label key={w} className="move-opt">
                  <input type="radio" name={`${ids}-workspace`} checked={workspace === w} disabled={busy} onChange={() => pickWorkspace(w)} />
                  <span className="move-opt-main">
                    <span>{w}</span>
                    <span className="move-opt-sub">
                      {probe?.state === "offered" && probe.workspace === w ? `Where your ${SYSTEM_TITLE[system]} calls on ${viaName} go when none is named` : `Your ${WORKSPACE[system]} ${w} on ${viaName}`}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <span className="move-opt-sub">The board syncs this one only, and keeps it with the link.</span>
          </fieldset>
        )}

        {system === "github" && via && offered && (
          <fieldset className="move-field">
            <legend>Where</legend>
            <div className="seg handoff-seg" role="radiogroup" aria-label="Project or repository">
              {(["project", "repo"] as const).map((k) => (
                <button key={k} type="button" role="radio" aria-checked={ghKind === k} disabled={busy} onClick={() => pickGhKind(k)}>
                  {k === "project" ? "A project" : "A repository"}
                </button>
              ))}
            </div>
            <span className="move-opt-sub">
              {asProject ? "The project’s Status options are the board’s columns, and its own order is kept." : "A repository’s issues: open and closed, or a column for each label you map."}
            </span>
            <label className="field">
              <span>Owner</span>
              <input
                className="mono"
                value={ownerShown}
                aria-label="Owner"
                onChange={(e) => pickOwner(e.target.value)}
                placeholder="a user or organization"
                maxLength={39}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={ownerTyped !== null && !ownerAsk}
              />
              {ownerTyped !== null && !ownerAsk ? (
                <span className="move-opt-sub state-blocked">A GitHub login is letters, digits and single dashes.</span>
              ) : (
                <span className="move-opt-sub">Whose {asProject ? "projects" : "repositories"} to list. Your own, until you name another.</span>
              )}
            </label>
            {ready && projectsWhy && asProject && (
              <p className="move-callout move-refused" role="alert">
                {projectsWhy}{" "}
                <button type="button" className="link" onClick={() => pickGhKind("repo")}>
                  Link a repository’s issues instead
                </button>
              </p>
            )}
            {ready && asProject && (
              <>
                {projects.length > 0 && !typedKey ? (
                  <label className="field">
                    <span>{ownerShown ? `${ownerShown}’s` : `${viaName}’s`} GitHub project</span>
                    <select className="board-select sync-select" value={target} onChange={(e) => setTarget(e.target.value)}>
                      <option value="">Pick a project</option>
                      {projects.map((p) => (
                        <option key={p.key} value={p.key}>
                          {p.name} · project {p.key.split("/").pop()}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label className="field">
                    <span>The project’s address</span>
                    <input
                      className="mono"
                      value={target}
                      onChange={(e) => setTarget(e.target.value.replace(/\s/g, ""))}
                      placeholder="acme/projects/7"
                      maxLength={160}
                      spellCheck={false}
                      autoComplete="off"
                      aria-invalid={!!target && !targetGood}
                    />
                    {!!target && !targetGood && <span className="move-opt-sub state-blocked">A project is written owner/projects/7.</span>}
                  </label>
                )}
                {projects.length > 0 && (
                  <button type="button" className="link small" onClick={() => { setTypedKey(!typedKey); setTarget(""); }}>
                    {typedKey ? "Pick from the list" : "Not listed? Type it"}
                  </button>
                )}
                {targetGood && (
                  <label className="field">
                    <span>New tickets go to</span>
                    <select className="board-select sync-select" aria-label="New tickets go to" value={newRepo} disabled={busy} onChange={(e) => setNewRepo(e.target.value)}>
                      <option value="">Nowhere: tickets made here stay on Desk</option>
                      {repos.map((r) => (
                        <option key={r.key} value={r.key}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                    <span className="move-opt-sub">A ticket made here becomes an issue in this repository and is added to the project.</span>
                  </label>
                )}
              </>
            )}
            {ready && !asProject && (
              <>
                {repos.length > 0 && !typedKey ? (
                  <label className="field">
                    <span>{ownerShown ? `${ownerShown}’s` : `${viaName}’s`} repository</span>
                    <select className="board-select sync-select" value={target} onChange={(e) => setTarget(e.target.value)}>
                      <option value="">Pick a repository</option>
                      {repos.map((r) => (
                        <option key={r.key} value={r.key}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label className="field">
                    <span>The repository</span>
                    <input
                      className="mono"
                      value={target}
                      onChange={(e) => setTarget(e.target.value.replace(/\s/g, ""))}
                      placeholder="acme/web"
                      maxLength={160}
                      spellCheck={false}
                      autoComplete="off"
                      aria-invalid={!!target && !targetGood}
                    />
                    {!!target && !targetGood && <span className="move-opt-sub state-blocked">A repository is written owner/name.</span>}
                  </label>
                )}
                {repos.length > 0 && (
                  <button type="button" className="link small" onClick={() => { setTypedKey(!typedKey); setTarget(""); }}>
                    {typedKey ? "Pick from the list" : "Not listed? Type it"}
                  </button>
                )}
              </>
            )}
            {system === "github" && ownerAsk && ownerProbe?.state === "checking" && (
              <span className="move-opt-sub" role="status">
                Asking {viaName} for {ownerAsk}’s projects and repositories…
              </span>
            )}
            {ownerProbe?.state === "no" && (
              <p className="move-callout move-refused" role="alert">
                {ownerProbe.error}
              </p>
            )}
          </fieldset>
        )}

        {system && system !== "github" && via && ready && (
          <fieldset className="move-field">
            <legend>{system === "jira" ? "Project" : "Team"}</legend>
            {system === "jira" && projects.length > 0 && !typedKey ? (
              <>
              <label className="field">
                <span>{viaName}’s Jira project</span>
                <select className="board-select sync-select" value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="">Pick a project</option>
                  {projects.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.key} · {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="link small" onClick={() => { setTypedKey(true); setTarget(""); }}>
                Not listed? Type the key
              </button>
              </>
            ) : system === "jira" ? (
              <>
              <label className="field">
                <span>
                  {viaName}’s Jira project key
                </span>
                <input
                  className="mono"
                  value={target}
                  onChange={(e) => setTarget(e.target.value.toUpperCase().replace(/\s/g, ""))}
                  placeholder="ACME"
                  maxLength={20}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={!!target && !targetGood}
                />
                {!!target && !targetGood && <span className="move-opt-sub state-blocked">A project key is capitals and digits, like ACME.</span>}
              </label>
              {projects.length > 0 && (
                <button type="button" className="link small" onClick={() => { setTypedKey(false); setTarget(""); }}>
                  Pick from the list
                </button>
              )}
              </>
            ) : teams.length === 0 ? (
              <p className="faint small">{viaName} has no Linear team you can reach.</p>
            ) : (
              <label className="field">
                <span>{viaName}’s Linear team</span>
                <select className="board-select sync-select" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
                  <option value="">Pick a team</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.key} · {t.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </fieldset>
        )}

        {system && via && ready && targetGood && (
          <fieldset className="move-field">
            <legend>Import</legend>
            <div className="seg handoff-seg" role="radiogroup" aria-label="Import">
              {filtersFor(system, asProject).map((f) => (
                <button key={f.kind} type="button" role="radio" aria-checked={filterKind === f.kind} disabled={busy} onClick={() => { setFilterKind(f.kind); setFilterValue(""); }}>
                  {f.label}
                </button>
              ))}
            </div>
            <span className="move-opt-sub">{filtersFor(system, asProject).find((f) => f.kind === filterKind)?.sub}</span>
            {filterKind === "all" && (
              <label className="sync-done">
                <input type="checkbox" checked={includeDone} disabled={busy} onChange={(e) => setIncludeDone(e.target.checked)} />
                Also bring in what was done in the last two weeks
              </label>
            )}
            {meNeeded && (
              <>
                <label className="field">
                  <span>{system === "github" ? "Your GitHub login" : "Your Linear member id"}</span>
                  <input
                    className="mono"
                    value={me}
                    onChange={(e) => setMe(e.target.value)}
                    placeholder={system === "github" ? "octocat" : "2f8c1d3a-9b1e-4c7a-…"}
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={meBad}
                    aria-describedby={`${ids}-me`}
                  />
                </label>
                <span id={`${ids}-me`} className={`move-opt-sub${meBad ? " state-blocked" : ""}`}>
                  {system === "github"
                    ? meBad
                      ? "That isn’t a GitHub login: letters, digits and single dashes, not your name or email."
                      : `${viaName} uses a shared GitHub key, which can’t say who you are, so Desk asks once for the login you go by.`
                    : meBad
                    ? "That isn’t a Linear id: it’s a long code of letters a–f, digits and dashes, not your name or email."
                    : `The long code Linear knows you by (its API calls it your user id), not your name or email. ${viaName} can’t say who you are on Linear, so Desk asks once.`}
                </span>
              </>
            )}
            {filterKind === "label" && (
              <label className="field">
                <span>Label</span>
                <input value={filterValue} onChange={(e) => setFilterValue(e.target.value)} placeholder="desk" maxLength={100} spellCheck={false} autoComplete="off" />
              </label>
            )}
            {filterKind === "milestone" && (
              <label className="field">
                <span>Milestone</span>
                {!asProject && (found?.milestones ?? []).length > 0 ? (
                  <select className="board-select sync-select" value={filterValue} disabled={busy} onChange={(e) => setFilterValue(e.target.value)}>
                    <option value="">Pick a milestone</option>
                    {(found?.milestones ?? []).map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input value={filterValue} onChange={(e) => setFilterValue(e.target.value)} placeholder="v2.0" maxLength={100} spellCheck={false} autoComplete="off" />
                )}
              </label>
            )}
            {filterKind === "query" && (
              <label className="field">
                <span>{system === "jira" ? "The search" : system === "github" ? "The project filter" : "The filter"}</span>
                <textarea
                  className="move-note mono sync-query"
                  value={filterValue}
                  onChange={(e) => setFilterValue(e.target.value)}
                  placeholder={system === "jira" ? 'status != Done AND labels = "desk"' : system === "github" ? "label:bug -status:Done" : '{ "state": { "type": { "neq": "completed" } } }'}
                  spellCheck={false}
                />
              </label>
            )}
            <MatchLine ready={filterReady} now={now} whole={filterKind === "all"} />
            {knownMe && (
              <span className="move-opt-sub sync-me">
                {heard?.by === "chosen" ? (
                  <>
                    {viaName} uses a shared {SYSTEM_TITLE[system]} key, and you chose <b>{knownMe.name}</b> there: Mine and Take it go by that.
                  </>
                ) : heard?.by ? (
                  <>
                    {viaName} uses a shared {SYSTEM_TITLE[system]} key, and matched you to <b>{knownMe.name}</b> there {heard.by === "slack" ? "by your Slack email" : "by your verified email"}: Mine and Take it go by that.
                  </>
                ) : (
                  <>
                    {viaName} knows you as <b>{knownMe.name}</b> on {SYSTEM_TITLE[system]}: Mine and Take it go by that.
                  </>
                )}{" "}
                <button type="button" className="link" onClick={() => (heard?.by ? setChoosing(true) : setNotMe(true))}>
                  {heard?.by === "chosen" ? "Change" : "That’s not me"}
                </button>
              </span>
            )}
            {(notMe || (heard && heard.me === null)) && (
              <span className="move-opt-sub sync-me">
                {notMe
                  ? `Desk won’t go by ${viaName}’s answer: Take it waits until you check who you are on the board.`
                  : (heard?.why ?? `${viaName} can’t say who you are on ${SYSTEM_TITLE[system]}.`)}{" "}
                {!notMe && heard?.why && /shared/.test(heard.why) && (
                  <>
                    <button type="button" className="link" onClick={() => setChoosing(true)}>
                      Choose who you are
                    </button>
                    {" · "}
                    <button type="button" className="link" onClick={() => openSettingsAt("connections")}>
                      Set up your own {SYSTEM_TITLE[system]} key
                    </button>
                    {" · "}
                  </>
                )}
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    setNotMe(false);
                    setAsked((n) => n + 1);
                  }}
                >
                  Check again
                </button>
              </span>
            )}
            {choosing && system && via && (
              <ChooseMe
                where={{ system, via, ...(found?.agent?.id ? { agent: found.agent.id } : {}), ...(workspace ? { workspace } : {}) }}
                hub={viaName}
                chosen={heard?.by === "chosen"}
                onCancel={() => setChoosing(false)}
                onDone={() => {
                  setChoosing(false);
                  setNotMe(false);
                  setAsked((n) => n + 1);
                }}
              />
            )}
          </fieldset>
        )}

        {found && remoteStates && (
          <fieldset className="move-field">
            <legend>States</legend>
            <span className="move-opt-sub">Moving a card into a column moves its issue to this state in {SYSTEM_TITLE[system!]}.</span>
            <div className="sync-states">
              {MAPPED.map((col) => (
                <label key={col} className="sync-state">
                  <span>{STATE_TITLE[col]}</span>
                  <select
                    className="board-select sync-select"
                    aria-label={`${STATE_TITLE[col]} moves its issue to`}
                    value={states[col] ?? ""}
                    disabled={busy}
                    onChange={(e) => setStates((s) => ({ ...s, [col]: e.target.value }))}
                  >
                    <option value="">Leave it as it is</option>
                    {remoteStates.map((r) => (
                      <option key={r} value={r}>
                        {stateName(r)}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </fieldset>
        )}
      </div>
      <footer className="dialog-foot move-foot">
        <span className={`dialog-foot-note${footNote?.failed ? " state-blocked" : ""}`} role={problem ? "alert" : "status"}>
          {footNote?.words}
        </span>
        <button type="button" className="btn btn-ghost" data-autofocus onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-signal" disabled={!canLink} onClick={() => void link()}>
          {busy ? "Linking…" : system && targetGood ? `Link to ${targetWords(system, targetKey)}` : "Link board"}
        </button>
      </footer>
    </Dialog>
  );
}

/** The key "This computer" goes by among the hubs. */
const THIS = "this-computer";

/** How many issues the filter matches, live. */
function MatchLine({ ready, now, whole }: { ready: boolean; now: Checked | null; whole: boolean }) {
  if (!ready) return <span className="move-opt-sub">Say what to import to see how many issues match.</span>;
  if (!now)
    return (
      <span className="move-opt-sub" role="status">
        Counting the issues that match…
      </span>
    );
  if (!now.ok)
    return (
      <p className="move-callout move-refused" role="alert">
        {now.error}
      </p>
    );
  if (now.check.filterError)
    return (
      <p className="move-callout move-refused" role="alert">
        {now.check.filterError}
      </p>
    );
  const n = now.check.matches;
  if (n === undefined) return null;
  const more = !!now.check.matchesAtLeast;
  const count = more ? `${n.toLocaleString()} or more ${whole ? "open " : ""}issues` : `${n.toLocaleString()} ${whole ? "open " : ""}issue${n === 1 ? "" : "s"}`;
  return (
    <p className="move-callout sync-matches" role="status">
      <b>{count}</b> {n === 1 && !more ? "matches" : "match"}
      {n === 0
        ? ": the board starts empty and fills as issues come to match."
        : more
          ? `. Desk counts up to ${(now.check.ceiling ?? n).toLocaleString()}; it brings them all in, a few hundred each time it syncs.`
          : ", and come onto the board in the columns their states map to when it’s linked."}
    </p>
  );
}

/** A hub a board may sync through, with what it said. */
function HubRow({ name, choice, system, probe, picked, disabled, onPick }: { name: string; choice: SyncChoice; system: SyncSystem; probe: Probe | undefined; picked: boolean; disabled: boolean; onPick: () => void }) {
  const title = SYSTEM_TITLE[system];
  const no = probe?.state === "no" && !probe.noToken;
  const sub =
    !probe || probe.state === "checking"
      ? `Asking whether it offers ${title}…`
      : probe.state === "offered"
        ? probe.agent
          ? `Offers ${title} through ${probe.agent}`
          : `Offers its ${title} tools to you`
        : probe.state === "needsToken"
          ? "Needs a token for your board sync, made there once"
          : probe.noToken
            ? "Its token was refused: it needs a new one"
            : probe.noAgent
              ? `No agent there you can reach has ${title} switched on`
              : probe.error;
  return (
    <label className="move-opt">
      <input type="radio" name={name} checked={picked} disabled={disabled || no || probe?.state === "checking"} onChange={onPick} />
      <span className="move-opt-main">
        <span>{choice.name}</span>
        <span className={no ? "move-opt-sub state-blocked" : "move-opt-sub"}>{sub}</span>
      </span>
    </label>
  );
}

/** This computer's own Jira or Linear keys: only when no hub offers them. */
function ThisComputer({ name, system, probe, hubOffers, picked, disabled, onPick }: { name: string; system: SyncSystem; probe: Probe | undefined; hubOffers: string | null; picked: boolean; disabled: boolean; onPick: () => void }) {
  const title = SYSTEM_TITLE[system];
  const usable = probe?.state === "offered" && !hubOffers;
  const sub = hubOffers
    ? `${hubOffers} has ${title}: link through it, so this computer keeps no ${title} keys of its own`
    : !probe || probe.state === "checking"
      ? `Asking whether this computer has ${title} keys…`
      : probe.state === "offered"
        ? `With this computer’s own ${title} keys`
        : probe.state === "no"
          ? probe.error
          : "";
  return (
    <label className="move-opt">
      <input type="radio" name={name} checked={picked} disabled={disabled || !usable} onChange={onPick} />
      <span className="move-opt-main">
        <span>This computer</span>
        <span className="move-opt-sub">{sub}</span>
      </span>
    </label>
  );
}

/** A token for a hub: Desk makes one there itself where the hub allows it
 *  (its native side mints with this Desk's device token and gives it to
 *  this computer's hub; the page never has it). Otherwise the person pastes
 *  one made on that hub, once: it goes to this computer's hub and is never
 *  shown, kept here or read back. */
export function TokenPanel({ choice, again, onKept }: { choice: SyncChoice; again: boolean; onKept?: () => void }) {
  const ids = useId();
  const [phase, setPhase] = useState<"minting" | "made" | "paste" | "saving">("minting");
  /** The hub said it doesn't let Desk make one (its admin can change that). */
  const [refused, setRefused] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  /** Bumped by Try again: the hub is asked once more. */
  const [asks, setAsks] = useState(0);
  const asked = useRef(-1);

  const kept = () => {
    void useSyncHubs.getState().load();
    onKept?.();
  };

  // Made at once where the hub allows it: asked each time the panel opens
  // (its admin may have allowed it since) and again on Try again; a refusal
  // is never remembered past this panel. (A hub keeps one such token per
  // device: a new one replaces the last.)
  useEffect(() => {
    if (asked.current === asks) return;
    asked.current = asks;
    const local = localHubRef();
    if (!local) {
      setPhase("paste");
      return;
    }
    setPhase("minting");
    setProblem(null);
    mintSyncToken(choice.paired, local.id, choice.id, choice.name)
      .then((m) => {
        if (m.kind === "kept") {
          setPhase("made");
          kept();
        } else {
          setRefused(m.kind === "notAllowed");
          setPhase("paste");
        }
      })
      .catch((e: unknown) => {
        setProblem(saidOf(e));
        setPhase("paste");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choice, asks]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const sync = localSync();
    if (!sync || !looksLikeToken(typed)) return;
    // Out of the page before it is sent: never kept, shown or read back.
    const token = typed.trim();
    setTyped("");
    setPhase("saving");
    setProblem(null);
    try {
      await sync.putHub(choice.id, { name: choice.name, url: choice.url, token });
      kept();
    } catch (err) {
      setProblem(saidOf(err));
      setPhase("paste");
    }
  };

  if (phase === "minting" || phase === "made")
    return (
      <p className="move-callout" role="status">
        {phase === "minting" ? `Making a token for your board sync on ${choice.name}…` : `${choice.name} made a token for your board sync; asking it what it offers…`}
      </p>
    );
  return (
    <form className="move-ask sync-token" onSubmit={(e) => void send(e)} aria-label={`A token for ${choice.name}`}>
      <p>
        {again ? `${choice.name} refused the token it had. ` : ""}
        {refused
          ? `${choice.name} doesn’t let Desk make this token itself yet — its admin can turn that on, or make a token on ${choice.name} and paste it here.`
          : `Paste a token made on ${choice.name}.`}{" "}
        <span className="muted">Desk keeps it on this computer, and never shows it again.</span>
      </p>
      <label className="field sync-token-field">
        <span>{choice.name}’s token for you</span>
        <input
          id={`${ids}-token`}
          type="password"
          className="mono"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="wfr_…"
          autoComplete="off"
          spellCheck={false}
          disabled={phase === "saving"}
          aria-invalid={!!typed && !looksLikeToken(typed)}
        />
      </label>
      {problem && (
        <p className="move-callout move-refused" role="alert">
          {problem}
        </p>
      )}
      <span className="sync-token-actions">
        {refused && (
          <button type="button" className="btn btn-sm" disabled={phase === "saving"} onClick={() => setAsks((n) => n + 1)}>
            Try again
          </button>
        )}
        <button type="button" className="btn btn-sm" onClick={() => openUrl(`${choice.url.replace(/\/+$/, "")}/my-settings`)}>
          Open {choice.name}’s token page
        </button>
        <button type="submit" className="btn btn-signal btn-sm" disabled={phase === "saving" || !looksLikeToken(typed)}>
          {phase === "saving" ? "Checking it…" : "Use this token"}
        </button>
      </span>
    </form>
  );
}

/** A new token for the hub a paused board syncs through, from the board's
 *  sync bar: made there where the hub allows it, else pasted once. */
export function NewTokenDialog({ choice, onClose }: { choice: SyncChoice; onClose: () => void }) {
  return (
    <Dialog
      onClose={onClose}
      title={(id) => (
        <header className="dialog-head">
          <span className="dialog-title">
            <h1 id={id} className="display-lg">
              A new token for {choice.name}
            </h1>
            <p className="small">Boards that sync through {choice.name} resume once it takes the new one.</p>
          </span>
          <CloseButton onClose={onClose} />
        </header>
      )}
    >
      <div className="dialog-scroll move-body">
        <TokenPanel choice={choice} again onKept={onClose} />
      </div>
      <footer className="dialog-foot move-foot">
        <span className="dialog-foot-note" />
        <button type="button" className="btn btn-ghost" data-autofocus onClick={onClose}>
          Cancel
        </button>
      </footer>
    </Dialog>
  );
}

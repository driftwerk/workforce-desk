import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useChat } from "../chat/store";
import { agentKey } from "../chat/types";
import { openTarget } from "../shell/navigate";
import { ProblemNote } from "../ui/ProblemNote";
import { openSettingsAt } from "../ui/problem";
import type { Problem } from "../ui/problem";
import { HubError } from "../hub/client";
import { looksLikeToken, mintSyncToken, SYSTEM_TITLE, targetOk, type Checked } from "../hub/boardSync";
import type { Board, LinkCheck, SyncAssignee, SyncFilter, SyncSystem, SyncVia, TicketState } from "../hub/types";
import { openUrl } from "../platform";
import { CloseButton, Dialog } from "../ui/Dialog";
import { STATE_TITLE } from "./board";
import { useBoard } from "./store";
import { localHubRef, localSync, syncChoices, useSyncHubs, type SyncChoice } from "./syncStore";
import { connectionsOf, type Listing } from "../hub/connections";
import { useDesk } from "../hub/store";
import { Connect } from "../settings/Connections";
import { useAgentConfigs } from "../crew/agentBrain";
import { bindingOf, choose, setAgentConnectors, throughOf, todayOf } from "../crew/connectors";

/** What a hub (or this computer) said when asked whether it offers the
 *  system's tools. */
type Probe =
  | { state: "checking" }
  | { state: "offered"; teams: Team[]; agent: string | null }
  | { state: "no"; error: string; noToken: boolean; noAgent: boolean }
  | { state: "needsToken" };
type Team = { id: string; key: string; name: string };

type FilterKind = SyncFilter["kind"];

/** The filters each system's sync can import by: the whole project or
 *  team first, then narrower ones. Linear's tools can't list a cycle, so it
 *  has none. */
const FILTERS: Record<SyncSystem, { kind: FilterKind; label: string; sub: string }[]> = {
  jira: [
    { kind: "all", label: "Whole project", sub: "every open issue, whoever has it: pick up work and see who has what" },
    { kind: "assignedToMe", label: "Assigned to me", sub: "assignee = currentUser()" },
    { kind: "currentCycle", label: "The current sprint", sub: "sprint in openSprints()" },
    { kind: "label", label: "A label", sub: "issues with one label" },
    { kind: "query", label: "JQL", sub: "kept inside the project" },
  ],
  linear: [
    { kind: "all", label: "Whole team", sub: "every open issue, whoever has it: pick up work and see who has what" },
    { kind: "assignedToMe", label: "Assigned to me", sub: "your issues in the team" },
    { kind: "label", label: "A label", sub: "issues with one label" },
    { kind: "query", label: "A Linear filter", sub: "as JSON, kept inside the team" },
  ],
};

/** The columns a remote state can be mapped from, left to right. */
const MAPPED: TicketState[] = ["backlog", "todo", "doing", "review", "done", "dropped"];

/** A Linear id (a member's), as the hub takes one. */
const linearId = (s: string): boolean => /^[0-9a-fA-F-]{1,64}$/.test(s);

/** A refusal in the hub's words, or why it couldn't be asked. */
const saidOf = (e: unknown): string =>
  e instanceof HubError ? e.message : e instanceof TypeError ? "Desk isn't ready right now. Try again in a moment." : e instanceof Error ? e.message : String(e);

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
  const [teamId, setTeamId] = useState("");
  const [filterKind, setFilterKind] = useState<FilterKind>("all");
  const [filterValue, setFilterValue] = useState("");
  const [includeDone, setIncludeDone] = useState(false);
  const [me, setMe] = useState("");
  /** Who the hub says the person is on the target's system (null: it
   *  can't say), by the system, hub and target it was asked for. */
  const [heardMe, setHeardMe] = useState<{ key: string; me: SyncAssignee | null; why?: string; byEmail?: boolean } | null>(null);
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
        .then(
          (r): Probe =>
            r.ok
              ? { state: "offered", teams: r.check.teams ?? [], agent: r.check.agent?.name ?? null }
              : { state: "no", error: r.error, noToken: r.paused?.kind === "noToken", noAgent: r.paused?.kind === "missing" },
        )
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

  // ── The target, the filter and what they match ──────────────────────────
  const teams = probe?.state === "offered" ? probe.teams : [];
  const team = teams.find((t) => t.id === teamId) ?? null;
  const targetKey = system === "linear" ? (team?.key ?? "") : target;
  const targetGood = !!system && !!targetKey && targetOk(system, targetKey);
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
  const meKey = `${system}:${viaKey}:${targetKey}`;
  const heard = heardMe?.key === meKey ? heardMe : null;
  const knownMe = notMe ? null : heard ? heard.me : undefined;
  const meNeeded = system === "linear" && filterKind === "assignedToMe" && knownMe === null;
  const filterReady = !!filter && (!meNeeded || linearId(me.trim()));
  const meBad = !!me.trim() && !linearId(me.trim());
  const checkKey = JSON.stringify([system, viaKey, targetKey, team?.id, filterReady ? filter : null, meNeeded ? me.trim() : null, asked]);
  const checkRun = useRef(0);
  useEffect(() => {
    if (!system || !via || !offered || !targetGood) return;
    const run = ++checkRun.current;
    const sync = localSync();
    if (!sync) return;
    const t = setTimeout(() => {
      void sync
        .check({
          system,
          via,
          target: targetKey,
          ...(team ? { targetId: team.id } : {}),
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
  }, [checkKey, offered, targetGood]);
  const now = checked?.key === checkKey ? checked.result : null;
  const found: LinkCheck | null = now?.ok ? now.check : null;
  // What the hub said of who the person is, kept for the target: an older
  // hub that wants the id says so as a refusal.
  useEffect(() => {
    if (!now || !targetKey) return;
    if (now.ok && now.check.me !== undefined) setHeardMe({ key: meKey, me: now.check.me, why: now.check.meWhy, byEmail: now.check.meBy === "email" });
    else if (!now.ok && now.status === 400 && system === "linear" && filterKind === "assignedToMe" && /member/i.test(now.error)) setHeardMe({ key: meKey, me: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now]);
  const remoteStates = found?.states ?? null;
  // The state map starts from what the hub's states mean, once per target.
  useEffect(() => {
    const k = `${system}:${viaKey}:${targetKey}`;
    if (!found?.prefill || prefilledFor.current === k) return;
    prefilledFor.current = k;
    setStates(found.prefill);
  }, [found, system, viaKey, targetKey]);

  const hasTickets = tickets > 0;
  /** What happens to the board's own tickets: kept beside the issues, or
   *  cleared first. */
  const [own, setOwn] = useState<"keep" | "clear" | null>(null);
  const canLink = (!hasTickets || !!own) && !!system && !!via && offered && targetGood && filterReady && !!found && found.matches !== undefined && !busy;
  /** Why Link can't be pressed yet: the first thing missing, in plain words. */
  const waitingOn: { words: string; failed: boolean } | null = (() => {
    if (busy) return null;
    if (hasTickets && !own) return { words: `Say what happens to ${board.name}’s ${tickets === 1 ? "ticket" : `${tickets} tickets`}.`, failed: false };
    if (!system) return { words: "Pick Jira or Linear.", failed: false };
    if (!localSync()) return { words: "Desk isn’t ready yet, so nothing can be checked or linked. Try again in a moment.", failed: true };
    if (!via) return { words: `Pick where ${SYSTEM_TITLE[system]} is reached through.`, failed: false };
    if (!offered) {
      if (!probe || probe.state === "checking") return { words: `Waiting for ${viaName} to say whether it offers ${SYSTEM_TITLE[system]}…`, failed: false };
      if (probe.state === "needsToken") return { words: `${viaName} needs a token first.`, failed: false };
      if (probe.state === "no") return { words: probe.noToken ? `${viaName} needs a new token.` : probe.error, failed: true };
    }
    if (!targetGood) return { words: system === "linear" ? "Pick a team." : "Enter the Jira project key.", failed: false };
    if (!filterReady) return { words: meNeeded ? "Enter your Linear member id." : "Say what to import.", failed: false };
    if (!now) return { words: "Waiting for the match count…", failed: false };
    if (!now.ok) return { words: `The match check failed: ${now.error}`, failed: true };
    if (now.check.matches === undefined) return { words: "Waiting for the match count…", failed: false };
    return null;
  })();
  const footNote = problem ? { words: problem, failed: true } : waitingOn;
  const link = async () => {
    const sync = localSync();
    if (!canLink || !sync || !system || !via || !filter) return;
    setBusy(true);
    setProblem(null);
    try {
      // Cleared first: they're Desk's own, and nothing there changes.
      if (hasTickets && own === "clear") {
        const mine = Object.values(useBoard.getState().tickets).filter((t) => t.board === board.id);
        for (const t of mine) await useBoard.getState().remove(t.id);
      }
      const mapped = Object.fromEntries(Object.entries(states).filter(([, v]) => !!v));
      const b = await sync.link(board.id, {
        system,
        target: targetKey,
        ...(team ? { targetId: team.id } : {}),
        via,
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
      setProblem(saidOf(e));
      setBusy(false);
    }
  };

  const pick = (key: string) => {
    setViaKey(key);
    setTarget("");
    setTeamId("");
    setChecked(null);
  };

  return (
    <Dialog
      onClose={onClose}
      title={(id) => (
        <header className="dialog-head">
          <span className="dialog-title">
            <h1 id={id} className="display-lg">
              Link “{board.name}” to Jira or Linear
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
                <input type="radio" name={`${ids}-own`} checked={own === "clear"} disabled={busy} onChange={() => setOwn("clear")} />
                <span className="move-opt-main">
                  <span>Clear {tickets === 1 ? "it" : "them"} first</span>
                  <span className="move-opt-sub">Deleted from this board before it links. Nothing in Jira or Linear changes.</span>
                </span>
              </label>
            </div>
          </fieldset>
        )}

        <fieldset className="move-field">
          <legend>System</legend>
          <div className="seg handoff-seg" role="radiogroup" aria-label="System">
            {(["jira", "linear"] as const).map((s) => (
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

        {system && via && offered && (
          <fieldset className="move-field">
            <legend>{system === "jira" ? "Project" : "Team"}</legend>
            {system === "jira" ? (
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

        {system && via && offered && targetGood && (
          <fieldset className="move-field">
            <legend>Import</legend>
            <div className="seg handoff-seg" role="radiogroup" aria-label="Import">
              {FILTERS[system].map((f) => (
                <button key={f.kind} type="button" role="radio" aria-checked={filterKind === f.kind} disabled={busy} onClick={() => setFilterKind(f.kind)}>
                  {f.label}
                </button>
              ))}
            </div>
            <span className="move-opt-sub">{FILTERS[system].find((f) => f.kind === filterKind)?.sub}</span>
            {filterKind === "all" && (
              <label className="sync-done">
                <input type="checkbox" checked={includeDone} disabled={busy} onChange={(e) => setIncludeDone(e.target.checked)} />
                Also bring in what was done in the last two weeks
              </label>
            )}
            {meNeeded && (
              <>
                <label className="field">
                  <span>Your Linear member id</span>
                  <input
                    className="mono"
                    value={me}
                    onChange={(e) => setMe(e.target.value)}
                    placeholder="2f8c1d3a-9b1e-4c7a-…"
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={meBad}
                    aria-describedby={`${ids}-me`}
                  />
                </label>
                <span id={`${ids}-me`} className={`move-opt-sub${meBad ? " state-blocked" : ""}`}>
                  {meBad
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
            {filterKind === "query" && (
              <label className="field">
                <span>{system === "jira" ? "The query" : "The filter"}</span>
                <textarea
                  className="move-note mono sync-query"
                  value={filterValue}
                  onChange={(e) => setFilterValue(e.target.value)}
                  placeholder={system === "jira" ? 'status != Done AND labels = "desk"' : '{ "state": { "type": { "neq": "completed" } } }'}
                  spellCheck={false}
                />
              </label>
            )}
            <MatchLine ready={filterReady} now={now} whole={filterKind === "all"} />
            {knownMe && (
              <span className="move-opt-sub sync-me">
                {heard?.byEmail ? (
                  <>
                    {viaName} uses a shared {SYSTEM_TITLE[system]} key, and matched you to <b>{knownMe.name}</b> there by your verified email: Mine and Take it go by that.
                  </>
                ) : (
                  <>
                    {viaName} knows you as <b>{knownMe.name}</b> on {SYSTEM_TITLE[system]}: Mine and Take it go by that.
                  </>
                )}{" "}
                <button type="button" className="link" onClick={() => setNotMe(true)}>
                  That’s not me
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
                        {r}
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
          {busy ? "Linking…" : system && targetGood ? `Link to ${targetKey}` : "Link board"}
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

/** What to say to an agent there so someone switches the system on. */
export const switchOnText = (system: SyncSystem, hub: string): string =>
  `Could you switch ${SYSTEM_TITLE[system]} on for an agent I can use on ${hub}? Desk needs it to sync one of my boards with ${SYSTEM_TITLE[system]}. If you can't, please tell me who can.`;

/** No agent on a hub has the system switched on: said in the one shape
 *  errors take, with asking an agent there to switch it on (in a DM, as the
 *  person), or whom to ask when there's no agent there to ask. */
function NoAgent({ choice, system, words }: { choice: SyncChoice; system: SyncSystem; words: string }) {
  const title = SYSTEM_TITLE[system];
  const roster = useChat((s) => s.roster);
  const there = roster.filter((a) => a.hubId === choice.paired).sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  const agent = there[0];
  const [asked, setAsked] = useState(false);
  const problem: Problem = {
    plain: words,
    ...(agent
      ? {
          fix: {
            label: `Ask ${agent.name} to switch ${title} on`,
            run: () => {
              const key = agentKey(agent);
              openTarget({ kind: "agent", key }, { beside: true });
              void useChat
                .getState()
                .sendTo(key, switchOnText(system, choice.name))
                .then((sent) => setAsked(sent));
            },
          },
        }
      : {}),
  };
  if (asked)
    return (
      <p className="move-callout" role="status">
        Asked {agent?.name} on {choice.name} to switch {title} on. Link again once it’s on.
      </p>
    );
  return (
    <div className="move-callout sync-no-agent">
      <ProblemNote problem={problem} />
      {!agent && <p className="move-opt-sub">Ask whoever runs {choice.name} to switch {title} on for an agent you can use.</p>}
    </div>
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

/** This computer hasn't the system's tools for the person, and no hub
 *  offers them: Desk turns them on itself. A board here syncs through this
 *  computer's default agent's tools with the person's own connection, so
 *  Desk turns the connector on for that agent; the one thing it can't make
 *  up is the person's key, so with no connection yet it asks for one in
 *  place first. Then the dialog asks this computer again. */
function ThisComputerSetup({ system, disabled, onReady }: { system: SyncSystem; disabled: boolean; onReady: () => void }) {
  const title = SYSTEM_TITLE[system];
  const desk = useDesk((s) => s.hub);
  const local = localHubRef();
  const agent = useChat((s) => (local ? s.roster.find((a) => a.hubId === local.id && a.isDefault) : undefined));
  const key = agent ? agentKey(agent) : "";
  const config = useAgentConfigs((s) => s.configs[key]);
  const [api] = useState(() => (local ? connectionsOf(local) : null));
  const [listing, setListing] = useState<Listing | null>(null);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    api.list().then(setListing, () => setListing(null));
  }, [api]);
  useEffect(() => {
    if (desk && agent && config === undefined) void useAgentConfigs.getState().load(desk, agent);
  }, [desk, agent, config]);

  const connector = listing?.connectors.find((c) => c.id === system);
  if (!api || !desk || !agent || !connector || config === undefined) return null;
  const connected = connector.connections.some((x) => x.status === "connected" && (x.level === "all" || x.agent === agent.id));
  const on = throughOf(bindingOf(config), system) !== "off";
  // Connected and on, yet not offered: nothing here Desk can change; the
  // row says why.
  if (connected && on) return null;

  const turnOn = async () => {
    setWorking(true);
    setProblem(null);
    try {
      if (!on) {
        const fresh = await api.list();
        const toml = await setAgentConnectors(desk, agent.id, (b) =>
          throughOf(b, system) === "off" ? choose(b, system, "mine", todayOf(fresh, agent.id)) : b,
        );
        useAgentConfigs.getState().put(key, toml);
      }
      // A connection just made shows as made, should this computer still
      // not offer it.
      api.list().then(setListing, () => {});
      onReady();
    } catch (e) {
      setProblem(saidOf(e));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="move-callout sync-this-computer">
      {connected ? (
        <ProblemNote
          problem={{
            plain: `${title} is connected on this computer, but it’s off for ${agent.name}, whose tools a board here syncs through.`,
            ...(working || disabled ? {} : { fix: { label: `Turn ${title} on for ${agent.name}`, run: () => void turnOn() } }),
          }}
        />
      ) : (
        <>
          <p className="move-opt-sub">
            Connect {title} to sync through this computer{on ? "" : `; Desk turns it on for ${agent.name}`}.
          </p>
          <Connect api={api} connector={connector} at={{ level: "all" }} label={`Connect ${title}`} onDone={turnOn} />
        </>
      )}
      {working && (
        <p className="move-opt-sub" role="status">
          Turning {title} on…
        </p>
      )}
      {problem && (
        <p className="small state-blocked" role="alert">
          {problem}
        </p>
      )}
    </div>
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

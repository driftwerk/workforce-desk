import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useChat } from "../chat/store";
import { HubError } from "../hub/client";
import { looksLikeToken, mintSyncToken, SYSTEM_TITLE, targetOk, type Checked } from "../hub/boardSync";
import type { Board, LinkCheck, SyncFilter, SyncSystem, SyncVia, TicketState } from "../hub/types";
import { openUrl } from "../platform";
import { CloseButton, Dialog } from "../ui/Dialog";
import { STATE_TITLE } from "./board";
import { useBoard } from "./store";
import { localHubRef, localSync, syncChoices, useSyncHubs, type SyncChoice } from "./syncStore";

/** What a hub (or this computer) said when asked whether it offers the
 *  system's tools. */
type Probe = { state: "checking" } | { state: "offered"; teams: Team[] } | { state: "no"; error: string; noToken: boolean } | { state: "needsToken" };
type Team = { id: string; key: string; name: string };

type FilterKind = SyncFilter["kind"];

/** The filters each system's sync can import by. Linear's tools can't list
 *  a cycle, so it has none. */
const FILTERS: Record<SyncSystem, { kind: FilterKind; label: string; sub: string }[]> = {
  jira: [
    { kind: "assignedToMe", label: "Assigned to me", sub: "assignee = currentUser()" },
    { kind: "currentCycle", label: "The current sprint", sub: "sprint in openSprints()" },
    { kind: "label", label: "A label", sub: "issues with one label" },
    { kind: "query", label: "JQL", sub: "kept inside the project" },
  ],
  linear: [
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
  e instanceof HubError ? e.message : e instanceof TypeError ? "Desk can't reach this computer's hub right now. Try again in a moment." : e instanceof Error ? e.message : String(e);

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
  const [filterKind, setFilterKind] = useState<FilterKind>("assignedToMe");
  const [filterValue, setFilterValue] = useState("");
  const [me, setMe] = useState("");
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
  const keptKey = (kept ?? []).map((h) => `${h.id}:${h.hasToken}`).join(",");
  useEffect(() => {
    if (!system) return;
    const run = ++probeRun.current;
    const sync = localSync();
    const ask = async (key: string, via: SyncVia) => {
      if (!sync) return;
      const said: Probe = await sync
        .check({ system, via })
        .then((r): Probe => (r.ok ? { state: "offered", teams: r.check.teams ?? [] } : { state: "no", error: r.error, noToken: r.paused?.kind === "noToken" }))
        .catch((e: unknown): Probe => ({ state: "no", error: saidOf(e), noToken: false }));
      if (probeRun.current === run) setProbes((p) => ({ ...p, [key]: said }));
    };
    const next: Record<string, Probe> = {};
    for (const c of choices) next[c.id] = c.kept?.hasToken ? { state: "checking" } : { state: "needsToken" };
    next[THIS] = { state: "checking" };
    setProbes(next);
    for (const c of choices) if (c.kept?.hasToken) void ask(c.id, { kind: "hub", hub: c.id });
    void ask(THIS, { kind: "thisHub" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [system, keptKey, choices.length]);

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
    filterKind === "assignedToMe" || filterKind === "currentCycle"
      ? { kind: filterKind }
      : filterValue.trim()
        ? { kind: filterKind, value: filterValue.trim() }
        : null;
  const meNeeded = system === "linear" && filterKind === "assignedToMe";
  const filterReady = !!filter && (!meNeeded || linearId(me.trim()));
  const checkKey = JSON.stringify([system, viaKey, targetKey, team?.id, filterReady ? filter : null, meNeeded ? me.trim() : null]);
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
  const remoteStates = found?.states ?? null;
  // The state map starts from what the hub's states mean, once per target.
  useEffect(() => {
    const k = `${system}:${viaKey}:${targetKey}`;
    if (!found?.prefill || prefilledFor.current === k) return;
    prefilledFor.current = k;
    setStates(found.prefill);
  }, [found, system, viaKey, targetKey]);

  const hasTickets = tickets > 0;
  const canLink = !hasTickets && !!system && !!via && offered && targetGood && filterReady && !!found && found.matches !== undefined && !busy;
  const link = async () => {
    const sync = localSync();
    if (!canLink || !sync || !system || !via || !filter) return;
    setBusy(true);
    setProblem(null);
    try {
      const mapped = Object.fromEntries(Object.entries(states).filter(([, v]) => !!v));
      const b = await sync.link(board.id, {
        system,
        target: targetKey,
        ...(team ? { targetId: team.id } : {}),
        via,
        filter,
        ...(meNeeded ? { me: me.trim() } : {}),
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
          <p className="move-callout move-refused" role="alert">
            {board.name} has tickets of its own. Link an empty board, or make a new one for the project.
          </p>
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
                  setFilterKind("assignedToMe");
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
            {meNeeded && (
              <label className="field">
                <span>Your Linear member id</span>
                <input className="mono" value={me} onChange={(e) => setMe(e.target.value)} placeholder="From Linear: Settings → Account → copy your id" spellCheck={false} autoComplete="off" />
              </label>
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
            <MatchLine ready={filterReady} now={now} />
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
        <span className="dialog-foot-note state-blocked" role={problem ? "alert" : undefined}>
          {problem}
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
function MatchLine({ ready, now }: { ready: boolean; now: Checked | null }) {
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
  const n = now.check.matches;
  if (n === undefined) return null;
  return (
    <p className="move-callout sync-matches" role="status">
      <b>{now.check.matchesAtLeast ? `${n} or more issues` : n === 1 ? "1 issue" : `${n} issues`}</b> {n === 1 && !now.check.matchesAtLeast ? "matches" : "match"}
      {n === 0 ? ": the board starts empty and fills as issues come to match." : ", and come onto the board’s Backlog when it’s linked."}
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
        ? `Offers its ${title} tools to you`
        : probe.state === "needsToken"
          ? "Needs a token for your board sync, made there once"
          : probe.noToken
            ? "Its token was refused: it needs a new one"
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
  const [phase, setPhase] = useState<"minting" | "paste" | "saving">("minting");
  const [why, setWhy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const tried = useRef(false);

  const kept = () => {
    void useSyncHubs.getState().load();
    onKept?.();
  };

  // Made at once where the hub allows it: one try per opening.
  useEffect(() => {
    if (tried.current) return;
    tried.current = true;
    const local = localHubRef();
    if (!local) {
      setPhase("paste");
      return;
    }
    mintSyncToken(choice.paired, local.id, choice.id, choice.name)
      .then((m) => {
        if (m.kind === "kept") kept();
        else {
          setWhy(m.kind === "notAllowed" ? m.error : null);
          setPhase("paste");
        }
      })
      .catch((e: unknown) => {
        setProblem(saidOf(e));
        setPhase("paste");
      });
  }, [choice]);

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

  if (phase === "minting")
    return (
      <p className="move-callout" role="status">
        Making a token for your board sync on {choice.name}…
      </p>
    );
  return (
    <form className="move-ask sync-token" onSubmit={(e) => void send(e)} aria-label={`A token for ${choice.name}`}>
      <p>
        {again ? `${choice.name} refused the token it had. ` : ""}
        {why ? `${choice.name} doesn’t let Desk make a token itself: paste one made there.` : `Paste a token made on ${choice.name}.`}{" "}
        <span className="muted">Desk sends it to this computer’s hub once, and never shows it again.</span>
      </p>
      {why && <p className="move-opt-sub sync-token-why">{why}</p>}
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

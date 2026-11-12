// Continue in another engine (session memory §5, §8.2): the engine and
// account it continues on, where, what becomes of this one, what the brief
// holds and leaves out (previewed by the hub, folded until asked), who
// receives it, and the person's yes where the group asks each time. A hand
// back resumes the session the work came from with only what is new. Each
// choice has a default, said in one line: Continue goes as it says, and
// Change shows the choices.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { OWN_SIGN_IN, OWN_SIGN_IN_LABEL, accountOfChoice, accountsOf, defaultChoice, hasAccounts, ownSignInWorks, useAccounts } from "../engines/accounts";
import { ENGINE_TITLE, defaultCaps, startable } from "../engines/engines";
import { useSessionName } from "../groups/names";
import { HubError } from "../hub/client";
import { useDesk } from "../hub/store";
import type { Engine, EngineInfo, HandoffPlace, HandoffPreview, HandoffSource, Session } from "../hub/types";
import { CloseButton, Dialog } from "../ui/Dialog";
import { plainError } from "../ui/plainError";
import { openSettingsAt } from "../ui/problem";
import { LOCAL } from "../machines/engines";
import { native } from "../machines/native";
import { thisComputerLower } from "../machines/words";
import { folderInfo } from "../machines/folders";
import { pairedHub } from "../hub/net";
import { useChat } from "../chat/store";
import { NothingToStart } from "../session/NewSession";
import { useHost } from "../shell/host";
import { useUpdates } from "../updates/store";
import { useHandoff, type HandoffAsk } from "./store";
import { runs, runsElsewhere } from "../session/actions";
import { backLine, busyNow, defaultSource, defaultsLine, enginesFor, tokensLine } from "./words";

/** How long a change of choice settles before it is previewed again. */
export const PREVIEW_AFTER_MS = 250;

const NOT_CONNECTED = "Desk isn’t ready just now; try again in a moment.";

const TOO_OLD = "This version of Desk can’t continue sessions in another engine yet. Update Desk to use it.";

/** A refusal as the hub says it: its own words, whole. */
const said = (e: unknown): string => {
  if (e instanceof HubError && (e.status === 404 || e.status === 405)) return TOO_OLD;
  return plainError(e);
};

/** Update Desk, where the refusal is that this one is too old: Help, with
 *  a check for the update asked. */
const updateDesk = () => {
  void useUpdates.getState().check({ asked: true });
  openSettingsAt("help");
};

/** The dialog, while a handoff is asked for. */
export function HandoffDialog() {
  const asking = useHandoff((s) => s.asking);
  const close = useHandoff((s) => s.close);
  const session = useDesk((s) => (asking ? s.sessions[asking.id] : undefined));
  if (!asking || !session) return null;
  return <HandoffDialogFor key={`${asking.id}:${asking.back ? "back" : "on"}`} ask={asking} session={session} onClose={close} />;
}

function HandoffDialogFor({ ask, session, onClose }: { ask: HandoffAsk; session: Session; onClose: () => void }) {
  const ids = useId();
  const hub = useDesk((s) => s.hub);
  const open = useDesk((s) => s.open);
  const name = useSessionName(session.id, session.name);
  const allAccounts = useAccounts((s) => s.accounts);
  const platform = useHost((h) => h.platform);
  const localHub = useChat((s) => s.hubs.find((h) => h.local) ?? null);

  const [engines, setEngines] = useState<EngineInfo[] | null | undefined>(undefined);
  const [engine, setEngine] = useState<Engine | null>(ask.engine ?? null);
  const [picked, setPicked] = useState<Partial<Record<Engine, string>>>({});
  const [place, setPlace] = useState<HandoffPlace>("same_folder");
  // Desk can't stop one running in another terminal: it is kept.
  const [source, setSource] = useState<HandoffSource>(runsElsewhere(session) ? "keep" : defaultSource(session));
  const [back, setBack] = useState(!!ask.back);
  const [goalOnly, setGoalOnly] = useState(false);
  const [preview, setPreview] = useState<HandoffPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  /** A goal-only start is possible where the brief can't be given. */
  const [goalOnlyOffered, setGoalOnlyOffered] = useState(false);
  const [showBrief, setShowBrief] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  /** The hub asked for the person's yes, though the preview didn't. */
  const [mustConfirm, setMustConfirm] = useState(false);
  const [sendProblem, setSendProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The choices shown: folded behind the line saying the defaults. */
  const [choosing, setChoosing] = useState(false);
  /** Whether the folder is a git project; undefined while unknown. */
  const [git, setGit] = useState<boolean | undefined>(undefined);
  /** When the engines were read again, after one was installed here. */
  const [readAt, setReadAt] = useState(0);

  // The engines this computer starts, read as the dialog opens and again
  // once one is installed from it.
  useEffect(() => {
    let live = true;
    void useAccounts.getState().load();
    if (!hub) return setEngines(null);
    (readAt ? hub.enginesNow() : hub.engines())
      .then((e) => live && setEngines(e))
      .catch(() => live && setEngines(null));
    return () => {
      live = false;
    };
  }, [hub, readAt]);

  // A new worktree branches from a git project: one that isn't has none.
  // Asked as New session asks, of this computer's hub.
  useEffect(() => {
    if (!localHub) return;
    let live = true;
    void folderInfo((path) => pairedHub(localHub).fetch("GET", path), session.cwd).then((i) => live && setGit(i.git));
    return () => {
      live = false;
    };
  }, [localHub, session.cwd]);
  const noWorktree = git === false;
  const offered = engines === undefined ? [] : enginesFor(startable(engines), session.engine);
  const target: Engine | null = engine ?? offered[0] ?? null;
  const info = engines?.find((e) => e.engine === target);
  const accounts = target && hasAccounts(defaultCaps(info)) ? accountsOf(allAccounts, target) : [];
  const ownWorks = ownSignInWorks(info?.signIn);
  const account = target ? (picked[target] ?? defaultChoice(allAccounts, target, ownWorks)) : OWN_SIGN_IN;
  /** The account as the hub takes it: absent, the engine's default. */
  const accountAsked = !back && accounts.length > 0 ? accountOfChoice(account) : undefined;

  // ── Previews ───────────────────────────────────────────────────────────
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const derived = useRef(false);
  const request = useCallback(
    async (q: { engine: Engine | undefined; account: string | null | undefined; place: HandoffPlace; back: boolean; goalOnly: boolean }) => {
      const n = ++seq.current;
      setProblem(null);
      setSendProblem(null);
      if (!hub) {
        setPreview(null);
        setLoading(false);
        return setProblem(NOT_CONNECTED);
      }
      setLoading(true);
      // Desk notes what it hasn't of the session only for the dialog's first
      // look: a model call, never made again for a change of choice.
      const derive = !derived.current;
      derived.current = true;
      try {
        const p = await hub.handoffPreview(session.id, q, derive);
        if (n !== seq.current) return;
        setPreview(p);
        setGoalOnlyOffered(q.goalOnly);
      } catch (e) {
        if (n !== seq.current) return;
        setPreview(null);
        setProblem(said(e));
        // Where only the conversation can't go across, the goal alone can:
        // asked of the hub, which says so by previewing it.
        setGoalOnlyOffered(false);
        if (!q.goalOnly && !q.back && e instanceof HubError && e.status === 409) {
          hub
            .handoffPreview(session.id, { ...q, goalOnly: true })
            .then(() => n === seq.current && setGoalOnlyOffered(true))
            .catch(() => {});
        }
      } finally {
        if (n === seq.current) setLoading(false);
      }
    },
    [hub, session.id],
  );
  useEffect(() => () => clearTimeout(timer.current), []);
  // What is previewed: asked again, settled, whenever a choice changes.
  const asked = { engine: back ? undefined : (target ?? undefined), account: accountAsked, place, back, goalOnly };
  const askedKey = JSON.stringify(asked);
  useEffect(() => {
    // Until the engines are read, there's no target to preview (a hand back
    // needs none).
    if (engines === undefined && !back) return;
    clearTimeout(timer.current);
    // Nothing to continue on: there's nothing to preview until one is installed.
    if (!back && offered.length === 0) return setLoading(false);
    if (!derived.current) return void request(asked);
    seq.current++;
    setLoading(true);
    timer.current = setTimeout(() => void request(asked), PREVIEW_AFTER_MS);
    // Only when what is asked changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askedKey, back || engines !== undefined, offered.length]);

  // The person's yes is for one vendor through one engine, as previewed: any
  // change of what is asked, or of who the preview says receives it, asks
  // again.
  const receiver = preview ? `${preview.engine}:${preview.vendor ?? ""}` : "";
  useEffect(() => setConfirmed(false), [askedKey, receiver]);

  // ── Continuing ─────────────────────────────────────────────────────────
  const asks = !!preview?.ask || mustConfirm;
  const canGo = !!preview && !loading && !busy && (!asks || confirmed);
  /** Why Continue waits on the person, said beside it. */
  const waitsOn = preview && !loading && !busy && asks && !confirmed ? `Tick “Send this brief to ${preview.vendor ?? ENGINE_TITLE[preview.engine]}” above to go on.` : null;
  const go = async () => {
    if (!canGo || !hub || !preview) return;
    setBusy(true);
    setSendProblem(null);
    try {
      const done = await hub.handoff(session.id, {
        ...(back ? { back: true, engine: preview.engine } : { engine: preview.engine, ...(accountAsked !== undefined ? { account: accountAsked } : {}), place }),
        source,
        ...(goalOnly ? { goalOnly: true } : {}),
        ...(confirmed ? { egressConfirmed: true } : {}),
      });
      useHandoff.getState().handed(session.id, done.session.id, { said: done.said, notes: done.notes });
      onClose();
      open(done.session.id);
    } catch (e) {
      setBusy(false);
      // The group asks before each handoff, though the preview didn't say:
      // its words, and the person's yes.
      if (e instanceof HubError && e.status === 409 && /confirm it/i.test(e.message)) {
        setMustConfirm(true);
        setConfirmed(false);
      }
      setSendProblem(said(e));
    }
  };

  // ── What's said ────────────────────────────────────────────────────────
  const targetTitle = preview ? ENGINE_TITLE[preview.engine] : target ? ENGINE_TITLE[target] : "another engine";
  const offeredBack = preview?.back ?? null;
  const backName = offeredBack?.name ?? "the session it came from";
  const working = busyNow(session);
  const accountName =
    accounts.length === 0 ? null : account === OWN_SIGN_IN ? OWN_SIGN_IN_LABEL.replace(/^\w/, (c) => c.toLowerCase()) : (accounts.find((a) => a.id === account)?.name ?? null);
  const noEngine = !back && engines !== undefined && offered.length === 0;
  const inTerminal = !!session.terminalId;
  const sources: { value: HandoffSource; label: string; sub: string }[] = inTerminal
    ? [{ value: "keep", label: "Keep it running", sub: "it runs in a Desk terminal: end it there when you’re done" }]
    : runsElsewhere(session)
      ? [{ value: "keep", label: "Keep it running", sub: "it runs in another terminal: end it there when you’re done" }]
      : !runs(session)
        ? [{ value: "stop", label: "Leave it stopped", sub: "it isn’t running" }]
        : [
            ...(working
              ? [{ value: "after_turn" as const, label: "Stop it after this turn", sub: "it’s in a turn now" }]
              : [{ value: "stop" as const, label: "Stop it now", sub: "it’s idle" }]),
            { value: "keep", label: "Keep it running", sub: "two engines will then edit one folder" },
          ];

  return (
    <Dialog
      onClose={onClose}
      title={(id) => (
        <header className="dialog-head">
          <span className="dialog-title">
            <h1 id={id} className="display-lg">
              {back ? `Hand “${name}” back` : `Continue “${name}” in another engine`}
            </h1>
            <p className="small">
              {back ? `Resumes ${backName} with what happened since it was handed over` : `Now in ${ENGINE_TITLE[session.engine]}${session.account ? ` · ${session.account.name}` : ""}`}
            </p>
          </span>
          <CloseButton onClose={onClose} />
        </header>
      )}
    >
      <div className="dialog-scroll move-body handoff-body">
        {offeredBack && !ask.back && (
          <fieldset className="move-field">
            <legend>Continue as</legend>
            <div className="move-opts" role="radiogroup" aria-label="Continue as">
              <label className="move-opt">
                <input type="radio" name={`${ids}-mode`} checked={!back} disabled={busy} onChange={() => setBack(false)} />
                <span className="move-opt-main">
                  <span>A new session</span>
                  <span className="move-opt-sub">with a brief of everything so far</span>
                </span>
              </label>
              <label className="move-opt">
                <input type="radio" name={`${ids}-mode`} checked={back} disabled={busy} onChange={() => setBack(true)} />
                <span className="move-opt-main">
                  <span>
                    Hand back to {offeredBack.name} ({ENGINE_TITLE[offeredBack.engine]})
                  </span>
                  <span className="move-opt-sub">resume it with what happened since</span>
                </span>
              </label>
            </div>
          </fieldset>
        )}

        {noEngine ? (
          <NothingToStart engines={engines ?? []} machine={LOCAL} where={thisComputerLower(platform)} native={native} onFixed={() => setReadAt(Date.now())} />
        ) : (
          <p className="handoff-defaults small" aria-label="As it goes">
            <span>
              {back
                ? backLine({ to: backName, source, running: runs(session) })
                : engines === undefined
                  ? "Looking at the engines…"
                  : defaultsLine({ engine: targetTitle, account: accountName, place, source, running: runs(session) })}
            </span>
            <button type="button" className="link small" aria-expanded={choosing} disabled={busy} onClick={() => setChoosing((c) => !c)}>
              {choosing ? "Hide the choices" : "Change"}
            </button>
          </p>
        )}

        {choosing && !back && !noEngine && (
          <fieldset className="move-field">
            <legend>Engine</legend>
            {engines === undefined ? (
              <p className="faint small">Looking at the engines…</p>
            ) : (
              <div className="seg handoff-seg" role="radiogroup" aria-label="Engine">
                {offered.map((e) => (
                  <button key={e} type="button" role="radio" aria-checked={target === e} disabled={busy} onClick={() => setEngine(e)}>
                    {ENGINE_TITLE[e]}
                  </button>
                ))}
              </div>
            )}
          </fieldset>
        )}

        {choosing && !back && accounts.length > 0 && target && (
          <fieldset className="move-field">
            <legend>Account</legend>
            <div className="seg handoff-seg" role="radiogroup" aria-label="Account">
              {accounts.map((a) => (
                <button key={a.id} type="button" role="radio" aria-checked={account === a.id} disabled={busy} onClick={() => setPicked((p) => ({ ...p, [target]: a.id }))}>
                  {a.name}
                </button>
              ))}
              {ownWorks && (
                <button type="button" role="radio" aria-checked={account === OWN_SIGN_IN} disabled={busy} onClick={() => setPicked((p) => ({ ...p, [target]: OWN_SIGN_IN }))}>
                  {OWN_SIGN_IN_LABEL}
                </button>
              )}
            </div>
          </fieldset>
        )}

        {choosing && !back && !noEngine && (
          <fieldset className="move-field">
            <legend>Where</legend>
            <div className="move-opts" role="radiogroup" aria-label="Where">
              <label className="move-opt">
                <input type="radio" name={`${ids}-place`} checked={place === "same_folder"} disabled={busy} onChange={() => setPlace("same_folder")} />
                <span className="move-opt-main">
                  <span>Same folder</span>
                  <span className="move-opt-sub mono">{session.cwd}</span>
                </span>
              </label>
              <label className="move-opt">
                <input type="radio" name={`${ids}-place`} checked={place === "new_worktree"} disabled={busy || noWorktree} onChange={() => setPlace("new_worktree")} />
                <span className="move-opt-main">
                  <span>New worktree from its branch</span>
                  <span className="move-opt-sub">
                    {noWorktree
                      ? "this folder isn’t in a git repository, so there’s no branch to start from"
                      : session.branch
                        ? `a new branch from ${session.branch}`
                        : "a new branch from where it is now"}
                  </span>
                </span>
              </label>
            </div>
          </fieldset>
        )}

        {choosing && !noEngine && (
          <fieldset className="move-field">
            <legend>This one</legend>
            <div className="move-opts" role="radiogroup" aria-label="This one">
              {sources.map((o) => (
                <label key={o.value} className="move-opt">
                  <input type="radio" name={`${ids}-source`} checked={source === o.value} disabled={busy} onChange={() => setSource(o.value)} />
                  <span className="move-opt-main">
                    <span>{o.label}</span>
                    <span className="move-opt-sub">{o.sub}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {!noEngine && (
          <section className="move-field" aria-label="What it gets">
            <h2 className="move-legend">{back ? `What ${backName} gets` : `What ${targetTitle} gets`}</h2>
            {loading && !preview ? (
              <p className="faint small" role="status">
                Desk is reading what this session did so far; this can take up to a minute…
              </p>
            ) : problem ? (
              <>
                <p className="move-callout move-refused" role="alert">
                  {problem}
                </p>
                {problem === TOO_OLD && (
                  <button type="button" className="btn handoff-goal-only" onClick={updateDesk}>
                    Update Desk
                  </button>
                )}
                {goalOnlyOffered && !goalOnly && (
                  <button type="button" className="btn handoff-goal-only" onClick={() => setGoalOnly(true)}>
                    Start {targetTitle} here with only the goal
                  </button>
                )}
              </>
            ) : preview ? (
              <>
                <p className="handoff-gets">
                  {preview.gets}
                  {preview.leavesOut && <span className="muted"> It leaves out {preview.leavesOut}.</span>}
                  {preview.search ? <span className="muted"> It can search the rest of this work.</span> : preview.onlyBrief && <span className="muted"> {preview.onlyBrief}</span>}
                </p>
                <div className="handoff-meta small">
                  <span className="faint">{tokensLine(preview)}</span>
                  {preview.notesPending && <span className="faint">Desk’s notes of it weren’t ready in time: the brief is built from its exchanges.</span>}
                </div>
                <p className="handoff-egress small">
                  <span>{preview.egress}</span>
                  <button type="button" className="link small" aria-expanded={showBrief} onClick={() => setShowBrief((b) => !b)}>
                    {showBrief ? "Hide the brief" : "Preview brief"}
                  </button>
                </p>
                {showBrief && (
                  <pre className="handoff-brief" tabIndex={0} aria-label="The brief">
                    {preview.brief}
                  </pre>
                )}
                {asks && (
                  <label className="handoff-confirm small">
                    <input type="checkbox" checked={confirmed} disabled={busy} onChange={(e) => setConfirmed(e.target.checked)} />
                    <span>
                      Send this brief to {preview.vendor ?? targetTitle}. <span className="muted">This group asks before each handoff.</span>
                    </span>
                  </label>
                )}
              </>
            ) : null}
          </section>
        )}
      </div>
      <footer className="dialog-foot move-foot">
        <span className={`dialog-foot-note ${sendProblem ? "state-blocked" : "faint"}`} role={sendProblem ? "alert" : undefined}>
          {sendProblem ?? waitsOn}
        </span>
        <button type="button" className="btn btn-ghost" data-autofocus onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-signal" disabled={!canGo} onClick={() => void go()}>
          {busy ? (back ? "Handing back…" : "Continuing…") : back ? `Hand back to ${backName}` : goalOnly ? `Start ${targetTitle} with the goal` : `Continue in ${targetTitle}`}
        </button>
      </footer>
    </Dialog>
  );
}

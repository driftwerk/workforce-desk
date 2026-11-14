// An agent's "What they see" (Sees K6): what it knows of the person's work
// in Desk, read-only. Everything, chosen places or only its own work; with
// or without transcripts; and a short update in its conversations with the
// person. Kept by this computer's hub as the person (`knowsOf`), and for an
// agent on another hub linked there first (the main window's linker, the
// native side).

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { agentKey, type Agent, type HubAccount } from "../chat/types";
import { HubError } from "../hub/client";
import { useMachines } from "../hub/engines";
import {
  knowsLinker,
  knowsOf,
  knowsTeller,
  type MachinesTold,
  type KnowsDigest,
  type KnowsHeld,
  type KnowsLogEntry,
  type KnowsRule,
  type KnowsView,
} from "../hub/knows";
import { localAccount } from "../groups/move";
import { CloseButton, Dialog, radioKeys } from "../ui/Dialog";
import { plainError } from "../ui/plainError";
import { ago } from "./files";
import { andSaid, countSaid, modeOf, placesSaid, type SeesMode } from "./places";
import { PlacePicker } from "./PlacePicker";
import { usePlaces } from "./usePlaces";

const DIGESTS: { id: KnowsDigest; name: string }[] = [
  { id: "off", name: "Off" },
  { id: "live", name: "Live" },
  { id: "daily", name: "Daily" },
];

const digestSub = (d: KnowsDigest, name: string): string =>
  d === "live"
    ? `When something changed, ${name} hears of it at the start of their next turn with you.`
    : d === "daily"
      ? `Once a morning, when something changed since the last.`
      : `None: ${name} looks with their tools when you ask.`;

/** Each agent elsewhere's rule key as its hub names it (`<hub>/<id>`,
 *  case and all), by Desk's key for it: from the link made this run, else
 *  the rule kept before (a link made in an earlier run). The link is made
 *  once a run. */
const linked = new Map<string, string>();
const known = new Map<string, string>();

/** For tests: forgets the links made and the keys found. */
export const forgetLinks = () => {
  linked.clear();
  known.clear();
};

/** Whether `next` shares less than `was`: transcripts turned off, or a
 *  place no longer covered. Only then is the person asked about what the
 *  agent already holds. */
export const narrows = (was: Pick<KnowsRule, "places" | "transcripts">, next: Pick<KnowsRule, "places" | "transcripts">): boolean => {
  if (was.transcripts && !next.transcripts) return true;
  if (next.places.includes("all")) return false;
  if (was.places.includes("all")) return true;
  return was.places.some((p) => !next.places.includes(p));
};

type Status = { state: "idle" | "saving" } | { state: "failed"; problem: string };

/** What the agent holds that the rule no longer covers, while the person
 *  is asked what becomes of it. */
type Asking = { held: KnowsHeld; why: "narrowed" | "transcripts" | "earlier" };

/** A refusal of a rule's route in the person's words. */
const said = (e: unknown): string => {
  if (e instanceof HubError && (e.status === 401 || e.status === 403)) return "Only the person whose Desk this is can change what an agent sees.";
  return plainError(e);
};

/** A link refused by the agent's hub, in the person's words. */
const refusedSaid = (error: string, agent: string, hub: string): string =>
  /turned off/i.test(error)
    ? `${hub}’s admin has turned this off.`
    : /doesn.t take Desk work|isn.t one you can use/i.test(error)
      ? `${agent} doesn’t take Desk work on ${hub}.`
      : error;

const n = (x: number): string => x.toLocaleString("en-GB");

/** What an agent holds, counted: "1,032 transcript exchanges from 14
 *  sessions", "40 items, 12 of them transcript exchanges, from 2 sessions". */
export const heldSaid = (h: KnowsHeld): string => {
  const all = h.transcripts === h.items && h.items > 0;
  const what = all
    ? `${n(h.items)} transcript ${h.items === 1 ? "exchange" : "exchanges"}`
    : `${n(h.items)} ${h.items === 1 ? "item" : "items"}${h.transcripts > 0 ? `, ${n(h.transcripts)} of them transcript exchanges,` : ""}`;
  return h.sessions > 0 ? `${what} from ${n(h.sessions)} ${h.sessions === 1 ? "session" : "sessions"}` : what;
};

/** What an agent holds outside its rule here and on the person's machines. */
const withMachines = (here: KnowsHeld, machines: MachinesTold | null): KnowsHeld =>
  machines
    ? {
        ...here,
        items: here.items + machines.held.items,
        transcripts: here.transcripts + machines.held.transcripts,
        sessions: here.sessions + machines.held.sessions,
      }
    : here;

export function WhatTheySee({ agent, hub }: { agent: Agent; hub: HubAccount | undefined }) {
  const ids = useId();
  const head = `${ids}-head`;
  const name = agent.name;
  const remote = !(hub?.local ?? false);
  const self = agentKey(agent);
  const keyOf = useCallback((): string => (remote ? (linked.get(self) ?? known.get(self) ?? self) : self), [remote, self]);
  // An agent elsewhere is shared with from the person's machines too
  // (Sees K7); one on this computer's hub isn't yet.
  const places = usePlaces(self, remote);
  const machines = useMachines((s) => s.machines);
  const [view, setView] = useState<KnowsView | null>(null);
  const [load, setLoad] = useState<"loading" | "ok" | "missing" | { problem: string }>("loading");
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const [picking, setPicking] = useState(false);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [log, setLog] = useState<KnowsLogEntry[] | null>(null);
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  /** The rule as the hub last said it: what a refused change goes back to. */
  const confirmed = useRef<KnowsView | null>(null);
  /** Bumped by each change, so an older read doesn't undo a newer one. */
  const seq = useRef(0);
  const logShown = useRef(false);
  logShown.current = showLog;

  const api = useCallback(() => {
    const h = localAccount();
    return h ? knowsOf(h) : null;
  }, []);

  const read = useCallback(async () => {
    const k = api();
    if (!k) return setLoad({ problem: "Desk isn’t ready just now; try again in a moment." });
    const n = seq.current;
    try {
      // An agent elsewhere linked in an earlier run: its rule is kept by
      // the id its hub gave, which may differ in case from the roster's.
      if (remote && !linked.has(self) && !known.has(self)) {
        const as = [self, `local/${agent.id}`].map((x) => x.toLowerCase());
        const kept = (await k.rules()).find((r) => as.includes(r.agent.toLowerCase()));
        if (kept) known.set(self, kept.agent);
      }
      const v = await k.rule(keyOf());
      if (n !== seq.current) return;
      confirmed.current = v;
      setView(v);
      setLoad("ok");
    } catch (e) {
      if (n !== seq.current) return;
      if (e instanceof HubError && (e.status === 404 || e.status === 405)) setLoad("missing");
      else setLoad({ problem: said(e) });
    }
  }, [api, keyOf, remote, self, agent.id]);

  useEffect(() => {
    setView(null);
    setLoad("loading");
    setLog(null);
    setShowLog(false);
    void read();
  }, [read]);

  const readLog = useCallback(async () => {
    const k = api();
    if (!k) return;
    try {
      setLog(await k.log(keyOf()));
    } catch {
      setLog([]);
    }
  }, [api, keyOf]);

  useEffect(() => {
    if (showLog) void readLog();
  }, [showLog, readLog]);

  /** Links an agent on another hub, once a run. False, with the problem
   *  shown, when it can't be. */
  const link = async (): Promise<boolean> => {
    if (!remote || linked.has(self)) return true;
    const where = hub?.label ?? "their hub";
    const linkThere = knowsLinker();
    if (!linkThere) {
      setStatus({ state: "failed", problem: "This is set in Desk’s main window." });
      return false;
    }
    let r;
    try {
      r = await linkThere(agent.hubId, agent.id);
    } catch {
      setStatus({ state: "failed", problem: `Desk can’t reach ${where}; try again in a moment.` });
      return false;
    }
    if (r.kind === "unavailable") {
      setStatus({ state: "failed", problem: "This is set in the Desk app on your computer." });
      return false;
    }
    if (r.kind === "notAllowed") {
      setStatus({ state: "failed", problem: refusedSaid(r.error, name, where) });
      return false;
    }
    linked.set(self, r.kind === "local" ? `local/${r.agent}` : `${agent.hubId}/${r.agent}`);
    return true;
  };

  /** Keeps `next`, one write after another. A rule that shares nothing
   *  with an agent elsewhere needs no link: it is kept by the key read
   *  (the one an earlier link gave, when there was one). */
  const save = (next: Pick<KnowsRule, "places" | "transcripts" | "digest">) => {
    const k = api();
    if (!k || !view) return;
    const was = view.rule;
    const n = ++seq.current;
    setView({ ...view, rule: { ...view.rule, ...next } });
    setStatus({ state: "saving" });
    const nothing = next.places.length === 0 && !next.transcripts && next.digest === "off";
    writes.current = writes.current.then(async () => {
      const back = () => {
        if (n === seq.current && confirmed.current) setView(confirmed.current);
      };
      if (!nothing && !(await link())) return back();
      try {
        const changed = await k.setRule(keyOf(), next);
        // The machines' part, told now: what they hold outside it is asked
        // about with this computer's.
        const machines = await tell();
        if (n === seq.current) setStatus({ state: "idle" });
        // Asked only when it now holds more outside the rule than before:
        // what was kept earlier was asked about then.
        const before = confirmed.current?.heldOutside.items ?? 0;
        if (narrows(was, next) && (changed.heldOutside.items > before || machines?.grew))
          setAsking({
            held: withMachines(changed.heldOutside, machines),
            why:
              was.transcripts && !next.transcripts && modeOf(was.places) === modeOf(next.places) && was.places.join() === next.places.join()
                ? "transcripts"
                : "narrowed",
          });
        await read();
        if (logShown.current) await readLog();
      } catch (e) {
        back();
        setStatus({ state: "failed", problem: said(e) });
      }
    });
  };

  /** Tells the machines this rule's part for them now, with the person's
   *  choice when there was one: an agent elsewhere's alone. */
  const tell = async (choice?: "delete" | "keep"): Promise<MachinesTold | null> => {
    const t = knowsTeller();
    const at = keyOf().indexOf("/");
    return remote && t && at > 0 ? t(keyOf().slice(0, at), keyOf().slice(at + 1), choice) : null;
  };

  const choose = (choice: "delete" | "keep") => {
    const k = api();
    setAsking(null);
    if (!k) return;
    writes.current = writes.current.then(async () => {
      try {
        await k.choose(keyOf(), choice);
        setStatus({ state: "idle" });
        await tell(choice);
      } catch (e) {
        setStatus({ state: "failed", problem: said(e) });
      }
      await read();
      if (logShown.current) await readLog();
    });
  };

  const rule = view?.rule;
  const mode: SeesMode | null = rule ? modeOf(rule.places) : null;
  const chosen = rule && mode === "chosen" ? placesSaid(rule.places, places) : null;
  const modes: { id: SeesMode; name: string; desc: string }[] = [
    { id: "all", name: "Everything", desc: "Every session, board and decision, every group included" },
    { id: "chosen", name: "Chosen places", desc: chosen || "Groups, boards, grids, sessions or agents you pick" },
    { id: "own", name: "Only their own work", desc: "The sessions they run and their own decisions" },
  ];
  const at = Math.max(
    0,
    modes.findIndex((m) => m.id === mode),
  );
  const pick = (m: SeesMode) => {
    if (!rule || m === mode) return;
    if (m === "chosen") return setPicking(true);
    save({ places: m === "all" ? ["all"] : [], transcripts: rule.transcripts, digest: rule.digest });
  };
  /** Arrows move between the choices; Space, Enter or a click picks one,
   *  so moving through them never changes what is shared. */
  const moveKeys = (e: React.KeyboardEvent<HTMLButtonElement>, i: number) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const buttons = e.currentTarget.closest("[role=radiogroup]")?.querySelectorAll<HTMLButtonElement>("button[role=radio]");
    buttons?.[(i + step + modes.length) % modes.length]?.focus();
  };
  const shared = (view?.sharedToday ?? []).filter((s) => s.items > 0);
  // Machines share with an agent elsewhere; with one here, not yet.
  const elsewhere = remote ? [] : machines.filter((m) => m.id !== "local").map((m) => m.name);
  const held = view?.heldOutside;

  return (
    <section id="sees" className="agent-section sees" aria-labelledby={head}>
      <div className="sees-head">
        <h2 id={head}>What they see</h2>
        <span className="oversee-sub">
          {load === "missing"
            ? "This needs a newer Desk on this computer: update Desk to set it."
            : `Read-only: what ${name} knows of your work in Desk. It doesn’t let them act.`}
        </span>
      </div>
      {load === "loading" && <p className="small faint">…</p>}
      {typeof load === "object" && (
        <p className="small state-blocked" role="alert">
          {load.problem}
        </p>
      )}
      {rule && (
        <>
          <div className="ability-card">
            <div className="pick-list" role="radiogroup" aria-label={`What ${name} sees`}>
              {modes.map((m, i) => (
                <div key={m.id} className="sees-mode">
                  <button
                    type="button"
                    role="radio"
                    className="pick"
                    aria-checked={mode === m.id}
                    tabIndex={i === at ? 0 : -1}
                    onClick={() => pick(m.id)}
                    onKeyDown={(e) => moveKeys(e, i)}
                  >
                    <span className="radio-ring" aria-hidden="true" />
                    <span className="pick-text">
                      <b>{m.name}</b>
                      <span>{m.desc}</span>
                    </span>
                  </button>
                  {m.id === "chosen" && (
                    <button type="button" className="link link-signal small sees-change" onClick={() => setPicking(true)}>
                      {mode === "chosen" ? "Change…" : "Choose…"}
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="ability-row">
              <span className="ability-text">
                <b id={`${ids}-transcripts`}>Include transcripts</b>
                <span className="ability-sub">Copies of each session’s conversation, secrets hidden, so {name} can read and search them</span>
              </span>
              <button
                type="button"
                role="switch"
                className="switch"
                aria-checked={rule.transcripts}
                aria-labelledby={`${ids}-transcripts`}
                onClick={() => save({ places: rule.places, transcripts: !rule.transcripts, digest: rule.digest })}
              >
                <span className="switch-knob" />
              </button>
            </div>
            <div className="ability-row ability-row-center">
              <span className="ability-text">
                <b id={`${ids}-digest`}>A short update in their conversations with you</b>
                <span className="ability-sub">{digestSub(rule.digest, name)}</span>
              </span>
              <div className="seg ability-seg" role="radiogroup" aria-labelledby={`${ids}-digest`}>
                {DIGESTS.map((d, i) => {
                  const now = DIGESTS.findIndex((x) => x.id === rule.digest);
                  const set = (to: KnowsDigest) => to !== rule.digest && save({ places: rule.places, transcripts: rule.transcripts, digest: to });
                  return (
                    <button
                      key={d.id}
                      type="button"
                      role="radio"
                      aria-checked={rule.digest === d.id}
                      tabIndex={i === now ? 0 : -1}
                      onClick={() => set(d.id)}
                      onKeyDown={(e) => radioKeys(e, DIGESTS, now, (n) => set(n.id))}
                    >
                      {d.name}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="sees-foot">
            <p className="small muted">
              {shared.length > 0 ? `Shared today: ${andSaid(shared.map((s) => countSaid(s.items, s.kind)))}` : "Nothing shared today."}
              {" · "}
              <button type="button" className="link link-signal small" aria-expanded={showLog} onClick={() => setShowLog((x) => !x)}>
                {showLog ? "Hide what was shared" : "See what was shared"}
              </button>
            </p>
            {held && held.items > 0 && !asking && (
              <p className="small muted">
                {name} holds {heldSaid(held)} that they no longer see.{" "}
                <button type="button" className="link link-signal small" onClick={() => setAsking({ held, why: "earlier" })}>
                  Delete them…
                </button>
              </p>
            )}
            {elsewhere.length > 0 && <p className="small faint">Sessions on {andSaid(elsewhere)} aren’t shared yet.</p>}
            {status.state === "saving" && (
              <p className="small faint" role="status">
                Saving…
              </p>
            )}
            {status.state === "failed" && (
              <p className="small state-blocked" role="alert">
                {status.problem}
              </p>
            )}
          </div>
          {showLog && <SharedLog log={log} />}
        </>
      )}
      {picking && rule && (
        <PlacePicker
          who={name}
          places={places}
          initial={mode === "chosen" ? rule.places : []}
          onUse={(next) => {
            setPicking(false);
            save({ places: next, transcripts: rule.transcripts, digest: rule.digest });
          }}
          onClose={() => setPicking(false)}
        />
      )}
      {asking && <KeepOrDelete name={name} asking={asking} onChoose={choose} onCancel={() => setAsking(null)} />}
    </section>
  );
}

/** Asks what becomes of what the agent holds outside its rule. After a
 *  narrowing, Keep is focused and Escape or a click outside keeps it (and
 *  is logged): nothing is lost by not answering. Asked again later from
 *  "Delete them…", closing it changes nothing. */
function KeepOrDelete({ name, asking, onChoose, onCancel }: { name: string; asking: Asking; onChoose: (c: "delete" | "keep") => void; onCancel: () => void }) {
  const { held, why } = asking;
  const later = why === "earlier";
  const close = later ? onCancel : () => onChoose("keep");
  const what =
    why === "transcripts"
      ? `Desk stopped sharing transcripts with ${name}.`
      : why === "narrowed"
        ? `Desk stopped sharing some of your work with ${name}.`
        : `Desk no longer shares this with ${name}.`;
  return (
    <Dialog
      onClose={close}
      title={(id) => (
        <header className="dialog-head">
          <span className="dialog-title">
            <h1 id={id} className="display-lg">
              {later ? `Delete what ${name} holds?` : `${name} keeps what Desk already shared?`}
            </h1>
            <p className="small">
              {what} They hold {heldSaid(held)}. Nothing more of it is shared either way.
            </p>
          </span>
          <CloseButton onClose={close} />
        </header>
      )}
    >
      <footer className="dialog-foot">
        <span className="dialog-foot-note" />
        <button type="button" className="btn btn-danger" onClick={() => onChoose("delete")}>
          Delete them
        </button>
        {later ? (
          <button type="button" className="btn btn-ghost" data-autofocus onClick={onCancel}>
            Cancel
          </button>
        ) : (
          <button type="button" className="btn btn-signal" data-autofocus onClick={() => onChoose("keep")}>
            Keep what they have
          </button>
        )}
      </footer>
    </Dialog>
  );
}

const LOG_SAID: Record<string, (d: Record<string, unknown>) => string> = {
  rule: () => "Changed what they see",
  delete: (d) => `Deleted ${items(d.items)} they held`,
  keep: (d) => `Kept ${items(d.items)} they held`,
  stop: () => "Stopped sharing",
};

const items = (x: unknown): string => (typeof x === "number" ? `${n(x)} ${x === 1 ? "item" : "items"}` : "the items");

/** What was shared today by kind, and the rule's log: counts and places,
 *  never content. */
function SharedLog({ log }: { log: KnowsLogEntry[] | null }) {
  // What was shared today is the line above it: the changes alone here.
  return (
    <div className="sees-log">
      {log === null ? (
        <p className="small faint">…</p>
      ) : log.length === 0 ? (
        <p className="small faint">No changes yet.</p>
      ) : (
        <ul className="sees-log-list" aria-label="Changes">
          {log.map((e) => {
            const d = e.detail && typeof e.detail === "object" ? (e.detail as Record<string, unknown>) : {};
            const line = (LOG_SAID[e.what] ?? (() => e.what))(d);
            return (
              <li key={e.id}>
                <span>
                  {line}
                  {e.what === "delete" && !e.doneAt ? " (waiting for their hub)" : ""}
                </span>
                <span className="faint">{ago(e.at)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

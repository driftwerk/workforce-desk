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
import { knowsLinker, knowsOf, type KnowsDigest, type KnowsHeld, type KnowsLogEntry, type KnowsRule, type KnowsView } from "../hub/knows";
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

/** The agent ids its hub canonicalised when linked, by Desk's key for it:
 *  the rule is kept by that id, and the link is made once a run. */
const linked = new Map<string, string>();

/** For tests: forgets the links made. */
export const forgetLinks = () => linked.clear();

type Status = { state: "idle" | "saving" } | { state: "failed"; problem: string };

/** What the agent holds that the rule no longer covers, while the person
 *  is asked what becomes of it. */
type Asking = { held: KnowsHeld; why: "narrowed" | "earlier" };

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
  const all = h.transcripts === h.items;
  const what = all
    ? `${n(h.items)} transcript ${h.items === 1 ? "exchange" : "exchanges"}`
    : `${n(h.items)} ${h.items === 1 ? "item" : "items"}${h.transcripts > 0 ? `, ${n(h.transcripts)} of them transcript exchanges,` : ""}`;
  return h.sessions > 0 ? `${what} from ${n(h.sessions)} ${h.sessions === 1 ? "session" : "sessions"}` : what;
};

export function WhatTheySee({ agent, hub }: { agent: Agent; hub: HubAccount | undefined }) {
  const ids = useId();
  const head = `${ids}-head`;
  const name = agent.name;
  const remote = !(hub?.local ?? false);
  const self = agentKey(agent);
  const keyOf = useCallback((): string => (remote ? `${agent.hubId}/${linked.get(self) ?? agent.id}` : self), [remote, agent.hubId, agent.id, self]);
  const places = usePlaces(self);
  const machines = useMachines((s) => s.machines);
  const [view, setView] = useState<KnowsView | null>(null);
  const [load, setLoad] = useState<"loading" | "ok" | "missing" | { problem: string }>("loading");
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const [picking, setPicking] = useState(false);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [log, setLog] = useState<KnowsLogEntry[] | null>(null);
  const writes = useRef<Promise<unknown>>(Promise.resolve());

  const api = useCallback(() => {
    const h = localAccount();
    return h ? knowsOf(h) : null;
  }, []);

  const read = useCallback(async () => {
    const k = api();
    if (!k) return setLoad({ problem: "Desk isn’t ready just now; try again in a moment." });
    try {
      const v = await k.rule(keyOf());
      setView(v);
      setLoad("ok");
    } catch (e) {
      if (e instanceof HubError && (e.status === 404 || e.status === 405)) setLoad("missing");
      else setLoad({ problem: said(e) });
    }
  }, [api, keyOf]);

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
    linked.set(self, r.agent);
    return true;
  };

  /** Keeps `next`, one write after another. A rule that shares nothing
   *  with an agent elsewhere needs no link. */
  const save = (next: Pick<KnowsRule, "places" | "transcripts" | "digest">) => {
    const k = api();
    if (!k || !view) return;
    const before = view;
    const was = before.heldOutside.items;
    setView({ ...before, rule: { ...before.rule, ...next } });
    setStatus({ state: "saving" });
    const nothing = next.places.length === 0 && !next.transcripts && next.digest === "off";
    writes.current = writes.current.then(async () => {
      if (!nothing && !(await link())) {
        setView(before);
        return;
      }
      try {
        const changed = await k.setRule(keyOf(), next);
        setView((v) => (v ? { ...v, rule: changed.rule, heldOutside: changed.heldOutside } : v));
        setStatus({ state: "idle" });
        if (changed.heldOutside.items > was) setAsking({ held: changed.heldOutside, why: "narrowed" });
        void read();
        if (showLog) void readLog();
      } catch (e) {
        setView(before);
        setStatus({ state: "failed", problem: said(e) });
      }
    });
  };

  const choose = (choice: "delete" | "keep") => {
    const k = api();
    setAsking(null);
    if (!k) return;
    writes.current = writes.current.then(async () => {
      try {
        await k.choose(keyOf(), choice);
        setStatus({ state: "idle" });
      } catch (e) {
        setStatus({ state: "failed", problem: said(e) });
      }
      void read();
      if (showLog) void readLog();
    });
  };

  if (load === "missing") return null;
  const rule = view?.rule;
  const mode: SeesMode | null = rule ? modeOf(rule.places) : null;
  const chosen = rule && mode === "chosen" ? placesSaid(rule.places, places) : null;
  const ready = !!rule && status.state !== "saving";
  const modes: { id: SeesMode; name: string; desc: string }[] = [
    { id: "all", name: "Everything", desc: "Every session, board and decision, every group included" },
    { id: "chosen", name: "Chosen places", desc: chosen || "Groups, boards, grids, sessions or agents you pick" },
    { id: "own", name: "Only their own work", desc: "The sessions they run and their own decisions" },
  ];
  const pick = (m: SeesMode) => {
    if (!rule || m === mode) return;
    if (m === "chosen") return setPicking(true);
    save({ places: m === "all" ? ["all"] : [], transcripts: rule.transcripts, digest: rule.digest });
  };
  const shared = (view?.sharedToday ?? []).filter((s) => s.items > 0);
  const elsewhere = machines.filter((m) => m.id !== "local").map((m) => m.name);
  const held = view?.heldOutside;

  return (
    <section id="sees" className="agent-section sees" aria-labelledby={head}>
      <h2 id={head}>What they see</h2>
      <p className="oversee-sub sees-intro">Read-only: what {name} knows of your work in Desk. It doesn’t let them act.</p>
      {load === "loading" && <p className="small faint">…</p>}
      {typeof load === "object" && (
        <p className="small state-blocked" role="alert">
          {load.problem}
        </p>
      )}
      {rule && (
        <>
          <div className="sees-rows">
            <div className="sees-modes" role="radiogroup" aria-labelledby={head}>
              {modes.map((m) => (
                <div key={m.id} className="sees-mode">
                  <label className="sees-mode-pick">
                    <input type="radio" name={`${ids}-mode`} checked={mode === m.id} disabled={!ready} onChange={() => pick(m.id)} />
                    <b>{m.name}</b>
                    <span className="sees-mode-desc">{m.desc}</span>
                  </label>
                  {m.id === "chosen" && (
                    <button type="button" className="link small sees-change" disabled={!ready} onClick={() => setPicking(true)}>
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
                disabled={!ready}
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
                      disabled={!ready}
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
              <button type="button" className="link small" aria-expanded={showLog} onClick={() => setShowLog((x) => !x)}>
                {showLog ? "Hide what was shared" : "See what was shared"}
              </button>
            </p>
            {held && held.items > 0 && !asking && (
              <p className="small muted">
                {name} holds {heldSaid(held)} that they no longer see.{" "}
                <button type="button" className="link small" onClick={() => setAsking({ held, why: "earlier" })}>
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
          {showLog && <SharedLog log={log} today={view?.sharedToday ?? []} />}
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
      {asking && <KeepOrDelete name={name} asking={asking} transcriptsOff={!!rule && !rule.transcripts} onChoose={choose} />}
    </section>
  );
}

/** Asks what becomes of what the agent holds outside its rule. Keep is
 *  focused, and Escape or a click outside keeps it: nothing is lost by
 *  not answering. */
function KeepOrDelete({
  name,
  asking,
  transcriptsOff,
  onChoose,
}: {
  name: string;
  asking: Asking;
  transcriptsOff: boolean;
  onChoose: (c: "delete" | "keep") => void;
}) {
  const { held, why } = asking;
  const what =
    why === "narrowed"
      ? transcriptsOff && held.transcripts === held.items
        ? `Desk stopped sharing transcripts with ${name}.`
        : `Desk stopped sharing some of your work with ${name}.`
      : `Desk no longer shares this with ${name}.`;
  return (
    <Dialog
      onClose={() => onChoose("keep")}
      title={(id) => (
        <header className="dialog-head">
          <span className="dialog-title">
            <h1 id={id} className="display-lg">
              {name} keeps what Desk already shared?
            </h1>
            <p className="small">
              {what} {name} holds {heldSaid(held)}. Nothing more of it is shared either way.
            </p>
          </span>
          <CloseButton onClose={() => onChoose("keep")} />
        </header>
      )}
    >
      <footer className="dialog-foot">
        <span className="dialog-foot-note" />
        <button type="button" className="btn btn-danger" onClick={() => onChoose("delete")}>
          Delete them
        </button>
        <button type="button" className="btn btn-signal" data-autofocus onClick={() => onChoose("keep")}>
          Keep what they have
        </button>
      </footer>
    </Dialog>
  );
}

const LOG_SAID: Record<string, (d: Record<string, unknown>) => string> = {
  rule: () => "Changed what they see",
  delete: (d) => `Deleted ${num(d.items)} items they held`,
  keep: (d) => `Kept ${num(d.items)} items they held`,
  stop: () => "Stopped sharing",
};

const num = (x: unknown): string => (typeof x === "number" ? x.toLocaleString("en-GB") : "the");

/** What was shared today by kind, and the rule's log: counts and places,
 *  never content. */
function SharedLog({ log, today }: { log: KnowsLogEntry[] | null; today: { kind: string; items: number }[] }) {
  const kinds = today.filter((t) => t.items > 0);
  return (
    <div className="sees-log">
      {kinds.length > 0 && (
        <ul className="sees-log-list" aria-label="Shared today">
          {kinds.map((t) => (
            <li key={t.kind}>
              <span>{countSaid(t.items, t.kind)}</span>
              <span className="faint">today</span>
            </li>
          ))}
        </ul>
      )}
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

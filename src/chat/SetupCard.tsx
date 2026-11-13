import { useEffect, useMemo, useState } from "react";
import type { FileHome } from "../attachments/Attachments";
import { browserOf } from "../hub/browser";
import { HubError } from "../hub/client";
import { connectionsOf, type ConnectionsApi, type Setup, type SetupStep } from "../hub/connections";
import { useUi } from "../shell/ui";
import { useLive } from "../ui/useLive";
import { useChat } from "./store";
import "../styles/connections.css";

/** How often a setup under way is asked about. */
const POLL_MS = 2000;
/** How long between asks at most, while the hub keeps failing. */
const MOST_MS = 60_000;
/** How far the clocks of Desk and its hub may differ. */
const SKEW_MS = 5000;
/** How long the hub keeps a setup: its `SETUP_TTL`. */
export const SETUP_LIFE_MS = 60 * 60_000;
/** How long a turn's setups are waited for before the hub lists any:
 *  one the hub refused never shows. */
const FIRST_SHOW_MS = 60_000;
/** Times sending "I'm signed in" is tried while the chat reconnects. */
const SEND_TRIES = 20;
const SEND_EVERY_MS = 150;

/** Whether a setup has nothing left to show changing. */
const settled = (s: Setup): boolean =>
  (!!s.connected?.onFor || s.steps.every((x) => x.state === "done")) || s.steps.some((x) => x.state === "failed");

/** The setups an agent's message started (`count` of them, between
 *  `since` and `until`), as the hub keeps them: never what the agent
 *  wrote. Shown while they run, and once they are done. */
export function SetupCards({
  origin,
  since,
  until,
  count,
  api: given,
  showPage: givenShow,
}: {
  origin: FileHome;
  /** When its turn started, at the latest: its first setup's call, else
   *  the message before it. */
  since: string;
  /** When the next message came, where one has. */
  until?: string;
  count: number;
  api?: ConnectionsApi;
  /** Brings the agent's page to the front; false when it can't. */
  showPage?: (agent: string) => Promise<boolean>;
}) {
  const hub = useChat((s) => s.hubs.find((h) => h.id === origin.hub));
  const api = useMemo(() => given ?? (hub?.local ? connectionsOf(hub) : null), [given, hub]);
  const showPage = useMemo(
    () => givenShow ?? (hub?.local ? (agent: string) => browserOf(hub).show(agent) : async () => false),
    [givenShow, hub],
  );
  const [setups, setSetups] = useState<Setup[] | null>(null);
  const live = useLive();

  useEffect(() => {
    if (!api) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const from = Date.parse(since) - SKEW_MS;
    const to = until ? Date.parse(until) + SKEW_MS : Infinity;
    // Past this the hub keeps none of them: an hour from the turn's start,
    // until it lists them, then from the last still under way.
    let gone = from + SKEW_MS + SETUP_LIFE_MS + SKEW_MS;
    const began = Date.now();
    let failures = 0;
    const tick = async () => {
      let wait = POLL_MS;
      try {
        const all = await api.setups(origin.agent);
        if (stop || !live.current) return;
        failures = 0;
        const mine = all
          .filter((s) => {
            const t = Date.parse(s.startedAt);
            return t >= from && t <= to;
          })
          .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
          .slice(0, count);
        setSetups(mine);
        const running = mine.filter((s) => !settled(s)).map((s) => Date.parse(s.startedAt));
        if (running.length > 0) gone = Math.max(gone, Math.max(...running) + SETUP_LIFE_MS + SKEW_MS);
        // Done: every one shown has settled, and the rest the turn started
        // haven't come by now (the hub refused them, or keeps them no more).
        const waited = Date.now() - began >= FIRST_SHOW_MS;
        if (mine.every(settled) && (waited || (mine.length > 0 && mine.length >= count))) return;
      } catch (e) {
        if (stop) return;
        // A hub without setups shows none.
        if (e instanceof HubError && e.status === 404) return;
        failures += 1;
        wait = Math.min(POLL_MS * 2 ** failures, MOST_MS);
      }
      if (Date.now() + wait > gone) return;
      timer = setTimeout(() => void tick(), wait);
    };
    void tick();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [api, origin.agent, since, until, count]);

  if (!api || !setups || setups.length === 0) return null;
  return (
    <>
      {setups.map((s) => (
        <SetupCard
          key={s.id}
          setup={s}
          api={api}
          origin={origin}
          showPage={showPage}
          onChange={(n) => setSetups((list) => list?.map((x) => (x.id === n.id ? n : x)) ?? null)}
        />
      ))}
    </>
  );
}

const ICON: Record<SetupStep["state"], string> = {
  done: "✓",
  failed: "!",
  current: "",
  waiting: "",
  todo: "",
};

/** One setup: its steps, done, under way, waiting on the person, to come;
 *  and, once it is on, what is connected. */
export function SetupCard({
  setup: s,
  api,
  origin,
  showPage,
  onChange,
}: {
  setup: Setup;
  api: ConnectionsApi;
  origin: FileHome;
  showPage: (agent: string) => Promise<boolean>;
  onChange: (s: Setup) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** The hub has it signed in, but the agent wasn't told. */
  const [untold, setUntold] = useState(false);
  const live = useLive();
  const named = useChat((c) => c.roster.find((a) => a.hubId === origin.hub && a.id === origin.agent)?.name);
  const agentName = named ?? "The agent";
  const title = `${s.serviceName} · ${s.name}`;
  const at = s.steps.findIndex((x) => x.state !== "done");
  const n = s.steps.length;

  /** Desk's browser to the front, on the sign-in page; where it isn't on
   *  screen, Settings → Browser, where it is turned on and its pages show. */
  const show = async () => {
    const shown = await showPage(origin.agent).catch(() => false);
    if (!shown) useUi.getState().openSettings("browser");
  };

  /** Tells the agent, trying again while its chat reconnects. */
  const tell = async (): Promise<boolean> => {
    for (let n = 0; n < SEND_TRIES; n++) {
      if (useChat.getState().send(`${origin.hub}/${origin.agent}`, SIGNED_IN)) return true;
      await new Promise((r) => setTimeout(r, SEND_EVERY_MS));
      if (!live.current) return false;
    }
    return false;
  };

  const signedIn = async () => {
    setBusy(true);
    setProblem(null);
    try {
      onChange(await api.signedIn(s.id));
    } catch (e) {
      setProblem(
        e instanceof HubError && (e.status === 404 || e.status === 409)
          ? "That setup has ended. Ask again to start over."
          : "Desk couldn’t be reached just now. Try again in a moment.",
      );
      setBusy(false);
      return;
    }
    const told = await tell();
    if (!live.current) return;
    setUntold(!told);
    setBusy(false);
  };

  const tellAgain = async () => {
    setBusy(true);
    const told = await tell();
    if (!live.current) return;
    setUntold(!told);
    setBusy(false);
  };

  return (
    <>
      <section className="setup-card" aria-label={`Setting up ${title}`}>
        <div className="setup-head">
          <b className="display">Setting up {title}</b>
          <span className="small faint">{at === -1 ? "done" : `step ${at + 1} of ${n}`}</span>
        </div>
        <ol className="setup-steps">
          {s.steps.map((x) =>
            x.state === "waiting" ? (
              <li key={x.id} className="setup-step setup-step-waiting">
                <span className="setup-mark" aria-hidden="true" />
                <span className="setup-waiting">
                  <b>{x.label}</b>
                  {/* Desk's own words: never replaced by what the agent wrote. */}
                  <span className="small muted">{WAITING_SAYS}</span>
                  {x.note && (
                    <span className="small setup-note">
                      <span className="faint">{agentName} says:</span> “{x.note}”
                    </span>
                  )}
                  <span className="setup-actions">
                    <button type="button" className="btn btn-sm btn-blocked" onClick={() => void show()}>
                      Show the sign-in page
                    </button>
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void signedIn()}>
                      Already signed in
                    </button>
                  </span>
                </span>
              </li>
            ) : (
              <li key={x.id} className={`setup-step setup-step-${x.state}`}>
                <span className="setup-mark" aria-hidden="true">
                  {ICON[x.state]}
                </span>
                <span>
                  {x.label}
                  {x.note && x.state !== "todo" && <span className={`small ${x.state === "failed" ? "state-blocked" : "muted"}`}> · {x.note}</span>}
                </span>
              </li>
            ),
          )}
        </ol>
        {problem && (
          <p className="small state-blocked" role="alert">
            {problem}
          </p>
        )}
        {untold && (
          <p className="small state-blocked" role="alert">
            Desk couldn’t tell {named ?? "the agent"} you’re signed in.{" "}
            <button type="button" className="link small" disabled={busy} onClick={() => void tellAgain()}>
              Tell {named ?? "the agent"}
            </button>
          </p>
        )}
        {s.steps.some((x) => x.state === "failed") && (
          <p className="small state-blocked">Nothing was kept. Ask the agent to try again, or connect it yourself in Settings → Connections.</p>
        )}
      </section>
      {s.connected?.onFor && (
        <section className="setup-done" aria-label={`${title} is connected`}>
          <div className="setup-head">
            <span className="conn-dot conn-dot-on" aria-hidden="true" />
            <b>{title} is connected</b>
            <span className="small faint">
              {s.connected.onFor} uses it · {s.connected.write ? "read and write" : "read only"}
            </span>
          </div>
          <p className="small muted">
            Signed in as {s.connected.account}. Saved in the vault on this computer, never in a file.{" "}
            <button type="button" className="link small" onClick={() => useUi.getState().openSettings("connections")}>
              Open in Connections
            </button>
          </p>
        </section>
      )}
    </>
  );
}

/** What Desk tells the agent once the person says they're signed in. */
export const SIGNED_IN = "I’m signed in.";

/** What Desk says while a step waits on the person to sign in. */
export const WAITING_SAYS =
  "Your password stays with you: Desk never reads or types it. The page is open in your browser, and the agent carries on the moment you’re in.";

/** How many setups a turn's tools started. */
export const setupsStarted = (tools: readonly { name?: string; tool?: string }[] | undefined): number =>
  (tools ?? []).filter((t) => (t.name ?? t.tool) === "connections.setup").length;

/** When a message's setups started, at the latest: its first setup call,
 *  timed live; else when the message before it came (a kept message's own
 *  time is when its turn ended); else an hour before it, as long as the
 *  hub keeps a setup. */
export const setupsSince = (m: { at: string; tools?: readonly { name: string; startedAt?: number }[] }, before?: string): string => {
  const calls = (m.tools ?? []).filter((t) => t.name === "connections.setup" && t.startedAt !== undefined).map((t) => t.startedAt!);
  if (calls.length > 0) return new Date(Math.min(...calls)).toISOString();
  if (before && !Number.isNaN(Date.parse(before))) return before;
  const at = Date.parse(m.at);
  return Number.isNaN(at) ? new Date(0).toISOString() : new Date(at - SETUP_LIFE_MS).toISOString();
};

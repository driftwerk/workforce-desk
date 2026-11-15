import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { FileHome } from "../attachments/Attachments";
import { browserOf } from "../hub/browser";
import { HubError } from "../hub/client";
import { connectionsOf, type ConnectionsApi, type Setup, type SetupAction, type SetupChoice, type SetupNow } from "../hub/connections";
import { openUrl } from "../platform";
import { useUi } from "../shell/ui";
import { useLive } from "../ui/useLive";
import { useChat } from "./store";
import { toolNameOf } from "./toolLine";
import type { ToolCall } from "./types";
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
/** How long a sign-in is watched for before the card also offers "Already
 *  signed in?", should Desk not see it. */
export const SIGN_IN_ESCAPE_MS = 90_000;
/** Times a message to the agent is tried while the chat reconnects. */
const SEND_TRIES = 20;
const SEND_EVERY_MS = 150;

/** What a hub from before `now` shows: the waiting step, else working. */
const nowOf = (s: Setup): SetupNow => {
  if (s.now) return s.now;
  const base = { detail: null, code: null, url: null, expiresAt: null, action: null, other: null } as const;
  if (s.connected?.onFor) return { ...base, kind: "connected", title: `${s.serviceName} connected as ${s.connected.account}` };
  if (s.steps.some((x) => x.state === "failed")) return { ...base, kind: "failed", title: `${s.serviceName} didn’t connect` };
  if (s.steps.some((x) => x.state === "waiting")) return { ...base, kind: "sign_in", title: `Sign in to ${s.serviceName} in Desk’s window`, action: "show_page" };
  return { ...base, kind: "working", title: `Setting up ${s.serviceName}` };
};

/** Whether a setup has nothing left to show changing. */
export const settled = (s: Setup): boolean => s.ended != null || ["connected", "failed", "ended"].includes(nowOf(s).kind);

/** What the card asks of the person now. */
const NEEDS_YOU = new Set(["offer", "code", "sign_in", "failed"]);

/* Which message shows each setup: the newest that asked for it, so one
   setup is one card, where the person is looking. */
const claims = new Map<string, Map<symbol, number>>();
const listeners = new Set<() => void>();
let version = 0;
const changed = () => {
  version += 1;
  for (const l of listeners) l();
};
export const claim = (anchor: symbol, since: number, ids: string[]) => {
  let moved = false;
  for (const [id, by] of claims) {
    if (!ids.includes(id) && by.delete(anchor)) moved = true;
    if (by.size === 0) claims.delete(id);
  }
  for (const id of ids) {
    const by = claims.get(id) ?? new Map<symbol, number>();
    if (by.get(anchor) !== since) {
      by.set(anchor, since);
      moved = true;
    }
    claims.set(id, by);
  }
  if (moved) changed();
};
export const ownerOf = (id: string): symbol | undefined => {
  let best: [symbol, number] | undefined;
  for (const [anchor, since] of claims.get(id) ?? []) if (!best || since > best[1]) best = [anchor, since];
  return best?.[0];
};
export const useClaims = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );

/** Each setup's card on screen, to bring to the front for a link to it. */
const cards = new Map<string, HTMLElement>();

/** Brings setup `id`'s card into view, where one shows: false where none. */
export const revealSetup = (id: string): boolean => {
  const el = cards.get(id);
  if (!el) return false;
  el.scrollIntoView?.({ block: "center", behavior: "smooth" });
  el.classList.remove("setup-flash");
  void el.offsetWidth;
  el.classList.add("setup-flash");
  return true;
};

/** The setups an agent's message started or asked for again (`count` of
 *  them, between `since` and `until`), as the hub keeps them: never what
 *  the agent wrote. One setup is one card: a newer message that asked for
 *  it shows it instead, and one a newer setup replaced shows nowhere. */
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
  const anchor = useRef(Symbol("setups")).current;
  useClaims();

  useEffect(() => () => claim(anchor, 0, []), [anchor]);

  useEffect(() => {
    if (!api) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const from = Date.parse(since) - SKEW_MS;
    const to = until ? Date.parse(until) + SKEW_MS : Infinity;
    const within = (at: string | undefined) => {
      const t = at ? Date.parse(at) : NaN;
      return t >= from && t <= to;
    };
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
          .filter((s) => within(s.startedAt) || within(s.askedAt))
          .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
          .slice(0, count);
        setSetups(mine);
        claim(anchor, Date.parse(since), mine.filter((s) => s.ended == null).map((s) => s.id));
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
  }, [api, origin.agent, since, until, count, anchor]);

  if (!api || !setups) return null;
  const shown = setups.filter((s) => s.ended == null && ownerOf(s.id) === anchor);
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map((s) => (
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

/** What each of the card's buttons says. */
const LABEL: Record<SetupAction, string> = {
  use_cli: "Use it",
  open_code: "Copy code and open GitHub",
  show_page: "Show the page",
  new_code: "Get a new code",
  other_way: "Sign in another way",
  retry: "Try again",
  paste_token: "Paste a token",
  open_connections: "Open Connections",
};

/** "in 14 min", while a code lasts. */
const expiresIn = (at: string | null, now: number): string | null => {
  const t = at ? Date.parse(at) : NaN;
  if (Number.isNaN(t)) return null;
  const min = Math.ceil((t - now) / 60_000);
  return min > 0 ? `The code expires in ${min} min.` : null;
};

/** One setup, as one card that changes in place: the one thing to do now
 *  (use a sign-in on this computer, approve a code, sign in in Desk's window),
 *  then what came of it. Nothing on it is the agent's words. */
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
  const [copied, setCopied] = useState(false);
  /** The field a token of the person's own is pasted in: open or not. */
  const [pasting, setPasting] = useState(false);
  const [token, setToken] = useState("");
  const live = useLive();
  const card = useRef<HTMLElement>(null);
  const named = useChat((c) => c.roster.find((a) => a.hubId === origin.hub && a.id === origin.agent)?.name);
  const now = nowOf(s);
  const title = `${s.serviceName} · ${s.name}`;
  const n = s.steps.length;
  const done = s.steps.filter((x) => x.state === "done").length;
  const needsYou = NEEDS_YOU.has(now.kind);

  useEffect(() => {
    const el = card.current;
    if (!el) return;
    cards.set(s.id, el);
    return () => {
      if (cards.get(s.id) === el) cards.delete(s.id);
    };
  }, [s.id]);

  // When it starts needing the person, it comes into view.
  const kindSeen = useRef<string | null>(null);
  useEffect(() => {
    if (needsYou && kindSeen.current !== now.kind && kindSeen.current !== null) {
      card.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    }
    kindSeen.current = now.kind;
  }, [needsYou, now.kind]);

  // A sign-in Desk hasn't seen for a while: "Already signed in?" too.
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (now.kind !== "sign_in" && now.kind !== "code") {
      setWaitingSince(null);
      return;
    }
    setWaitingSince((w) => w ?? Date.now());
    const t = setInterval(() => setClock(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [now.kind]);
  const escape = now.kind === "sign_in" && waitingSince !== null && clock - waitingSince >= SIGN_IN_ESCAPE_MS;

  /** Tells the agent `text`, trying again while its chat reconnects. */
  const tell = async (text: string): Promise<boolean> => {
    for (let i = 0; i < SEND_TRIES; i++) {
      // Gone from the screen while it waited: nothing is sent unseen.
      if (i > 0 && !live.current) return false;
      if (useChat.getState().send(`${origin.hub}/${origin.agent}`, text)) return true;
      await new Promise((r) => setTimeout(r, SEND_EVERY_MS));
    }
    return false;
  };

  const ended = (e: unknown) =>
    e instanceof HubError && (e.status === 404 || e.status === 409)
      ? "That setup has ended. Ask again to start over."
      : "Desk couldn’t be reached just now. Try again in a moment.";

  const choose = async (choice: SetupChoice) => {
    setBusy(true);
    setProblem(null);
    try {
      const next = await api.choose(s.id, choice);
      if (live.current) onChange(next);
    } catch (e) {
      if (live.current) setProblem(ended(e));
    } finally {
      if (live.current) setBusy(false);
    }
  };

  /** Desk's browser to the front, on the sign-in page; where it isn't on
   *  screen, Settings → Browser, where it is turned on and its pages show. */
  const show = async () => {
    const shown = await showPage(origin.agent).catch(() => false);
    if (!shown) useUi.getState().openSettings("browser");
  };

  const openCode = async () => {
    if (now.code) {
      await navigator.clipboard?.writeText(now.code).then(
        () => setCopied(true),
        () => undefined,
      );
    }
    if (now.url) openUrl(now.url);
  };

  const act = (a: SetupAction) => {
    switch (a) {
      case "use_cli":
        return void choose("use-cli");
      case "other_way":
        return void choose("other-way");
      case "new_code":
        return void choose("new-code");
      case "open_code":
        return void openCode();
      case "show_page":
        return void show();
      case "paste_token":
        return void startPaste(false);
      case "open_connections":
        return void useUi.getState().openSettings("connections");
      case "retry":
        return void (async () => {
          setBusy(true);
          const told = await tell(`Please try setting up ${s.serviceName} again.`);
          if (!live.current) return;
          setBusy(false);
          if (!told) setProblem(`Desk couldn’t reach ${named ?? "the agent"} just now. Try again in a moment.`);
        })();
    }
  };

  /** Opens GitHub's token page, filled in, and the field to paste it in. */
  const startPaste = (open: boolean) => {
    setProblem(null);
    setPasting(true);
    if (open && now.paste) openUrl(now.paste);
  };

  /** The pasted token goes to the hub alone: never into the chat. */
  const paste = async () => {
    const given = token.trim();
    if (!given) return;
    setBusy(true);
    setProblem(null);
    setToken("");
    try {
      const next = await api.pasteToken(s.id, given);
      if (!live.current) return;
      onChange(next);
      setPasting(false);
    } catch (e) {
      if (!live.current) return;
      setProblem(e instanceof HubError && e.status === 400 ? e.message : ended(e));
    } finally {
      if (live.current) setBusy(false);
    }
  };

  /** The person says they're signed in, where Desk didn't see it. */
  const signedIn = async () => {
    setBusy(true);
    setProblem(null);
    try {
      onChange(await api.signedIn(s.id));
      // The agent waiting sees it; one whose turn ended is told.
      if (!(await tell(SIGNED_IN)) && live.current) setProblem(`Desk couldn’t tell ${named ?? "the agent"} you’re signed in. Try again in a moment.`);
    } catch (e) {
      if (live.current) setProblem(ended(e));
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const primary = now.kind === "failed" || now.action === "use_cli" || now.action === "open_code" || now.action === "new_code";
  const expiry = now.kind === "code" ? expiresIn(now.expiresAt, clock) : null;
  return (
    <section ref={card} className={`setup-card setup-${now.kind}${needsYou ? " setup-needs" : ""}`} aria-label={`Setting up ${title}`}>
      <div className="setup-head">
        {now.kind === "working" && <span className="setup-spin" aria-hidden="true" />}
        {now.kind === "connected" && <span className="conn-dot conn-dot-on" aria-hidden="true" />}
        <b className={`display${now.kind === "failed" ? " state-blocked" : ""}`} role={needsYou ? "status" : undefined}>
          {now.title}
        </b>
        {now.kind !== "connected" && now.kind !== "failed" && n > 1 && (
          <span className="setup-dots" aria-label={`step ${Math.min(done + 1, n)} of ${n}`}>
            {s.steps.map((x) => (
              <i key={x.id} className={x.state === "done" ? "done" : x.state === "todo" ? "" : "on"} />
            ))}
          </span>
        )}
      </div>
      {now.code && <p className="conn-code mono">{now.code}</p>}
      {(now.detail || expiry) && (
        <p className="small muted setup-detail">
          {now.detail}
          {expiry && ` ${expiry}`}
          {now.kind === "connected" && (
            <>
              {" · "}
              <button type="button" className="link small setup-link" onClick={() => useUi.getState().openSettings("connections")}>
                Open in Connections
              </button>
            </>
          )}
        </p>
      )}
      {pasting && now.paste != null && (
        <form
          className="setup-paste"
          onSubmit={(e) => {
            e.preventDefault();
            void paste();
          }}
        >
          <label className="small muted" htmlFor={`token-${s.id}`}>
            On GitHub’s page, under Repository access choose All repositories, then Generate token. Paste the token here: it goes straight to the vault on this computer, never into the chat.
          </label>
          <span className="setup-paste-row">
            <input
              id={`token-${s.id}`}
              className="mono"
              type="password"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder="github_pat_…"
              value={token}
              disabled={busy}
              onChange={(e) => setToken(e.target.value)}
            />
            <button type="submit" className="btn btn-approve" disabled={busy || !token.trim()}>
              {busy ? "Checking…" : "Connect"}
            </button>
            <button type="button" className="link small" disabled={busy} onClick={() => (setPasting(false), setToken(""))}>
              Cancel
            </button>
          </span>
        </form>
      )}
      {!pasting && (now.action || now.other || escape || now.paste) && (
        <div className="setup-actions">
          {now.action && now.action !== "paste_token" && (
            <button type="button" className={primary ? "btn btn-approve" : "btn"} disabled={busy} onClick={() => act(now.action!)}>
              {busy && now.action === "use_cli"
                ? "Checking…"
                : now.action === "open_code" && copied
                  ? "Copied · open GitHub again"
                  : LABEL[now.action]}
            </button>
          )}
          {(now.paste || now.action === "paste_token") && (
            <button
              type="button"
              className={now.action === "paste_token" ? "btn btn-approve" : "btn"}
              disabled={busy}
              onClick={() => startPaste(now.action !== "paste_token")}
            >
              {LABEL.paste_token}
            </button>
          )}
          {now.other && (
            <button type="button" className="link small" disabled={busy} onClick={() => act(now.other!)}>
              {LABEL[now.other]}
            </button>
          )}
          {escape && (
            <button type="button" className="link small" disabled={busy} onClick={() => void signedIn()}>
              Already signed in?
            </button>
          )}
        </div>
      )}
      {problem && (
        <p className="small state-blocked" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}

/** What Desk tells the agent once the person says they're signed in. */
export const SIGNED_IN = "I’m signed in.";

/** The tool that sets a connection up. */
const SETUP_TOOL = "connections.setup";
const isSetupCall = (t: { name?: string; tool?: string }): boolean => toolNameOf(t.name ?? t.tool ?? "") === SETUP_TOOL;

/** How many setups a turn's tools started. */
export const setupsStarted = (tools: readonly { name?: string; tool?: string }[] | undefined): number => (tools ?? []).filter(isSetupCall).length;

/** When a message's setups started, at the latest: its first setup call,
 *  timed live; else when the message before it came (a kept message's own
 *  time is when its turn ended); else an hour before it, as long as the
 *  hub keeps a setup. */
export const setupsSince = (m: { at: string; tools?: readonly { name: string; startedAt?: number }[] }, before?: string): string => {
  const calls = (m.tools ?? []).filter((t) => isSetupCall(t) && t.startedAt !== undefined).map((t) => t.startedAt!);
  if (calls.length > 0) return new Date(Math.min(...calls)).toISOString();
  if (before && !Number.isNaN(Date.parse(before))) return before;
  const at = Date.parse(m.at);
  return Number.isNaN(at) ? new Date(0).toISOString() : new Date(at - SETUP_LIFE_MS).toISOString();
};

/** The cards of an answer still under way that has said nothing yet (the
 *  working row): the setups its tools started, shown while the turn waits
 *  on them (`connections.wait`), not only once it ends. `before`: when the
 *  message it answers came. */
export function PendingSetups({ origin, message, before }: { origin?: FileHome; message?: { at: string; tools?: ToolCall[] }; before?: string }) {
  const count = setupsStarted(message?.tools);
  if (!origin || !message || count === 0) return null;
  return <SetupCards origin={origin} since={setupsSince(message, before)} count={count} />;
}

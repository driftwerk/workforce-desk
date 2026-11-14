// Signing an engine in, the same on this computer and on each machine:
// Claude through a Desk account (`claude setup-token`, run by that engine's
// hub), ChatGPT through Codex's device page and Devin through its own page
// (each also run by that hub). Where
// it runs is the only difference: on a machine the page opens here, and
// Claude's page comes back to the machine through Desk's forward of its one
// port for as long as the sign-in runs.
//
// Every wait has a limit, and every failure says why, with Try again:
// - 30 s for the sign-in's page to open (Claude's, or Codex's device code);
// - 10 minutes for the person to approve Claude's sign-in;
// - 15 minutes for Codex's code to be typed (as long as the code lasts);
// - 10 minutes for the person to sign in on Devin's page.
// A sign-in that runs out of time is stopped on its hub.

import { useCallback, useEffect, useRef, useState } from "react";
import { HubError, type DeskHub } from "../hub/client";
import { LOCAL, type MachineId } from "../hub/machines";
import { useHubOf } from "../hub/store";
import type { AccountSignIn, EngineSignIn } from "../hub/types";
import { native as realNative, type MachineNative } from "../machines/native";
import { openUrl } from "../platform";
import { plainError } from "../ui/plainError";
import { useLive } from "../ui/useLive";
import { accountsOn } from "./accounts";

/** How long the sign-in's page has to open. */
export const OPEN_WITHIN_MS = 30_000;
/** How long the person has to approve Claude's sign-in. */
export const APPROVE_WITHIN_MS = 10 * 60_000;
/** How long Codex's code works. */
export const CODE_WITHIN_MS = 15 * 60_000;
/** How often a sign-in under way is read again (besides its events). */
export const SIGN_IN_POLL_MS = 1000;

/** Codex's sign-in for a computer with no browser of its own, for a hub
 *  too old to run it itself. */
export const CODEX_LOGIN = "codex login --device-auth";

/** Where a sign-in runs, mid-sentence: "this computer", "devbox". */
export type Where = string;

/** The page opened for a Claude sign-in: the one that comes back by itself
 *  (a machine's, held by the native side, which opens it again), or a page
 *  this computer opens (on this computer, or the page with a code). */
type Page = { kind: "direct" } | { kind: "url"; url: string };

export type ClaudeRun =
  | { at: "idle" }
  /** Begun: the page isn't open yet (30 s). */
  | { at: "opening"; name: string; id: string | null; checking: boolean }
  /** The page is open: approve it in the browser (10 minutes), or paste the
   *  code it shows (`codeAsked`). */
  | { at: "waiting"; name: string; id: string; page: Page | null; codeAsked: boolean; checking: boolean; why: string | null }
  /** `account`: the account it went to, when the hub said. */
  | { at: "done"; name: string; account?: string }
  /** `kind`: the page never opened, nobody approved it in time, or another
   *  failure, said in `why`. */
  | { at: "failed"; name: string; why: string; kind: "open" | "wait" | "other" };

/** The page a sign-in shows, once it does. */
const pageOf = (s: AccountSignIn): string | null => (s.state === "open" || s.state === "code" ? s.url : null);

const over = (s: { state: string }) => s.state === "done" || s.state === "failed";

/** What a sign-in on `where` says when its page didn't open in time. */
export const notOpened = (where: Where): string => `Claude’s sign-in page didn’t open within 30 s: Claude Code on ${where} didn’t answer.`;
export const notApproved = "Nobody approved the sign-in within 10 minutes, so Desk stopped it.";

/** Signing a Claude account in on `machine`'s engine: `begin` with its name,
 *  then the run says where it is. */
export function useClaudeSignIn(machine: MachineId, where: Where, native: MachineNative = realNative, onDone?: (name: string) => void) {
  const hub = useHubOf(machine);
  const remote = machine !== LOCAL;
  const store = accountsOn(machine);
  const [run, setRun] = useState<ClaudeRun>({ at: "idle" });
  const runNow = useRef(run);
  runNow.current = run;
  const live = useLive();
  const done = useRef(onDone);
  done.current = onDone;
  /** Each begin and cancel starts a new run: what an older one's awaits
   *  bring back is for nothing (and a sign-in it started is stopped). */
  const gen = useRef(0);
  /** "New sessions start on it", as the last begin asked: Try again keeps it. */
  const lastDefault = useRef(false);
  /** The account the last begin signed in again, if it did. */
  const lastAgain = useRef<string | undefined>(undefined);
  /** The sign-in followed now, and what's been done for it. */
  const seen = useRef<{ id: string; forwarding: boolean; wantCode: boolean; opened: string | null; latest: AccountSignIn } | null>(null);

  const stopForward = useCallback(
    (id: string | undefined = seen.current?.id) => {
      if (remote && id) void native.signInForwardStop(machine, id).catch(() => undefined);
    },
    [native, machine, remote],
  );

  /** Opens a page the sign-in gave: here, this computer's; a machine's only
   *  once the native side has checked it is Claude's own. */
  const open = useCallback(
    (url: string) => {
      if (!remote) return openUrl(url);
      void native.openSignInPage("claude", url).catch((e: unknown) => {
        if (live.current) setRun((now) => (now.at === "waiting" ? { ...now, why: plainError(e) } : now));
      });
    },
    [native, remote, live],
  );

  const toWaiting = useCallback((s: AccountSignIn, change: (now: Extract<ClaudeRun, { at: "waiting" }>) => Partial<Extract<ClaudeRun, { at: "waiting" }>> = () => ({})) => {
    setRun((now) => {
      const base: Extract<ClaudeRun, { at: "waiting" }> =
        now.at === "waiting" && now.id === s.id
          ? now
          : { at: "waiting", name: now.at === "idle" || now.at === "done" ? s.name : now.name, id: s.id, page: null, codeAsked: false, checking: false, why: null };
      return { ...base, checking: s.state === "checking", ...change(base) };
    });
  }, []);

  /** The page with a code: opened once it shows, and the field for it. */
  const toCode = useCallback(() => {
    const s = seen.current;
    if (!s) return;
    s.wantCode = true;
    const page = pageOf(s.latest);
    if (page && s.opened !== page) {
      s.opened = page;
      open(page);
    }
    toWaiting(s.latest, (now) => ({ codeAsked: true, page: page ? { kind: "url", url: page } : now.page }));
  }, [open, toWaiting]);

  const follow = useCallback(
    (s: AccountSignIn) => {
      if (!live.current) return;
      if (seen.current && seen.current.id !== s.id) return;
      // Only the sign-in under way now: one stopped (cancelled, or out of
      // time) says nothing more, whatever a read in flight brings back.
      const now = runNow.current;
      if (!((now.at === "opening" && (now.id === null || now.id === s.id)) || (now.at === "waiting" && now.id === s.id))) return;
      if (s.state === "done") {
        stopForward(s.id);
        seen.current = null;
        setRun((now) => ({ at: "done", name: now.at === "idle" ? s.name : "name" in now ? now.name : s.name, account: s.account }));
        done.current?.(s.name);
        return;
      }
      if (s.state === "failed") {
        stopForward(s.id);
        seen.current = null;
        setRun((now) => ({ at: "failed", name: "name" in now ? now.name : s.name, why: s.why, kind: "other" }));
        return;
      }
      const it = seen.current ?? { id: s.id, forwarding: false, wantCode: false, opened: null, latest: s };
      it.latest = s;
      seen.current = it;
      if (it.wantCode) return toCode();
      if (!remote) {
        // This computer's Claude Code opens its page itself.
        const page = pageOf(s);
        if (page) toWaiting(s, () => ({ page: { kind: "url", url: page } }));
        else setRun((now) => (now.at === "opening" ? { ...now, id: s.id, checking: s.state === "checking" } : now.at === "waiting" ? { ...now, checking: s.state === "checking" } : now));
        return;
      }
      if (s.directReady && !it.forwarding) {
        it.forwarding = true;
        // The native side reads the page from the machine, listens for it
        // coming back, and opens it: the page never names either.
        native
          .signInForward(machine, s.id)
          .then(() => {
            if (!live.current || seen.current !== it) return;
            toWaiting(it.latest, () => ({ page: { kind: "direct" } }));
          })
          .catch((e: unknown) => {
            if (!live.current || seen.current !== it) return;
            // The page with a code still works: now, or once it shows.
            toWaiting(it.latest, () => ({ why: plainError(e) }));
            toCode();
          });
      } else if (!s.directReady && !it.forwarding && pageOf(s)) {
        // A hub that can't give the page that comes back: the page with a code.
        toCode();
      } else {
        setRun((now) => (now.at === "opening" ? { ...now, id: s.id, checking: s.state === "checking" } : now.at === "waiting" ? { ...now, checking: s.state === "checking" } : now));
      }
    },
    [live, machine, native, remote, stopForward, toCode, toWaiting],
  );

  // Its events, as the engine says them.
  const id = run.at === "opening" || run.at === "waiting" ? run.id : null;
  const heard = store((s) => (id ? (s.signIns[id] ?? null) : null));
  useEffect(() => {
    if (heard) follow(heard);
  }, [heard, follow]);

  // And read again each second, so a missed event never strands it.
  useEffect(() => {
    if (!hub || !id) return;
    const t = setInterval(() => {
      void hub
        .accounts()
        .then((a) => {
          const now = a?.signIns.find((s) => s.id === id);
          if (now) follow(now);
          else if (a && !a.signIns.some((s) => s.id === id)) {
            const kept = seen.current?.latest.name;
            if (kept && a.accounts.some((x) => x.engine === "claude" && x.name === kept)) follow({ ...seen.current!.latest, state: "done", account: "" });
            else follow({ id, engine: "claude", name: kept ?? "", state: "failed", why: `The sign-in ended on ${where} before it finished. Start it again.` });
          }
        })
        .catch(() => undefined);
    }, SIGN_IN_POLL_MS);
    return () => clearInterval(t);
  }, [hub, id, follow, where]);

  /** Stops the sign-in on its hub and here. */
  const stop = useCallback(
    (signIn: string | null) => {
      if (signIn) void hub?.cancelSignIn(signIn).catch(() => undefined);
      stopForward(signIn ?? undefined);
      seen.current = null;
    },
    [hub, stopForward],
  );

  // Its limits: 30 s for the page, 10 minutes to approve.
  // The page opening starts one clock; the page open, another.
  const phase = run.at === "opening" ? "opening" : run.at === "waiting" ? `waiting:${run.id}` : null;
  useEffect(() => {
    if (!phase) return;
    const opening = phase === "opening";
    const t = setTimeout(
      () => {
        const now = runNow.current;
        // Said at once, so a read in flight can't put it back.
        const put = (r: ClaudeRun) => {
          runNow.current = r;
          setRun(r);
        };
        if (opening && now.at === "opening") {
          put({ at: "failed", name: now.name, why: notOpened(where), kind: "open" });
          stop(now.id);
        } else if (!opening && now.at === "waiting") {
          put({ at: "failed", name: now.name, why: notApproved, kind: "wait" });
          stop(now.id);
        }
      },
      opening ? OPEN_WITHIN_MS : APPROVE_WITHIN_MS,
    );
    return () => clearTimeout(t);
  }, [phase, stop, where]);

  // Ended with the card: a sign-in under way goes on there, and is picked
  // up again by the next one; its forward doesn't outlive the page.
  useEffect(
    () => () => {
      const signIn = seen.current?.id;
      if (remote && signIn) void native.signInForwardStop(machine, signIn).catch(() => undefined);
    },
    [native, machine, remote],
  );

  /** Signs `name` in (the default for new sessions when `makeDefault`). One
   *  already under way there with that name is picked up, not refused. */
  /** Says where the sign-in is at once, so a read in flight sees it. */
  const put = (r: ClaudeRun) => {
    runNow.current = r;
    setRun(r);
  };

  const begin = async (name: string, makeDefault: boolean, againId?: string) => {
    if (!hub) return;
    const mine = ++gen.current;
    lastDefault.current = makeDefault;
    lastAgain.current = againId;
    stop(run.at === "opening" || run.at === "waiting" ? run.id : null);
    put({ at: "opening", name, id: null, checking: false });
    // Cancelled (or begun again) while a read was out: nothing more is
    // done for this run.
    const stale = () => !live.current || gen.current !== mine;
    try {
      const accounts = await hub.accounts().catch(() => null);
      if (stale()) return;
      const pending = accounts?.signIns.find((s) => s.engine === "claude" && !over(s) && s.name.toLowerCase() === name.toLowerCase());
      if (pending) {
        put({ at: "opening", name, id: pending.id, checking: false });
        return follow(pending);
      }
      const added = againId
        ? await hub.signInAgain(againId, remote ? { remote: true } : {}).catch((e: unknown) => {
            // A Desk there from before signing in again.
            if (e instanceof HubError && e.status === 404) throw new Error(`Desk on ${where} is too old to sign ${name} in again: update it there, or remove the account and add it again.`);
            throw e;
          })
        : await hub.addAccount({ engine: "claude", name, makeDefault, ...(remote ? { remote: true } : {}) });
      if (stale()) {
        // Its sign-in started after the person cancelled: stopped on its
        // hub at once, and nothing of it is opened.
        if (added.kind === "signIn") void hub.cancelSignIn(added.signIn.id).catch(() => undefined);
        return;
      }
      if (added.kind === "account") {
        setRun({ at: "done", name, account: added.account.id });
        done.current?.(name);
        return;
      }
      store.setState((st) => ({ signIns: { ...st.signIns, [added.signIn.id]: added.signIn } }));
      put({ at: "opening", name, id: added.signIn.id, checking: false });
      follow(added.signIn);
    } catch (e) {
      if (!stale()) setRun({ at: "failed", name, why: plainError(e), kind: "other" });
    }
  };

  /** "Try again": the same name, and the same choice of default. */
  const again = () => {
    const now = runNow.current;
    if (now.at === "failed") void begin(now.name, lastDefault.current, lastAgain.current);
  };

  const cancel = () => {
    gen.current++;
    const id = run.at === "opening" || run.at === "waiting" ? run.id : null;
    runNow.current = { at: "idle" };
    setRun({ at: "idle" });
    stop(id);
  };

  /** "Open the sign-in page again". */
  const reopen = () => {
    if (run.at !== "waiting" || !run.page) return;
    if (run.page.kind === "url") return open(run.page.url);
    void native.signInForward(machine, run.id).catch((e: unknown) => {
      if (!live.current) return;
      toWaiting(seen.current?.latest ?? ({ id: run.id, engine: "claude", name: run.name, state: "starting" } as AccountSignIn), () => ({ why: plainError(e) }));
      toCode();
    });
  };

  /** Sends the code the page showed. A refused code is said, and the field stays. */
  const sendCode = async (code: string) => {
    if (!hub || run.at !== "waiting") return;
    try {
      const s = await hub.signInCode(run.id, code.trim());
      if (s.state === "failed") toWaiting(seen.current?.latest ?? s, () => ({ why: codeRefused(s.why) }));
      else follow(s);
    } catch (e) {
      setRun((now) => (now.at === "waiting" ? { ...now, why: codeRefused(plainError(e)) } : now));
    }
  };

  /** "Use a code instead". */
  const withCode = () => toCode();

  const reset = () => setRun({ at: "idle" });

  return { run, begin, again, cancel, reopen, sendCode, withCode, reset, hub };
}

/** What a refused code says: Claude's own words, and what to do. */
export const codeRefused = (why: string): string => `That code didn’t work: ${why.replace(/\.$/, "")}. Open the page again for a new one.`;

/** An engine's own sign-in, as the engine's hub runs it: Codex's device
 *  page, Devin's page (with a token to paste back when `manual`). */
export const engineRoutes = (hub: DeskHub, engine: "codex" | "devin", opts: { manual?: boolean } = {}) => ({
  start: () => (opts.manual ? hub.startEngineSignIn(engine, { manual: true }) : hub.startEngineSignIn(engine)),
  read: (id: string) => hub.engineSignIn(id),
  cancel: (id: string) => hub.cancelEngineSignIn(id),
});

/** Codex's device sign-in, as the engine's hub runs it. */
export const codexRoutes = (hub: DeskHub) => engineRoutes(hub, "codex");

export type CodexRun =
  | { at: "idle" }
  /** Begun: its device page isn't up yet (30 s). */
  | { at: "opening"; id: string | null }
  /** Type `code` on the page that opened (15 minutes). */
  | { at: "device"; id: string; url: string; code: string }

  | { at: "done" }
  | { at: "failed"; why: string }
  /** A hub too old to run Codex's sign-in itself: a terminal there. */
  | { at: "terminal" };

export const codeExpired = "The code ran out after 15 minutes, so Desk stopped the sign-in.";
export const codexNotOpened = (where: Where): string => `ChatGPT’s sign-in page didn’t open within 30 s: Codex on ${where} didn’t answer.`;

/** Signing ChatGPT in for Codex on `machine`'s engine, by Codex's device
 *  page: opened here, its code shown to type there. */
export function useCodexSignIn(machine: MachineId, where: Where, native: MachineNative = realNative, onDone?: () => void) {
  const hub = useHubOf(machine);
  const [run, setRun] = useState<CodexRun>({ at: "idle" });
  const runNow = useRef(run);
  runNow.current = run;
  const opened = useRef<string | null>(null);
  const live = useLive();
  const done = useRef(onDone);
  done.current = onDone;
  const gen = useRef(0);

  /** The device page, opened only once it is checked to be Codex's own; a
   *  page that won't open stops the sign-in on its hub. */
  const openPage = useCallback(
    (url: string, signIn?: string) =>
      void native.openSignInPage("codex", url).catch((e: unknown) => {
        const now = runNow.current;
        const id = signIn ?? (now.at === "device" ? now.id : null);
        if (hub && id)
          void codexRoutes(hub)
            .cancel(id)
            .catch(() => undefined);
        if (!live.current) return;
        runNow.current = { at: "failed", why: plainError(e) };
        setRun(runNow.current);
      }),
    [native, live, hub],
  );

  const follow = useCallback(
    (s: EngineSignIn) => {
      if (!live.current) return;
      // Only the sign-in under way now.
      const now = runNow.current;
      if (!((now.at === "opening" && (now.id === null || now.id === s.id)) || (now.at === "device" && now.id === s.id))) return;
      switch (s.state) {
        case "starting":
          return setRun((now) => (now.at === "opening" ? { at: "opening", id: s.id } : now));
        case "device":
          if (opened.current !== s.id) {
            opened.current = s.id;
            openPage(s.url, s.id);
          }
          return setRun((now) => (now.at === "device" && now.id === s.id ? now : { at: "device", id: s.id, url: s.url, code: s.code }));
        case "done":
          setRun({ at: "done" });
          return done.current?.();
        case "failed":
          return setRun({ at: "failed", why: s.why });
        // Devin's; Codex never says them.
        case "page":
        case "paste":
          return;
      }
    },
    [openPage, live],
  );

  const id = run.at === "device" || run.at === "opening" ? (run.id ?? null) : null;
  useEffect(() => {
    if (!hub || !id) return;
    const routes = codexRoutes(hub);
    const t = setInterval(() => {
      void routes
        .read(id)
        .then(follow)
        .catch((e: unknown) => {
          if (e instanceof HubError && e.status === 404) follow({ id, engine: "codex", state: "failed", why: `The sign-in ended on ${where} before it finished. Start it again.` });
        });
    }, SIGN_IN_POLL_MS);
    return () => clearInterval(t);
  }, [hub, id, follow, where]);

  // Its limits: 30 s for the device page, 15 minutes for the code.
  const phase = run.at === "opening" ? "opening" : run.at === "device" ? `device:${run.id}` : null;
  useEffect(() => {
    if (!phase || !hub) return;
    const t = setTimeout(
      () => {
        const now = runNow.current;
        const stopIt = (signIn: string | null) => {
          if (signIn) void codexRoutes(hub).cancel(signIn).catch(() => undefined);
        };
        const put = (r: CodexRun) => {
          runNow.current = r;
          setRun(r);
        };
        if (phase === "opening" && now.at === "opening") {
          put({ at: "failed", why: codexNotOpened(where) });
          stopIt(now.id);
        } else if (phase !== "opening" && now.at === "device") {
          put({ at: "failed", why: codeExpired });
          stopIt(now.id);
        }
      },
      phase === "opening" ? OPEN_WITHIN_MS : CODE_WITHIN_MS,
    );
    return () => clearTimeout(t);
  }, [phase, hub, where]);

  const begin = async () => {
    if (!hub) return;
    const mine = ++gen.current;
    opened.current = null;
    runNow.current = { at: "opening", id: null };
    setRun({ at: "opening", id: null });
    try {
      const s = await codexRoutes(hub).start();
      if (!live.current || gen.current !== mine) {
        // Cancelled before its id was known: stopped on its hub, its page
        // never opened.
        void codexRoutes(hub)
          .cancel(s.id)
          .catch(() => undefined);
        return;
      }
      follow(s);
    } catch (e) {
      if (!live.current || gen.current !== mine) return;
      if (e instanceof HubError && (e.status === 404 || e.status === 405)) setRun({ at: "terminal" });
      else setRun({ at: "failed", why: plainError(e) });
    }
  };

  const cancel = () => {
    gen.current++;
    runNow.current = { at: "idle" };
    setRun({ at: "idle" });
    if (hub && id) void codexRoutes(hub).cancel(id).catch(() => undefined);
  };

  const reset = () => setRun({ at: "idle" });

  return { run, begin, cancel, openPage, reset, busy: run.at === "opening" || run.at === "device" };
}

export type DevinRun =
  | { at: "idle" }
  /** Begun: its page isn't up yet (30 s). */
  | { at: "opening"; id: string | null }
  /** Its page is open: Devin carries on by itself once the person signs in
   *  there (10 minutes), or (`paste`) the page gives a token to paste here.
   *  `why`: a token that didn't go, said beside its field. */
  | { at: "page"; id: string; url: string; paste: boolean; why: string | null }
  | { at: "done" }
  | { at: "failed"; why: string };

export const devinNotOpened = (where: Where): string => `Devin’s sign-in page didn’t open within 30 s: Devin on ${where} didn’t answer.`;
export const devinNotSigned = "Nobody signed in on Devin’s page within 10 minutes, so Desk stopped it.";
/** What a token the hub refused says, by why it refused it (`status`): a
 *  token that wasn't one (400) is pasted again as the page shows it; a
 *  sign-in no longer waiting for one (409) needs the page again. */
export const tokenRefused = (why: string, status?: number): string => {
  const said = `That token didn’t go through: ${why.replace(/\.$/, "")}.`;
  if (status === 400) return `${said} Paste the token exactly as the page shows it.`;
  if (status === 409) return `${said} Open the page again for a new one.`;
  return said;
};
/** What Devin asking for a token again, after one was sent, says. */
export const tokenNotTaken = "Devin didn’t take that token; paste it again.";

/** Signing in to Devin on `machine`'s engine, by Devin's own sign-in run by
 *  its hub: its page opened here once it's checked to be Devin's own, and
 *  on a machine (no browser there) the token the page gives pasted back.
 *  The token is sent at once and kept nowhere: not in the run, nor a log. */
export function useDevinSignIn(machine: MachineId, where: Where, native: MachineNative = realNative, onDone?: () => void) {
  const hub = useHubOf(machine);
  const [run, setRun] = useState<DevinRun>({ at: "idle" });
  const runNow = useRef(run);
  runNow.current = run;
  /** The page opened for each sign-in, once per page it gives. */
  const opened = useRef<string | null>(null);
  /** The token last sent and taken by the hub: for which sign-in, its page
   *  then, and whether the sign-in has moved off asking for it since. */
  const sent = useRef<{ id: string; url: string; left: boolean } | null>(null);
  const live = useLive();
  const done = useRef(onDone);
  done.current = onDone;
  const gen = useRef(0);
  /** The last begin asked for the token to paste. */
  const manual = useRef(machine !== LOCAL);
  const put = (r: DevinRun) => {
    runNow.current = r;
    setRun(r);
  };

  /** Devin's page, opened only once it is checked to be Devin's own; a page
   *  that won't open stops the sign-in on its hub. */
  const openPage = useCallback(
    (url: string, signIn?: string) =>
      void native.openSignInPage("devin", url).catch((e: unknown) => {
        const now = runNow.current;
        const id = signIn ?? (now.at === "page" ? now.id : null);
        if (hub && id) void hub.cancelEngineSignIn(id).catch(() => undefined);
        if (!live.current) return;
        runNow.current = { at: "failed", why: plainError(e) };
        setRun(runNow.current);
      }),
    [native, live, hub],
  );

  const follow = useCallback(
    (s: EngineSignIn) => {
      if (!live.current) return;
      const now = runNow.current;
      if (!((now.at === "opening" && (now.id === null || now.id === s.id)) || (now.at === "page" && now.id === s.id))) return;
      const token = sent.current?.id === s.id ? sent.current : null;
      if (token && s.state !== "paste") token.left = true;
      switch (s.state) {
        case "starting":
          return setRun((now) => (now.at === "opening" ? { at: "opening", id: s.id } : now));
        case "page":
        case "paste": {
          const page = `${s.id} ${s.url}`;
          if (opened.current !== page) {
            opened.current = page;
            openPage(s.url, s.id);
          }
          const paste = s.state === "paste";
          // Asked again for a token after one went: Devin didn't take it.
          const retake = paste && token !== null && (token.left || token.url !== s.url);
          if (retake) sent.current = null;
          return setRun((now) =>
            !retake && now.at === "page" && now.id === s.id && now.paste === paste && now.url === s.url
              ? now
              : { at: "page", id: s.id, url: s.url, paste, why: retake ? tokenNotTaken : now.at === "page" ? now.why : null },
          );
        }
        case "done":
          put({ at: "done" });
          return done.current?.();
        case "failed":
          return put({ at: "failed", why: s.why });
        case "device":
          return;
      }
    },
    [openPage, live],
  );

  const id = run.at === "page" || run.at === "opening" ? (run.id ?? null) : null;
  useEffect(() => {
    if (!hub || !id) return;
    const t = setInterval(() => {
      void hub
        .engineSignIn(id)
        .then(follow)
        .catch((e: unknown) => {
          if (e instanceof HubError && e.status === 404) follow({ id, engine: "devin", state: "failed", why: `The sign-in ended on ${where} before it finished. Start it again.` });
        });
    }, SIGN_IN_POLL_MS);
    return () => clearInterval(t);
  }, [hub, id, follow, where]);

  // Its limits: 30 s for the page, 10 minutes to sign in there.
  const phase = run.at === "opening" ? "opening" : run.at === "page" ? `page:${run.id}` : null;
  useEffect(() => {
    if (!phase || !hub) return;
    const t = setTimeout(
      () => {
        const now = runNow.current;
        const stopIt = (signIn: string | null) => {
          if (signIn) void hub.cancelEngineSignIn(signIn).catch(() => undefined);
        };
        if (phase === "opening" && now.at === "opening") {
          put({ at: "failed", why: devinNotOpened(where) });
          stopIt(now.id);
        } else if (phase !== "opening" && now.at === "page") {
          put({ at: "failed", why: devinNotSigned });
          stopIt(now.id);
        }
      },
      phase === "opening" ? OPEN_WITHIN_MS : APPROVE_WITHIN_MS,
    );
    return () => clearTimeout(t);
  }, [phase, hub, where]);

  /** Starts it: by the page alone, or (`asked`, and always on a
   *  machine) with a token to paste back. */
  const begin = async (asked = false) => {
    if (!hub) return;
    const withToken = asked || machine !== LOCAL;
    const mine = ++gen.current;
    manual.current = withToken;
    sent.current = null;
    const was = runNow.current;
    if (was.at === "opening" || was.at === "page") if (was.id) void hub.cancelEngineSignIn(was.id).catch(() => undefined);
    opened.current = null;
    put({ at: "opening", id: null });
    try {
      const s = await engineRoutes(hub, "devin", withToken ? { manual: true } : {}).start();
      if (!live.current || gen.current !== mine) {
        void hub.cancelEngineSignIn(s.id).catch(() => undefined);
        return;
      }
      follow(s);
    } catch (e) {
      if (!live.current || gen.current !== mine) return;
      put({ at: "failed", why: plainError(e) });
    }
  };

  /** Sends the token the page gave, straight to the sign-in. A refused
   *  token is said, and the field stays (empty). */
  const sendToken = async (token: string) => {
    const now = runNow.current;
    if (!hub || now.at !== "page") return;
    sent.current = null;
    try {
      await hub.sendEngineSignInToken(now.id, token.trim());
      sent.current = { id: now.id, url: now.url, left: false };
      if (live.current) setRun((r) => (r.at === "page" && r.id === now.id ? { ...r, why: null } : r));
      // The sign-in says when it's done; read it now rather than in a second.
      void hub
        .engineSignIn(now.id)
        .then(follow)
        .catch(() => undefined);
    } catch (e) {
      if (!live.current) return;
      const status = e instanceof HubError ? e.status : undefined;
      const why = status === 409 ? "Devin wasn’t waiting for one just then" : plainError(e);
      setRun((r) => (r.at === "page" && r.id === now.id ? { ...r, why: tokenRefused(why, status) } : r));
    }
  };

  const cancel = () => {
    gen.current++;
    put({ at: "idle" });
    if (hub && id) void hub.cancelEngineSignIn(id).catch(() => undefined);
  };

  /** "Try again": the same way as the last begin (on a machine, always
   *  with a token to paste). */
  const again = () => void begin(manual.current);
  /** "Paste a token instead": the sign-in again, with a token to paste. */
  const withToken = () => void begin(true);

  const reset = () => put({ at: "idle" });

  return { run, begin, again, withToken, sendToken, cancel, openPage, reset, busy: run.at === "opening" || run.at === "page" };
}

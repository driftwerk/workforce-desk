import { useEffect, useRef, useState } from "react";
import {
  helperLastReason,
  helperProgress,
  helperStatus,
  moveToApplications,
  openLoginItems,
  startHelper,
  type HelperStage,
  type HelperStatus,
} from "../platform";
import { useHost, type Platform } from "../shell/host";
import { useUi } from "../shell/ui";
import { useDesk } from "./store";

/** Before Desk has answered once this run, how long before it says it's
 *  getting ready (a quick start shows nothing). */
export const SHOW_AFTER_MS = 1_500;
/** Once it has answered, how long it may be out of reach before Desk says
 *  so: Desk's helper restarts what it runs by itself, and an update hands
 *  over to the new one. */
export const GRACE_MS = 4_000;
/** Out of reach this long after answering: Desk starts its helper itself. */
export const RESTART_AFTER_MS = 8_000;
/** Never answered this long after Desk opened: Desk starts its helper
 *  itself, in case it stopped while starting. */
export const FIRST_WAIT_MS = 90_000;
/** How long after starting its helper Desk waits before saying it didn't
 *  come back. */
export const START_WAIT_MS = 45_000;
const PROGRESS_EVERY_MS = 1_000;
const STATUS_EVERY_MS = 3_000;

/** Where Desk stands with its own helper, as the page shows it. */
export type Readiness =
  | { kind: "ready" }
  /** Starting, the first time this run (`first`) or again. */
  | { kind: "getting-ready"; stage: HelperStage | null; first: boolean }
  /** The system won't run the helper until the person does something. */
  | { kind: "blocked"; status: HelperStatus }
  /** Desk started its helper and nothing answered. */
  | { kind: "stuck"; reason: string | null };

export type ReadyAction = "login-items" | "move" | "retry" | "help";

export interface ReadyWords {
  title: string;
  detail?: string;
  /** What the helper last logged, under Details. */
  logged?: string | null;
  action?: { kind: ReadyAction; label: string };
}

/** Whether the helper can't run until the person does something. */
export const blocks = (s: HelperStatus): boolean =>
  !["running", "starting", "not-registered"].includes(s.state);

export const STEPS: readonly { stage: HelperStage; words: string }[] = [
  { stage: "starting", words: "Starting Desk’s helper" },
  { stage: "database", words: "Opening Desk’s database" },
  { stage: "services", words: "Starting Desk’s services" },
  { stage: "connecting", words: "Connecting" },
];

const loginItems = (platform: Platform): { where: string; label: string } =>
  platform === "windows"
    ? { where: "Settings → Apps → Startup", label: "Open Startup apps" }
    : platform === "linux"
      ? { where: "your session’s autostart settings", label: "Open autostart settings" }
      : { where: "System Settings → General → Login Items", label: "Open Login Items" };

/** What the banner says, in the person's words; null while Desk is ready. */
export function readyWords(r: Readiness, platform: Platform): ReadyWords | null {
  switch (r.kind) {
    case "ready":
      return null;
    case "getting-ready":
      return {
        title: "Getting Desk ready…",
        detail: r.first ? "This takes a little longer the first time." : undefined,
      };
    case "stuck":
      return {
        title: "Desk’s helper stopped and didn’t start again",
        detail: "Try again. If it keeps stopping, Settings → Help can save a report for whoever helps you.",
        logged: r.reason,
        action: { kind: "retry", label: "Try again" },
      };
    case "blocked":
      return blockedWords(r.status, platform);
  }
}

function blockedWords(s: HelperStatus, platform: Platform): ReadyWords {
  switch (s.state) {
    case "needs-approval": {
      const { where, label } = loginItems(platform);
      return {
        title: "Desk needs your OK to run in the background",
        detail: `Turn Desk on in ${where}. Desk carries on by itself once it’s on.`,
        action: { kind: "login-items", label },
      };
    }
    case "move-to-applications":
      return {
        title: "Desk needs to be in your Applications folder",
        detail: "It can’t keep your agents running from where it was opened. Desk moves itself there and opens again.",
        action: { kind: "move", label: "Move it for me" },
      };
    case "development":
      return {
        title: "This build doesn’t start Desk’s helper",
        detail: "Start desk-hubd by hand, as you did before.",
        action: { kind: "retry", label: "Try again" },
      };
    case "no-wsl":
    case "port-unreachable":
      return {
        title: "Desk can’t reach its helper in WSL",
        detail: "Settings → Help shows how to fix it.",
        action: { kind: "help", label: "Open Help" },
      };
    case "failed":
      return {
        title: "Desk couldn’t start its helper",
        detail: "Try again. If it keeps failing, Settings → Help can save a report for whoever helps you.",
        logged: s.message,
        action: { kind: "retry", label: "Try again" },
      };
    default:
      return { title: "Getting Desk ready…" };
  }
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Where Desk stands with its own helper. While it hasn't answered it is
 *  getting ready, with how far it has got; if it stops, Desk starts it again
 *  by itself, and says so only when that doesn't work. Login Items are
 *  looked at again whenever Desk comes forward. */
export function useDeskReady(): { readiness: Readiness; retry: () => void } {
  const connected = useDesk((s) => s.connected);
  const answered = useDesk((s) => s.answered);
  const noLocal = useHost((h) => h.platform === "windows" && h.host === null);
  const [shown, setShown] = useState(false);
  const [stage, setStage] = useState<HelperStage | null>(null);
  const [status, setStatus] = useState<HelperStatus | null>(null);
  const [stuck, setStuck] = useState<{ reason: string | null } | null>(null);
  const [tries, setTries] = useState(0);
  const last = useRef<HelperStatus | null>(null);

  useEffect(() => {
    if (connected || noLocal) {
      setShown(false);
      setStage(null);
      setStatus(null);
      setStuck(null);
      last.current = null;
      return;
    }
    let live = true;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const later = (ms: number, f: () => void) => timers.push(setTimeout(() => live && f(), ms));
    const settle = (s: HelperStatus) => {
      last.current = s;
      setStatus(s);
    };
    const start = () => {
      setStuck(null);
      startHelper()
        .then((s) => {
          if (!live) return;
          settle(s);
          if (!blocks(s))
            later(START_WAIT_MS, () =>
              void helperLastReason()
                .catch(() => null)
                .then((reason) => live && setStuck({ reason })),
            );
        })
        .catch((e: unknown) => live && settle({ state: "failed", message: messageOf(e) }));
    };
    const readProgress = () =>
      void helperProgress()
        .then((s) => live && setStage(s))
        .catch(() => undefined);
    // Turned on in Login Items (seen when Desk comes forward, or on the next
    // look): started now, no reopening.
    const readStatus = () =>
      void helperStatus()
        .then((s) => {
          if (!live) return;
          const was = last.current;
          settle(s);
          if (was?.state === "needs-approval" && !blocks(s)) start();
        })
        .catch(() => undefined);
    later(answered ? GRACE_MS : SHOW_AFTER_MS, () => setShown(true));
    later(tries > 0 ? 0 : answered ? RESTART_AFTER_MS : FIRST_WAIT_MS, start);
    readProgress();
    readStatus();
    const progress = setInterval(readProgress, PROGRESS_EVERY_MS);
    const looks = setInterval(readStatus, STATUS_EVERY_MS);
    const onFocus = () => readStatus();
    const onVisible = () => document.visibilityState === "visible" && readStatus();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      timers.forEach(clearTimeout);
      clearInterval(progress);
      clearInterval(looks);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [connected, answered, noLocal, tries]);

  const readiness: Readiness =
    connected || noLocal || !shown
      ? { kind: "ready" }
      : status && blocks(status)
        ? { kind: "blocked", status }
        : stuck
          ? { kind: "stuck", reason: stuck.reason }
          : { kind: "getting-ready", stage, first: !answered };
  return { readiness, retry: () => setTries((t) => t + 1) };
}

/** How far along the steps `stage` is, 0 to 1; null when unknown. */
export const progressOf = (stage: HelperStage | null): number | null => {
  if (!stage) return null;
  const at = STEPS.findIndex((s) => s.stage === stage);
  return (at + 0.5) / STEPS.length;
};

/** The banner itself, for `readiness`; nothing while Desk is ready. */
export function DeskReadyBanner({ readiness, onRetry }: { readiness: Readiness; onRetry: () => void }) {
  const platform = useHost((h) => h.platform);
  const [moving, setMoving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const words = readyWords(readiness, platform);
  if (!words) return null;

  const act = (kind: ReadyAction) => {
    setNote(null);
    switch (kind) {
      case "login-items":
        void openLoginItems();
        return;
      case "move":
        setMoving(true);
        moveToApplications()
          .catch((e: unknown) => setNote(messageOf(e)))
          .finally(() => setMoving(false));
        return;
      case "retry":
        onRetry();
        return;
      case "help":
        useUi.getState().openSettings("help");
        return;
    }
  };

  const ready = readiness.kind === "getting-ready" ? readiness : null;
  const progress = ready ? progressOf(ready.stage) : null;
  const step = ready ? (STEPS.find((s) => s.stage === ready.stage) ?? STEPS[0]!) : null;
  return (
    <section className="hub-down" role="status" aria-label={words.title}>
      <span className="hub-down-text">
        <b>{words.title}</b>
        {ready && (
          <>
            <span
              className={`ready-bar${progress === null ? " ready-bar-unknown" : ""}`}
              role="progressbar"
              aria-label="Getting Desk ready"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress === null ? undefined : Math.round(progress * 100)}
            >
              <span style={progress === null ? undefined : { width: `${progress * 100}%` }} />
            </span>
            <span className="muted small">
              {step!.words}
              {progress !== null && ` · step ${STEPS.indexOf(step!) + 1} of ${STEPS.length}`}
            </span>
          </>
        )}
        {words.detail && <span className="muted small">{words.detail}</span>}
        {note && <span className="small hub-down-note">{note}</span>}
        {words.logged && (
          <details className="faint small hub-down-reason">
            <summary>Details</summary>
            {words.logged}
          </details>
        )}
      </span>
      {words.action && (
        <button type="button" className="btn btn-signal" disabled={moving} onClick={() => act(words.action!.kind)}>
          {moving ? "Moving…" : words.action.label}
        </button>
      )}
    </section>
  );
}

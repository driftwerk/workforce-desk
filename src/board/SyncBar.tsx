import { useId, useState } from "react";
import { useChat } from "../chat/store";
import { HubError } from "../hub/client";
import { linkedTo, matchedBy, SYSTEM_TITLE, syncStatus, vouched } from "../hub/boardSync";
import { ChooseMe } from "./ChooseMe";
import { openSettingsAt } from "../ui/problem";
import type { Board, Ticket } from "../hub/types";
import { useDesk } from "../hub/store";
import { Confirm } from "../ui/Confirm";
import { useOpenTicket } from "./opener";
import { useBoard } from "./store";
import { hubNameOf, localSync, useSyncHubs } from "./syncStore";

const saidOf = (e: unknown): string => (e instanceof HubError || e instanceof Error ? e.message : String(e));

/** "3 min ago", from the minute it's drawn in. */
const ago = (iso: string | null | undefined, now: number): string | null => {
  if (!iso) return null;
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (Number.isNaN(mins)) return null;
  return mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
};

/** A synced board's sync, under its header: what it is linked to, a chip
 *  that says synced, paused (and why) or a problem (in the hub's words),
 *  and Pause or Resume and Sync now. */
export function SyncBar({ board, now, onToken }: { board: Board; now: number; onToken?: () => void }) {
  const kept = useSyncHubs((s) => s.hubs);
  const paired = useChat((s) => s.hubs);
  const fail = useDesk((s) => s.fail);
  const [busy, setBusy] = useState<"pause" | "sync" | "me" | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const sync = board.sync;
  if (!sync) return null;
  const hub = hubNameOf(sync.via, kept, paired);
  const status = syncStatus(board, hub)!;
  const paused = !!sync.paused;
  const kept_ = (b: Board) => useBoard.setState((s) => ({ boards: { ...s.boards, [b.id]: b } }));
  const pause = async () => {
    const api = localSync();
    if (!api) return;
    setBusy("pause");
    try {
      kept_(await api.pause(board.id, !paused));
    } catch (e) {
      fail(new Error(saidOf(e)));
    } finally {
      setBusy(null);
    }
  };
  const syncNow = async () => {
    const api = localSync();
    if (!api) return;
    setBusy("sync");
    setSaid(null);
    try {
      await api.syncNow(board.id);
      setSaid("Syncing now");
    } catch (e) {
      fail(new Error(saidOf(e)));
    } finally {
      setBusy(null);
    }
  };
  // Who the hub says the person is there, asked again: "that's not me" or
  // a new token of their own.
  const recheck = async () => {
    const api = localSync();
    if (!api) return;
    setBusy("me");
    setSaid(null);
    try {
      const b = await api.recheckMe(board.id);
      kept_(b);
      setSaid(vouched(b.sync?.meSource) ? `${hub} knows you as ${b.sync?.meName ?? "you"}` : (b.sync?.meNote ?? `${hub} can't say who you are`));
    } catch (e) {
      fail(new Error(saidOf(e)));
    } finally {
      setBusy(null);
    }
  };
  const pulled = ago(sync.pulledAt, now);
  const who =
    sync.meSource === "vouched" && sync.meName
      ? `you're ${sync.meName} there`
      : matchedBy(sync.meSource) && sync.meName
        ? `you're ${sync.meName} there, ${matchedBy(sync.meSource)}`
      : sync.meSource === "typed"
        ? "your id as you typed it: Take it needs the hub to say who you are"
        : (sync.meNote ?? null);
  return (
    <div className="board-sync" aria-label={`Sync with ${SYSTEM_TITLE[sync.system]}`}>
      <span className={`chip board-sync-chip board-sync-${status.kind}`}>{status.kind === "synced" ? "Synced" : status.kind === "paused" ? "Paused" : "Sync problem"}</span>
      <span className="board-sync-words" role="status">
        {status.kind === "synced" ? (
          <>
            {linkedTo(board, hub)}
            {pulled && <span className="faint"> · checked {pulled}</span>}
            {who && <span className="faint board-sync-me"> · {who}</span>}
          </>
        ) : (
          status.words
        )}
      </span>
      {said && <span className="sr-only" aria-live="polite">{said}</span>}
      <span className="board-sync-actions">
        {sync.paused?.kind === "noToken" && sync.via.kind === "hub" && onToken && (
          <button type="button" className="btn btn-sm btn-signal" onClick={onToken}>
            New token…
          </button>
        )}
        <button type="button" className="btn btn-sm" disabled={!!busy || paused} title={`Ask ${hub} again who you are on ${SYSTEM_TITLE[sync.system]}`} onClick={() => void recheck()}>
          {busy === "me" ? "Checking…" : vouched(sync.meSource) ? "Check again" : "Check who you are"}
        </button>
        {/* A shared key: they say who they are there, or change it. */}
        {(matchedBy(sync.meSource) || (!vouched(sync.meSource) && sync.meNote && /shared/.test(sync.meNote))) && (
          <button type="button" className="btn btn-sm" disabled={paused} onClick={() => setChoosing(true)}>
            {sync.meSource === "chosen" ? "Change" : matchedBy(sync.meSource) ? "That’s not me" : "Choose who you are"}
          </button>
        )}
        {/* A shared key that couldn't be matched to them: their own key fixes it too. */}
        {!vouched(sync.meSource) && sync.meNote && /shared/.test(sync.meNote) && (
          <button type="button" className="btn btn-sm" onClick={() => openSettingsAt("connections")}>
            Set up your own {SYSTEM_TITLE[sync.system]} key
          </button>
        )}
        <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => void pause()}>
          {paused ? "Resume" : "Pause"}
        </button>
        <button type="button" className="btn btn-sm" disabled={!!busy || paused} title={paused ? "Resume it first" : undefined} onClick={() => void syncNow()}>
          {busy === "sync" ? "Syncing…" : "Sync now"}
        </button>
      </span>
      {choosing && (
        <ChooseMe
          where={{ system: sync.system, via: sync.via, ...(sync.agent ? { agent: sync.agent } : {}) }}
          hub={hub}
          chosen={sync.meSource === "chosen"}
          onCancel={() => setChoosing(false)}
          onDone={() => {
            setChoosing(false);
            void recheck();
          }}
        />
      )}
    </div>
  );
}

/** The tickets whose issues left the board's import filter: kept here,
 *  unsynced for good, or dropped (the issue is never touched). */
export function LeftFilterShelf({ board, tickets }: { board: Board; tickets: Ticket[] }) {
  const fail = useDesk((s) => s.fail);
  const [busy, setBusy] = useState<string | null>(null);
  // Its own, as a grid can show more than one board.
  const titleId = useId();
  const openTicket = useOpenTicket();
  if (!tickets.length) return null;
  const system = board.sync ? SYSTEM_TITLE[board.sync.system] : "the remote";
  const decide = async (t: Ticket, keep: boolean) => {
    const hub = useDesk.getState().hub;
    if (!hub) return;
    setBusy(t.id);
    try {
      useBoard.getState().heard(await hub.leftFilter(t.id, keep));
    } catch (e) {
      fail(new Error(saidOf(e)));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="board-left" aria-labelledby={titleId}>
      <div className="board-left-head">
        <h2 id={titleId} className="ov-label muted">
          Left the filter · {tickets.length}
        </h2>
        <span className="move-opt-sub">These issues no longer match what the board imports. Keep one here, unsynced, or drop it; {system} is never changed.</span>
      </div>
      <ul className="board-left-rows">
        {tickets.map((t) => (
          <li key={t.id} className="board-left-row">
            <button type="button" className="link board-left-open" onClick={() => openTicket(t.id)}>
              <span className="mono board-key">{t.key}</span>
              <span className="board-left-title">{t.title}</span>
            </button>
            <span className="board-left-actions">
              <button type="button" className="btn btn-sm" disabled={busy === t.id} onClick={() => void decide(t, true)}>
                Keep
              </button>
              <button type="button" className="btn btn-sm btn-ghost" disabled={busy === t.id} onClick={() => void decide(t, false)}>
                Drop
              </button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Asks before unlinking: the board keeps its tickets, unsynced. */
export function UnlinkBoard({ board, onClose }: { board: Board; onClose: () => void }) {
  const target = board.sync ? `${SYSTEM_TITLE[board.sync.system]} ${board.sync.target}` : "its project";
  return (
    <Confirm
      title={`Unlink “${board.name}” from ${target}?`}
      action="Unlink"
      onConfirm={async () => {
        const api = localSync();
        if (!api) throw new Error("Desk isn't ready yet. Try again in a moment.");
        const b = await api.unlink(board.id);
        useBoard.setState((s) => ({ boards: { ...s.boards, [b.id]: b } }));
      }}
      onClose={onClose}
    >
      <p className="muted">Its tickets stay here with their keys, no longer synced; new ones get keys of the board’s own. Nothing changes in {target}.</p>
    </Confirm>
  );
}

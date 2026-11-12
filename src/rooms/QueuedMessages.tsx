import { useEffect, useState } from "react";
import { shownText } from "../chat/commands";
import { useShallow } from "zustand/react/shallow";
import { useChat } from "../chat/store";
import type { Queue, Queued } from "../chat/queue";

const NO_QUEUE: Queue = { items: [], paused: false };

/** What's queued for an agent's next turn, under the composer: each message
 *  can be edited, taken out or sent at once; a paused queue (after a Stop,
 *  or put back after a reload) is sent on from here. */
export function QueuedMessages({ to, name, busy }: { to: string; name: string; busy: boolean }) {
  const queue = useChat((s) => s.queues[to] ?? NO_QUEUE);
  const resume = useChat((s) => s.resumeQueue);
  if (!queue.items.length) return null;
  const n = queue.items.length;
  const what = n === 1 ? "1 message" : `${n} messages`;
  const note = queue.paused
    ? `${what} waiting. ${n === 1 ? "It won’t go on its own" : "They won’t go on their own"}.`
    : `${what} queued. ${n === 1 ? "It goes" : "They go together"} when ${name}’s done.`;
  return (
    <section className="composer-queue" aria-label={`Queued for ${name}`}>
      <header className="composer-queue-head">
        <span className="small muted">{note}</span>
        {queue.paused && (
          <button type="button" className="link small" onClick={() => resume(to)}>
            {busy ? `Send when ${name}’s done` : n === 1 ? "Send it" : "Send them"}
          </button>
        )}
      </header>
      <ol className="composer-queue-list">
        {queue.items.map((item) => (
          <QueuedRow key={item.id} to={to} item={item} name={name} busy={busy} />
        ))}
      </ol>
    </section>
  );
}

function QueuedRow({ to, item, name, busy }: { to: string; item: Queued; name: string; busy: boolean }) {
  const { edit, remove, sendNow, editingQueued } = useChat(
    useShallow((s) => ({ edit: s.editQueued, remove: s.removeQueued, sendNow: s.sendQueuedNow, editingQueued: s.editingQueued })),
  );
  const [editing, setEditing] = useState<string | null>(null);
  // ↑ in the composer asked for this one: it opens for editing here.
  const asked = useChat((s) => s.queues[to]?.editing === item.id);
  useEffect(() => {
    if (asked && !item.sending) setEditing((was) => was ?? item.text);
  }, [asked, item.sending, item.text]);
  const files = item.attachments ?? [];
  const label = shownText(item.text.trim()) || files.map((f) => f.filename).join(", ");
  const start = () => {
    // Nothing goes while you edit: what's sent is what you save.
    editingQueued(to, item.id);
    setEditing(item.text);
  };
  const finish = (text: string | null) => {
    if (text !== null) edit(to, item.id, text);
    setEditing(null);
    editingQueued(to, null);
  };
  const filesWait = files.length > 0 && busy;
  return (
    <li className="queued" aria-busy={item.sending ? true : undefined}>
      {editing === null ? (
        <span className="queued-text" title={shownText(item.text)}>
          {label}
        </span>
      ) : (
        <textarea
          className="queued-edit"
          rows={1}
          autoFocus
          value={editing}
          aria-label="Edit queued message"
          onChange={(e) => setEditing(e.target.value)}
          onBlur={() => finish(editing)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              finish(editing);
            } else if (e.key === "Escape") {
              // Only the edit goes: not the turn, nor the panel around it.
              e.preventDefault();
              e.stopPropagation();
              finish(null);
            }
          }}
        />
      )}
      {files.length > 0 && <span className="chip queued-files">{files.length === 1 ? "1 file" : `${files.length} files`}</span>}
      {item.sending ? (
        <span className="small faint queued-actions">Sending…</span>
      ) : (
        <span className="queued-actions">
          <button
            type="button"
            className="link small"
            disabled={filesWait || editing !== null}
            title={
              filesWait
                ? `Files can’t join a turn under way: this goes when ${name}’s done`
                : busy
                  ? `Send to ${name} now, into what it’s doing`
                  : `Send to ${name} now`
            }
            onClick={() => sendNow(to, item.id)}
          >
            Send now
          </button>
          {editing === null && (
            <button type="button" className="icon-btn-sm" aria-label="Edit queued message" onClick={start}>
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <path d="M9.5 2.5l2 2L5 11H3V9z" />
              </svg>
            </button>
          )}
          <button
            type="button"
            className="icon-btn-sm"
            aria-label="Remove queued message"
            // Pressed while editing, the edit's blur mustn't put it back.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              remove(to, item.id);
              if (editing !== null) finish(null);
            }}
          >
            <svg width="11" height="11" viewBox="0 0 14 14" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M3 3l8 8M11 3l-8 8" />
            </svg>
          </button>
        </span>
      )}
    </li>
  );
}

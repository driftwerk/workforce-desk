import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { toShow } from "../chat/conversation";
import { formAnswer } from "../chat/forms";
import { withHistory } from "../chat/legacy";
import { onceEach, shownWith } from "../chat/reconcile";
import { isRunning, useChat } from "../chat/store";
import { splitKey, threadKey, type ThreadSummary } from "../chat/thread";
import { canStartThreads, useRepliesInThreads } from "../chat/threadReplies";
import { agentKey, FEATURES, type Agent, type ChatMessage, type HubAccount } from "../chat/types";
import { draftKey, useDraft } from "../restore/drafts";
import { useStayPut } from "../restore/scroll";
import { SidePanel } from "../panels/Stage";
import { useUi } from "../shell/ui";
import { WorkingRow } from "../chat/WorkingRow";
import { PendingSetups } from "../chat/SetupCard";
import { relayedOf } from "../chat/relayed";
import { DmMessage } from "./Rooms";
import { QueuedMessages } from "./QueuedMessages";
import { repliesText } from "./ThreadBar";
import { dayClock } from "../floor/time";
import { AgentMark, YouMark } from "../ui/Mark";
import { useDesk } from "../hub/store";

// A thread in a DM: a column beside the chat holding the message it is on,
// the replies, and a box to reply in. It is a conversation of its own (own
// history, own queue), so it works while the DM does.

const NO_THREADS: ThreadSummary[] = [];

/** The thread open in the DM Rooms shows, beside it. */
export function useOpenDmThread(): { agent: Agent; hub: HubAccount; parent: string } | null {
  const key = useChat((s) => s.activeAgent);
  const parent = useUi((u) => (key ? (u.dmThreads[key] ?? null) : null));
  const agent = useChat((s) => (key ? s.roster.find((a) => agentKey(a) === key) : undefined));
  const hub = useChat((s) => (agent ? s.hubs.find((h) => h.id === agent.hubId) : undefined));
  return key && parent && agent && hub ? { agent, hub, parent } : null;
}

/** The DM's threads, newest reply first, by parent id. */
export const useDmThreads = (key: string | null): ThreadSummary[] => useChat((s) => (key ? (s.threads[key] ?? NO_THREADS) : NO_THREADS));

/** "N threads working", for the DM's header; null when none is. */
export const threadsWorking = (threads: readonly ThreadSummary[]): string | null => {
  const n = threads.filter((t) => t.working).length;
  return n ? `${n} thread${n === 1 ? "" : "s"} working` : null;
};

/** Opens thread `parent` of agent `agent`'s DM beside the DM in Rooms: from
 *  a grid's pane or the side panel (`inPane`), which have no room for it,
 *  the DM opens there first. */
export const openDmThread = (agent: string, parent: string, inPane = false): void => {
  if (inPane) {
    const chat = useChat.getState();
    if (chat.panelAgent === agent) chat.setPanelAgent(null);
    void useDesk.getState().openRoom(null);
    useUi.getState().setAgentTab(agent, "chat");
    chat.openDm(agent);
  }
  useUi.getState().setDmThread(agent, parent);
};

/** Under a message with replies: how many, when last, and who is working in
 *  it; opens the thread. */
export const ThreadChip = memo(function ThreadChip({
  agent,
  hub,
  name,
  thread,
  inPane,
}: {
  agent: string;
  hub: string;
  name: string;
  thread: ThreadSummary;
  inPane?: boolean;
}) {
  const openNow = useUi((u) => u.dmThreads[agent]);
  return (
    <button
      type="button"
      className="thread-bar thread-chip small"
      aria-current={openNow === thread.parent && !inPane ? "true" : undefined}
      onClick={() => openDmThread(agent, thread.parent, inPane)}
    >
      {thread.authors.length > 0 && (
        <span className="thread-marks">
          {thread.authors.map((a) => (a === "user" ? <YouMark key={a} hub={hub} size="xs" /> : <AgentMark key={a} agent={agent} name={name} size="xs" />))}
        </span>
      )}
      <span className="thread-count">{repliesText(thread.replies, null)}</span>
      {thread.lastAt && (
        <>
          {" "}
          <span className="thread-last">last {dayClock(thread.lastAt)}</span>
        </>
      )}
      {thread.working && (
        <>
          {" "}
          <span className="thread-live thread-answering">· working</span>
        </>
      )}
    </button>
  );
});

/** Under a message that started its own thread: as [`ThreadChip`], from
 *  the moment it's sent, before the hub lists the thread; working while its
 *  turn runs, and said when the message didn't get there. */
export const StartedChip = memo(function StartedChip({
  agent,
  hub,
  name,
  parent,
  thread,
  inPane,
}: {
  agent: string;
  hub: string;
  name: string;
  parent: string;
  thread: ThreadSummary | undefined;
  inPane?: boolean;
}) {
  const key = threadKey(agent, parent);
  const running = useChat((s) => isRunning(s.conversations[key]));
  const lost = useChat((s) => !!s.conversations[key]?.messages.some((m) => m.role === "user" && m.clientId === parent && m.undelivered));
  const openNow = useUi((u) => u.dmThreads[agent]);
  const working = running || !!thread?.working;
  // Answered, and not shown: its connection goes until the thread is.
  const release = useChat((s) => s.release);
  const starting = useChat((s) => !!s.starting[agent]?.some((m) => m.id === parent));
  useEffect(() => {
    if (!running && !starting && openNow !== parent) release(key);
  }, [running, starting, openNow, parent, key, release]);
  if (thread?.replies && !lost)
    return <ThreadChip agent={agent} hub={hub} name={name} inPane={inPane} thread={working ? { ...thread, working: true } : thread} />;
  return (
    <button
      type="button"
      className="thread-bar thread-chip small"
      aria-current={openNow === parent && !inPane ? "true" : undefined}
      onClick={() => openDmThread(agent, parent, inPane)}
    >
      {lost ? (
        <span className="thread-failed">Not sent · open the thread to try again</span>
      ) : working ? (
        <span className="thread-live thread-answering">{name} is replying</span>
      ) : (
        <span className="thread-count">Open thread</span>
      )}
    </button>
  );
});

/** What you type in a thread: its own queue and drafts, and "Also send to the
 *  chat", which copies the reply to the DM. */
function ThreadComposer({ keyOf, name, connected, busy }: { keyOf: string; name: string; connected: boolean; busy: boolean }) {
  const send = useChat((s) => s.send);
  const enqueue = useChat((s) => s.enqueue);
  const cancel = useChat((s) => s.cancel);
  const copyReply = useChat((s) => s.copyReply);
  // Where every new message starts a thread, the chat is a list of them: a
  // copy of a reply there would read as one more.
  const base = splitKey(keyOf).agent;
  const always = useRepliesInThreads(base);
  const features = useChat((s) => s.conversations[base]?.features);
  const threading = always && canStartThreads(features);
  const waiting = useChat((s) => !!s.queues[keyOf]?.items.length && !s.queues[keyOf]!.paused);
  const holding = busy || waiting;
  const [draft, setDraft] = useDraft(draftKey.dm(keyOf));
  const [also, setAlso] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setProblem(null);
    if (holding) enqueue(keyOf, text);
    else if (!send(keyOf, text)) return setProblem(`Couldn’t reach ${name}. Try again in a moment.`);
    setDraft("");
    if (also && !threading) void copyReply(keyOf, text).then((ok) => !ok && setProblem("Your reply is in the thread, but the chat didn’t take a copy."));
  };
  return (
    <form className="composer thread-composer" onSubmit={submit} data-composer="">
      <textarea
        rows={1}
        value={draft}
        placeholder="Reply in thread"
        aria-label={`Reply in thread to ${name}`}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter" && !e.shiftKey) submit(e);
          else if (e.key === "Escape" && holding && !e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            cancel(keyOf);
          }
        }}
      />
      {!threading && (
        <label className="also-in-room small">
          <input type="checkbox" checked={also} onChange={(e) => setAlso(e.target.checked)} /> Also send to the chat
        </label>
      )}
      {holding && (
        <button type="button" className="btn btn-ghost" title={`Stop ${name} (Esc)`} onClick={() => cancel(keyOf)}>
          Stop
        </button>
      )}
      <button type="submit" className="btn btn-signal" disabled={!draft.trim() || (!holding && !connected)}>
        {holding ? "Queue" : "Reply"}
      </button>
      {problem && (
        <p className="composer-note small" role="status">
          {problem}
        </p>
      )}
      <QueuedMessages to={keyOf} name={name} busy={busy} />
    </form>
  );
}

/** A thread of the DM: its first message, the replies, and a reply box. */
export function DmThreadPanel({ agent, hub, parent }: { agent: Agent; hub: HubAccount; parent: string }) {
  const base = agentKey(agent);
  const key = threadKey(base, parent);
  const close = useUi((u) => u.setDmThread);
  const watch = useChat((s) => s.watchDm);
  const loadHistory = useChat((s) => s.loadHistory);
  const release = useChat((s) => s.release);
  useEffect(() => {
    watch(key);
    // Closed, a thread with nothing going on lets its connection go.
    return () => release(key);
  }, [key, watch, release]);
  const convo = useChat((s) => s.conversations[key]);
  const history = useChat((s) => s.histories[key]);
  const chat = useChat((s) => s.histories[base]);
  const chatLive = useChat((s) => s.conversations[base]);
  const summary = useChat((s) => s.threads[base]?.find((t) => t.parent === parent));
  const starting = useChat((s) => s.starting[base]);
  const first = useMemo(
    () =>
      chat?.messages.find((m) => m.id === parent) ??
      chatLive?.messages.find((m) => m.id === parent) ??
      starting?.find((m) => m.id === parent),
    [chat?.messages, chatLive?.messages, starting, parent],
  );
  const read = history?.state === "ready" || history?.state === "absent" || history?.state === "failed";
  const stay = useStayPut(`thread:${key}`, read);
  const last = convo?.messages.at(-1);
  const pending = last?.role === "assistant" && last.status === "streaming" && !last.content ? last : undefined;
  const answering = last?.role === "assistant" && last.status === "streaming" && !!last.content;
  // The message that started the thread is shown once, above: here only
  // while it didn't get there, to send again.
  const liveShown = toShow(pending ? (convo?.messages ?? []).slice(0, -1) : (convo?.messages ?? [])).filter(
    (m) => !(m.role === "user" && m.clientId === parent && !m.undelivered),
  );
  const replies: ChatMessage[] = convo?.features?.has(FEATURES.clientIds)
    ? shownWith(history?.messages ?? [], liveShown)
    : onceEach(withHistory(history?.messages ?? [], liveShown, history?.loadedAt ?? null));
  useLayoutEffect(() => {
    stay.keep();
  });
  const send = useChat((s) => s.send);
  const retry = useChat((s) => s.retry);
  const discard = useChat((s) => s.discard);
  const submitForm = useCallback((summary: string, values: Record<string, unknown>) => send(key, formAnswer(summary, values)), [key, send]);
  const onRetry = useCallback((id: string) => void retry(key, id), [key, retry]);
  const onRemove = useCallback((id: string) => discard(key, id), [key, discard]);
  const sentOn = useMemo<Parameters<typeof relayedOf>[1]>(() => ({ local: hub.local ?? false, crew: [], overseer: null, person: null }), [hub.local]);
  const origin = useMemo(() => ({ hub: agent.hubId, agent: agent.id }), [agent.hubId, agent.id]);
  const count = Math.max(summary?.replies ?? 0, replies.length);
  return (
    <SidePanel
      className="thread-panel"
      label="Thread"
      noun="the thread"
      onClose={() => close(base, null)}
      title={
        <span className="thread-head">
          <span className="thread-head-row">
            <b className="display rpanel-name">Thread</b>
          </span>
        </span>
      }
    >
      <div className="thread-body">
        <div className="timeline">
          <div ref={stay.pane} className="room-scroll dm-scroll">
            <div ref={stay.list} className="dm-list">
              {first && (
                <div className="room-msg thread-first">
                  <DmMessage message={first} author={agent.name} authorKey={base} youOn={agent.hubId} home={hub.label} sentOn={sentOn} origin={origin} onSubmitForm={submitForm} onRetry={onRetry} onRemove={onRemove} />
                </div>
              )}
              <div className="thread-count-rule small">
                <span>{count ? repliesText(count, null) : "No replies yet"}</span>
                {(convo ? isRunning(convo) : summary?.working) && <span className="thread-live thread-answering">· working</span>}
              </div>
              {history?.state === "loading" && replies.length === 0 && (
                <div className="history-note">
                  <span className="faint small">Loading the thread…</span>
                </div>
              )}
              {history?.state === "failed" && (
                <div className="history-note">
                  <span className="faint small">
                    Couldn’t load the thread.{" "}
                    <button type="button" className="link small" onClick={() => void loadHistory(key)}>
                      Try again
                    </button>
                  </span>
                </div>
              )}
              {replies.map((m) => (
                <div key={m.id} className="room-msg">
                  <DmMessage message={m} author={agent.name} authorKey={base} youOn={agent.hubId} home={hub.label} sentOn={sentOn} origin={origin} onSubmitForm={submitForm} onRetry={onRetry} onRemove={onRemove} />
                </div>
              ))}
              {convo?.working && !answering ? (
                <WorkingRow agent={base} name={agent.name} working={convo.working} tools={pending?.tools}>
                  <PendingSetups origin={origin} message={pending} before={replies.findLast((m) => m.role === "user")?.at ?? first?.at} />
                </WorkingRow>
              ) : (
                <PendingSetups origin={origin} message={pending} before={replies.findLast((m) => m.role === "user")?.at ?? first?.at} />
              )}
            </div>
          </div>
        </div>
        <ThreadComposer keyOf={key} name={agent.name} connected={!!convo?.connected} busy={isRunning(convo)} />
      </div>
    </SidePanel>
  );
}

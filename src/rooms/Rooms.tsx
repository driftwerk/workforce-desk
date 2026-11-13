import { toShow } from "../chat/conversation";
import { SetupInDm } from "../setup/slot";
import { formAnswer } from "../chat/forms";
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { useShallow } from "zustand/react/shallow";
import { AttachButton, DropOverlay, PendingFiles, useFileDrop, usePendingFiles } from "../attachments/Compose";
import { uploadAll } from "../attachments/upload";
import { PromptCard } from "../chat/Approvals";
import { AgentAccess } from "../computer/AgentAccess";
import { withHistory } from "../chat/legacy";
import { onceEach, shownWith } from "../chat/reconcile";
import { useCommandMenu, useHubCommands } from "../chat/commands";
import { isRunning, useChat } from "../chat/store";
import { useDesk, localSessions } from "../hub/store";
import { DM_TYPING_EVERY_MS, typingPinger } from "../line/typing";
import { RoomView } from "./RoomView";
import { Unread as UnreadPage } from "../unread/Unread";
import { agentKey, describeAgent, DESK_DM, FEATURES } from "../chat/types";
import { useAgentBrain } from "../crew/agentBrain";
import { AgentConnectors } from "../crew/AgentConnectors";
import { AgentFiles, discardDrafts, saveDraft } from "../crew/AgentFiles";
import { AgentSettings } from "../crew/AgentSettings";
import { brainLine } from "../crew/brain";
import { dirtyFiles, useDrafts } from "../crew/files";
import { useProviders } from "../providers/store";
import { CloseButton, Dialog } from "../ui/Dialog";
import { AgentMark } from "../ui/Mark";
import { WorkingRow } from "../chat/WorkingRow";
import { EmojiButton } from "../emoji/EmojiButton";
import { useEmojiInput } from "../emoji/useEmojiInput";
import { Message } from "./Message";
import { QueuedMessages } from "./QueuedMessages";
import { relayedOf } from "../chat/relayed";
import { memoriesFrom, type SavedMemory } from "../chat/remove";
import { termsOf } from "../chat/search";
import { SearchBar, SearchResults, useDmSearch, useSearchMarks } from "./DmSearch";
import { ThreadChip, threadsWorking, useDmThreads } from "./DmThread";
import { useOverview } from "../overview/store";
import { useUi, type AgentTab } from "../shell/ui";
import { draftKey, useDraft } from "../restore/drafts";
import { useStayPut } from "../restore/scroll";
import { useReads } from "../unread/reads";
import type { Agent, ChatMessage, HubAccount } from "../chat/types";
import type { Step } from "../hub/types";
import { GroupChip } from "../groups/GroupChip";
import { agentItem } from "../groups/model";
import type { OversightLevel } from "../hub/types";
import { useFocusRequest } from "../shell/focus";
import { useOutOfSight } from "../panels/Stage";
import { useOnScreen } from "../unread/seen";
import { useUnread } from "../unread/summary";
import { DmVoiceBar, DmVoiceControls, useDmVoiceEntries } from "../voice/DmVoice";
import { ComposerMore } from "./ComposerMore";
import { useDmPresence } from "../voice/dms";
import { after } from "./time";
import type { ReadPoint } from "../hub/types";

const LEVEL: Record<OversightLevel, string> = { watch: "Watch", suggest: "Suggest", act: "Act", full: "Act fully" };

/** Who said a message and what, as one key. */
const saidKey = (m: ChatMessage): string => `${m.role}\u0000${m.content.trim()}`;

/** A message's time in ms; 0 when it has none. */
const ms = (iso: string): number => Date.parse(iso) || 0;

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Overseeing 3 crew and 4 sessions · Suggest" */
const overseeingLine = (roster: Agent[], manager: Agent, tracked: number, level: OversightLevel): string => {
  const crew = roster.filter((a) => a.hubId === manager.hubId && a.id !== manager.id).length;
  return `Overseeing ${crew} crew and ${count(tracked, "session", "sessions")} · ${LEVEL[level]}`;
};

export function Rooms() {
  const activeRoom = useDesk((s) => s.activeRoom);
  const room = useDesk((s) => (s.activeRoom ? s.rooms[s.activeRoom] : undefined));
  const loaded = useDesk((s) => s.loaded);
  const activeAgent = useChat((s) => s.activeAgent);
  const inbox = useDesk((s) => s.inbox);
  if (inbox) return <UnreadPage />;
  // Each keyed by what it shows, so nothing typed or picked for one shows in another.
  if (room) return <RoomView key={room.id} room={room} />;
  // A room put back on launch shows once the hub says what rooms it has.
  if (activeRoom && !loaded) return <Waiting />;
  return <DirectMessage key={activeAgent ?? ""} />;
}

/** In place of a room or DM that's open but not loaded yet: not the empty
 *  Rooms, which would read as everything having closed. */
function Waiting() {
  return <main className="room room-empty" aria-label="Rooms" aria-busy="true" />;
}

type Tab = AgentTab;

const TABS: { id: Tab; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "settings", label: "Settings" },
  { id: "access", label: "This computer" },
  { id: "connectors", label: "Connectors" },
  { id: "files", label: "Files" },
];

/** A DM: the one Rooms shows, or with `agent`, that agent's in a grid pane
 *  or the side panel — the conversation alone, under its own header. */
export function DirectMessage({ agent: inPane }: { agent?: string } = {}) {
  // Only what this conversation shows: the rest of the chat store changing
  // (another conversation streaming, someone's picture) leaves it be.
  const shownInRooms = useChat((s) => s.activeAgent);
  const activeAgent = inPane ?? shownInRooms;
  const roster = useChat((s) => s.roster);
  const hubs = useChat((s) => s.hubs);
  const agent = roster.find((a) => agentKey(a) === activeAgent);
  const person = useChat((s) => (agent ? (s.me[agent.hubId]?.name ?? null) : null));
  const convo = useChat((s) => (activeAgent ? s.conversations[activeAgent] : undefined));
  const history = useChat((s) => (activeAgent ? s.histories[activeAgent] : undefined));
  const openedThread = useUi((u) => (activeAgent ? u.dmThreads[activeAgent] : undefined));
  const { send, loadHistory, loadEarlier, watchDm, answerPrompt } = useChat(
    useShallow((s) => ({
      send: s.send,
      loadHistory: s.loadHistory,
      loadEarlier: s.loadEarlier,
      watchDm: s.watchDm,
      answerPrompt: s.answerPrompt,
    })),
  );
  const hub = hubs.find((h) => h.id === agent?.hubId);
  const local = hub?.local ?? false;
  const desk = useDesk((s) => s.hub);
  const drafts = useDrafts((s) => s.drafts);
  const { brain, provider } = useAgentBrain(agent, local);
  const fallback = useProviders((s) => s.fallback);
  const manager = useOverview((s) => s.manager);
  // The sessions overseen, counted: what each is doing isn't shown here.
  const trackedOverview = useOverview((s) => (s.overview ? s.overview.items.filter((i) => i.kind === "session").length : null));
  const trackedSessions = useDesk((s) => Object.values(localSessions(s.sessions)).filter((x) => x.state !== "closed").length);
  // Each agent's tab, kept while you visit others (and across launches).
  const tabs = useUi((u) => u.agentTabs);
  const setAgentTab = useUi((u) => u.setAgentTab);
  const rosterRead = useChat((s) => s.rosterRead);
  const rosterErrors = useChat((s) => s.rosterErrors);
  const [leaving, setLeaving] = useState<Tab | null>(null);
  const files = usePendingFiles();
  const drop = useFileDrop(files.add, files.setProblem);
  // Held here, not in the composer, so a message still uploading while
  // another tab is open is still sending when you come back.
  const sending = useState(false);
  const root = useRef<HTMLElement | null>(null);
  // Where "talk here" finds this DM, and lets its microphone go when it goes.
  useDmPresence(agent ? (activeAgent ?? null) : null, root);
  const scroller = useRef<HTMLDivElement | null>(null);
  const settled = !history || history.state === "ready" || history.state === "absent";
  const read = history?.state === "ready" || history?.state === "absent" || history?.state === "failed";
  // Where you're reading stays put; at the newest message, it follows.
  const stay = useStayPut(activeAgent ? `dm:${activeAgent}` : null, read);
  // How far the DM was read when it opened, once that's known (null: not
  // at all), and the message its New line goes before once the
  // conversation is read (null: none).
  const readsLoaded = useReads((s) => s.loaded);
  const readAtOpen = useRef<ReadPoint | null | undefined>(undefined);
  if (readAtOpen.current === undefined && readsLoaded && activeAgent) readAtOpen.current = useReads.getState().dms[activeAgent] ?? null;
  const newLine = useRef<string | null | undefined>(undefined);
  const openedAtLine = useRef(false);
  // The newest message's time when you last were at the end: Jump to
  // latest counts what the agent said after it.
  const leftAt = useRef(0);
  // What an edit set aside, hidden at once; your latest message being
  // edited, and why it can't be when it can't.
  const aside = useChat((s) => (activeAgent ? s.setAside[activeAgent] : undefined));
  const queuedCount = useChat((s) => (activeAgent ? (s.queues[activeAgent]?.items.length ?? 0) : 0));
  const editLast = useChat((s) => s.editLast);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [editNote, setEditNote] = useState<string | null>(null);
  // Your message whose Delete is being confirmed, in place; the answers to
  // ones you deleted, until the hub says so itself.
  const [deleting, setDeleting] = useState<string | null>(null);
  const orphans = useChat((s) => (activeAgent ? s.orphans[activeAgent] : undefined));
  useEffect(() => {
    if (!editNote) return;
    const t = setTimeout(() => setEditNote(null), NOTE_MS);
    return () => clearTimeout(t);
  }, [editNote]);
  const seenThen = useRef<Set<string>>(new Set());
  // ⌘F: the search, the stretch of the chat shown around a match not
  // loaded, and the match to show once it's rendered.
  const [searching, setSearching] = useState(false);
  // The threads on this DM's messages, and the one open beside it.
  const threads = useDmThreads(activeAgent ?? null);
  const openThread = useUi((u) => u.setDmThread);
  const search = useDmSearch(hub, agent?.id ?? "");
  const around = useChat((s) => (activeAgent ? s.around[activeAgent] : undefined));
  const showAround = useChat((s) => s.showAround);
  const leaveAround = useChat((s) => s.leaveAround);
  const toShowAt = useRef<string | null>(null);
  const [paneEl, setPaneEl] = useState<HTMLDivElement | null>(null);
  const scrollerRef = useCallback(
    (el: HTMLDivElement | null) => {
      scroller.current = el;
      setPaneEl(el);
      stay.pane(el);
    },
    [stay.pane],
  );
  const chosen = search.current >= 0 ? (search.matches[search.current]?.id ?? null) : null;
  useSearchMarks(paneEl, searching ? termsOf(search.q) : [], chosen, `${history?.messages.length}:${convo?.messages.length}:${around?.around}`);
  /** The newest message, leaving a stretch shown around a match. */
  const latest = useCallback(() => {
    if (activeAgent) leaveAround(activeAgent);
    stay.toLatest();
  }, [activeAgent, leaveAround, stay.toLatest]);
  const tab: Tab = inPane ? "chat" : (activeAgent && tabs[activeAgent]) || "chat";
  // The conversation is read while it's on screen, wherever this shows:
  // through the newest of the hub's copies of what the agent said, or the
  // newest its hub counts unread, whichever is later.
  const outOfSight = useOutOfSight();
  const counted = useUnread((s) => (activeAgent ? s.dms[activeAgent]?.last : undefined));
  const newest = useMemo(() => {
    const said = (history?.messages ?? []).findLast((m) => m.role !== "user");
    const mine = said ? { at: said.at, message: said.id } : null;
    if (!counted) return mine;
    return mine && !after({ createdAt: counted.at }, mine.at) ? mine : { at: counted.at, message: counted.message_id };
  }, [history?.messages, counted]);
  useOnScreen(agent ? { kind: "dm", hub: agent.hubId, agent: agent.id } : null, scroller, newest, {
    enabled: tab === "chat" && !outOfSight,
  });
  const known = roster.some((a) => agentKey(a) === inPane);
  useEffect(() => {
    if (inPane && known) watchDm(inPane);
  }, [inPane, known, watchDm]);

  // Every render may change what's shown: kept where it was, or at the end.
  // A DM opened with something unread opens at its New line.
  useLayoutEffect(() => {
    const match = toShowAt.current;
    if (match && paneEl?.querySelector(`[data-message-id="${CSS.escape(match)}"]`)) {
      toShowAt.current = null;
      stay.showAt(match, Math.round((paneEl.clientHeight ?? 0) / 3));
    } else if (typeof newLine.current === "string" && !openedAtLine.current) {
      openedAtLine.current = true;
      stay.showAt(newLine.current);
    } else stay.keep();
  });

  const earlier = useCallback(() => {
    if (!activeAgent || !history?.more || history.earlier === "loading") return;
    void loadEarlier(activeAgent);
  }, [activeAgent, history?.more, history?.earlier, loadEarlier]);

  const submitForm = useCallback(
    (summary: string, values: Record<string, unknown>) =>
      !!activeAgent && send(activeAgent, formAnswer(summary, values)),
    [activeAgent, send],
  );
  const retrySend = useChat((s) => s.retry);
  const discardSend = useChat((s) => s.discard);
  const retry = useCallback((id: string) => void (activeAgent && retrySend(activeAgent, id)), [activeAgent, retrySend]);
  const discard = useCallback((id: string) => activeAgent && discardSend(activeAgent, id), [activeAgent, discardSend]);

  // What every message is shown with, kept the same while it is, so a
  // message renders again only when it changes.
  const hubId = agent?.hubId ?? null;
  const agentId = agent?.id ?? null;
  const origin = useMemo(() => (hubId && agentId ? { hub: hubId, agent: agentId } : undefined), [hubId, agentId]);
  // Who sent a message on is the hub's to say; where it doesn't, its
  // wording tells, on this computer, where the overseer is (under the name it
  // had then).
  const overseerId = local ? (manager?.agentId ?? null) : null;
  const sentOn = useMemo(() => {
    const crew = local ? roster.filter((a) => a.hubId === hubId).flatMap((a) => [a.name, a.id]) : [];
    const overseer = overseerId ? (roster.find((a) => a.hubId === hubId && a.id === overseerId)?.name ?? null) : null;
    return { local, crew, overseer, person };
  }, [local, roster, hubId, overseerId, person]);

  if (inPane && (!agent || !convo)) {
    return (
      <div className="pane-note">
        <p className="muted small">{agent ? "Connecting…" : "This agent isn’t on any hub Desk is paired with right now."}</p>
      </div>
    );
  }
  if (!agent || !activeAgent || !convo) {
    // The DM put back on launch, until its hub's roster is read.
    const hubId = activeAgent?.split("/")[0] ?? "";
    if (activeAgent && (!rosterRead || hubId in rosterErrors || (agent && !convo))) return <Waiting />;
    return (
      <main className="room room-empty" aria-label="Rooms">
        <h1 className="display-lg">Rooms</h1>
        <p className="muted">
          Pick a room, or someone from Crew to talk to them directly. Local agents and agents on every paired hub are listed
          there.
        </p>
      </main>
    );
  }

  const unsaved = dirtyFiles(drafts, activeAgent);
  const go = (next: Tab) => setAgentTab(activeAgent, next);
  const choose = (next: Tab) => (tab === "files" && next !== "files" && unsaved.length > 0 ? setLeaving(next) : go(next));
  const shownTabs = local ? TABS : TABS.filter((t) => t.id !== "files" && t.id !== "access" && t.id !== "connectors");
  // What the hub reports stands in until the providers list says more.
  const brainSubtitle =
    local && brain && provider && !fallback
      ? [hub?.label ?? "This computer", brainLine(brain, provider)].join(" · ")
      : describeAgent(agent, hub?.label ?? agent.hubId);
  const overseeing = local && manager?.agentId === agent.id && manager.level ? manager.level : null;
  const subtitle =
    overseeing && tab === "chat" ? overseeingLine(roster, agent, trackedOverview ?? trackedSessions, overseeing) : brainSubtitle;
  const Root = inPane ? "div" : "main";
  // Working, or a streamed turn not yet said to have ended (for a grace).
  const busy = isRunning(convo);
  const last = convo.messages.at(-1);
  // Until any answer text arrives, the reply is the working row (with the
  // tools it has run), not an empty message.
  const pending = last?.role === "assistant" && last.status === "streaming" && !last.content ? last : undefined;
  const answering = last?.role === "assistant" && last.status === "streaming" && !!last.content;
  const liveShown = toShow(pending ? convo.messages.slice(0, -1) : convo.messages);
  // A hub with client ids says which kept row each live message became;
  // an older hub's are matched by words and times.
  const all = around
    ? around.messages
    : convo.features?.has(FEATURES.clientIds)
    ? shownWith(history?.messages ?? [], liveShown)
    : onceEach(withHistory(history?.messages ?? [], liveShown, history?.loadedAt ?? null));
  const asideSet = new Set(aside ?? []);
  const shown = aside?.length ? all.filter((m) => !asideSet.has(m.id) && !(m.clientId && asideSet.has(m.clientId))) : all;
  // Your latest message, what ↑ and Edit replace: one you typed, not one
  // the overseer sent on, a command, or one that never got there.
  const mineAt = shown.findLastIndex((m) => m.role === "user" && !m.undelivered && !m.command && !relayedOf(m, sentOn));
  const mine = mineAt >= 0 ? shown[mineAt] : undefined;
  // Around a search match, the chat is a stretch of its past: nothing is
  // edited or deleted from there. And only where the hub says which kept
  // row each live message became: what's set aside is then known by id.
  const editable = !around && !!convo.features?.has(FEATURES.edit) && !!convo.features?.has(FEATURES.clientIds);
  const whyNot = !mine
    ? null
    : busy
      ? `You can edit your last message once ${agent.name} has finished replying.`
      : queuedCount > 0
        ? "You can edit your last message once your queued messages have gone."
        : !(history?.messages ?? []).some((k) => k.id === mine.id)
          ? `You can edit your last message once ${agent.name}’s hub has saved it.`
          : mine.attachments?.length
            ? "A message with files can’t be edited. Send a new one instead."
            : null;
  const deletable = !around && !!convo.features?.has(FEATURES.delete);
  const threadable = !around && !!convo.features?.has(FEATURES.dmThreads);
  const threadsOf = new Map(threads.map((t) => [t.parent, t]));
  const yours = (m: ChatMessage) =>
    m.role === "user" && (!m.author || m.author.kind === "you") && !m.undelivered && !m.command && !relayedOf(m, sentOn);
  const keptIds = new Set((history?.messages ?? []).map((k) => k.id));
  const startDelete = (m: ChatMessage) => {
    // Its turn may still be reading it; and the hub knows it only once kept.
    if (busy) return setEditNote(`You can delete a message once ${agent.name} has finished replying.`);
    if (!keptIds.has(m.id)) return setEditNote(`You can delete it once ${agent.name}’s hub has saved it.`);
    setEditing(null);
    setDeleting(m.id);
  };
  const orphanSet = new Set(orphans ?? []);
  /** Shows match `i` in place: at once when it's shown, else once the
   *  stretch around it is read. */
  const pick = (i: number) => {
    const m = search.matches[i];
    if (!m) return;
    search.setCurrent(i);
    toShowAt.current = m.id;
    if (shown.some((x) => x.id === m.id)) return stay.keep();
    showAround(activeAgent, m.id).catch((e: unknown) => {
      if (toShowAt.current === m.id) toShowAt.current = null;
      setEditNote(e instanceof Error ? e.message : String(e));
    });
  };
  const step = (by: 1 | -1) => {
    const n = search.matches.length;
    if (!n) return;
    pick(Math.min(n - 1, Math.max(0, search.current + by)));
  };
  const closeSearch = () => {
    toShowAt.current = null;
    setSearching(false);
    search.setQ("");
  };
  const startEdit = () => {
    if (!mine || !editable) return;
    if (whyNot) return setEditNote(whyNot);
    setDeleting(null);
    const after = shown.slice(mineAt);
    setEditing({
      id: mine.id,
      text: mine.content,
      aside: after.flatMap((m) => (m.clientId ? [m.id, m.clientId] : [m.id])),
      did: after.slice(1).flatMap((m) => m.steps ?? []),
    });
  };
  if (newLine.current === undefined && read && readAtOpen.current !== undefined) {
    const r = readAtOpen.current;
    newLine.current = r ? (shown.find((m) => m.role === "assistant" && ms(m.at) > ms(r.at))?.id ?? null) : null;
  }
  if (!stay.away) {
    leftAt.current = shown.reduce((t, m) => Math.max(t, ms(m.at)), 0);
    // By id and by what it says: a kept copy that takes a live message's
    // place (another id, the hub's time) isn't new.
    seenThen.current = new Set(shown.flatMap((m) => [m.id, saidKey(m)]));
  }
  // Only what the agent said counts: not what you sent, nor your queue
  // going as a message.
  const arrived = stay.away ? shown.filter((m) => m.role === "assistant" && !seenThen.current.has(m.id) && !seenThen.current.has(saidKey(m)) && ms(m.at) >= leftAt.current).length : 0;

  const chat = tab !== "settings" && !((tab === "files" || tab === "access" || tab === "connectors") && local);
  return (
    <Root
      ref={(el: HTMLElement | null) => {
        root.current = el;
      }}
      className={`${inPane ? "room room-in-pane" : "room"} drop-target`}
      aria-label={`Conversation with ${agent.name}`}
      {...(chat ? drop.handlers : {})}
      onKeyDown={(e) => {
        if (searching && e.key === "Escape" && !e.defaultPrevented) {
          e.preventDefault();
          closeSearch();
          return;
        }
        // ⌘F searches the chat's whole history, on a hub that can.
        if (tab === "chat" && (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "f" && convo.features?.has(FEATURES.search)) {
          e.preventDefault();
          setSearching(true);
          return;
        }
        // End goes to the newest message: not from a field (where it moves
        // the caret), but from the composer when nothing's typed in it.
        if (tab !== "chat" || e.key !== "End" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
        const t = e.target;
        const field = t instanceof Element && t.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
        if (field && !(t instanceof HTMLTextAreaElement && t.closest("[data-composer]") && t.value === "")) return;
        e.preventDefault();
        latest();
      }}
    >
      {!inPane && (
        <header className="room-head">
          <AgentMark agent={agentKey(agent)} name={agent.name} size="lg" />
          <span className="room-title">
            <span className="room-title-name">
              <h1 className="display-lg">{agent.name}</h1>
              <GroupChip item={agentItem(agent)} />
            </span>
            <span className="faint small">
              {subtitle}
              {threadsWorking(threads) ? ` · ${threadsWorking(threads)}` : ""}
              {convo.connected ? "" : " · reconnecting…"}
            </span>
          </span>
          <div className="tabs agent-tabs" role="tablist" aria-label={agent.name}>
            {shownTabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`agent-tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls="agent-tab-panel"
                onClick={() => choose(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </header>
      )}
      {tab === "settings" ? (
        <div className="agent-panel" role="tabpanel" id="agent-tab-panel" aria-labelledby="agent-tab-settings">
          <AgentSettings agent={agent} hub={hub} onOpenFiles={() => go("files")} />
        </div>
      ) : tab === "access" && local ? (
        <div className="agent-panel" role="tabpanel" id="agent-tab-panel" aria-labelledby="agent-tab-access">
          <AgentAccess agent={agent} />
        </div>
      ) : tab === "connectors" && local ? (
        <div className="agent-panel" role="tabpanel" id="agent-tab-panel" aria-labelledby="agent-tab-connectors">
          <AgentConnectors agent={agent} />
        </div>
      ) : tab === "files" && local ? (
        <div className="agent-panel" role="tabpanel" id="agent-tab-panel" aria-labelledby="agent-tab-files">
          <AgentFiles agent={agent} />
        </div>
      ) : (
        <>
          {searching && <SearchBar s={search} name={agent.name} onStep={step} onClose={closeSearch} />}
          <div className={searching ? "dm-body dm-body-searching" : "dm-body"}>
          <div className="timeline">
            <div
              ref={scrollerRef}
              className="room-scroll dm-scroll"
              role={inPane ? undefined : "tabpanel"}
              id={inPane ? undefined : "agent-tab-panel"}
              aria-labelledby={inPane ? undefined : "agent-tab-chat"}
              onScroll={(e) => {
                if (e.currentTarget.scrollTop < 80 && history?.earlier === "idle") earlier();
              }}
            >
              <div ref={stay.list} className="dm-list">
                {history?.more && (
                  <div className="history-note">
                    {history.earlier === "failed" ? (
                      <span className="faint small">
                        Couldn’t load earlier messages.{" "}
                        <button type="button" className="link small" onClick={earlier}>
                          Try again
                        </button>
                      </span>
                    ) : (
                      <button type="button" className="link small" disabled={history.earlier === "loading"} onClick={earlier}>
                        {history.earlier === "loading" ? "Loading earlier messages…" : "Load earlier messages"}
                      </button>
                    )}
                  </div>
                )}
                {history?.state === "failed" && (
                  <div className="history-note">
                    <span className="faint small">
                      Couldn’t load your earlier conversation.{" "}
                      <button type="button" className="link small" onClick={() => void loadHistory(activeAgent)}>
                        Try again
                      </button>
                    </span>
                  </div>
                )}
                {history?.state === "loading" && shown.length === 0 && (
                  <div className="history-note">
                    <span className="faint small">Loading your conversation…</span>
                  </div>
                )}
                {settled && shown.length === 0 && !convo.working && (
                  <div className="history-note">
                    <span className="faint small">This is the start of your conversation with {agent.name}.</span>
                  </div>
                )}
                {shown.map((m) => (
                  <Fragment key={m.id}>
                    {m.id === newLine.current && (
                      <div className="new-divider" role="separator" aria-label="New messages">
                        <span>New</span>
                      </div>
                    )}
                    <div className={`room-msg${editing && editing.id !== m.id && editing.aside.includes(m.id) ? " msg-dim" : ""}${openedThread === m.id ? " thread-open" : ""}`}>
                      <DmMessage
                        message={m}
                        author={agent.name}
                        authorKey={agentKey(agent)}
                        youOn={agent.hubId}
                        home={hub?.label}
                        sentOn={sentOn}
                        origin={origin}
                        onSubmitForm={submitForm}
                        onRetry={retry}
                        onRemove={discard}
                        orphan={!!m.answeredDeleted || orphanSet.has(m.id)}
                      />
                      {!editing && deleting !== m.id && threadsOf.has(m.id) && (
                        <ThreadChip agent={activeAgent} hub={agent.hubId} name={agent.name} thread={threadsOf.get(m.id)!} />
                      )}
                      {!editing && deleting !== m.id && ((editable && m === mine) || (deletable && yours(m)) || (threadable && keptIds.has(m.id) && !m.command)) && (
                        <span className="msg-actions" role="toolbar" aria-label="Message actions">
                          {threadable && keptIds.has(m.id) && !m.command && (
                            <button type="button" className="msg-action" title="Reply in thread" onClick={() => openThread(activeAgent, m.id)}>
                              Reply in thread
                            </button>
                          )}
                          {editable && m === mine && (
                            <button type="button" className="msg-action" title={whyNot ?? "Edit (↑)"} onClick={startEdit}>
                              Edit
                            </button>
                          )}
                          {deletable && yours(m) && (
                            <button type="button" className="msg-action msg-action-danger" onClick={() => startDelete(m)}>
                              Delete
                            </button>
                          )}
                        </span>
                      )}
                      {deleting === m.id && hub && (
                        <DeleteConfirm
                          hub={hub}
                          agentKey={activeAgent}
                          agentId={agent.id}
                          name={agent.name}
                          message={m}
                          replies={repliesTo(shown, m)}
                          onClose={() => setDeleting(null)}
                        />
                      )}
                    </div>
                  </Fragment>
                ))}
                {/* Desk's own agent says the setup in its DM while it's open. */}
                <SetupInDm agent={agent} />
                {convo.prompts.map((p) => (
                  <PromptCard
                    key={p.requestId}
                    prompt={p}
                    agent={activeAgent}
                    onAnswer={(choice) => answerPrompt(activeAgent, p.requestId, choice)}
                  />
                ))}
                {convo.working && !answering && (
                  <WorkingRow agent={agentKey(agent)} name={agent.name} working={convo.working} tools={pending?.tools} />
                )}
              </div>
            </div>
            {around && (
              <div className="history-note timeline-older" role="status">
                <span className="faint small">Viewing older messages · </span>
                <button type="button" className="link small" onClick={latest}>
                  Jump to latest
                </button>
              </div>
            )}
            {(stay.away || around) && (
              <button type="button" className="jump-pill" title="Jump to latest (End)" aria-live="polite" onClick={latest}>
                <span aria-hidden="true">↓</span> Jump to latest
                {arrived > 0 && <small className="jump-pill-count">{arrived} new</small>}
              </button>
            )}
          </div>
          {searching && <SearchResults s={search} name={agent.name} onPick={pick} />}
          </div>
          {editNote && (
            <p className="composer-note small" role="status">
              {editNote}
            </p>
          )}
          {editing ? (
            <EditLast
              name={agent.name}
              editing={editing}
              onCancel={() => setEditing(null)}
              onSave={(text) => {
                const why = editLast(activeAgent, editing.id, editing.aside, text);
                if (why)
                  return setEditNote(
                    why === "busy"
                      ? `You can edit your last message once ${agent.name} has finished replying.`
                      : why === "queued"
                        ? "You can edit your last message once your queued messages have gone."
                        : `Couldn’t reach ${agent.name}. Try again in a moment.`,
                  );
                setEditing(null);
                latest();
              }}
            />
          ) : (
          <DmComposer
            onEditLast={startEdit}
            onEditBack={(why, restored) =>
              setEditNote(`${agent.name}’s hub didn’t take your edit${why ? ` (${why})` : ""}.${restored ? " Your words are back in the box." : ""}`)
            }
            to={activeAgent}
            agent={agent}
            hub={hub}
            busy={busy}
            connected={convo.connected}
            overseeing={!!overseeing}
            boss={local && (manager?.agentId === agent.id || !!manager?.bosses?.some((b) => b.agentId === agent.id))}
            inPane={!!inPane}
            files={files}
            sending={sending}
            onSent={latest}
            away={stay.away}
          />
          )}
          {drop.dragging && <DropOverlay to={agent.name} />}
        </>
      )}
      {leaving && (
        <LeaveFiles
          files={unsaved}
          onKeep={() => setLeaving(null)}
          onDiscard={() => {
            discardDrafts(agent);
            go(leaving);
            setLeaving(null);
          }}
          onSave={async () => {
            if (!desk) return;
            for (const f of unsaved) await saveDraft(desk, agent, f);
            go(leaving);
            setLeaving(null);
          }}
        />
      )}
    </Root>
  );
}

/** A message in a DM, rendered again only when it, or how it's shown,
 *  changes: not while you type, nor as another message streams in. */
export const DmMessage = memo(function DmMessage({
  message,
  sentOn,
  orphan,
  ...shown
}: Omit<ComponentProps<typeof Message>, "relayed" | "chips"> & {
  message: ChatMessage;
  sentOn: Parameters<typeof relayedOf>[1];
  /** It answered a message you deleted since. */
  orphan?: boolean;
}) {
  const relayed = useMemo(() => relayedOf(message, sentOn), [message, sentOn]);
  const chips = useMemo(() => (orphan ? <span className="faint small msg-note msg-orphan">Answered a deleted message</span> : undefined), [orphan]);
  return <Message message={message} relayed={relayed} steps={message.steps} chips={chips} {...shown} />;
});

/** The answers to your message `m` in `shown`: those its turn said, by its
 *  client id, else what follows it until your next message. */
const repliesTo = (shown: readonly ChatMessage[], m: ChatMessage): string[] => {
  const said = m.clientId ? shown.filter((x) => x.role === "assistant" && x.replyTo === m.clientId) : [];
  if (said.length) return said.map((x) => x.id);
  // Not said: what the agent said after it, until your next message, that
  // answers nothing else. The hub's next read says for sure.
  const from = shown.indexOf(m) + 1;
  const next = shown.findIndex((x, i) => i >= from && x.role === "user");
  return shown
    .slice(from, next < 0 ? undefined : next)
    .filter((x) => x.role === "assistant" && !x.replyTo)
    .map((x) => x.id);
};

/** Deleting your message, confirmed in place: what the agent saved from it,
 *  to forget too (ticked), and Delete. */
function DeleteConfirm({
  hub,
  agentKey: key,
  agentId,
  name,
  message,
  replies,
  onClose,
}: {
  hub: HubAccount;
  agentKey: string;
  agentId: string;
  name: string;
  message: ChatMessage;
  replies: string[];
  onClose: () => void;
}) {
  const deleteMine = useChat((s) => s.deleteMine);
  const [memories, setMemories] = useState<SavedMemory[] | null>(null);
  const [unchecked, setUnchecked] = useState(false);
  const [forget, setForget] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    memoriesFrom(hub, agentId, message.id).then(
      (m) => live && setMemories(m),
      // Not known: nothing to offer forgetting, said so, and the message
      // may still go.
      () => {
        if (!live) return;
        setMemories([]);
        setUnchecked(true);
      },
    );
    return () => {
      live = false;
    };
  }, [hub, agentId, message.id]);
  const remove = () => {
    setBusy(true);
    setProblem(null);
    const ids = message.clientId ? [message.id, message.clientId] : [message.id];
    deleteMine(key, message.id, ids, replies, forget && memories ? memories.map((m) => m.id) : []).then(onClose, (e: unknown) => {
      setProblem(e instanceof Error ? e.message : String(e));
      setBusy(false);
    });
  };
  const n = memories?.length ?? 0;
  return (
    <div
      className="msg-confirm"
      role="group"
      aria-label="Delete this message?"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || busy) return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <div>
        <b>Delete this message?</b> <span className="faint small">It leaves this chat and everything {name} sees from now on.</span>
      </div>
      {memories === null ? (
        <span className="faint small">Checking what {name} saved from it…</span>
      ) : (
        n > 0 && (
          <label className="msg-confirm-forget">
            <input type="checkbox" checked={forget} onChange={(e) => setForget(e.target.checked)} />
            <span>
              Also forget what {name} saved from it. {name} saved {n === 1 ? "1 memory" : `${n} memories`} from this message:{" "}
              {memories.map((m, i) => (
                <Fragment key={m.id}>
                  {i > 0 && "; "}
                  <i>“{m.text}”</i>
                </Fragment>
              ))}
              .
            </span>
          </label>
        )
      )}
      {unchecked && (
        <span className="faint small">
          Couldn’t check what {name} saved from it, so nothing {name} saved will be forgotten.
        </span>
      )}
      {problem && <span className="small state-blocked">{problem}</span>}
      <div className="msg-confirm-row">
        <button type="button" className="btn btn-ghost" autoFocus onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-danger" disabled={busy || memories === null} onClick={remove}>
          {busy ? "Deleting…" : "Delete"}
        </button>
      </div>
    </div>
  );
}

/** How long a note on why you can't edit stays. */
const NOTE_MS = 6000;

/** Your latest sent message, being edited: its kept id and text, what
 *  saving sets aside (it and what followed, by id and client id), and what
 *  the reply being set aside did. */
interface Editing {
  id: string;
  text: string;
  aside: string[];
  did: Step[];
}

/** The composer while you edit your latest message: the new version, what
 *  the reply to the old one already did, and Save and ask again. */
function EditLast({ name, editing, onCancel, onSave }: { name: string; editing: Editing; onCancel: () => void; onSave: (text: string) => void }) {
  const [text, setText] = useState(editing.text);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const save = () => {
    if (!text.trim()) return;
    if (text.trim() === editing.text.trim()) return onCancel();
    onSave(text);
  };
  const n = editing.did.length;
  return (
    <form
      className="composer composer-edit"
      data-composer=""
      aria-label="Editing your last message"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <span className="composer-edit-label">Editing your last message</span>
      <textarea
        ref={box}
        rows={1}
        value={text}
        aria-label="Your last message"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      {n > 0 && (
        <div className="composer-edit-did" role="note">
          <b>
            {name}’s reply to it already did {n === 1 ? "1 thing" : `${n} things`}:
          </b>
          <ul>
            {editing.did.map((d, i) => (
              <li key={i}>
                <span className="mono">{d.tool}</span>
                {d.ok ? "" : " (failed)"}
              </li>
            ))}
          </ul>
          <span>
            Editing won’t undo {n === 1 ? "it" : "them"}. {name} answers the new version knowing {n === 1 ? "it" : "they"} happened, so it
            can put {n === 1 ? "it" : "them"} right itself.
          </span>
        </div>
      )}
      <div className="composer-edit-row">
        <span className="composer-hint">
          <kbd>Esc</kbd> cancel
        </span>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-signal" disabled={!text.trim()}>
          Save and ask again
        </button>
      </div>
    </form>
  );
}

/** Files dropped anywhere on the conversation go with its next message. */
type Files = ReturnType<typeof usePendingFiles>;

/** What you type to an agent: on its own, so a keystroke renders the box
 *  and not the conversation above it. */
function DmComposer({
  to,
  agent,
  hub,
  busy,
  connected,
  overseeing,
  boss,
  inPane,
  files,
  sending: [sending, setSending],
  onSent,
  away,
  onEditLast,
  onEditBack,
}: {
  /** The agent's key. */
  to: string;
  agent: Agent;
  hub: HubAccount | undefined;
  busy: boolean;
  connected: boolean;
  overseeing: boolean;
  /** A boss on this computer (the main one or a group's): its posts wait
   *  while you type to it. */
  boss: boolean;
  /** In a grid's pane: its placeholder is short, as a room's is there. */
  inPane: boolean;
  files: Files;
  sending: [boolean, (sending: boolean) => void];
  /** Something you sent went: the chat goes to it. Not a queued one. */
  onSent: () => void;
  /** Scrolled up from the newest message: End takes you back. */
  away: boolean;
  /** ↑ with nothing queued to edit: edits your latest sent message, or
   *  says why it can't be. */
  onEditLast: () => void;
  /** An edit the hub didn't take: why, and whether its words went back
   *  into the box. */
  onEditBack: (why: string, restored: boolean) => void;
}) {
  const send = useChat((s) => s.send);
  const enqueue = useChat((s) => s.enqueue);
  // A queue that's waiting to go keeps what you send behind it, and Stop
  // beside it, whatever the agent is doing.
  const waiting = useChat((s) => !!s.queues[to]?.items.length && !s.queues[to]!.paused);
  const holding = busy || waiting;
  const cancel = useChat((s) => s.cancel);
  // What's typed to each agent, kept until it's sent (and through a crash).
  const [draft, setDraft] = useDraft(draftKey.dm(to));
  // An edit the hub didn't take: its words come back here, if the box is
  // empty, and you're told.
  const editBack = useChat((s) => s.editBack[to]);
  useEffect(() => {
    if (!editBack) return;
    const restored = !draft.trim();
    if (restored) setDraft(editBack.text);
    useChat.getState().tookEditBack(to);
    onEditBack(editBack.why, restored);
    // Once per edit given back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editBack]);
  const composer = useRef<HTMLTextAreaElement>(null);
  useFocusRequest(`agent:${to}`, composer);
  // Typing to a boss on this computer: its posts wait for your pause.
  const pingBoss = useMemo(() => typingPinger((id) => void useDesk.getState().hub?.dmTyping?.(id), DM_TYPING_EVERY_MS), []);
  const emoji = useEmojiInput({
    field: composer,
    value: draft,
    setValue: setDraft,
  });
  const commands = useCommandMenu({
    field: composer,
    value: draft,
    setValue: setDraft,
    commands: useHubCommands(hub),
  });
  const listing = commands.open ? commands : emoji.open ? emoji : null;
  const voiceEntries = useDmVoiceEntries(to, agent.name);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const picked = files.files;
    if (sending || (!draft.trim() && !picked.length)) return;
    const text = emoji.settle(draft);
    // While the agent works, what you send waits for its next turn: Stop
    // (or Esc) stops it, and a queued message can be sent at once.
    if (!picked.length) {
      if (holding) {
        enqueue(to, text);
        setDraft("");
      } else if (send(to, text)) {
        setDraft("");
        onSent();
      }
      return;
    }
    if (!hub) return;
    setSending(true);
    uploadAll(hub, agent.id, DESK_DM, picked)
      .then((attachments) => {
        // Still working once the files are up: they wait with the rest.
        const s = useChat.getState();
        const q = s.queues[to];
        if (isRunning(s.conversations[to]) || (!!q?.items.length && !q.paused)) enqueue(to, text, attachments);
        else if (!send(to, text, { attachments })) throw new Error(`Couldn’t reach ${agent.name}. Try again in a moment.`);
        else onSent();
        setDraft("");
        files.sent(picked);
      })
      .catch((err: unknown) => files.setProblem(err instanceof Error ? err.message : String(err)))
      .finally(() => setSending(false));
  };
  return (
    <>
      <DmVoiceBar agent={to} name={agent.name} />
      <form className="composer composer-files" onSubmit={submit} data-composer="">
        <PendingFiles pending={files.pending} problem={files.problem} onRemove={files.remove} />
        {commands.menu}
        {emoji.menu}
        <AttachButton onFiles={files.add} disabled={sending} />
        <textarea
          ref={composer}
          rows={1}
          value={draft}
          placeholder={overseeing && !inPane ? `Ask ${agent.name}, or tell it what to do — “restart anything stuck”` : `Message ${agent.name}`}
          {...(listing
            ? { role: "combobox", "aria-autocomplete": "list", "aria-expanded": true, "aria-controls": listing.listId, "aria-activedescendant": listing.activeId }
            : {})}
          onChange={(e) => {
            setDraft(e.target.value);
            emoji.onChange(e);
            if (boss) pingBoss(agent.id, e.target.value);
          }}
          onSelect={emoji.onSelect}
          onFocus={emoji.onFocus}
          onKeyDown={(e) => {
            // Keys that pick or end an IME composition are the input method's.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (commands.onKeyDown(e)) return;
            if (emoji.onKeyDown(e)) return;
            if (e.key === "Enter" && !e.shiftKey) submit(e);
            // ↑ in an empty composer edits your last message: the last one
            // still waiting in the queue (not yet sent, so nothing is asked
            // again), else the last one sent.
            else if (e.key === "ArrowUp" && !draft && !files.pending.length && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              const last = useChat.getState().queues[to]?.items.filter((i) => !i.sending).at(-1);
              if (last) useChat.getState().editingQueued(to, last.id);
              else onEditLast();
            }
            // Esc stops the agent, as Stop does; with nothing running it's
            // left to close what it always closed.
            else if (e.key === "Escape" && holding && !e.shiftKey) {
              e.preventDefault();
              e.stopPropagation();
              cancel(to);
            }
          }}
        />
        <EmojiButton onPick={emoji.insert} disabled={sending} />
        <DmVoiceControls agent={to} name={agent.name} />
        <ComposerMore label={`More for ${agent.name}`} onEmoji={emoji.insert} more={voiceEntries} disabled={sending} />
        {away && !draft && (
          <span className="composer-hint" aria-hidden="true">
            <kbd>End</kbd> jumps to latest
          </span>
        )}
        {holding && (
          <button type="button" className="btn btn-ghost" title={`Stop ${agent.name} (Esc)`} onClick={() => cancel(to)}>
            Stop
          </button>
        )}
        <button
          type="submit"
          className="btn btn-signal"
          title={holding ? `Sends when ${agent.name}’s done` : undefined}
          disabled={sending || (!draft.trim() && !files.pending.length) || (!holding && !connected)}
        >
          {sending ? "Sending…" : holding ? "Queue" : "Send"}
        </button>
        <QueuedMessages to={to} name={agent.name} busy={busy} />
      </form>
    </>
  );
}

/** Asked when leaving Files with changes not saved. */
function LeaveFiles({
  files,
  onKeep,
  onDiscard,
  onSave,
}: {
  files: string[];
  onKeep: () => void;
  onDiscard: () => void;
  onSave: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const list = files.length === 1 ? files[0] : `${files.slice(0, -1).join(", ")} and ${files.at(-1)}`;
  return (
    <Dialog
      onClose={onKeep}
      title={(id) => (
        <header className="dialog-head">
          <span className="dialog-title">
            <h1 id={id} className="display-md">
              Save your changes?
            </h1>
            <p>
              {list} {files.length === 1 ? "has" : "have"} changes you haven’t saved.
            </p>
          </span>
          <CloseButton onClose={onKeep} />
        </header>
      )}
    >
      <footer className="dialog-foot">
        <span className="dialog-foot-note state-blocked">{problem}</span>
        <button type="button" className="btn btn-ghost" data-autofocus onClick={onKeep}>
          Keep editing
        </button>
        <button type="button" className="btn btn-danger" onClick={onDiscard}>
          Discard
        </button>
        <button
          type="button"
          className="btn btn-signal"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            onSave().catch((e: unknown) => {
              setProblem(e instanceof Error ? e.message : String(e));
              setBusy(false);
            });
          }}
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </footer>
    </Dialog>
  );
}

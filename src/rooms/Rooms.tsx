import { formAnswer } from "../chat/forms";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { useShallow } from "zustand/react/shallow";
import { AttachButton, DropOverlay, PendingFiles, useFileDrop, usePendingFiles } from "../attachments/Compose";
import { uploadAll } from "../attachments/upload";
import { PromptCard } from "../chat/Approvals";
import { withHistory } from "../chat/history";
import { useChat } from "../chat/store";
import { useDesk } from "../hub/store";
import { RoomView } from "./RoomView";
import { agentKey, describeAgent, DESK_DM } from "../chat/types";
import { useAgentBrain } from "../crew/agentBrain";
import { AgentFiles, discardDrafts, saveDraft } from "../crew/AgentFiles";
import { AgentSettings } from "../crew/AgentSettings";
import { brainLine } from "../crew/brain";
import { dirtyFiles, useDrafts } from "../crew/files";
import { useProviders } from "../providers/store";
import { CloseButton, Dialog } from "../ui/Dialog";
import { AgentMark } from "../ui/Mark";
import { WorkingRow } from "../chat/WorkingRow";
import { Message } from "./Message";
import { relayedOf } from "../chat/relayed";
import { useOverview } from "../overview/store";
import { useUi, type AgentTab } from "../shell/ui";
import { draftKey, useDraft } from "../restore/drafts";
import { useAnchoredScroll } from "../restore/scroll";
import type { Agent, ChatMessage, HubAccount } from "../chat/types";
import type { OversightLevel } from "../hub/types";
import { useFocusRequest } from "../shell/focus";

const LEVEL: Record<OversightLevel, string> = { watch: "Watch", suggest: "Suggest", act: "Act" };

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
  const { send, loadHistory, loadEarlier, watchDm, answerPrompt, seenDm } = useChat(
    useShallow((s) => ({
      send: s.send,
      loadHistory: s.loadHistory,
      loadEarlier: s.loadEarlier,
      watchDm: s.watchDm,
      answerPrompt: s.answerPrompt,
      seenDm: s.seenDm,
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
  const trackedSessions = useDesk((s) => Object.values(s.sessions).filter((x) => x.state !== "closed").length);
  // Each agent's tab, kept while you visit others (and across launches).
  const tabs = useUi((u) => u.agentTabs);
  const setAgentTab = useUi((u) => u.setAgentTab);
  const rosterRead = useChat((s) => s.rosterRead);
  const rosterErrors = useChat((s) => s.rosterErrors);
  const [leaving, setLeaving] = useState<Tab | null>(null);
  const files = usePendingFiles();
  const drop = useFileDrop(files.add);
  // Held here, not in the composer, so a message still uploading while
  // another tab is open is still sending when you come back.
  const sending = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const anchored = useAnchoredScroll<HTMLDivElement>(activeAgent ? `dm:${activeAgent}` : null);
  const scrollerRef = useCallback(
    (el: HTMLDivElement | null) => {
      scroller.current = el;
      anchored(el);
    },
    [anchored],
  );
  // Distance from the bottom when an earlier page was asked for, so the
  // messages you were reading stay put as it lands above them.
  const anchor = useRef<number | null>(null);
  const tab: Tab = inPane ? "chat" : (activeAgent && tabs[activeAgent]) || "chat";
  const known = roster.some((a) => agentKey(a) === inPane);
  useEffect(() => {
    if (inPane && known) watchDm(inPane);
  }, [inPane, known, watchDm]);

  // In a pane, only the pane's own list scrolls: never the grid around it.
  const toEnd = useCallback(() => {
    if (!inPane) end.current?.scrollIntoView({ block: "end" });
    else if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [inPane]);

  useEffect(() => {
    if (tab === "chat") toEnd();
  }, [convo?.messages, convo?.working?.step, convo?.prompts.length, tab, toEnd]);
  // Shown: what was delivered into it isn't unread any more.
  useEffect(() => {
    if (activeAgent && tab === "chat") seenDm(activeAgent);
  }, [activeAgent, tab, history?.messages, seenDm]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || tab !== "chat") return;
    if (anchor.current !== null) el.scrollTop = el.scrollHeight - anchor.current;
    else toEnd();
    anchor.current = null;
  }, [history?.messages, tab, toEnd]);

  const earlier = useCallback(() => {
    if (!activeAgent || !history?.more || history.earlier === "loading") return;
    const el = scroller.current;
    if (el) anchor.current = el.scrollHeight - el.scrollTop;
    void loadEarlier(activeAgent);
  }, [activeAgent, history?.more, history?.earlier, loadEarlier]);

  const submitForm = useCallback(
    (summary: string, values: Record<string, unknown>) =>
      !!activeAgent && send(activeAgent, formAnswer(summary, values)),
    [activeAgent, send],
  );

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
  const shownTabs = local ? TABS : TABS.filter((t) => t.id !== "files");
  // What the hub reports stands in until the providers list says more.
  const brainSubtitle =
    local && brain && provider && !fallback
      ? [hub?.label ?? "This computer", brainLine(brain, provider)].join(" · ")
      : describeAgent(agent, hub?.label ?? agent.hubId);
  const overseeing = local && manager?.agentId === agent.id && manager.level ? manager.level : null;
  const subtitle =
    overseeing && tab === "chat" ? overseeingLine(roster, agent, trackedOverview ?? trackedSessions, overseeing) : brainSubtitle;
  const Root = inPane ? "div" : "main";
  const busy = convo.working !== null;
  const last = convo.messages.at(-1);
  // Until any answer text arrives, the reply is the working row (with the
  // tools it has run), not an empty message.
  const pending = last?.role === "assistant" && last.status === "streaming" && !last.content ? last : undefined;
  const answering = last?.role === "assistant" && last.status === "streaming" && !!last.content;
  const liveShown = pending ? convo.messages.slice(0, -1) : convo.messages;
  const shown = withHistory(history?.messages ?? [], liveShown, history?.loadedAt ?? null);
  const settled = !history || history.state === "ready" || history.state === "absent";

  const chat = tab !== "settings" && !(tab === "files" && local);
  return (
    <Root
      className={`${inPane ? "room room-in-pane" : "room"} drop-target`}
      aria-label={`Conversation with ${agent.name}`}
      {...(chat ? drop.handlers : {})}
    >
      {!inPane && (
        <header className="room-head">
          <AgentMark agent={agentKey(agent)} name={agent.name} size="lg" />
          <span className="room-title">
            <h1 className="display-lg">{agent.name}</h1>
            <span className="faint small">
              {subtitle}
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
      ) : tab === "files" && local ? (
        <div className="agent-panel" role="tabpanel" id="agent-tab-panel" aria-labelledby="agent-tab-files">
          <AgentFiles agent={agent} />
        </div>
      ) : (
        <>
          <div
            ref={scrollerRef}
            className="room-scroll"
            role={inPane ? undefined : "tabpanel"}
            id={inPane ? undefined : "agent-tab-panel"}
            aria-labelledby={inPane ? undefined : "agent-tab-chat"}
            onScroll={(e) => {
              if (e.currentTarget.scrollTop < 80 && history?.earlier === "idle") earlier();
            }}
          >
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
              <DmMessage
                key={m.id}
                message={m}
                author={agent.name}
                authorKey={agentKey(agent)}
                youOn={agent.hubId}
                home={hub?.label}
                sentOn={sentOn}
                origin={origin}
                onSubmitForm={submitForm}
              />
            ))}
            {convo.prompts.map((p) => (
              <PromptCard key={p.requestId} prompt={p} onAnswer={(choice) => answerPrompt(activeAgent, p.requestId, choice)} />
            ))}
            {convo.working && !answering && <WorkingRow agent={agentKey(agent)} name={agent.name} working={convo.working} tools={pending?.tools} />}
            <div ref={end} />
          </div>
          <DmComposer
            to={activeAgent}
            agent={agent}
            hub={hub}
            busy={busy}
            connected={convo.connected}
            overseeing={!!overseeing}
            files={files}
            sending={sending}
          />
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
const DmMessage = memo(function DmMessage({
  message,
  sentOn,
  ...shown
}: Omit<ComponentProps<typeof Message>, "relayed"> & { message: ChatMessage; sentOn: Parameters<typeof relayedOf>[1] }) {
  const relayed = useMemo(() => relayedOf(message, sentOn), [message, sentOn]);
  return <Message message={message} relayed={relayed} {...shown} />;
});

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
  files,
  sending: [sending, setSending],
}: {
  /** The agent's key. */
  to: string;
  agent: Agent;
  hub: HubAccount | undefined;
  busy: boolean;
  connected: boolean;
  overseeing: boolean;
  files: Files;
  sending: [boolean, (sending: boolean) => void];
}) {
  const send = useChat((s) => s.send);
  const cancel = useChat((s) => s.cancel);
  // What's typed to each agent, kept until it's sent (and through a crash).
  const [draft, setDraft] = useDraft(draftKey.dm(to));
  const composer = useRef<HTMLTextAreaElement>(null);
  useFocusRequest(`agent:${to}`, composer);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const picked = files.files;
    if (sending || (!draft.trim() && !picked.length)) return;
    if (!picked.length) {
      if (send(to, draft)) setDraft("");
      return;
    }
    if (!hub) return;
    setSending(true);
    uploadAll(hub, agent.id, DESK_DM, picked)
      .then((attachments) => {
        if (!send(to, draft, { attachments })) throw new Error(`Couldn’t reach ${agent.name}. Try again in a moment.`);
        setDraft("");
        files.sent(picked);
      })
      .catch((err: unknown) => files.setProblem(err instanceof Error ? err.message : String(err)))
      .finally(() => setSending(false));
  };
  return (
    <form className="composer composer-files" onSubmit={submit}>
      <PendingFiles pending={files.pending} problem={files.problem} onRemove={files.remove} />
      <AttachButton onFiles={files.add} disabled={sending} />
      <textarea
        ref={composer}
        rows={1}
        value={draft}
        placeholder={overseeing ? `Ask ${agent.name}, or tell it what to do — “restart anything stuck”` : `Message ${agent.name}`}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) submit(e);
        }}
      />
      {busy ? (
        <button type="button" className="btn btn-ghost" onClick={() => cancel(to)}>
          Stop
        </button>
      ) : (
        <button type="submit" className="btn btn-signal" disabled={sending || (!draft.trim() && !files.pending.length) || !connected}>
          {sending ? "Sending…" : "Send"}
        </button>
      )}
    </form>
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

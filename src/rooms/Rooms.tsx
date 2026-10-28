import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { withHistory } from "../chat/history";
import { useChat } from "../chat/store";
import { useDesk } from "../hub/store";
import { RoomView } from "./RoomView";
import { agentKey, describeAgent } from "../chat/types";
import { useAgentBrain } from "../crew/agentBrain";
import { AgentFiles, discardDrafts, saveDraft } from "../crew/AgentFiles";
import { AgentSettings } from "../crew/AgentSettings";
import { brainLine } from "../crew/brain";
import { dirtyFiles, useDrafts } from "../crew/files";
import { useProviders } from "../providers/store";
import { CloseButton, Dialog } from "../ui/Dialog";
import { Mark } from "../ui/Mark";
import { WorkingRow } from "../chat/WorkingRow";
import { Message } from "./Message";
import { useOverview } from "../overview/store";
import type { Agent } from "../chat/types";
import type { OversightLevel, Overview, Session } from "../hub/types";

const LEVEL: Record<OversightLevel, string> = { watch: "Watch", suggest: "Suggest", act: "Act" };

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Overseeing 3 crew and 4 sessions · Suggest" */
const overseeingLine = (
  roster: Agent[],
  manager: Agent,
  overview: Overview | null,
  sessions: Record<string, Session>,
  level: OversightLevel,
): string => {
  const crew = roster.filter((a) => a.hubId === manager.hubId && a.id !== manager.id).length;
  const tracked = overview
    ? overview.items.filter((i) => i.kind === "session").length
    : Object.values(sessions).filter((s) => s.state !== "closed").length;
  return `Overseeing ${crew} crew and ${count(tracked, "session", "sessions")} · ${LEVEL[level]}`;
};

export function Rooms() {
  const room = useDesk((s) => (s.activeRoom ? s.rooms[s.activeRoom] : undefined));
  return room ? <RoomView room={room} /> : <DirectMessage />;
}

type Tab = "chat" | "settings" | "files";

const TABS: { id: Tab; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "settings", label: "Settings" },
  { id: "files", label: "Files" },
];

function DirectMessage() {
  const { activeAgent, roster, hubs, conversations, histories, send, cancel, loadHistory, loadEarlier } = useChat();
  const agent = roster.find((a) => agentKey(a) === activeAgent);
  const convo = activeAgent ? conversations[activeAgent] : undefined;
  const history = activeAgent ? histories[activeAgent] : undefined;
  const hub = hubs.find((h) => h.id === agent?.hubId);
  const local = hub?.local ?? false;
  const desk = useDesk((s) => s.hub);
  const drafts = useDrafts((s) => s.drafts);
  const { brain, provider } = useAgentBrain(agent, local);
  const fallback = useProviders((s) => s.fallback);
  const manager = useOverview((s) => s.manager);
  const overview = useOverview((s) => s.overview);
  const sessions = useDesk((s) => s.sessions);
  const [draft, setDraft] = useState("");
  // Each agent's tab, kept while you visit others.
  const [tabs, setTabs] = useState<Record<string, Tab>>({});
  const [leaving, setLeaving] = useState<Tab | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // Distance from the bottom when an earlier page was asked for, so the
  // messages you were reading stay put as it lands above them.
  const anchor = useRef<number | null>(null);
  const tab: Tab = (activeAgent && tabs[activeAgent]) || "chat";

  useEffect(() => {
    if (tab === "chat") end.current?.scrollIntoView({ block: "end" });
  }, [convo?.messages, convo?.working?.step, tab]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || tab !== "chat") return;
    if (anchor.current !== null) el.scrollTop = el.scrollHeight - anchor.current;
    else end.current?.scrollIntoView({ block: "end" });
    anchor.current = null;
  }, [history?.messages, tab]);

  const earlier = useCallback(() => {
    if (!activeAgent || !history?.more || history.earlier === "loading") return;
    const el = scroller.current;
    if (el) anchor.current = el.scrollHeight - el.scrollTop;
    void loadEarlier(activeAgent);
  }, [activeAgent, history?.more, history?.earlier, loadEarlier]);

  const submitForm = useCallback(
    (summary: string, values: Record<string, unknown>) =>
      !!activeAgent && send(activeAgent, `${summary}\n\n\`\`\`json\n${JSON.stringify(values, null, 2)}\n\`\`\``),
    [activeAgent, send],
  );

  if (!agent || !activeAgent || !convo) {
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

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (send(activeAgent, draft)) setDraft("");
  };
  const unsaved = dirtyFiles(drafts, activeAgent);
  const go = (next: Tab) => setTabs((t) => ({ ...t, [activeAgent]: next }));
  const choose = (next: Tab) => (tab === "files" && next !== "files" && unsaved.length > 0 ? setLeaving(next) : go(next));
  const shownTabs = local ? TABS : TABS.filter((t) => t.id !== "files");
  // What the hub reports stands in until the providers list says more.
  const brainSubtitle =
    local && brain && provider && !fallback
      ? [hub?.label ?? "This Mac", brainLine(brain, provider)].join(" · ")
      : describeAgent(agent, hub?.label ?? agent.hubId);
  const overseeing = local && manager?.agentId === agent.id && manager.level ? manager.level : null;
  const subtitle = overseeing && tab === "chat" ? overseeingLine(roster, agent, overview, sessions, overseeing) : brainSubtitle;
  const busy = convo.working !== null;
  const last = convo.messages.at(-1);
  // Until any answer text arrives, the reply is the working row (with the
  // tools it has run), not an empty message.
  const pending = last?.role === "assistant" && last.status === "streaming" && !last.content ? last : undefined;
  const answering = last?.role === "assistant" && last.status === "streaming" && !!last.content;
  const liveShown = pending ? convo.messages.slice(0, -1) : convo.messages;
  const shown = withHistory(history?.messages ?? [], liveShown, history?.loadedAt ?? null);
  const settled = !history || history.state === "ready" || history.state === "absent";

  return (
    <main className="room" aria-label={`Conversation with ${agent.name}`}>
      <header className="room-head">
        <Mark name={agent.name} size="lg" />
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
            ref={scroller}
            className="room-scroll"
            role="tabpanel"
            id="agent-tab-panel"
            aria-labelledby="agent-tab-chat"
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
              <Message key={m.id} message={m} author={agent.name} home={hub?.label} onSubmitForm={submitForm} />
            ))}
            {convo.working && !answering && <WorkingRow name={agent.name} working={convo.working} tools={pending?.tools} />}
            <div ref={end} />
          </div>
          <form className="composer" onSubmit={submit}>
            <textarea
              rows={1}
              value={draft}
              placeholder={overseeing ? `Ask ${agent.name}, or tell it what to do — “restart anything stuck”` : `Message ${agent.name}`}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) submit(e);
              }}
            />
            {busy ? (
              <button type="button" className="btn btn-ghost" onClick={() => cancel(activeAgent)}>
                Stop
              </button>
            ) : (
              <button type="submit" className="btn btn-signal" disabled={!draft.trim() || !convo.connected}>
                Send
              </button>
            )}
          </form>
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
    </main>
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

import { useCallback, useEffect, useRef, useState } from "react";
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
  const { activeAgent, roster, hubs, conversations, send, cancel } = useChat();
  const agent = roster.find((a) => agentKey(a) === activeAgent);
  const convo = activeAgent ? conversations[activeAgent] : undefined;
  const hub = hubs.find((h) => h.id === agent?.hubId);
  const local = hub?.local ?? false;
  const desk = useDesk((s) => s.hub);
  const drafts = useDrafts((s) => s.drafts);
  const { brain, provider } = useAgentBrain(agent, local);
  const fallback = useProviders((s) => s.fallback);
  const [draft, setDraft] = useState("");
  // Each agent's tab, kept while you visit others.
  const [tabs, setTabs] = useState<Record<string, Tab>>({});
  const [leaving, setLeaving] = useState<Tab | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const tab: Tab = (activeAgent && tabs[activeAgent]) || "chat";

  useEffect(() => {
    if (tab === "chat") end.current?.scrollIntoView({ block: "end" });
  }, [convo?.messages, convo?.working?.step, tab]);

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
  const subtitle =
    local && brain && provider && !fallback
      ? [hub?.label ?? "This Mac", brainLine(brain, provider)].join(" · ")
      : describeAgent(agent, hub?.label ?? agent.hubId);
  const busy = convo.working !== null;
  const last = convo.messages.at(-1);
  // Until any answer text arrives, the reply is the working row (with the
  // tools it has run), not an empty message.
  const pending = last?.role === "assistant" && last.status === "streaming" && !last.content ? last : undefined;
  const answering = last?.role === "assistant" && last.status === "streaming" && !!last.content;
  const shown = pending ? convo.messages.slice(0, -1) : convo.messages;

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
          <div className="room-scroll" role="tabpanel" id="agent-tab-panel" aria-labelledby="agent-tab-chat">
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
              placeholder={`Message ${agent.name}`}
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

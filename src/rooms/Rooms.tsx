import { useCallback, useEffect, useRef, useState } from "react";
import { useChat } from "../chat/store";
import { useDesk } from "../hub/store";
import { RoomView } from "./RoomView";
import { AgentAbout } from "../chat/AgentAbout";
import { agentKey, describeAgent } from "../chat/types";
import { Mark } from "../ui/Mark";
import { WorkingRow } from "../chat/WorkingRow";
import { Message } from "./Message";

export function Rooms() {
  const room = useDesk((s) => (s.activeRoom ? s.rooms[s.activeRoom] : undefined));
  return room ? <RoomView room={room} /> : <DirectMessage />;
}

function DirectMessage() {
  const { activeAgent, roster, hubs, conversations, send, cancel } = useChat();
  const agent = roster.find((a) => agentKey(a) === activeAgent);
  const convo = activeAgent ? conversations[activeAgent] : undefined;
  const hub = hubs.find((h) => h.id === agent?.hubId);
  const [draft, setDraft] = useState("");
  const [about, setAbout] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [convo?.messages, convo?.working?.step]);

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
            {describeAgent(agent, hub?.label ?? agent.hubId)}
            {convo.connected ? "" : " · reconnecting…"}
          </span>
        </span>
        <button type="button" className="link small room-about" onClick={() => setAbout((a) => !a)}>
          Settings
        </button>
        {about && <AgentAbout agent={agent} hub={hub} onClose={() => setAbout(false)} />}
      </header>
      <div className="room-scroll">
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
    </main>
  );
}

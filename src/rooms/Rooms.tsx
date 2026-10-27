import { useCallback, useEffect, useRef, useState } from "react";
import { useChat } from "../chat/store";
import { useDesk } from "../hub/store";
import { RoomView } from "./RoomView";
import { agentKey } from "../chat/types";
import { Mark } from "../ui/Mark";
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
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [convo?.messages]);

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
  const busy = convo.typing || convo.streaming;

  return (
    <main className="room" aria-label={`Conversation with ${agent.name}`}>
      <header className="room-head">
        <Mark name={agent.name} size="lg" />
        <span className="room-title">
          <h1 className="display-lg">{agent.name}</h1>
          <span className="faint small">
            {hub?.label ?? agent.hubId}
            {agent.model ? ` · ${agent.model}` : ""}
            {convo.connected ? "" : " · reconnecting…"}
          </span>
        </span>
      </header>
      <div className="room-scroll">
        {convo.messages.map((m) => (
          <Message key={m.id} message={m} author={agent.name} home={hub?.label} onSubmitForm={submitForm} />
        ))}
        {convo.typing && <p className="faint small typing">{agent.name} is thinking…</p>}
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

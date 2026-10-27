import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "../chat/store";
import { useDesk } from "../hub/store";
import type { Room, RoomMessage } from "../hub/types";
import { Mark } from "../ui/Mark";
import { Message } from "./Message";
import { say } from "./engine";
import { memberKey } from "./routing";

const asChat = (m: RoomMessage) => ({
  id: m.id,
  role: m.author === "you" ? ("user" as const) : m.author === "desk" ? ("system" as const) : ("assistant" as const),
  content: m.content,
  at: m.createdAt,
  status: "complete" as const,
  tools: [],
});

function Composer({ room, threadId, placeholder }: { room: Room; threadId: string | null; placeholder: string }) {
  const fail = useDesk((s) => s.fail);
  const [draft, setDraft] = useState("");
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft;
    setDraft("");
    say(room, text, threadId).catch((err) => {
      setDraft(text);
      fail(err);
    });
  };
  return (
    <form className="composer" onSubmit={submit}>
      <textarea
        rows={1}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) submit(e);
        }}
      />
      <button type="submit" className="btn btn-signal" disabled={!draft.trim()}>
        Send
      </button>
    </form>
  );
}

export function RoomView({ room }: { room: Room }) {
  const { timelines, openThread } = useDesk();
  const { roster, hubs } = useChat();
  const [thread, setThread] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const all = timelines[room.id] ?? [];
  const main = all.filter((m) => !m.threadId);
  const replies = useMemo(() => {
    const by = new Map<string, RoomMessage[]>();
    for (const m of all) if (m.threadId) by.set(m.threadId, [...(by.get(m.threadId) ?? []), m]);
    return by;
  }, [all]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [main.length]);
  useEffect(() => {
    setThread(null);
  }, [room.id]);

  const author = (key: string) => {
    const [hub, agent] = key.split("/");
    return {
      name: roster.find((a) => a.hubId === hub && a.id === agent)?.name ?? agent ?? key,
      home: hubs.find((h) => h.id === hub)?.label ?? hub,
    };
  };
  const parent = thread ? all.find((m) => m.id === thread) : undefined;
  const noForms = () => false;

  return (
    <div className="room-split">
      <main className="room" aria-label={`Room ${room.name}`}>
        <header className="room-head">
          <span className="room-title">
            <span className="room-title-row">
              <h1 className="display-lg">{room.name}</h1>
              <span className="member-stack">
                {room.members.map((m) => (
                  <Mark key={memberKey(m)} name={author(memberKey(m)).name} size="sm" />
                ))}
              </span>
            </span>
            <span className="faint small">
              {room.members.map((m) => `@${author(memberKey(m)).name}`).join(" ") || "No members yet"}
              {room.defaultMember ? ` · unaddressed messages go to @${author(room.defaultMember).name}` : ""}
            </span>
          </span>
        </header>
        <div className="room-scroll">
          {main.map((m) => {
            const a = author(m.author);
            const n = replies.get(m.id)?.length ?? 0;
            return (
              <div key={m.id} className="room-msg">
                <Message message={asChat(m)} author={a.name} home={m.author.includes("/") ? a.home : undefined} onSubmitForm={noForms} />
                <button
                  type="button"
                  className="link small thread-link"
                  onClick={() => {
                    setThread(m.id);
                    void openThread(room.id, m.id);
                  }}
                >
                  {n ? `${n} repl${n === 1 ? "y" : "ies"}` : "Reply in thread"}
                </button>
              </div>
            );
          })}
          <div ref={end} />
        </div>
        <Composer room={room} threadId={null} placeholder={`Message ${room.name} — @ to bring someone in`} />
      </main>
      {parent && (
        <aside className="thread-panel" aria-label="Thread">
          <header className="session-head">
            <b className="display">Thread</b>
            <span className="session-actions">
              <button type="button" className="link" onClick={() => setThread(null)}>
                Close
              </button>
            </span>
          </header>
          <div className="room-scroll">
            <Message message={asChat(parent)} author={author(parent.author).name} onSubmitForm={noForms} />
            {(replies.get(parent.id) ?? []).map((m) => (
              <Message key={m.id} message={asChat(m)} author={author(m.author).name} onSubmitForm={noForms} />
            ))}
          </div>
          <Composer room={room} threadId={parent.id} placeholder="Reply in thread" />
        </aside>
      )}
    </div>
  );
}

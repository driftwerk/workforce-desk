import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useChat } from "../chat/store";
import { agentKey, type Agent } from "../chat/types";
import { useDesk } from "../hub/store";
import type { Room, RoomMessage } from "../hub/types";
import { Mark } from "../ui/Mark";
import { WorkingRow } from "../chat/WorkingRow";
import { Message } from "./Message";
import { say } from "./engine";
import { insertMention, mentionAt, mentionFor, suggestions } from "./mentions";
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
  const { roster, hubs } = useChat();
  const [draft, setDraft] = useState("");
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  // Escape closes the list until you type on.
  const [dismissed, setDismissed] = useState<number | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const listId = useId();

  const typing = mentionAt(draft, caret);
  const options = typing && dismissed !== typing.start ? suggestions(typing.query, roster, room.members) : [];
  const open = options.length > 0;
  const current = Math.min(active, options.length - 1);
  const inRoom = (a: Agent) => room.members.some((m) => m.hub === a.hubId && m.agent === a.id);
  const home = (a: Agent) => hubs.find((h) => h.id === a.hubId)?.label ?? a.hubId;

  const pick = (a: Agent) => {
    if (!typing) return;
    const next = insertMention(draft, typing.start, caret, mentionFor(a, roster, hubs));
    setDraft(next.text);
    setCaret(next.caret);
    setActive(0);
    requestAnimationFrame(() => {
      field.current?.focus();
      field.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft;
    if (!text.trim()) return;
    setDraft("");
    setCaret(0);
    say(room, text, threadId).catch((err) => {
      setDraft(text);
      fail(err);
    });
  };
  return (
    <form className="composer composer-mentions" onSubmit={submit}>
      {open && (
        <ul className="mention-menu" role="listbox" id={listId} aria-label="Mention someone">
          {options.map((a, i) => (
            <li
              key={agentKey(a)}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === current}
              className="mention-option"
              onMouseDown={(e) => {
                e.preventDefault();
                pick(a);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <Mark name={a.name} size="sm" />
              <b>{a.name}</b>
              <span className="faint small">
                {home(a)}
                {inRoom(a) ? "" : " · not in the room yet — mentioning adds them"}
              </span>
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={field}
        rows={1}
        value={draft}
        placeholder={placeholder}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${current}` : undefined}
        onChange={(e) => {
          setDraft(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setActive(0);
          setDismissed(null);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onKeyDown={(e) => {
          if (open) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const step = e.key === "ArrowDown" ? 1 : -1;
              setActive((current + step + options.length) % options.length);
              return;
            }
            if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
              e.preventDefault();
              pick(options[current]!);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setDismissed(typing!.start);
              return;
            }
          }
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
  const working = useDesk((s) => s.roomWorking[room.id]) ?? {};
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
  }, [main.length, Object.keys(working).length]);
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
          {Object.entries(working).map(([key, w]) => (
            <WorkingRow key={key} name={author(key).name} working={w} />
          ))}
          <div ref={end} />
        </div>
        <Composer
          room={room}
          threadId={null}
          placeholder={`Message ${room.name} — @ someone to ask them, or to bring them in`}
        />
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
          <Composer room={room} threadId={parent.id} placeholder="Reply in thread — @ someone to ask them" />
        </aside>
      )}
    </div>
  );
}

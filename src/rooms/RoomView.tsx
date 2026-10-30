import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useChat } from "../chat/store";
import { agentKey, type Agent } from "../chat/types";
import { useDesk } from "../hub/store";
import type { Room, RoomMessage } from "../hub/types";
import { AgentMark } from "../ui/Mark";
import { WorkingRow } from "../chat/WorkingRow";
import { Message } from "./Message";
import { say } from "./engine";
import { insertMention, mentionAt, mentionFor, suggestions } from "./mentions";
import { memberKey } from "./routing";
import { draftKey, useDraft } from "../restore/drafts";
import { useAnchoredScroll } from "../restore/scroll";
import { useUi } from "../shell/ui";
import { SidePanel } from "../panels/Stage";

/** A room message's author's agent key (`hub/agent`), for a member's. */
const agentAuthor = (author: string): string | undefined => (author.includes("/") ? author : undefined);

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
  // Kept per room and thread until it's sent (and through a crash).
  const [draft, setDraft] = useDraft(draftKey.room(room.id, threadId));
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
              <AgentMark agent={agentKey(a)} name={a.name} size="sm" />
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

/** Who wrote `key` (`hub/agent`), and where they live. */
function useAuthor(): (key: string) => { name: string; home: string } {
  const { roster, hubs } = useChat();
  return (key: string) => {
    const [hub, agent] = key.split("/");
    return {
      name: roster.find((a) => a.hubId === hub && a.id === agent)?.name ?? agent ?? key,
      home: hubs.find((h) => h.id === hub)?.label ?? hub ?? key,
    };
  };
}

const noForms = () => false;

/** The thread open in the room Rooms shows, while its first message is
 *  loaded: it opens as a column on the right. */
export function useOpenThread(): { room: Room; thread: string } | null {
  const room = useDesk((s) => (s.view === "rooms" && s.activeRoom ? s.rooms[s.activeRoom] : undefined));
  const thread = useUi((u) => (room ? (u.roomThreads[room.id] ?? null) : null));
  const loaded = useDesk((s) => !!(room && thread && s.timelines[room.id]?.some((m) => m.id === thread)));
  return room && thread && loaded ? { room, thread } : null;
}

/** A room's thread: its first message, the replies, and a reply box. */
export function ThreadPanel({ room, thread }: { room: Room; thread: string }) {
  const all = useDesk((s) => s.timelines[room.id]) ?? [];
  const setRoomThread = useUi((u) => u.setRoomThread);
  const author = useAuthor();
  const parent = all.find((m) => m.id === thread);
  if (!parent) return null;
  const replies = all.filter((m) => m.threadId === thread);
  return (
    <SidePanel
      className="thread-panel"
      label="Thread"
      noun="the thread"
      onClose={() => setRoomThread(room.id, null)}
      title={<b className="display rpanel-name">Thread</b>}
    >
      <div className="room-scroll">
        <Message message={asChat(parent)} author={author(parent.author).name} authorKey={agentAuthor(parent.author)} onSubmitForm={noForms} />
        {replies.map((m) => (
          <Message key={m.id} message={asChat(m)} author={author(m.author).name} authorKey={agentAuthor(m.author)} onSubmitForm={noForms} />
        ))}
      </div>
      <Composer room={room} threadId={parent.id} placeholder="Reply in thread — @ someone to ask them" />
    </SidePanel>
  );
}

export function RoomView({ room }: { room: Room }) {
  const { timelines, openThread } = useDesk();
  const working = useDesk((s) => s.roomWorking[room.id]) ?? {};
  // The open thread, per room (and across launches): shown beside, as a
  // column of its own.
  const thread = useUi((u) => u.roomThreads[room.id] ?? null);
  const setRoomThread = useUi((u) => u.setRoomThread);
  const setThread = (id: string | null) => setRoomThread(room.id, id);
  const connected = useDesk((s) => s.connected);
  const scroller = useAnchoredScroll<HTMLDivElement>(`room:${room.id}`);
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
  // A thread put back on launch, or open while the hub restarted: its
  // replies are read (again).
  useEffect(() => {
    if (thread && connected) void openThread(room.id, thread);
  }, [room.id, thread, connected, openThread]);

  const author = useAuthor();

  return (
    <main className="room" aria-label={`Room ${room.name}`}>
      <header className="room-head">
        <span className="room-title">
          <span className="room-title-row">
            <h1 className="display-lg">{room.name}</h1>
            <span className="member-stack">
              {room.members.map((m) => (
                <AgentMark key={memberKey(m)} agent={memberKey(m)} name={author(memberKey(m)).name} size="sm" />
              ))}
            </span>
          </span>
          <span className="faint small">
            {room.members.map((m) => `@${author(memberKey(m)).name}`).join(" ") || "No members yet"}
            {room.defaultMember ? ` · unaddressed messages go to @${author(room.defaultMember).name}` : ""}
          </span>
        </span>
      </header>
      <div ref={scroller} className="room-scroll">
        {main.map((m) => {
          const a = author(m.author);
          const n = replies.get(m.id)?.length ?? 0;
          return (
            <div key={m.id} className="room-msg">
              <Message message={asChat(m)} author={a.name} authorKey={agentAuthor(m.author)} home={m.author.includes("/") ? a.home : undefined} onSubmitForm={noForms} />
              <button
                type="button"
                className="link small thread-link"
                onClick={() => setThread(m.id)}
              >
                {n ? `${n} repl${n === 1 ? "y" : "ies"}` : "Reply in thread"}
              </button>
            </div>
          );
        })}
        {Object.entries(working).map(([key, w]) => (
          <WorkingRow key={key} agent={key} name={author(key).name} working={w} />
        ))}
        <div ref={end} />
      </div>
      <Composer
        room={room}
        threadId={null}
        placeholder={`Message ${room.name} — @ someone to ask them, or to bring them in`}
      />
    </main>
  );
}

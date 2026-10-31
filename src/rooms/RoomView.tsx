import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AttachButton, DropOverlay, PendingFiles, useFileDrop, usePendingFiles } from "../attachments/Compose";
import { formAnswer } from "../chat/forms";
import { useChat } from "../chat/store";
import { agentKey, type Agent, type ChatMessage } from "../chat/types";
import { useDesk, type RoomDraft } from "../hub/store";
import type { Room, RoomMessage } from "../hub/types";
import { AgentMark } from "../ui/Mark";
import { Draft } from "./Draft";
import { Message } from "./Message";
import { answerForm, say } from "./engine";
import { insertMention, mentionAt, mentionFor, suggestions } from "./mentions";
import { memberKey, memberOf } from "./routing";
import { draftKey, useDraft } from "../restore/drafts";
import { useAnchoredScroll } from "../restore/scroll";
import { useUi } from "../shell/ui";
import { EmojiButton } from "../emoji/EmojiButton";
import { useEmojiInput } from "../emoji/useEmojiInput";
import { SidePanel } from "../panels/Stage";
import { useFocusRequest } from "../shell/focus";

const asChat = (m: RoomMessage): ChatMessage => ({
  id: m.id,
  role: m.author === "you" ? "user" : m.author === "desk" ? "system" : "assistant",
  content: m.content,
  at: m.createdAt,
  status: "complete",
  tools: [],
  ...(m.delivery ? { delivery: m.delivery } : {}),
  ...(m.requestId ? { requestId: m.requestId } : {}),
  ...(m.attachments?.length ? { attachments: m.attachments } : {}),
});

/** The drafts on their way, by thread (the main timeline's under null),
 *  but not one whose answer is in already. */
const draftsByThread = (drafts: readonly RoomDraft[], all: readonly RoomMessage[]): Map<string | null, RoomDraft[]> => {
  const posted = new Set(all.flatMap((m) => m.source ?? []));
  const by = new Map<string | null, RoomDraft[]>();
  for (const d of drafts) if (!(d.source && posted.has(d.source))) by.set(d.threadId, [...(by.get(d.threadId) ?? []), d]);
  return by;
};

/** Whether a draft's member is answering now, not waiting or stopped. */
const answering = (d: RoomDraft): boolean => d.state === "live" || d.state === "stalled";

/** Files dropped anywhere on a room or thread go with its next message. */
type Files = ReturnType<typeof usePendingFiles>;

function Composer({ room, threadId, placeholder, files }: { room: Room; threadId: string | null; placeholder: string; files: Files }) {
  const fail = useDesk((s) => s.fail);
  const roster = useChat((s) => s.roster);
  const hubs = useChat((s) => s.hubs);
  // Kept per room and thread until it's sent (and through a crash).
  const [draft, setDraft] = useDraft(draftKey.room(room.id, threadId));
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  // Escape closes the list until you type on.
  const [dismissed, setDismissed] = useState<number | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  useFocusRequest(threadId ? `room:${room.id}/${threadId}` : `room:${room.id}`, field);
  const listId = useId();

  const typing = mentionAt(draft, caret);
  const emoji = useEmojiInput({ field, value: draft, setValue: setDraft });
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

  const [sending, setSending] = useState(false);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = emoji.settle(draft);
    const picked = files.files;
    if ((!text.trim() && !picked.length) || sending) return;
    setDraft("");
    setCaret(0);
    setSending(true);
    say(room, text, threadId, picked)
      .then(() => files.sent(picked))
      .catch((err: unknown) => {
        setDraft(text);
        if (picked.length) files.setProblem(err instanceof Error ? err.message : String(err));
        else fail(err);
      })
      .finally(() => setSending(false));
  };
  return (
    <form className="composer composer-mentions composer-files" onSubmit={submit}>
      <PendingFiles pending={files.pending} problem={files.problem} onRemove={files.remove} />
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
      {emoji.menu}
      <AttachButton onFiles={files.add} disabled={sending} />
      <textarea
        ref={field}
        rows={1}
        value={draft}
        placeholder={placeholder}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open || emoji.open}
        aria-controls={open ? listId : emoji.open ? emoji.listId : undefined}
        aria-activedescendant={open ? `${listId}-${current}` : emoji.activeId}
        onChange={(e) => {
          setDraft(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setActive(0);
          setDismissed(null);
          emoji.onChange(e);
        }}
        onSelect={(e) => {
          setCaret(e.currentTarget.selectionStart ?? 0);
          emoji.onSelect(e);
        }}
        onFocus={emoji.onFocus}
        onKeyDown={(e) => {
          if (emoji.onKeyDown(e)) return;
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
      <EmojiButton onPick={emoji.insert} disabled={sending} />
      <button type="submit" className="btn btn-signal" disabled={sending || (!draft.trim() && !files.pending.length)}>
        {sending ? "Sending…" : "Send"}
      </button>
    </form>
  );
}

/** Who wrote `key` (`hub/agent`), and where they live. */
function useAuthor(): (key: string) => { name: string; home: string } {
  const roster = useChat((s) => s.roster);
  const hubs = useChat((s) => s.hubs);
  return (key: string) => {
    const m = memberOf(key);
    return {
      name: roster.find((a) => a.hubId === m?.hub && a.id === m.agent)?.name ?? m?.agent ?? key,
      home: hubs.find((h) => h.id === m?.hub)?.label ?? m?.hub ?? key,
    };
  };
}

/** The thread open in the room Rooms shows, while its first message is
 *  loaded: it opens as a column on the right. */
export function useOpenThread(): { room: Room; thread: string } | null {
  const room = useDesk((s) => (s.view === "rooms" && s.activeRoom ? s.rooms[s.activeRoom] : undefined));
  const thread = useUi((u) => (room ? (u.roomThreads[room.id] ?? null) : null));
  const loaded = useDesk((s) => !!(room && thread && s.timelines[room.id]?.some((m) => m.id === thread)));
  return room && thread && loaded ? { room, thread } : null;
}

const NO_DRAFTS: RoomDraft[] = [];
const NO_MESSAGES: RoomMessage[] = [];

/** A room message as the room shows it; a form an agent posted in it is
 *  answered to that agent, where the form is. Rendered again only when it
 *  changes, not as an answer streams in below it. */
const RoomMessageView = memo(function RoomMessageView({ room, m, name, home }: { room: Room; m: RoomMessage; name: string; home?: string }) {
  const submitForm = useCallback(
    (summary: string, values: Record<string, unknown>): boolean => {
      if (!memberOf(m.author)) return false;
      void answerForm(room, m, formAnswer(summary, values)).catch(useDesk.getState().fail);
      return true;
    },
    [room, m],
  );
  const message = useMemo(() => asChat(m), [m]);
  const member = useMemo(() => memberOf(m.author), [m.author]);
  return (
    <Message
      message={message}
      author={name}
      authorKey={member ? m.author : undefined}
      home={home}
      origin={member ?? undefined}
      onSubmitForm={submitForm}
    />
  );
});

/** A room's thread: its first message, the replies, and a reply box. */
export function ThreadPanel({ room, thread }: { room: Room; thread: string }) {
  const all = useDesk((s) => s.timelines[room.id]) ?? NO_MESSAGES;
  const drafts = useDesk((s) => s.roomDrafts[room.id]) ?? NO_DRAFTS;
  const setRoomThread = useUi((u) => u.setRoomThread);
  const author = useAuthor();
  const files = usePendingFiles();
  const drop = useFileDrop(files.add);
  const shown = useMemo(() => draftsByThread(drafts, all).get(thread) ?? NO_DRAFTS, [drafts, all, thread]);
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
      <div className="thread-body drop-target" {...drop.handlers}>
        <div className="room-scroll">
          <RoomMessageView room={room} m={parent} name={author(parent.author).name} />
          {replies.map((m) => (
            <RoomMessageView key={m.id} room={room} m={m} name={author(m.author).name} />
          ))}
          {shown.map((d) => (
            <Draft key={d.id} roomId={room.id} draft={d} name={author(d.member).name} />
          ))}
        </div>
        <Composer room={room} threadId={parent.id} placeholder="Reply in thread — @ someone to ask them" files={files} />
        {drop.dragging && <DropOverlay to="the thread" />}
      </div>
    </SidePanel>
  );
}

export function RoomView({ room }: { room: Room }) {
  const all = useDesk((s) => s.timelines[room.id]) ?? NO_MESSAGES;
  const openThread = useDesk((s) => s.openThread);
  const drafts = useDesk((s) => s.roomDrafts[room.id]) ?? NO_DRAFTS;
  const files = usePendingFiles();
  const drop = useFileDrop(files.add);
  // The open thread, per room (and across launches): shown beside, as a
  // column of its own.
  const thread = useUi((u) => u.roomThreads[room.id] ?? null);
  const setRoomThread = useUi((u) => u.setRoomThread);
  const setThread = (id: string | null) => setRoomThread(room.id, id);
  const connected = useDesk((s) => s.connected);
  const scroller = useAnchoredScroll<HTMLDivElement>(`room:${room.id}`);
  const end = useRef<HTMLDivElement>(null);
  const main = useMemo(() => all.filter((m) => !m.threadId), [all]);
  const replies = useMemo(() => {
    const by = new Map<string, RoomMessage[]>();
    for (const m of all) if (m.threadId) by.set(m.threadId, [...(by.get(m.threadId) ?? []), m]);
    return by;
  }, [all]);

  const byThread = useMemo(() => draftsByThread(drafts, all), [drafts, all]);
  const shownDrafts = byThread.get(null) ?? NO_DRAFTS;
  const draftText = shownDrafts.map((d) => d.text.length).join();
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [main.length, shownDrafts.length, draftText]);
  // A thread put back on launch, or open while the hub restarted: its
  // replies are read (again).
  useEffect(() => {
    if (thread && connected) void openThread(room.id, thread);
  }, [room.id, thread, connected, openThread]);

  const author = useAuthor();

  return (
    <main className="room drop-target" aria-label={`Room ${room.name}`} {...drop.handlers}>
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
          const n = m.replyCount ?? replies.get(m.id)?.length ?? 0;
          const there = thread === m.id ? NO_DRAFTS : (byThread.get(m.id) ?? NO_DRAFTS);
          const names = (ds: RoomDraft[]) => [...new Set(ds.map((d) => author(d.member).name))];
          const replying = names(there.filter(answering));
          const stopped = names(there.filter((d) => d.state === "failed" || d.state === "interrupted"));
          return (
            <div key={m.id} className="room-msg">
              <RoomMessageView room={room} m={m} name={a.name} home={memberOf(m.author) ? a.home : undefined} />
              <button
                type="button"
                className="link small thread-link"
                onClick={() => setThread(m.id)}
              >
                {n ? `${n} repl${n === 1 ? "y" : "ies"}` : "Reply in thread"}
              </button>
              {replying.length > 0 && (
                <span className="small faint thread-replying">
                  {replying.join(", ")} {replying.length === 1 ? "is" : "are"} replying…
                </span>
              )}
              {stopped.length > 0 && <span className="small state-blocked thread-replying">{stopped.join(", ")} couldn’t answer</span>}
            </div>
          );
        })}
        {shownDrafts.map((d) => (
          <Draft key={d.id} roomId={room.id} draft={d} name={author(d.member).name} />
        ))}
        <div ref={end} />
      </div>
      <Composer
        room={room}
        threadId={null}
        placeholder={`Message ${room.name} — @ someone to ask them, or to bring them in`}
        files={files}
      />
      {drop.dragging && <DropOverlay to={room.name} />}
    </main>
  );
}

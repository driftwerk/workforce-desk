# Threads in a DM

Frame 5 of [agent-chat-mockups.html](agent-chat-mockups.html) is the spec. This note says how threads work, in the hub and in Desk, before they're built.

## What you see

- **Opening a thread:** Reply in thread (the hover bar, or T on a focused message) opens the thread beside the chat, the way a room's thread opens. The panel shows the parent message, a reply count, the replies, and a composer with "Also send to the chat".
- **In the main chat:** the parent shows "N replies · last 16:38", with the faces of who replied. Clicking it opens the thread.
- **Working at once:** the header says how many threads are working ("1 thread working"). The main chat and each thread can have a turn running at the same time.

## The model

**A thread is a conversation of its own.**
- Each thread is the agent's own session on a Desk channel of its own, `desk:thread:<parent id>`. The parent id is the id the hub keeps the parent message under.
- A thread turn therefore runs concurrently with the main DM's. The hub allows one live turn per session (`LiveTurns`) and no more, so this needs no new locking.
- A thread's turns never queue behind the main chat's, nor the main chat's behind a thread's.

**What the agent sees in a thread:**
- the thread's own session, which holds the thread so far
- the parent message and the chat up to it, sent by Desk with the turn as `context` lines, clamped by the hub as a room thread's are (`CONTEXT_LINES`, `CONTEXT_BYTES`)

Other threads stay out.

**Memory is shared.** Memory belongs to the agent and the person, not to a session, so what the agent learns in a thread it knows everywhere. No change is needed.

**Slack.** With thread isolation (the default), each Slack thread is already its own session (`slack:{workspace}:{channel}:{thread_ts}`). A Slack DM thread and a Desk DM thread are the same shape, one session per thread, and the same rule applies to both: one session per thread, with the parent as context.

## The hub (one PR)

**The thread's channel.**
- `DeskAnchor` gains `DmThread(parent)` for `desk:thread:<id>`.
- `DeskPlace::Dm` gains `thread: Option<String>`. It fits the anchor only when the two match.
- `is_desk_conversation` accepts the new channel, so `GET /api/desk/conversations/{agent}?channel=desk:thread:<id>` reads a thread like any Desk conversation.

**Marks.**
- `DeskMark.thread_of: Option<String>` (the parent id) is stamped on a thread's messages.
- `DeskMark.thread_copy: bool` is stamped on a reply also sent to the chat.

**Listing threads.** `GET /api/desk/conversations/{agent}/threads` lists the DM's threads: `{parent, replies, last_at, authors, working}`. Desk uses it for the reply counts and "N threads working".

**"Also send to the chat".** `POST /api/desk/conversations/{agent}/messages` with `{text, thread_of}` appends your reply to the main DM, both its transcript and its context, marked `thread_copy`. It starts no turn there, and it is refused only if the DM's session can't be written.

**The feature flag** is `desk.dm_threads`.

## Desk (one PR)

**Conversations.**
- A thread is a `Conversation` on its channel, kept in the chat store under `<agent key>#<parent id>`.
- Its history, queue and drain are the existing ones, keyed by that key. Each thread therefore has its own queue: Queue shows under the thread's composer, and its queue never holds the main chat.
- The panel reuses the room thread pane (`thread-body`, `ThreadBar` for the count) and the DM's scroll (`useStayPut`), so a thread stays where you're reading.

**Sending.** A thread turn is a DM turn with `place: {kind: "dm", thread}`. It carries context lines: the parent message and the chat before it, newest kept, as a room thread's do.

**Edit and delete** work in a thread as they do in the main chat, on the thread's own messages.

## With the queue

- **Separate queues:** each thread has its own queue, and the main chat has its own. Sending in a thread while the main chat is busy goes at once, and the reverse is true too.
- **Stop:** Esc and Stop in a thread stop that thread's turn and pause that thread's queue only.
- **Jump to latest:** the main chat's pill counts only main-chat messages. A reply also sent to the chat counts there once.

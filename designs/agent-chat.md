# Agent chat upgrades

The mockup is [agent-chat-mockups.html](agent-chat-mockups.html). Its frames and notes are the spec. The names in it are stand-ins.

These changes apply to a DM with an agent: `DirectMessage` and `DmComposer` in `src/rooms/Rooms.tsx`. Rooms already have a follow-the-end timeline, a jump pill, threads, search and a message action bar (`src/rooms/Timeline.tsx`, `unread.ts`, `ThreadBar`, `SearchPanel`, `MessageActions`). The DM reuses those pieces rather than adding a third version.

Each feature is its own PR, in this order. Hub PRs merge first, and Desk pins `hub.ref` to the hub's merge commit.

## The queue is not to break

When you send to an agent that's busy, the message waits in a queue under the composer (`src/chat/queue.ts`, `QueuedMessages`). It goes as the agent's next turn once the current one ends, merged with anything else queued. A queued item with a `sending` ticket is on its way and no longer yours to change. Every change below goes through the store's `putQueue`, so other windows see it, and keeps the existing queue tests green.

| Feature | With queued messages |
| --- | --- |
| Scroll and Jump to latest | Queued items aren't chat messages: the pill never counts them. The pill sits on the scroll pane, so a growing queue never hides it. When the queue grows or drains, a reader scrolled up stays put and a reader at the bottom stays at the bottom. When the queue drains, the message it sends moves no one. Only what you send yourself takes you to the end. |
| ↑ edit | With items queued and not yet on their way, ↑ edits the last one in place. It hasn't been sent, so the agent isn't asked again. |
| Edit the last sent message | Not offered while queued messages wait behind it or the agent is replying. The UI says why. |
| Delete | Deleting a queued message takes it out of the queue. |
| Threads | Each thread has its own queue, and a thread's queue never holds up the main chat's. |

## 1. Scroll stays put, and Jump to latest

**The bug.** The DM scrolled to its end on every change, and it kept your place only for an earlier page, measured from the bottom. A few things moved what you were reading with nobody touching the scroll:

- Content above you changing height after it rendered. This covers a table, image or code block finishing drawing, and a kept copy replacing a live one. Desk's macOS webview (WebKit) has no native scroll anchoring, so the text slides down. Chrome hides this.
- An earlier page landing while the reply grew below. The position was restored by distance from the bottom, so it came back wrong.
- A saved reading place re-applied on open, for up to five seconds, against the follow-to-end.

**The fix.**

- The DM follows the end only when you're already there. That includes height changes no message caused, through a ResizeObserver on the list.
- Scrolled up, the first row in sight keeps its offset through any change of height above or below it.
- The pane sets `overflow-anchor: none`, so Chrome and WebKit do the same thing.
- What you send yourself takes you to the end.

**Jump to latest.** The pill shows whenever you're scrolled up, with a count of the agent's messages that arrived below you. Click it or press End (outside a text field) to go to the latest. Coming back to a DM with unread messages opens at a "New" line.

## 2. ↑ edits your last message, and re-asks

In an empty composer, ↑ opens your last message for editing. Saving replaces it, marks it "(edited)", sets aside the agent's reply to it, and asks again. If that reply took actions, the edit box lists them, and the agent is told they happened. This needs the hub to replace a turn, as a hub PR.

## 3. Delete your own messages

Delete is confirmed in place. The message leaves the chat and the agent's history. Memories saved from it are listed, with "also forget" ticked. The agent's reply stays, marked "answered a deleted message". This needs a hub PR.

## 4. ⌘F search

Search covers the whole history, on the hub. Results are listed on the right, newest first. Choosing one loads the chat around it and highlights the match.

## 5. Threads in a DM

Reply in thread opens a side panel. Each thread runs its own turn, with the parent message, the thread, and the chat up to that point as context. "Also send to the chat" posts the reply in both places. Memory is shared. Slack DM threads map to these one to one. The hub needs DM replies to carry a thread id. This one gets its own design note before it's built.

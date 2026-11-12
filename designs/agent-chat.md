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

In an empty composer, ↑ opens your last message for editing. Edit on the message's hover bar does the same.

What ↑ edits depends on the queue:

1. **A message waiting in the queue, not yet on its way:** ↑ edits the last such message in place, the way the queue's own Edit does. It hasn't been sent, so nothing is asked again.
2. **Otherwise, your latest sent message:** the composer becomes the edit box, labelled "Editing your last message". This is only possible once the agent has finished replying and nothing queued is waiting behind it. When it isn't possible, ↑ and Edit say why instead ("…once Desk has finished replying", "…once your queued messages have gone"). A message the hub hasn't kept yet waits the same way.

**The edit box.** If the reply being set aside took actions (its steps), the box lists them first, with a note that editing won't undo them. Esc or Cancel leaves the edit. "Save and ask again" sends the new text as a DM turn carrying `edit: { replaces: <kept id> }` on a hub with `desk.edit`. The hub then does three things:

- It sets aside your old message and everything after it, in the transcript and in the agent's context.
- It tells the agent what the set-aside reply had done.
- It marks the new message `edited`, so it reads "(edited)".

Desk hides the set-aside messages as soon as you save, and the hub's next read leaves them out.

**On an older hub** (no `desk.edit`), ↑ only edits queued messages, and the last sent message offers no Edit.

## 3. Delete your own messages

Hover a message you sent and choose Delete. You confirm in place, under the message, with no pop-up: "Delete this message? It leaves this chat and everything {agent} sees from now on."

- **Memories:** Desk asks the hub which memories the agent saved from the message. It lists them, with "Also forget what {agent} saved from it" ticked.
- **On confirm:** Desk calls the hub. The hub refuses while a turn is running in the DM.
  - The message leaves the transcript.
  - In the agent's context, its words are replaced by a note that you deleted it, so the turns around it stay well formed and the words can't come back in a later turn.
  - The replies to it are marked `answered_deleted`, and the ticked memories are forgotten.
- **What Desk shows:** Desk hides the message at once. Each reply to it stays, with a note that it "answered a deleted message".
- **What can't be deleted:** the agent's own messages, a message the overseer sent on, and a command.
- **On an older hub** (no `desk.delete`), no Delete is offered.

### With the queue

- **Deleting a queued message** takes it out of the queue: the queue's own × does this, and nothing reaches the hub.
- **While the agent is replying,** a sent message can't be deleted. Delete says "…once {agent} has finished replying", because its turn may still be reading it.
- **Queued messages waiting** don't block deleting an earlier message. The queue is untouched.

## 4. ⌘F search

⌘F in a DM, on a hub with `desk.search`, opens a bar over the chat and the matches beside it.

**Where it searches.** The search runs on the hub (`GET …/conversations/{agent}/search?q=`), over the DM's whole history. That includes what isn't loaded and what was said from another device.

**The results.**
- Matches are listed newest first, with older pages on request.
- ↑ ↓, Enter and Shift+Enter step through them. Esc or Done closes the search.

**Choosing a match.**
- **Already shown:** the chat scrolls to it and holds it there.
- **Not shown:** Desk reads the stretch of the DM around it (`?around=<id>`) and shows that instead of the newest messages, under "Viewing older messages · Jump to latest". Edit and Delete aren't offered there.

**Marking.** The words found are marked in place with the CSS Custom Highlight API, so the messages' own rendering is untouched. The chosen match is marked strongest.

**With the queue.** Searching never touches it: queued messages stay queued, and go when the turn ends. While you're looking around a match, what's sent shows once you're back at the latest. Jump to latest and End leave the stretch around a match.

## 5. Threads in a DM

Reply in thread opens a side panel. Each thread runs its own turn, with the parent message, the thread, and the chat up to that point as context. "Also send to the chat" posts the reply in both places. Memory is shared. Slack DM threads map to these one to one. The hub needs DM replies to carry a thread id. This one gets its own design note before it's built.

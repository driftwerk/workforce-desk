# Talk across views: the header pill

You start talking with Kat in her DM, then open the Floor, a grid or a board. The conversation should keep going until you press End, use the Talk here shortcut, or a microphone problem stops it. While it's live, a pill in the title strip says who you're talking to and what's happening.

## Why it ends today

`useDmPresence` (src/voice/dms.ts) records which DMs are mounted. When the last mount of an agent's DM goes, it calls `forget(agent)` (src/voice/mic.ts) on the next microtask. `forget` sets `talk: null`, so switching views unmounts `Rooms` (or a grid pane), and that ends the conversation. Two tests pin this behaviour:

- dms.test.tsx: "lets the microphone go when the last DM showing its agent goes".
- mic.test.ts: "is let go by a DM that isn't shown any more".

Nothing on the Rust side ends a claim on its own. `voice_claim` only stores the mode it is given.

## The fix

A DM going away no longer touches the microphone. `useDmPresence` keeps only what it's for: which DMs are shown (now also published to a store) and which one was focused last. The pending microtask still prunes `recent`.

The microphone can still be let go in two situations:

- **A hold button unmounts while it's pressed.** The button's own hook releases it, through `endHold`, so the engine also gets `pushToTalk(false)`. Today `forget` drops the state but never tells the engine.
- **The agent leaves the roster.** `useVoice` watches the roster. Once the agent's hub has been read without it (no `rosterErrors` entry for that hub), or the hub is gone, it calls `forget(agent)`. A hub that couldn't be read keeps the conversation going. That clears `talk`, `hold`, `pressed`, `problem` and `muted` for that agent. `forget` keeps its name, and its doc now says it's for an agent that's gone.

`Turns.heard` sends to the microphone's owner through `useChat.send`. That needs the agent's live conversation. So when the owner isn't shown anywhere, `heard` calls `chat.watchDm(key)`, which connects without navigating, before sending. A conversation switched to an agent whose DM was never opened then still reaches it.

`talkOrEnd` in another agent's DM moves the conversation there (`switchConversation`). `talkHere` with no target DM now ends the live conversation (`endConversation(talk)`). The existing shortcut then works from every view.

## The mic store (mic.ts)

New fields:

- `muted: boolean`
- `since: number | null` — when this conversation started
- `from: string | null` — the agent it was moved from, or null when it started in its own DM

New and changed actions:

- `toggleTalk(agent)`: as before. On start it sets `since: Date.now()`, `from: null` and `muted: false`. On end it clears all three.
- `switchTalk(agent)`: one atomic `setState` that sets `talk: agent`, `since: now`, `from: the previous talk`, `muted: false` and `problem: null`. The microphone never passes through `null`, so voice by name doesn't wake up between the two agents.
- `toggleMute()`: flips `muted`, only while `talk` is set.
- `dismissProblem()`: sets `problem: null`.
- `micFailed(owner, message)`: also clears `muted`, `since` and `from`, and records whether a talk or a hold failed (`problem.mode`). Only a talk's failure shows in the pill, and only a talk is retried.

`claimMode` with mute:

| hold | talk | muted | mode |
|---|---|---|---|
| set, equal to talk | set | no | `open` |
| set, equal to talk | set | yes | `held` |
| set, another agent | any | any | `held` |
| none | set | no | `open` |
| none | set | yes | `held` (push to talk only; voice by name stays paused) |
| none | none | – | `held` while replying, else `null` |

`useVoice.ts` gets these exports:

- `switchConversation(agent)`: hushes the old agent, calls `switchTalk(agent)`, then `stopSpeaking()`.
- `talkHere` falls back to ending the conversation.
- A `muteTalk` app shortcut that calls `toggleMute`.

### The shortcut

| | |
|---|---|
| id | `muteTalk` |
| Name | "Mute" |
| About | "Mutes or unmutes your microphone in a spoken conversation, without ending it." |
| Keys | `Control+Shift+O` (⌃⇧O on macOS, Ctrl+Shift+O on Windows and Linux) |
| Scope | `app` |
| Terminal | `terminal: false` |

The key is clash-free on all three platforms. ⌥M from the mockup can't be used: an Alt-only app shortcut is refused because it would stop you typing.

## View model (view.ts)

`talkView(mic, status, waiting, speakingFor, permission)` is a pure function. It returns `TalkView | null`:

```ts
{ agent: string; tone: "live" | "busy" | "muted" | "problem"; line: string; elapsed: boolean; speaking: boolean }
```

It returns null when neither `talk` nor `problem` is set. Otherwise the first matching row in this table decides the result (first match wins). `elapsed` is true only in the "Listening" row.

| Condition | Line | Tone |
|---|---|---|
| A problem | "Microphone blocked — fix" for a permission problem, else "Microphone problem — fix" | problem |
| `status.state` is `downloading` | "Getting voice ready · 40%" | busy |
| `status.state` is `off` | "Starting…" | busy |
| Speaking for this agent | "Speaking" (shows Stop reply) | live |
| Its hold is pressed | "Listening — let go to send" | live |
| Waiting on this agent | "Thinking…" | busy |
| Transcribing, or its hold has been released | "Transcribing…" | busy |
| Muted | "Muted — tap to talk" | muted |
| Another agent's hold has the microphone | "Paused" | muted |
| Otherwise | "Listening" | live |

The pill appends "· m:ss" to "Listening".

`dmVoiceView` gains a "Muted" line for its own talk when it's muted ("You're muted", detail "Unmute to talk again"). Pure helpers live beside these:

- `clock(ms)` formats a duration as "m:ss".
- `lastExchange(messages, since)` returns your last message and the agent's reply after it, both sent since `since`, as strings or null.

## Components

### src/voice/TalkPill.tsx (new): `TalkPill`

- Mounted once in App, in a new title strip slot. It renders nothing where voice doesn't run here (`useVoiceStore.here`) and when `talkView` is null.
- It finds the agent's name from the roster (`useAgentName`, shared with VoicePill) and uses its key as a fallback, so a live microphone is never hidden.

**The full pill** is a `role="group"` labelled "Talking with Kat". Left to right:

1. **Name button.** `AgentMark` (xs) and the name. It opens the agent's DM: close Settings, then `openTarget({kind: "agent"})`.
2. **Status button.** The meter (live tone only) and the line, with `<Elapsed since>` while listening. `aria-haspopup="dialog"` and `aria-expanded`. Clicking it opens the popover, or unmutes when muted ("tap to talk").
3. **Stop reply** (`.btn` small), while speaking.
4. **Mute** icon button. Its label changes (no `aria-pressed`, so it is never read as "Unmute, pressed"): "Mute your microphone" or "Unmute your microphone"; the title shows its shortcut.
5. **▾** icon button, "Conversation options". Opens a `Menu` with `useTalkEntries`, computed once in the pill and passed to the popover.
6. **End** (`.btn-signal`). Calls `endConversation`.

For the problem state there's no Mute, and End becomes Dismiss.

A visually hidden `<span role="status" aria-live="polite">` says the line without the elapsed time, so screen readers aren't told every second.

**The dot.** When the talking agent's DM is shown in the window, the pill shrinks to a single 26px button containing a dot in the tone's colour. It opens the same popover. Its label is "Talking with Kat: conversation controls".

**The popover** (`Popover`, centred under the whole pill via its new `anchor`, following it as the pill's width changes; focus goes back to the button that opened it):

- **Head.** The agent's mark (md), "Talking with Kat", "Started in the DM · m:ss" or "Moved from Ash · m:ss", and an "Open DM" link.
- **Last exchange.** "You · …" and "Kat · …", or "Nothing said yet". It reads `conversations[talk]` with a selector that returns the two strings, inside the popover only, so streaming re-renders only the open popover.
- **Problem.** `ProblemNote` with `permissionProblem` and a "Try again" button (`toggleTalk(agent)`). `useRecheckOnFocus("microphone")` retries once access is granted.
- **Buttons.** Mute or Unmute (`.btn`), Hold to talk (`.btn`, the shared hold handlers), End (`.btn-signal`). All 44px tall.
- **Choices.** `MenuRows` over `useTalkEntries`.

**`useTalkEntries(agent, name)`**:

- `answerEntries` (aloud / in writing)
- `useAudioEntries()`
- "Switch to" with a submenu of the other roster agents, each with its hub when names repeat. Choosing one calls `switchConversation`.

**`MenuRows` (new, in src/ui/Menu.tsx).** It shows a menu's entries as a list of rows in place. Each row is a 44px button with the same body as a `Menu` item (`ItemBody`, shared). Radio entries sit in a `radiogroup` as `role="radio"`; a row with a submenu opens a `Menu` under it.

### DmVoice.tsx

- `answerEntries(agent, name, written)` replaces the two inline copies. It's used by the controls' menu, `useDmVoiceEntries` and `useTalkEntries`.
- `useAudioEntries` is exported.
- `useHoldButton(agent)` returns the pointer and key handlers the DM's hold button and the popover's share. It also releases the hold if it unmounts while pressed.
- `DmVoiceBar` gains a Mute or Unmute link beside End.
- `MicBadge` takes an optional `className`, so the sidebar can style it.
- `MicIcon` is exported from DmVoice. TalkPill and VoicePill import it instead of keeping their own copies.

### Settings/Audio.tsx

`useLevel(onFill)` holds `LevelMeter`'s 10 Hz polling, and both meters use it. The pill reads the engine's own microphone through `voice_audio_level`. It never opens a meter stream (no `audioMeter`).

### Popover.tsx

- New `align?: "end" | "center"`, defaulting to `"end"` as today.
- A mousedown or Escape inside a `[data-menu]` element is left to that menu, so device submenus work inside the popover.
- `onClose` is read through a ref, and the first control takes focus only when the popover opens, so a re-render never moves focus (a held Hold to talk stays held).
- It goes above its anchor only when it fits there; fitting neither way, it's kept on screen.

### dms.ts

- `useDmShown(agent)` is a hook backed by a zustand store of shown agents. The store updates when the first DM for an agent mounts and when the last one unmounts.
- A DM going is published in the same microtask that prunes `recent`, so a pane moving doesn't flicker the dot.
- It counts mounted DMs only: Rooms' DM, a grid pane, and the Floor's side panel. Each of these has its own `DmVoiceBar`, so the dot never hides something you can't see elsewhere.

### Sidebar crew rows (src/groups/SidebarGroups.tsx)

`ItemRow` adds `<MicBadge agent className="gi-mic" />` to the agent rows' trail. `.gi-mic` is a bare 14px mic in `--signal-soft-text`.

### VoicePill

VoicePill is about voice by name. While a conversation is live, `pillView` no longer says "Kat has the mic", because the header pill says that. It now says:

- "Voice by name is paused" / "While you talk with Kat", if voice by name is on.
- Its normal off state, if it's off.

A hold without a talk still shows as today, because the header pill only shows talks.

## Where the pill sits

**macOS.** A fixed slot centred in the 28px `.titlebar` strip (`.title-slot`, z-index 31, `pointer-events: none` except on its children). It holds `TalkPill` and, on macOS only, `BrowserPill place="titlebar"`, side by side. `.browser-pill-titlebar` loses its own fixed position. The pill is 26px tall at `top: 1px`, so the strip's height doesn't change. The slot is a sibling of the drag strip, so a press on the pill never drags the window, and nothing stops a press from closing an open menu.

**Windows and Linux.** The same slot at the same place. Floor, Rooms, Settings and the sidebar already pad their tops by 30–34px; Grids, which padded only on macOS, now leaves the strip's 28px on every system. BrowserPill stays in its band there.

The popover is portaled to `body` and anchored under the pill. Nothing below it moves.

## Styles (voice.css, tokens only)

**The pill** (`.talk-pill`): 26px tall, `border-radius: 999px`, 1px border.

| Tone | Background | Border | Text |
|---|---|---|---|
| live | `--signal-soft` | `--signal` | `--signal-soft-text`; status `--muted` |
| busy | `--raised` | `--working` | status `--working` |
| muted | `--raised` | dashed `--faint` | `--muted` |
| problem | `--blocked-soft` | `--blocked` | `--blocked`; the mark becomes a "!" disc in `--blocked` / `--on-blocked` |

**The meter** is five 2px bars in `--signal`, scaled by a `--level` custom property set on its element. The pulse respects `prefers-reduced-motion`.

**The popover** is `.popover.talk-pop`, 380px wide. The exchange box and the popover's plain buttons use `--surface`, with `--radius-sm`. The muted pill greys the agent's mark. "You ·" is `--faint` and "Kat ·" is `--signal-soft-text`. The buttons are `.btn` and `.btn-signal` at `min-height: 44px`, and the rows are 44px tall.

## Tests

- **mic.test.ts**
  - The `claimMode` table, mute included.
  - `switchTalk` moves the conversation without passing through null.
  - Mute is cleared on end, on switch and on `micFailed`.
  - `forget` drops talk, hold and problem for a gone agent.
- **dms.test.tsx**
  - The DM going leaves `talk` as it was (the inverted test).
  - `useDmShown` follows mounts.
- **view.test.ts**
  - Every `talkView` row.
  - `clock` and `lastExchange`.
  - `pillView` while a talk is live.
- **TalkPill.test.tsx**
  - Hidden with no talk.
  - The states' lines.
  - The name opens the DM.
  - Mute toggles, and the claim follows.
  - End ends it.
  - Dot in the agent's DM.
  - The popover opens and closes on Esc (focus goes back) and on an outside click, and stays open while its device submenu is used.
  - The last exchange.
  - Switch to.
  - Problem with Try again and Dismiss.
- **useVoice (turns.test.ts or DmVoice.test.tsx)**
  - Talk here with no DM ends it.
  - The mute shortcut.
  - An utterance for a talk whose DM isn't shown is sent through `watchDm`.
  - An agent leaving the roster ends its talk.
- **Popover**: `[data-menu]` clicks are ignored.
- **Sidebar**: the mic mark on the talking agent's row.
- **keys.test.ts**: the defaults include `muteTalk`.

The rules: no TODOs or partial work, comments only where they're needed, and no duplicated code.

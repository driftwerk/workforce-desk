# Opening a page for the person

**The bug.** Someone asked their overseer to "open my Chrome to staging.example.com". The agent called `browser.navigate`, which loaded the page in its own tab in Desk's window. That window opens unfocused, so the page never came to the front. When the turn ended, `browser::turn_ended` closed the tab. The agent said it was done, and the person saw nothing.

**The fix.** Opening a page *for* the person is a hand-over, and it gets its own tool.

## `browser.open_for_me`

The tool is separate from `browser.navigate` and isn't a flag on it. The model chooses by the tool's name and description, so the two descriptions split the cases:

- **navigate** is "browse for yourself". It opens your own tab, which may be out of sight and closes when your turn ends.
- **open_for_me** is for "open X for me", "show me X" and "open my Chrome to X". The page opens in front of the person and is theirs from then on.

A separate tool also gives the gate, the activity list and the tests one name to key on.

The flow:

1. **Every check navigate makes.** The call goes through the same path in the agent's own tab, where it is still hidden:
   - only web pages;
   - never the hub's own port;
   - the person's site list (allowed and never);
   - the gate's per-site visit decision (`chrome-visit:<origin>`, so `computer::navigates` includes the tool);
   - the check on where a redirect lands;
   - the activity record with its picture.

   Anything refused stops here, before the person sees anything.
2. **`hand_over`.** This is a new extension command, and the last thing the call asks of that tab. The extension:
   - moves the tab, out of Desk's group, into the person's own window. That is the normal window they used last that isn't Desk's. If they have only Desk's window, it opens a new normal window for the tab.
   - makes the tab active and focuses its window. A minimised window is restored, because the person asked to see the page. Otherwise the window keeps its size.
   - drops the tab from its sessions and from what Desk's pages opened. Desk never closes it, drives it or adopts its popups again. Desk's window closes once it holds no session.
   - reads back from Chrome whether the tab is active and its window is focused and not minimised. It retries for up to 1.5 s, because focus lands a moment late.
3. **The hub lets go.** The cell's tab is marked closed. That means:
   - the turn's end closes nothing;
   - the tab is gone from the live indicator;
   - the next agent call opens a fresh tab in Desk's window;
   - what the page read is forgotten the way a closed tab's is, and a hostile page still holds the agent back.

## Its own window, not Desk's

Settings → Browser promises Desk works "in a window of its own in your Chrome, never in your other tabs". We considered raising Desk's window and leaving the tab there. That leaves the person's page inside Desk's window and group. It also means the next Stop, or the last session closing, would close the window under them.

Moving the tab into their window makes the page plainly theirs. Desk lets go in the same step, so the promise still holds: Desk never works in a tab that's theirs.

## Fail closed

The tool succeeds only on `{handed: true, active: true, focused: true}`.

| What comes back | What the agent is told | What happens to the tab |
| --- | --- | --- |
| Chrome failed, or there was no tab | An error with Chrome's reason: "tell them it wasn't shown". | Still the agent's, so it closes at the turn's end as usual. |
| An answer without `handed` (an extension older than the hub answers an unknown command with nothing) | "Desk's extension is out of date, it wasn't shown." | Still the agent's. |
| Moved, but Chrome didn't confirm it's in front (on macOS another app can keep the focus) | "It's open as a tab in their Chrome but not confirmed in front: tell them to switch to Chrome, don't say it's showing." | Moved, so it's theirs and isn't closed. |

## What the person sees

In Settings → Browser → What it did, the row reads "Opened staging.example.com for you". The hub writes that line and Desk shows it as it comes.

## PRs

1. **Hub:**
   - the tool;
   - `navigates`;
   - the hand-over in the browser adapter;
   - the activity line;
   - `hand_over` in the protocol fixture.

   Tests cover:
   - the hand-over tab surviving `turn_ended` while a browsed tab is closed;
   - each failure reported plainly;
   - a page on the never-list, or that redirects somewhere it may not go, never handed over.
2. **Desk:**
   - `hand_over` in the extension, with tests;
   - this note;
   - the same fixture;
   - `hub.ref` pinned to the hub's merge.

// Moving something to another group: one way in from every place that moves
// one (the sidebar's drag, menu and keys, a pane's menu, a Floor tile, a
// board card, a room's details and a boss's settings), and one dialog
// (MoveDialog.tsx). What only rearranges the sidebar happens at once; what
// crosses from one boss's part of Desk to another's is previewed by the hub
// and asked about first, and nothing of it moves until the person says Move.

import { create } from "zustand";
import { useChat } from "../chat/store";
import { useCharges } from "../crew/chargeStore";
import type { Agent, HubAccount } from "../chat/types";
import { HubError } from "../hub/client";
import { movesOf, NO_CHOICES, type MoveChoices, type MoveItem, type MovePreview } from "../hub/moves";
import { useDesk } from "../hub/store";
import type { Manager, Ticket } from "../hub/types";
import { useBoard } from "../board/store";
import { useOverview } from "../overview/store";
import { bossOfGroup, isSealed } from "./bosses";
import { useHubLayout } from "./hubLayout";
import { sessionItem, UNGROUPED } from "./model";
import { currentLayout } from "./store";

/** What is moved, with what the dialog calls it and the group it is in
 *  now (`ungrouped` for none). */
export type MoveSubject =
  | { kind: "session"; id: string; name: string; from: string }
  | { kind: "ticket"; id: string; name: string; from: string }
  | { kind: "room"; id: string; name: string; from: string }
  | { kind: "boss"; id: string; name: string; from: string }
  /** An agent's row: the hub keeps no move of its own for one, so only its
   *  place in the sidebar changes, through `apply`. */
  | { kind: "agent"; agent: Agent; name: string; from: string };

/** A move asked for. */
export interface MoveAsk {
  subject: MoveSubject;
  /** Where to, when it was chosen already (a drag, a menu's group). */
  to?: string | null;
  /** The hub's preview of it, when one was made on the way in. */
  preview?: MovePreview;
  /** Makes an agent's move in the sidebar. */
  apply?: (to: string) => void;
  /** Once it moved: puts it where it was dropped among its new group's. */
  placed?: (to: string) => void;
}

interface MoveState {
  asking: MoveAsk | null;
  open: (ask: MoveAsk) => void;
  close: () => void;
}

export const useMove = create<MoveState>((set) => ({
  asking: null,
  open: (asking) => set({ asking }),
  close: () => set({ asking: null }),
}));

/** The sidebar group sidebar item `key` is in now (`ungrouped` for none). */
export const groupOfKey = (key: string): string => currentLayout().groups.find((g) => g.items.includes(key))?.id ?? UNGROUPED;

/** A session of this computer's hub, as the move dialog moves it. */
export const sessionSubject = (id: string, name: string): MoveSubject => ({ kind: "session", id, name, from: groupOfKey(sessionItem(id)) });

/** A ticket, as the move dialog moves it: from its board's group. */
export const ticketSubject = (t: Ticket): MoveSubject => ({
  kind: "ticket",
  id: t.id,
  name: t.key ?? "this ticket",
  from: useBoard.getState().boards[t.board]?.group ?? UNGROUPED,
});

/** Whether moves can be made here: this computer's hub keeps the groups. */
export const canMove = (): boolean => useHubLayout.getState().layout !== null && !!localAccount();

/** Opens the move dialog for `subject`, its group still to be chosen
 *  unless `to` is. */
export const askMove = (subject: MoveSubject, to?: string | null): void => useMove.getState().open({ subject, to });

/** This computer's hub, as the person reaches it. */
export const localAccount = (): HubAccount | undefined => useChat.getState().hubs.find((h) => h.local);

/** The hub's item for `subject`; none for an agent's row. */
export const itemOf = (subject: MoveSubject): MoveItem | null => (subject.kind === "agent" ? null : { kind: subject.kind, id: subject.id });

/** A group as the hub's routes name it: none for Ungrouped. */
export const hubGroup = (group: string | null | undefined): string | null => (!group || group === UNGROUPED ? null : group);

/** What a session's move asks first: its ticket goes along (as the design
 *  has it), its new boss runs it. */
export const FIRST_CHOICES: MoveChoices = { ...NO_CHOICES, ticketGoes: true };

/** The boss whose part of Desk `group` is (its agent id): the group's own,
 *  the main boss for one with none, and no one for a sealed one. */
export const scopeBoss = (manager: Manager | null, group: string): string | null => {
  if (group !== UNGROUPED) {
    const own = bossOfGroup(manager, group);
    if (own) return own.agentId;
    if (isSealed(manager, group)) return null;
  }
  return manager?.agentId ?? null;
};

/** Moves a sidebar row from `from` to `to`. A session of this computer's
 *  hub is previewed first: when that crosses from one boss to another, the
 *  dialog asks, and nothing moves unless the person says so; otherwise (or
 *  for an agent's row, a machine's session, or a hub too old to preview)
 *  `layout` makes the move in the sidebar as before. */
export async function moveRow(
  subject: MoveSubject,
  to: string,
  layout: () => void,
  placed?: (to: string) => void,
): Promise<void> {
  if (subject.from === to) return layout();
  if (subject.kind === "agent") {
    const manager = useOverview.getState().manager;
    // The same boss on both sides: only the sidebar changes.
    if (scopeBoss(manager, subject.from) === scopeBoss(manager, to)) return layout();
    return useMove.getState().open({ subject, to, apply: () => layout() });
  }
  const hub = localAccount();
  const item = itemOf(subject);
  // Groups Desk keeps itself (no hub keeps them) have no bosses to cross.
  if (!hub || !item || !useHubLayout.getState().layout) return layout();
  let preview: MovePreview;
  try {
    preview = await movesOf(hub).preview(item, hubGroup(to), subject.kind === "session" ? FIRST_CHOICES : NO_CHOICES);
  } catch (e) {
    // A hub from before moves were previewed moves it as it did.
    if (e instanceof HubError && (e.status === 404 || e.status === 405)) return layout();
    // Nothing else is moved blind: the dialog says why.
    return useMove.getState().open({ subject, to, placed });
  }
  if (preview.effects.length === 0 && !preview.blocked) return layout();
  useMove.getState().open({ subject, to, preview, placed });
}

/** Whatever a move changed, read again: who oversees what, the Floor, which
 *  sessions bosses run, and a moved room's group. */
export const afterMove = async (kind: MoveSubject["kind"]): Promise<void> => {
  const s = useOverview.getState();
  await s.loadManager().catch(() => {});
  if (s.overviewSupport === "yes") void s.loadOverview();
  void useCharges.getState().load().catch(() => {});
  const hub = useDesk.getState().hub;
  if (kind === "room" && hub)
    void hub
      .rooms()
      .then((rooms) => useDesk.setState((d) => ({ rooms: { ...d.rooms, ...Object.fromEntries(rooms.map((r) => [r.id, r])) } })))
      .catch(() => {});
};

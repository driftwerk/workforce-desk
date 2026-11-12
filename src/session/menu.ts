// What a session offers in its ⋯ menu, wherever it shows: the side panel
// and a grid pane build theirs from this one list, each adding its own
// (where it shows, and taking it away).

import { useChargeActions } from "../crew/ChargeBadge";
import { OWN_SIGN_IN_LABEL, accountsOf, accountsOn, hasAccounts, ownSignInWorks } from "../engines/accounts";
import { askMove, canMove, sessionSubject } from "../groups/move";
import { useSessionNames } from "../groups/names";
import { canHandOff } from "../handoff/LineageChips";
import { askHandoff } from "../handoff/store";
import { LOCAL, machineOf, sessionKey } from "../hub/machines";
import { hubFor, useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { useLinePanel } from "../line/panel";
import type { MenuEntry } from "../ui/Menu";
import { approvalsSwitchable, lifecycleActions, sessionActions, setApprovalsInDesk } from "./actions";

/** A session's menu in its parts, each in the order it shows. */
export interface SessionMenu {
  /** Stop, Continue in…, Account, Move to group…, Edit goal…, Messages
   *  with Desk…, Answer approvals in Desk. */
  session: MenuEntry[];
  /** Who runs it: I'll drive, Hand back, Release, Hand to … */
  driver: MenuEntry[];
  /** End session…, Remove… or Stop tracking… */
  lifecycle: MenuEntry[];
}

/** The session's own entries. `onEditGoal` edits its goal where it shows. */
export function useSessionMenu(session: Session | null | undefined, { onEditGoal }: { onEditGoal?: () => void } = {}): SessionMenu {
  const names = useSessionNames();
  const charge = useChargeActions(session);
  // The accounts of the engine the session runs on: a machine's are its own.
  const accountStore = accountsOn(session ? machineOf(session) : undefined);
  const allAccounts = accountStore((s) => s.accounts);
  // Where Claude Code says it isn't logged in, its own sign-in is no choice.
  const ownWorks = accountStore((s) => ownSignInWorks(s.claudeSignIn));
  if (!session) return { session: [], driver: [], lifecycle: [] };
  const fail = useDesk.getState().fail;
  // Another account for a session Desk started (one in a terminal of its
  // own is moved there).
  const accounts = hasAccounts(session.caps) && !session.terminalId && session.origin === "desk" ? accountsOf(allAccounts, session.engine) : [];
  const onAccount = (to: string | null) => void hubFor(session)?.switchAccount(session.id, to).catch(fail);
  const account: MenuEntry[] = [
    // Only an account whose sign-in the hub can read is one to move to.
    ...accounts
      .filter((a) => a.signedIn || session.account?.id === a.id)
      .map((a): MenuEntry => ({ kind: "item", label: a.name, checked: session.account?.id === a.id, onSelect: () => onAccount(a.id) })),
    ...(ownWorks || session.engine !== "claude" ? [{ kind: "item" as const, label: OWN_SIGN_IN_LABEL, checked: !session.account, onSelect: () => onAccount(null) }] : []),
  ];
  // Interrupt and Resume are the header's own button; Stop, which ends the
  // process, is only here, away from closing the panel.
  const stop = sessionActions(session).filter((a) => a.label === "Stop");
  return {
    session: [
      ...stop.map((a): MenuEntry => ({ kind: "item", label: a.label, onSelect: a.run })),
      ...(canHandOff(session) ? [{ kind: "item" as const, label: "Continue in…", onSelect: () => askHandoff({ id: session.id }) }] : []),
      ...(accounts.length ? [{ kind: "item" as const, label: "Account", submenu: account }] : []),
      // This computer's session moves between groups as the hub previews it.
      ...(machineOf(session) === LOCAL && canMove()
        ? [{ kind: "item" as const, label: "Move to group…", onSelect: () => askMove(sessionSubject(session.id, names[session.id] ?? session.displayName ?? session.name)) }]
        : []),
      ...(onEditGoal ? [{ kind: "item" as const, label: session.goal ? "Edit goal…" : "Add a goal…", onSelect: onEditGoal }] : []),
      ...(session.view !== "desk"
        ? [{ kind: "item" as const, label: "Messages with Desk…", onSelect: () => useLinePanel.getState().show(sessionKey(session), "history") }]
        : []),
      ...(approvalsSwitchable(session)
        ? [
            {
              kind: "item" as const,
              label: "Answer approvals in Desk",
              checked: session.approvals === "desk",
              onSelect: () => setApprovalsInDesk(session, session.approvals !== "desk"),
            },
          ]
        : []),
    ],
    driver: charge.map((a): MenuEntry => ({ kind: "item", label: a.label, disabled: a.busy, onSelect: a.run })),
    lifecycle: lifecycleActions(session).map((a): MenuEntry => ({ kind: "item", label: a.label, onSelect: a.run })),
  };
}

/** Sections, separated, leaving out the empty ones. */
export const sections = (...parts: MenuEntry[][]): MenuEntry[] =>
  parts.filter((p) => p.length).flatMap((p, i) => (i ? [{ kind: "separator" as const }, ...p] : p));

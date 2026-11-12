// A session's chrome, the same wherever it shows (the side panel, a grid
// pane): two rows over what it shows. The first says who and where it is,
// then its one state action and the host's own buttons; the second what it
// is for, then who runs it, what it spent and its tabs. The rest is in its
// ⋯ menu.

import { useId, useState, type HTMLAttributes, type ReactNode } from "react";
import { SessionTicketChip } from "../board/TicketChip";
import { DriverChip } from "../crew/ChargeBadge";
import { CostChip } from "../spend/SpendStrip";
import { switchingText, withAccount } from "../engines/accounts";
import { ENGINE_TITLE } from "../engines/engines";
import { lookOf, statusOf } from "../floor/background";
import { nameParts } from "../grids/head";
import { sessionItem } from "../groups/model";
import { GroupChip } from "../groups/GroupChip";
import { machineOf, sessionKey } from "../hub/machines";
import { hubFor, useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { OnMachine } from "../machines/OnMachine";
import { Mark } from "../ui/Mark";
import { Menu, type MenuEntry } from "../ui/Menu";
import { homeShort } from "../ui/paths";
import { sessionActions } from "./actions";
import { GoalText } from "./GoalText";
import { sections, useSessionMenu } from "./menu";
import { STATE_LABEL } from "./words";

export type SessionTab = "session" | "memory" | "history";

export const TABS: readonly { id: SessionTab; label: string }[] = [
  { id: "session", label: "Session" },
  { id: "memory", label: "Memory" },
  { id: "history", label: "History" },
];

/** The ids a tab and its panel are known by. */
export const tabId = (ids: string, tab: SessionTab): string => `${ids}-${tab}-tab`;
export const panelId = (ids: string, tab: SessionTab): string => `${ids}-${tab}`;

/** What a session is and where it runs, in a line: engine and account,
 *  what Desk set for it, and its branch or folder. */
export const whereText = (s: Session): string =>
  [
    withAccount(ENGINE_TITLE[s.engine], s),
    switchingText(s),
    s.mode === "auto" ? "Auto mode (set by Desk)" : s.mode === "bypassPermissions" ? "Bypass mode (set by Desk)" : null,
    s.approveForMe && "Approve for me",
    s.fast && "Fast",
    s.branch ? `branch ${s.branch}` : homeShort(s.cwd),
  ]
    .filter(Boolean)
    .join(" · ");

export function SessionChrome({
  session,
  name,
  size,
  tab,
  onTab,
  tabIds,
  lead,
  close,
  hostEntries = [],
  closeEntries = [],
  menuLabel,
  headProps,
  place,
}: {
  session: Session;
  /** The name it's shown by. */
  name: string;
  /** In the side panel or a grid pane: the mark's size and the rows' heights. */
  size: "panel" | "pane";
  tab: SessionTab;
  onTab: (tab: SessionTab) => void;
  /** What its tabs' and panels' ids start with. */
  tabIds: string;
  /** The host's own buttons: before the menu (focus, fill) and last (close,
   *  remove). */
  lead?: ReactNode;
  close?: ReactNode;
  /** The host's own entries in the menu: where it shows (after the session's
   *  and its driver's), and taking it away (last). */
  hostEntries?: MenuEntry[];
  closeEntries?: MenuEntry[];
  /** The menu button's name: "Session options", "Pane options". */
  menuLabel: string;
  /** On the header itself: a pane's header drags the pane. */
  headProps?: HTMLAttributes<HTMLElement>;
  /** Where else it shows, in the second row. */
  place?: ReactNode;
}) {
  const fail = useDesk((s) => s.fail);
  const [editing, setEditing] = useState(false);
  const [goal, setGoal] = useState(session.goal);
  const [menu, setMenu] = useState<{ x: number; y: number; from: HTMLElement | null } | null>(null);
  const own = useSessionMenu(session, {
    onEditGoal: () => {
      setGoal(session.goal);
      setEditing(true);
    },
  });
  const entries = sections(own.session, own.driver, hostEntries, own.lifecycle, closeEntries);
  const said = useId();
  const key = sessionKey(session);
  const look = lookOf(session);
  const where = whereText(session);
  const [start, end] = nameParts(name);
  // Interrupt while it works (Esc in its terminal), Resume once it runs
  // nowhere: its one button. Stop, which ends it, is in the menu.
  const primary = sessionActions(session).find((a) => a.label !== "Stop");
  const save = () => {
    setEditing(false);
    if (goal !== session.goal) hubFor(session)?.update(session.id, { goal }).catch(fail);
  };
  return (
    <header {...headProps} className={`sc sc-${size} ${headProps?.className ?? ""}`} aria-describedby={`${said}-where`}>
      <div className="sc-r1">
        <Mark name={name} engine={session.engine} state={look} size={size === "panel" ? "sm" : "xs"} />
        <span className="sc-name mono" title={`${name}\n${where}`}>
          <span className="sc-name-start">{start}</span>
          {end && <span className="sc-name-end">{end}</span>}
        </span>
        <span className="sc-status">
          <span className={`dot dot-${look}`} aria-hidden="true" />
          <span className={`sc-status-word ${look === "blocked" ? "state-blocked" : ""}`}>{statusOf(session, STATE_LABEL)}</span>
        </span>
        <OnMachine machine={machineOf(session)} />
        <GroupChip item={sessionItem(key)} className="sc-group" />
        <SessionTicketChip session={key} className="sc-ticket" />
        <span id={`${said}-where`} className="sc-meta">
          {where}
        </span>
        {primary && (
          <button
            type="button"
            className="icon-btn-sm sc-primary"
            aria-label={primary.label}
            title={primary.label === "Interrupt" ? "Interrupt (Esc in its terminal)" : primary.label}
            onClick={primary.run}
          >
            {primary.label === "Interrupt" ? <InterruptIcon /> : <ResumeIcon />}
          </button>
        )}
        {lead}
        <button
          type="button"
          className="icon-btn-sm sc-more"
          aria-label={menuLabel}
          title={menuLabel}
          aria-haspopup="menu"
          aria-expanded={!!menu}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.left, y: r.bottom + 2, from: e.currentTarget });
          }}
        >
          <MoreIcon />
        </button>
        {close}
      </div>
      <div className="sc-r2">
        <span className="sc-goal">
          {editing ? (
            <input
              autoFocus
              value={goal}
              aria-label="Goal"
              placeholder="What is this session for?"
              onChange={(e) => setGoal(e.target.value)}
              onBlur={save}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                if (e.key === "Escape") {
                  setGoal(session.goal);
                  setEditing(false);
                }
              }}
            />
          ) : (
            <GoalText
              goal={session.goal}
              onEdit={() => {
                setGoal(session.goal);
                setEditing(true);
              }}
            />
          )}
        </span>
        {place}
        <span className="sc-fill" />
        <DriverChip session={session} />
        <CostChip sessionId={key} />
        <SessionTabs name={name} tab={tab} onTab={onTab} ids={tabIds} />
      </div>
      {menu && (
        <Menu
          label={`${name} options`}
          at={menu}
          entries={entries}
          onClose={(refocus) => {
            if (refocus) menu.from?.focus();
            setMenu(null);
          }}
        />
      )}
    </header>
  );
}

/** Session · Memory · History: what shows under the chrome. */
function SessionTabs({ name, tab, onTab, ids }: { name: string; tab: SessionTab; onTab: (t: SessionTab) => void; ids: string }) {
  return (
    <span className="sc-tabs" role="tablist" aria-label={`${name}: what shows`}>
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          id={tabId(ids, t.id)}
          aria-selected={tab === t.id}
          aria-controls={panelId(ids, t.id)}
          title={t.label}
          onClick={() => onTab(t.id)}
        >
          <TabIcon tab={t.id} />
          <span className="sc-tab-label">{t.label}</span>
        </button>
      ))}
    </span>
  );
}

const InterruptIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" fill="currentColor" />
  </svg>
);

const ResumeIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <path d="M4.5 3.2v7.6L10.8 7z" fill="currentColor" />
  </svg>
);

const MoreIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
    <circle cx="3" cy="7" r="1.3" />
    <circle cx="7" cy="7" r="1.3" />
    <circle cx="11" cy="7" r="1.3" />
  </svg>
);

function TabIcon({ tab }: { tab: SessionTab }) {
  return (
    <svg className="sc-tab-icon" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      {tab === "session" ? (
        <path d="M2.5 4l3 3-3 3M7 10.5h4.5" />
      ) : tab === "memory" ? (
        <>
          <rect x="2.5" y="2.5" width="9" height="9" rx="2" />
          <path d="M5 5.5h4M5 8h3" />
        </>
      ) : (
        <>
          <circle cx="7" cy="7" r="4.5" />
          <path d="M7 4.6V7l1.7 1.1" />
        </>
      )}
    </svg>
  );
}

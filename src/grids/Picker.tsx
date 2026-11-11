// "What goes in this pane?": an empty pane's picker. One search over
// everything a pane can show, and a tab for each kind — sessions, agents, a
// terminal, rooms, boards and the Floor (of everything, or of one group).
// What's in this grid already is listed, greyed: it's there.

import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useChat } from "../chat/store";
import { agentKey } from "../chat/types";
import { arrangedBoards, useBoardOrder } from "../board/order";
import { useBoard } from "../board/store";
import { shownState } from "../floor/background";
import { useSessionNames } from "../groups/names";
import { useLayout } from "../groups/store";
import { localSessions, sortedSessions, useDesk } from "../hub/store";
import { useAuthor } from "../rooms/names";
import { arranged, useRoomOrder } from "../rooms/order";
import { memberKey } from "../rooms/routing";
import { useSettings } from "../settings/store";
import { shortcutLabel } from "../shortcuts/keys";
import { boardContent, findContent, floorContent, roomContent, type PaneContent } from "./engine";
import { STATE_LABEL } from "./Pane";
import { replacePane, useGrids } from "./store";

export type PickKind = "session" | "agent" | "terminal" | "room" | "board" | "floor";

export const PICK_TABS: readonly { id: PickKind; label: string; noun: string }[] = [
  { id: "session", label: "Sessions", noun: "Session" },
  { id: "agent", label: "Agents", noun: "Agent" },
  { id: "terminal", label: "Terminal", noun: "Terminal" },
  { id: "room", label: "Rooms", noun: "Room" },
  { id: "board", label: "Boards", noun: "Board" },
  { id: "floor", label: "Floor", noun: "Floor" },
];

/** One thing the picker offers. */
export interface Pick {
  kind: PickKind;
  key: string;
  name: string;
  meta: string;
  content: PaneContent;
}

/** Everything a pane can show now, by kind, in the sidebar's order. */
function usePicks(): Pick[] {
  const sessions = useDesk((s) => localSessions(s.sessions));
  const names = useSessionNames();
  const roster = useChat((s) => s.roster);
  const hubs = useChat((s) => s.hubs);
  const rooms = useDesk((s) => s.rooms);
  const roomOrder = useRoomOrder((s) => s.order);
  const author = useAuthor();
  const boards = useBoard((s) => s.boards);
  const boardOrder = useBoardOrder((s) => s.order);
  const groups = useLayout().groups;
  const keys = useSettings((s) => s.keys.newTerminal);
  return useMemo(
    () => [
      ...sortedSessions(sessions)
        .filter((s) => s.state !== "closed")
        .map((s): Pick => ({ kind: "session", key: `session:${s.id}`, name: names[s.id] ?? s.name, meta: STATE_LABEL[shownState(s)], content: { kind: "session", sessionId: s.id } })),
      ...roster.map(
        (a): Pick => ({ kind: "agent", key: `agent:${agentKey(a)}`, name: a.name, meta: hubs.find((h) => h.id === a.hubId)?.label ?? "", content: { kind: "agent", agent: agentKey(a) } }),
      ),
      { kind: "terminal", key: "terminal:new", name: "New terminal", meta: `on this computer · ${shortcutLabel(keys)}`, content: { kind: "terminal", terminalId: null } },
      ...arranged(rooms, roomOrder).map(
        (r): Pick => ({ kind: "room", key: `room:${r.id}`, name: r.name, meta: [...r.members.map((m) => author(memberKey(m)).name), "you"].join(", "), content: roomContent(r.id) }),
      ),
      ...arrangedBoards(boards, boardOrder).map(
        (b): Pick => ({ kind: "board", key: `board:${b.id}`, name: b.name, meta: b.sync ? `${b.sync.system === "jira" ? "Jira" : "Linear"} ${b.sync.target}` : (b.prefix ?? ""), content: boardContent(b.id) }),
      ),
      { kind: "floor", key: "floor:", name: "Everything", meta: "the whole Floor", content: floorContent() },
      ...groups.map((g): Pick => ({ kind: "floor", key: `floor:${g.id}`, name: `Floor › ${g.name}`, meta: "one group", content: floorContent(g.id) })),
    ],
    [sessions, names, roster, hubs, rooms, roomOrder, author, boards, boardOrder, groups, keys],
  );
}

/** Whether `p` matches what's typed: its name, or what it says of itself. */
const matches = (p: Pick, q: string): boolean => {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const text = `${p.name} ${p.meta}`.toLowerCase();
  return words.every((w) => text.includes(w));
};

/** An empty pane's picker: what's chosen goes in this pane. */
export function PanePicker({ gridId, paneId }: { gridId: string; paneId: string }) {
  const [tab, setTab] = useState<PickKind>("session");
  const [q, setQ] = useState("");
  const all = usePicks();
  const panes = useGrids((s) => s.grids[gridId]?.panes);
  const list = useRef<HTMLDivElement>(null);
  const ids = useId();
  const typed = q.trim();
  const shown = typed ? all.filter((p) => matches(p, typed)) : all.filter((p) => p.kind === tab);
  const here = (p: Pick) => p.kind !== "terminal" && !!panes && !!findContent(panes, p.content);
  const pick = (p: Pick) => {
    if (!here(p)) replacePane(gridId, paneId, p.content);
  };
  const rows = () => [...(list.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
  const onListKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const all = rows();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    all[Math.max(0, Math.min(all.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
  };
  const onTabKey = (e: KeyboardEvent, i: number) => {
    const by = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!by) return;
    e.preventDefault();
    const next = PICK_TABS[(i + by + PICK_TABS.length) % PICK_TABS.length]!;
    setTab(next.id);
    document.getElementById(`${ids}-tab-${next.id}`)?.focus();
  };
  const noun = (k: PickKind) => PICK_TABS.find((t) => t.id === k)!.noun;
  return (
    <div className="gpick" role="group" aria-labelledby={`${ids}-title`}>
      <h2 id={`${ids}-title`} className="gpick-title display">
        What goes in this pane?
      </h2>
      <label className="sr-only" htmlFor={`${ids}-q`}>
        Search
      </label>
      <input
        id={`${ids}-q`}
        className="gpick-search"
        value={q}
        placeholder="Search sessions, agents, rooms, boards…"
        autoComplete="off"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const first = shown.find((p) => !here(p));
            if (first) pick(first);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            rows()[0]?.focus();
          } else if (e.key === "Escape" && q) {
            e.preventDefault();
            e.stopPropagation();
            setQ("");
          }
        }}
      />
      {!typed && (
        <div className="gpick-tabs" role="tablist" aria-label="Kind">
          {PICK_TABS.map((t, i) => (
            <button
              key={t.id}
              id={`${ids}-tab-${t.id}`}
              type="button"
              role="tab"
              className="gpick-tab"
              aria-selected={tab === t.id}
              aria-controls={`${ids}-list`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => setTab(t.id)}
              onKeyDown={(e) => onTabKey(e, i)}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      <div
        ref={list}
        id={`${ids}-list`}
        className="gpick-list"
        role={typed ? "list" : "tabpanel"}
        aria-label={typed ? "Matches" : undefined}
        aria-labelledby={typed ? undefined : `${ids}-tab-${tab}`}
        onKeyDown={onListKey}
      >
        {shown.map((p) => {
          const there = here(p);
          return (
            <button
              key={p.key}
              type="button"
              role={typed ? "listitem" : undefined}
              className={`gpick-row ${p.kind === "session" ? "gpick-mono" : ""}`}
              disabled={there}
              title={there ? "Already in this grid" : undefined}
              onClick={() => pick(p)}
            >
              <span className="gpick-name">{p.name}</span>
              <span className="gpick-meta">{there ? "already in this grid" : typed ? [noun(p.kind), p.meta].filter(Boolean).join(" · ") : p.meta}</span>
            </button>
          );
        })}
        {shown.length === 0 && <p className="faint small gpick-none">{typed ? `Nothing matches “${typed}”.` : EMPTY[tab]}</p>}
      </div>
      <p className="gpick-foot faint small">
        {tab === "floor" && !typed ? "The Floor can show everything, or one group’s." : "Or drag a room, board, session or agent here from the sidebar."}
      </p>
    </div>
  );
}

const EMPTY: Record<PickKind, string> = {
  session: "No sessions are open.",
  agent: "No agents yet.",
  terminal: "",
  room: "No rooms yet.",
  board: "No boards yet.",
  floor: "",
};

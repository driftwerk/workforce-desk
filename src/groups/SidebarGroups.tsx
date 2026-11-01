import { DragDropProvider, DragOverlay, useDraggable, useDroppable } from "@dnd-kit/react";
import { useCallback, useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useChat } from "../chat/store";
import { agentKey, describeAgent, type Agent } from "../chat/types";
import { contentOfItem, dropOnGrid, endGridDrag, moveGridDrag, startGridDrag, useGridDrag } from "../grids/drag";
import { lookOf, statusOf, waitsOnYou } from "../floor/background";
import { filledPane, flashPanes, shownGrid, useGrids } from "../grids/store";
import { itemOf, placesOf } from "../grids/where";
import { addToGrid as placeInGrid } from "../grids/windows";
import { openAgentSettings } from "../rooms/AgentPanel";
import { sortedSessions, useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { useOverview } from "../overview/store";
import { openTarget, targetOfItem } from "../shell/navigate";
import { AgentMark } from "../ui/Mark";
import { Menu, type MenuEntry } from "../ui/Menu";
import { RenameField } from "../ui/RenameField";
import {
  agentItem,
  dropAt,
  moveGroup as movedGroup,
  moveItem as moved,
  nudgeGroupTarget,
  nudgeTarget,
  removeFromGroup as removed,
  resolve,
  sessionItem,
  UNGROUPED,
  type Drop,
  type DragEnd,
  type ItemKey,
  type Layout,
  type Shown,
} from "./model";
import { badgeOfGroup, itemBadge, type Badge } from "../unread/badges";
import { Marks, useBadgeData } from "../unread/Marks";
import { levelOf, NOTIFY_LEVELS, setLevel } from "../unread/prefs";
import { useSessionNames } from "./names";
import { below, DragChip, isMenuKey, MoreIcon, PLUGINS, SENSORS, SortRow, step, type Operation } from "./rows";
import {
  collapseGroup,
  currentLayout,
  deleteGroup,
  dropItem,
  moveGroup,
  moveItem,
  nameSession,
  newGroup as addGroup,
  removeFromGroup,
  renameGroup,
  useLayout,
} from "./store";
import { ENGINE_SHORT } from "../engines/engines";
import { lifecycleActions, sessionActions } from "../session/actions";
import { askLifecycle } from "../session/lifecycle";

const ENGINE = ENGINE_SHORT;

const STATE: Record<Session["state"], string> = {
  starting: "starting",
  working: "working",
  blocked: "needs you",
  asking: "needs you · asked",
  done: "done",
  idle: "idle",
  interrupted: "interrupted",
  stopped: "stopped",
  closed: "closed",
};

const NEW_GROUP = "New group";

type Item = { key: ItemKey; kind: "agent"; agent: Agent } | { key: ItemKey; kind: "session"; session: Session };

type Editing = { kind: "group"; id: string } | { kind: "session"; key: ItemKey } | null;

type Opened =
  | { kind: "item"; key: ItemKey; at: { x: number; y: number }; from: HTMLElement | null }
  | { kind: "group"; id: string; at: { x: number; y: number }; from: HTMLElement | null }
  | null;

const newId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const GROUP_ACCEPTS = ["item", "group"];

/** How long the pointer rests on a row before its panes are pointed out,
 *  so passing over rows on the way somewhere doesn't flash each. */
export const HOVER_MS = 150;

/** Groups of agents and sessions, kept by the hub (or, on a hub that can't,
 *  by Desk), with Ungrouped last. Drag to
 *  move and reorder; or Alt+↑/↓, F2 to rename, and Shift+F10 for the rest.
 *  One that's showing in a grid is shown there when clicked. In the Grids
 *  view, the one whose pane has focus is lit, and hovering one points out
 *  its panes. */
export function SidebarGroups() {
  const { sessions, openId, view, activeRoom } = useDesk();
  const { roster, hubs, activeAgent, panelAgent } = useChat();
  const layout = useLayout();
  const { groups } = layout;
  const names = useSessionNames();
  const badges = useBadgeData();
  const managerId = useOverview((s) => s.manager?.agentId ?? null);
  const gridOrder = useGrids((s) => s.order);
  const allGrids = useGrids((s) => s.grids);
  const shownId = useGrids((s) => shownGrid(s)?.id ?? null);
  const focusedPane = useGrids((s) => (shownId ? s.grids[shownId]?.panes.find((p) => p.id === s.focus[shownId]) : undefined));
  const [editing, setEditing] = useState<Editing>(null);
  const [menu, setMenu] = useState<Opened>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const [dragging, setDragging] = useState<{ kind: "item" | "group"; id: string } | null>(null);
  const [said, setSaid] = useState("");
  const focusNext = useRef<string | null>(null);
  const justDragged = useRef(false);
  const rows = useRef(new Map<string, HTMLElement>());
  const hint = useId();

  const items = new Map<ItemKey, Item>();
  for (const a of roster) items.set(agentItem(a), { key: agentItem(a), kind: "agent", agent: a });
  for (const s of sortedSessions(sessions)) if (s.state !== "closed") items.set(sessionItem(s.id), { key: sessionItem(s.id), kind: "session", session: s });
  const present = [...items.keys()];
  const shown = resolve(layout, present);

  // The item the focused pane of the grid the Grids view shows is (see
  // `itemOf`), while that pane is laid out; none in any other view.
  const focusedItem = view === "grids" && focusedPane?.rect ? itemOf(sessions, focusedPane.content) : null;
  const inFocus = focusedItem && items.has(focusedItem) ? focusedItem : null;

  const hubLabel = (id: string) => hubs.find((h) => h.id === id)?.label ?? id;
  const nameOf = (item: Item | undefined): string =>
    !item ? "" : item.kind === "agent" ? item.agent.name : (names[item.session.id] ?? item.session.name);
  const groupName = (id: string) => shown.find((g) => g.id === id)?.name ?? "";

  const register = useCallback((id: string, el: HTMLElement | null) => {
    if (el) rows.current.set(id, el);
    else rows.current.delete(id);
  }, []);

  // After a move from the keyboard, focus stays on what moved, wherever it
  // was drawn again.
  useEffect(() => {
    const id = focusNext.current;
    if (!id) return;
    focusNext.current = null;
    rows.current.get(id)?.focus();
  });

  // Focus moving to another item's pane opens its group if it was collapsed
  // and scrolls its row into view; once each time, so it can be collapsed
  // again.
  const litBefore = useRef<ItemKey | null>(null);
  const scrollTo = useRef<ItemKey | null>(null);
  useEffect(() => {
    if (inFocus === litBefore.current) return;
    litBefore.current = inFocus;
    if (!inFocus) return;
    const group = shown.find((g) => g.items.includes(inFocus));
    if (group?.collapsed) collapseGroup(group.id, false);
    scrollTo.current = inFocus;
  });
  useEffect(() => {
    const el = scrollTo.current && rows.current.get(scrollTo.current);
    if (!el) return;
    scrollTo.current = null;
    el.scrollIntoView?.({ block: "nearest" });
  });

  /** Points out, for a moment, the panes showing `key` (see `placesOf`) in
   *  sight in the grid the Grids view shows, as things are by then. */
  const pointOut = (key: ItemKey) => {
    const s = useGrids.getState();
    const gridId = useDesk.getState().view === "grids" ? shownGrid(s)?.id : undefined;
    if (!gridId) return;
    // A pane filling the grid hides the rest.
    const filled = filledPane(s, gridId);
    const panes = placesOf(s, useDesk.getState().sessions, key).flatMap((p) => (p.gridId === gridId && !p.parked && (!filled || p.paneId === filled) ? [p.paneId] : []));
    if (panes.length) flashPanes(gridId, panes);
  };
  const resting = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** The pointer came onto `key`'s row, or left it (null): its panes are
   *  pointed out once it has rested there a moment. */
  const hover = (key: ItemKey | null) => {
    clearTimeout(resting.current);
    resting.current = key && !dragging ? setTimeout(() => pointOut(key), HOVER_MS) : undefined;
  };
  useEffect(() => () => clearTimeout(resting.current), []);

  /** After a change: where focus goes, and what a screen reader hears. */
  const after = (focus?: string, say?: string) => {
    if (focus) focusNext.current = focus;
    if (say) setSaid(say);
  };

  const where = (l: Layout, key: ItemKey): string => {
    const g = resolve(l, present).find((x) => x.items.includes(key));
    return g ? `${g.name}, ${g.items.indexOf(key) + 1} of ${g.items.length}` : "";
  };

  const moveTo = (key: ItemKey, to: string) => {
    const next = moved(currentLayout(), present, key, to, null);
    moveItem(present, key, to, null);
    after(key, `Moved ${nameOf(items.get(key))} to ${where(next, key)}`);
  };

  const nudge = (key: ItemKey, by: -1 | 1) => {
    const now = currentLayout();
    const t = nudgeTarget(now, present, key, by);
    if (!t) return setSaid(by < 0 ? "Already at the top" : "Already at the bottom");
    const next = moved(now, present, key, t.to, t.before);
    moveItem(present, key, t.to, t.before);
    after(key, `${nameOf(items.get(key))}: ${where(next, key)}`);
  };

  const nudgeGroupBy = (id: string, by: -1 | 1) => {
    const now = currentLayout();
    const t = nudgeGroupTarget(now, id, by);
    if (!t) return setSaid(by < 0 ? "Already the first group" : "Already the last group");
    const next = movedGroup(now, id, t.before);
    moveGroup(id, t.before);
    const at = next.groups.findIndex((g) => g.id === id);
    after(`group:${id}`, `${groupName(id)}: group ${at + 1} of ${next.groups.length}`);
  };

  const newGroup = (with_?: ItemKey) => {
    const id = newId();
    addGroup(id, NEW_GROUP, with_ ? [with_] : []);
    setEditing({ kind: "group", id });
    if (with_) setSaid(`Moved ${nameOf(items.get(with_))} to a new group`);
  };

  const removeGroup = (id: string) => {
    const name = groupName(id);
    deleteGroup(present, id);
    after(`group:${UNGROUPED}`, `Deleted ${name}; its members are in Ungrouped`);
  };

  /** Opens it as always; or, when it's showing in a grid, shows it there. */
  const openItem = (item: Item) => {
    const target = targetOfItem(item.key);
    if (target) openTarget(target);
  };

  /** Puts it in grid `gridId` (its first empty pane, else beside the
   *  largest), or a new grid, and shows it there. */
  const addToGrid = (item: Item, gridId: string | null) => {
    const content = contentOfItem(item.key);
    if (!content) return;
    const id = placeInGrid(content, gridId).gridId;
    setSaid(`Added ${nameOf(item)} to ${useGrids.getState().grids[id]?.name ?? "the grid"}`);
  };

  const startRename = (item: Item) => item.kind === "session" && setEditing({ kind: "session", key: item.key });

  const itemMenu = (key: ItemKey): MenuEntry[] => {
    const item = items.get(key);
    if (!item) return [];
    const from = shown.find((g) => g.items.includes(key))?.id ?? UNGROUPED;
    const targets = shown.filter((g) => g.id !== UNGROUPED && g.id !== from);
    return [
      ...(item.kind === "session" ? [{ kind: "item" as const, label: "Rename", kbd: "F2", onSelect: () => startRename(item) }] : []),
      {
        kind: "item",
        label: "Move to group",
        submenu: [
          ...targets.map((g): MenuEntry => ({ kind: "item", label: g.name, onSelect: () => moveTo(key, g.id) })),
          ...(targets.length ? [{ kind: "separator" as const }] : []),
          { kind: "item", label: "New group…", onSelect: () => newGroup(key) },
        ],
      },
      {
        kind: "item",
        label: "Add to grid",
        submenu: [
          ...gridOrder.flatMap((id): MenuEntry[] => (allGrids[id] ? [{ kind: "item", label: allGrids[id]!.name, onSelect: () => addToGrid(item, id) }] : [])),
          ...(gridOrder.length ? [{ kind: "separator" as const }] : []),
          { kind: "item", label: "New grid", onSelect: () => addToGrid(item, null) },
        ],
      },
      ...(from !== UNGROUPED
        ? [
            {
              kind: "item" as const,
              label: "Remove from group",
              onSelect: () => {
                const next = removed(currentLayout(), present, key);
                removeFromGroup(present, key);
                after(key, `Moved ${nameOf(item)} to ${where(next, key)}`);
              },
            },
          ]
        : []),
      { kind: "separator" },
      { kind: "item", label: "Open", onSelect: () => openItem(item) },
      ...(item.kind === "session"
        ? [
            ...sessionActions(item.session).map((a): MenuEntry => ({ kind: "item", label: a.label, onSelect: a.run })),
            { kind: "separator" as const },
            ...lifecycleActions(item.session).map(
              (a): MenuEntry => ({ kind: "item", label: a.label, kbd: a.label === "End session…" ? undefined : "⌫", onSelect: a.run }),
            ),
          ]
        : []),
      ...(item.kind === "agent" ? [{ kind: "item" as const, label: "Settings", onSelect: () => openAgentSettings(agentKey(item.agent)) }] : []),
      ...(item.kind === "agent"
        ? [
            {
              kind: "item" as const,
              label: "Notifications",
              submenu: NOTIFY_LEVELS.map((l) => {
                const place = { kind: "dm" as const, hub: item.agent.hubId, agent: item.agent.id };
                return { kind: "item" as const, label: `${levelOf(place) === l.id ? "✓ " : ""}${l.label}`, onSelect: () => setLevel(place, l.id) };
              }),
            },
          ]
        : []),
    ];
  };

  const clearing: MenuEntry = { kind: "item", label: "Clear finished sessions…", onSelect: () => askLifecycle({ kind: "clear" }) };
  const groupMenu = (id: string): MenuEntry[] =>
    id === UNGROUPED
      ? [clearing]
      : [
          { kind: "item", label: "Rename group", kbd: "F2", onSelect: () => setEditing({ kind: "group", id }) },
          { kind: "item", label: "Delete group", onSelect: () => removeGroup(id) },
          { kind: "separator" },
          clearing,
        ];

  const closeMenu = useCallback(
    (refocus: boolean) =>
      setMenu((m) => {
        if (refocus) m?.from?.focus();
        return null;
      }),
    [],
  );

  // ── Dragging ───────────────────────────────────────────────────────────

  /** dnd-kit's ids: an item's key, or `group:<id>`. */
  const end = (e: { type?: unknown; id: unknown }): DragEnd => {
    const id = String(e.id);
    return e.type === "group" ? { type: "group", id: id.slice(6) } : { type: "item", id };
  };

  const dropFor = (op: Operation): Drop | null => {
    const { source, target } = op;
    if (!source || !target) return null;
    const rect = target.element?.getBoundingClientRect();
    const upper = rect ? op.position.current.y < rect.top + rect.height / 2 : true;
    return dropAt(layout, shown, end(source), end(target), upper);
  };

  const sameDrop = (a: Drop | null, b: Drop | null) => JSON.stringify(a) === JSON.stringify(b);

  return (
    <DragDropProvider
      sensors={SENSORS}
      plugins={PLUGINS}
      onDragStart={(e) => {
        const s = e.operation.source;
        if (s) setDragging({ kind: s.type === "group" ? "group" : "item", id: String(s.id) });
        hover(null);
        // An agent or session can also be dropped on a grid's pane.
        const content = s && s.type !== "group" ? contentOfItem(String(s.id)) : null;
        if (content) startGridDrag(content, nameOf(items.get(String(s!.id))));
        setMenu(null);
      }}
      onDragMove={(e) => {
        const { x, y } = e.operation.position.current;
        const d = moveGridDrag(x, y) ? null : dropFor(e.operation);
        setDrop((was) => (sameDrop(was, d) ? was : d));
      }}
      onDragOver={(e) => {
        const d = useGridDrag.getState().over ? null : dropFor(e.operation);
        setDrop((was) => (sameDrop(was, d) ? was : d));
      }}
      onDragEnd={(e) => {
        const s = e.operation.source;
        const onGrid = endGridDrag(e.canceled);
        const d = e.canceled || onGrid ? null : dropFor(e.operation);
        setDrop(null);
        setDragging(null);
        justDragged.current = true;
        setTimeout(() => (justDragged.current = false), 0);
        if (onGrid) return dropOnGrid(onGrid.target, onGrid.content);
        if (!s || !d) return;
        dropItem(present, end(s).id, d);
      }}
    >
      <div className="side-section groups" aria-label="Groups" role="region">
        <span className="side-label side-label-action side-head">
          Groups
          <button type="button" className="icon-btn-sm" aria-label="New group" title="New group" onClick={() => newGroup()}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M7 2v10M2 7h10" />
            </svg>
          </button>
        </span>
        <span id={`${hint}-session`} className="sr-only">
          Alt+Up and Alt+Down move it. F2 renames. Delete removes it. Shift+F10 opens its menu.
        </span>
        <span id={`${hint}-agent`} className="sr-only">
          Alt+Up and Alt+Down move it. Shift+F10 opens its menu.
        </span>
        <span id={`${hint}-group`} className="sr-only">
          Alt+Up and Alt+Down move the group. F2 renames it. Shift+F10 opens its options.
        </span>
        {shown.map((g) => (
          <GroupSection
            key={g.id}
            group={g}
            hint={`${hint}-group`}
            dropBefore={drop?.kind === "group" && drop.before === g.id && dragging?.kind === "group"}
            dropAfter={drop?.kind === "group" && drop.before === null && g.id === groups.at(-1)?.id && dragging?.kind === "group"}
            dropInside={drop?.kind === "item" && drop.group === g.id && drop.before === null && dragging?.kind === "item"}
            dragging={dragging}
            badge={badgeOfGroup(g.items.map((key) => itemBadge(key, badges)))}
            editing={editing?.kind === "group" && editing.id === g.id}
            register={register}
            onToggle={() => collapseGroup(g.id, !g.collapsed)}
            onRename={(name) => {
              setEditing(null);
              if (name !== null) renameGroup(g.id, name);
              focusNext.current = `group:${g.id}`;
            }}
            onStartRename={() => g.id !== UNGROUPED && setEditing({ kind: "group", id: g.id })}
            onNudge={(by) => g.id !== UNGROUPED && nudgeGroupBy(g.id, by)}
            onMenu={(at, from) => setMenu({ kind: "group", id: g.id, at, from })}
          >
            {g.items.map((key) => {
              const item = items.get(key)!;
              const lineBefore = drop?.kind === "item" && drop.group === g.id && drop.before === key && dragging?.kind === "item";
              return (
                <ItemRow
                  key={key}
                  item={item}
                  name={nameOf(item)}
                  badge={itemBadge(key, badges)}
                  hint={`${hint}-${item.kind}`}
                  lineBefore={lineBefore}
                  lit={inFocus === key}
                  on={
                    item.kind === "session"
                      ? openId === item.session.id
                      : view === "rooms"
                        ? !activeRoom && activeAgent === agentKey(item.agent)
                        : view === "floor" && panelAgent === agentKey(item.agent)
                  }
                  meta={
                    item.kind === "session"
                      ? waitsOnYou(item.session)
                        ? STATE[item.session.state]
                        : ENGINE[item.session.engine]
                      : item.agent.id === managerId && hubs.find((h) => h.id === item.agent.hubId)?.local
                        ? "overseer"
                        : hubLabel(item.agent.hubId)
                  }
                  title={item.kind === "agent" ? describeAgent(item.agent, hubLabel(item.agent.hubId)) : `${ENGINE[item.session.engine]} · ${statusOf(item.session, STATE)}`}
                  editing={editing?.kind === "session" && editing.key === key}
                  register={register}
                  onOpen={() => {
                    hover(null);
                    if (!justDragged.current) openItem(item);
                  }}
                  onStartRename={() => startRename(item)}
                  onRename={(name) => {
                    setEditing(null);
                    if (name !== null && item.kind === "session") nameSession(item.session.id, name, item.session.name);
                    focusNext.current = key;
                  }}
                  onNudge={(by) => nudge(key, by)}
                  onMenu={(at, from) => setMenu({ kind: "item", key, at, from })}
                  onRemove={item.kind === "session" ? () => lifecycleActions(item.session).at(-1)!.run() : undefined}
                  onHover={(over) => hover(over ? key : null)}
                />
              );
            })}
          </GroupSection>
        ))}
        <span className="sr-only" aria-live="polite">
          {said}
        </span>
      </div>
      <DragOverlay dropAnimation={null}>
        {(source) => {
          const id = String(source.id);
          if (source.type === "group") return <DragChip>{groupName(id.slice(6))}</DragChip>;
          const item = items.get(id);
          return item ? (
            <DragChip mono={item.kind === "session"}>
              {item.kind === "session" ? <span className={`dot dot-${lookOf(item.session)}`} /> : <AgentMark agent={agentKey(item.agent)} name={item.agent.name} size="sm" />}
              {nameOf(item)}
            </DragChip>
          ) : null;
        }}
      </DragOverlay>
      {menu && (
        <Menu
          label={menu.kind === "item" ? `${nameOf(items.get(menu.key))} options` : `${groupName(menu.id)} options`}
          at={menu.at}
          entries={menu.kind === "item" ? itemMenu(menu.key) : groupMenu(menu.id)}
          onClose={closeMenu}
        />
      )}
    </DragDropProvider>
  );
}

function GroupSection({
  group,
  hint,
  dropBefore,
  dropAfter,
  dropInside,
  dragging,
  badge,
  editing,
  register,
  onToggle,
  onRename,
  onStartRename,
  onNudge,
  onMenu,
  children,
}: {
  group: Shown;
  hint: string;
  dropBefore: boolean;
  dropAfter: boolean;
  dropInside: boolean;
  dragging: { kind: "item" | "group"; id: string } | null;
  /** Its items' badges together. */
  badge: Badge;
  editing: boolean;
  register: (id: string, el: HTMLElement | null) => void;
  onToggle: () => void;
  onRename: (name: string | null) => void;
  onStartRename: () => void;
  onNudge: (by: -1 | 1) => void;
  onMenu: (at: { x: number; y: number }, from: HTMLElement | null) => void;
  children: ReactNode;
}) {
  const fixed = group.id === UNGROUPED;
  const section = useRef<HTMLElement>(null);
  const handle = useRef<HTMLSpanElement>(null);
  const toggle = useRef<HTMLButtonElement | null>(null);
  const id = `group:${group.id}`;
  const drag = useDraggable({ id, type: "group", element: section, handle, disabled: fixed || editing });
  useDroppable({ id, type: "group", accept: GROUP_ACCEPTS, element: section, collisionPriority: 1 });
  const open = !group.collapsed;
  const listId = useId();
  return (
    <>
      {dropBefore && <div className="drop-line drop-line-group" aria-hidden="true" />}
      <section
        ref={section}
        role="group"
        className={`grp ${dropInside ? "drop-in" : ""} ${drag.isDragSource ? "ghost" : ""}`}
        aria-label={group.name}
        data-group={group.id}
      >
        <div className="grp-head">
          {fixed ? (
            <span className="grp-handle" aria-hidden="true" />
          ) : (
            <span ref={handle} className="grp-handle grip" title="Drag to reorder groups" aria-hidden="true">
              <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
                <circle cx="3" cy="3" r="1.2" />
                <circle cx="7" cy="3" r="1.2" />
                <circle cx="3" cy="7" r="1.2" />
                <circle cx="7" cy="7" r="1.2" />
                <circle cx="3" cy="11" r="1.2" />
                <circle cx="7" cy="11" r="1.2" />
              </svg>
            </span>
          )}
          {editing ? (
            <RenameField label="Group name" initial={group.name} mono={false} onDone={onRename} />
          ) : (
            <button
              ref={(el) => {
                toggle.current = el;
                register(id, el);
              }}
              type="button"
              className="grp-toggle"
              aria-expanded={open}
              aria-controls={open ? listId : undefined}
              aria-describedby={fixed ? undefined : hint}
              onClick={onToggle}
              onDoubleClick={(e) => {
                e.preventDefault();
                onStartRename();
              }}
              onKeyDown={(e) => {
                const by = step(e);
                if (by) {
                  e.preventDefault();
                  onNudge(by);
                } else if (e.key === "F2") {
                  e.preventDefault();
                  onStartRename();
                } else if (isMenuKey(e)) {
                  e.preventDefault();
                  onMenu(below(e.currentTarget), e.currentTarget);
                }
              }}
              onContextMenu={(e: MouseEvent) => {
                e.preventDefault();
                onMenu({ x: e.clientX, y: e.clientY }, toggle.current);
              }}
            >
              <span className={`grp-chevron ${open ? "open" : ""}`} aria-hidden="true">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M3 2l4 3-4 3" />
                </svg>
              </span>
              <span className="grp-name">{group.name}</span>
              <span className="grp-count">{group.items.length}</span>
              <Marks badge={badge} />
            </button>
          )}
          <button
            type="button"
            className="icon-btn-sm grp-more"
            aria-label={`${group.name} options`}
            aria-haspopup="menu"
            onClick={(e) => onMenu(below(e.currentTarget), e.currentTarget)}
          >
            <MoreIcon />
          </button>
        </div>
        {open && (
          <ul id={listId} className="grp-items" aria-label={group.name}>
            {children}
            {group.items.length === 0 && !dropInside && (
              <li className="grp-empty faint small">{dragging?.kind === "item" ? "Drop here" : "Empty. Drag agents or sessions here."}</li>
            )}
            {dropInside && <li className="drop-line" aria-hidden="true" />}
          </ul>
        )}
      </section>
      {dropAfter && <div className="drop-line drop-line-group" aria-hidden="true" />}
    </>
  );
}

function ItemRow({
  item,
  name,
  badge,
  hint,
  lineBefore,
  lit,
  on,
  meta,
  title,
  editing,
  register,
  onOpen,
  onStartRename,
  onRename,
  onNudge,
  onMenu,
  onRemove,
  onHover,
}: {
  item: Item;
  name: string;
  badge: Badge;
  hint: string;
  lineBefore: boolean;
  /** Its pane has focus in the grid shown. */
  lit: boolean;
  on: boolean;
  meta: string;
  title: string;
  editing: boolean;
  register: (id: string, el: HTMLElement | null) => void;
  onOpen: () => void;
  onStartRename: () => void;
  onRename: (name: string | null) => void;
  onNudge: (by: -1 | 1) => void;
  onMenu: (at: { x: number; y: number }, from: HTMLElement | null) => void;
  /** Delete or Backspace on it: asks before removing it. */
  onRemove?: () => void;
  onHover: (over: boolean) => void;
}) {
  const session = item.kind === "session" ? item.session : null;
  return (
    <SortRow
      id={item.key}
      type="item"
      collisionPriority={3}
      lineBefore={lineBefore}
      on={on}
      className={lit ? "in-focus" : ""}
      editing={editing && session ? <RenameField label={`Rename ${name}`} initial={name} mono onDone={onRename} /> : null}
      lead={item.kind === "agent" ? <AgentMark agent={agentKey(item.agent)} name={name} size="sm" /> : <span className={`dot dot-${lookOf(item.session)}`} aria-hidden="true" />}
      name={name}
      nameClass={session ? "mono" : "display"}
      meta={<span className={`gi-meta small ${session && waitsOnYou(session) ? "state-blocked" : "faint"}`}>{meta}</span>}
      title={title}
      describedBy={hint}
      data={{ "data-item": item.key }}
      register={(el) => register(item.key, el)}
      onOpen={onOpen}
      onStartRename={session ? onStartRename : undefined}
      onNudge={onNudge}
      onMenu={onMenu}
      onRemove={onRemove}
      onHover={onHover}
    >
      <Marks badge={badge} />
    </SortRow>
  );
}

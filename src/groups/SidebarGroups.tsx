import { Accessibility, defaultPreset, PointerSensor } from "@dnd-kit/dom";
import { DragDropProvider, DragOverlay, useDraggable, useDroppable } from "@dnd-kit/react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useChat } from "../chat/store";
import { agentKey, describeAgent, type Agent } from "../chat/types";
import { contentOfItem, dropOnGrid, endGridDrag, moveGridDrag, startGridDrag, useGridDrag } from "../grids/drag";
import { createGrid, deliver, useGrids } from "../grids/store";
import { reveal, revealIn } from "../grids/windows";
import { sortedSessions, useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { useOverview } from "../overview/store";
import { useSettings } from "../settings/store";
import { Mark } from "../ui/Mark";
import { Menu, type MenuEntry } from "../ui/Menu";
import { RenameField } from "../ui/RenameField";
import {
  agentItem,
  createGroup,
  deleteGroup,
  dropAt,
  dropOn,
  moveItem,
  nudgeGroup,
  nudgeItem,
  removeFromGroup,
  renameGroup,
  resolve,
  sessionItem,
  setCollapsed,
  UNGROUPED,
  type Drop,
  type DragEnd,
  type ItemKey,
  type Layout,
  type Shown,
} from "./model";
import { useSessionNames } from "./names";
import { changeLayout, layoutOf, nameSession } from "./store";

const ENGINE: Record<Session["engine"], string> = { claude: "Claude", codex: "Codex" };

const STATE: Record<Session["state"], string> = {
  starting: "starting",
  working: "working",
  blocked: "needs you",
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

/** Where a menu opened from the keyboard appears: under what it's for. */
const below = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return { x: r.left + 12, y: r.bottom + 2 };
};

const isMenuKey = (e: KeyboardEvent) => e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey);

const step = (e: KeyboardEvent): -1 | 1 | null =>
  e.altKey && !e.metaKey && !e.ctrlKey ? (e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : null) : null;

/** Only the pointer drags: the keyboard moves with Alt+↑/↓ and the menus,
 *  and Desk says so itself, so the library's keyboard dragging and its
 *  instructions are left out. */
const SENSORS = [PointerSensor];
// Module-level, so the provider sees the same lists every render (it
// reapplies them whenever they change).
const PLUGINS = defaultPreset.plugins.filter((p) => p !== Accessibility);
const GROUP_ACCEPTS = ["item", "group"];

type Operation = Parameters<NonNullable<ComponentProps<typeof DragDropProvider>["onDragMove"]>>[0]["operation"];

/** Groups of agents and sessions, Desk's own, with Ungrouped last. Drag to
 *  move and reorder; or Alt+↑/↓, F2 to rename, and Shift+F10 for the rest.
 *  One that's showing in a grid is shown there when clicked. */
export function SidebarGroups() {
  const { sessions, openId, open, view, activeRoom, openRoom } = useDesk();
  const { roster, hubs, activeAgent, openDm } = useChat();
  const groups = useSettings((s) => s.groups);
  const ungrouped = useSettings((s) => s.ungrouped);
  const names = useSessionNames();
  const managerId = useOverview((s) => s.manager?.agentId ?? null);
  const gridOrder = useGrids((s) => s.order);
  const allGrids = useGrids((s) => s.grids);
  const [editing, setEditing] = useState<Editing>(null);
  const [menu, setMenu] = useState<Opened>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const [dragging, setDragging] = useState<{ kind: "item" | "group"; id: string } | null>(null);
  const [said, setSaid] = useState("");
  const focusNext = useRef<string | null>(null);
  const justDragged = useRef(false);
  const rows = useRef(new Map<string, HTMLElement>());
  const hint = useId();

  const layout: Layout = { groups, ungrouped };
  const items = new Map<ItemKey, Item>();
  for (const a of roster) items.set(agentItem(a), { key: agentItem(a), kind: "agent", agent: a });
  for (const s of sortedSessions(sessions)) if (s.state !== "closed") items.set(sessionItem(s.id), { key: sessionItem(s.id), kind: "session", session: s });
  const present = [...items.keys()];
  const shown = resolve(layout, present);

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

  const change = (f: (l: Layout) => Layout | null, focus?: string, say?: string) => {
    changeLayout(f);
    if (focus) focusNext.current = focus;
    if (say) setSaid(say);
  };

  const where = (l: Layout, key: ItemKey): string => {
    const g = resolve(l, present).find((x) => x.items.includes(key));
    return g ? `${g.name}, ${g.items.indexOf(key) + 1} of ${g.items.length}` : "";
  };

  const moveTo = (key: ItemKey, to: string) => {
    const now = layoutOf(useSettings.getState());
    const next = moveItem(now, present, key, to, null);
    change(() => next, key, `Moved ${nameOf(items.get(key))} to ${where(next, key)}`);
  };

  const nudge = (key: ItemKey, by: -1 | 1) => {
    const next = nudgeItem(layoutOf(useSettings.getState()), present, key, by);
    if (!next) return setSaid(by < 0 ? "Already at the top" : "Already at the bottom");
    change(() => next, key, `${nameOf(items.get(key))}: ${where(next, key)}`);
  };

  const nudgeGroupBy = (id: string, by: -1 | 1) => {
    const next = nudgeGroup(layoutOf(useSettings.getState()), id, by);
    if (!next) return setSaid(by < 0 ? "Already the first group" : "Already the last group");
    const at = next.groups.findIndex((g) => g.id === id);
    change(() => next, `group:${id}`, `${groupName(id)}: group ${at + 1} of ${next.groups.length}`);
  };

  const newGroup = (with_?: ItemKey) => {
    const id = newId();
    change((l) => createGroup(l, id, NEW_GROUP, with_ ? [with_] : []));
    setEditing({ kind: "group", id });
    if (with_) setSaid(`Moved ${nameOf(items.get(with_))} to a new group`);
  };

  const removeGroup = (id: string) => {
    const name = groupName(id);
    change((l) => deleteGroup(l, present, id), `group:${UNGROUPED}`, `Deleted ${name}; its members are in Ungrouped`);
  };

  /** Opens it as always; or, when it's showing in a grid, shows it there. */
  const openItem = (item: Item) => {
    const content = contentOfItem(item.key);
    if (content && reveal(content)) return;
    if (item.kind === "session") open(item.session.id);
    else {
      void openRoom(null);
      openDm(agentKey(item.agent));
    }
  };

  /** Puts it in grid `gridId` (its first empty pane, else beside the
   *  largest), or a new grid, and shows it there. */
  const addToGrid = (item: Item, gridId: string | null) => {
    const content = contentOfItem(item.key);
    if (!content) return;
    const id = gridId ?? createGrid();
    deliver(id, content);
    revealIn(id, content);
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
                const next = removeFromGroup(layoutOf(useSettings.getState()), present, key);
                change(() => next, key, `Moved ${nameOf(item)} to ${where(next, key)}`);
              },
            },
          ]
        : []),
      { kind: "separator" },
      { kind: "item", label: "Open", onSelect: () => openItem(item) },
    ];
  };

  const groupMenu = (id: string): MenuEntry[] => [
    { kind: "item", label: "Rename group", kbd: "F2", onSelect: () => setEditing({ kind: "group", id }) },
    { kind: "item", label: "Delete group", onSelect: () => removeGroup(id) },
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
        changeLayout((l) => dropOn(l, present, end(s).id, d));
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
          Alt+Up and Alt+Down move it. F2 renames. Shift+F10 opens its menu.
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
            editing={editing?.kind === "group" && editing.id === g.id}
            register={register}
            onToggle={() => change((l) => setCollapsed(l, g.id, !g.collapsed))}
            onRename={(name) => {
              setEditing(null);
              if (name !== null) changeLayout((l) => renameGroup(l, g.id, name));
              focusNext.current = `group:${g.id}`;
            }}
            onStartRename={() => g.id !== UNGROUPED && setEditing({ kind: "group", id: g.id })}
            onNudge={(by) => g.id !== UNGROUPED && nudgeGroupBy(g.id, by)}
            onMenu={(at, from) => g.id !== UNGROUPED && setMenu({ kind: "group", id: g.id, at, from })}
          >
            {g.items.map((key) => {
              const item = items.get(key)!;
              const lineBefore = drop?.kind === "item" && drop.group === g.id && drop.before === key && dragging?.kind === "item";
              return (
                <ItemRow
                  key={key}
                  item={item}
                  name={nameOf(item)}
                  hint={`${hint}-${item.kind}`}
                  lineBefore={lineBefore}
                  on={
                    item.kind === "session"
                      ? openId === item.session.id
                      : view === "rooms" && !activeRoom && activeAgent === agentKey(item.agent)
                  }
                  meta={
                    item.kind === "session"
                      ? item.session.state === "blocked"
                        ? STATE.blocked
                        : ENGINE[item.session.engine]
                      : item.agent.id === managerId && hubs.find((h) => h.id === item.agent.hubId)?.local
                        ? "overseer"
                        : hubLabel(item.agent.hubId)
                  }
                  title={item.kind === "agent" ? describeAgent(item.agent, hubLabel(item.agent.hubId)) : `${ENGINE[item.session.engine]} · ${STATE[item.session.state]}`}
                  editing={editing?.kind === "session" && editing.key === key}
                  register={register}
                  onOpen={() => !justDragged.current && openItem(item)}
                  onStartRename={() => startRename(item)}
                  onRename={(name) => {
                    setEditing(null);
                    if (name !== null && item.kind === "session") nameSession(item.session.id, name, item.session.name);
                    focusNext.current = key;
                  }}
                  onNudge={(by) => nudge(key, by)}
                  onMenu={(at, from) => setMenu({ kind: "item", key, at, from })}
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
          if (source.type === "group") return <div className="drag-chip">{groupName(id.slice(6))}</div>;
          const item = items.get(id);
          return item ? (
            <div className={`drag-chip ${item.kind === "session" ? "mono" : ""}`}>
              {item.kind === "session" ? <span className={`dot dot-${item.session.state}`} /> : <Mark name={item.agent.name} size="sm" />}
              {nameOf(item)}
            </div>
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
                if (fixed) return;
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
            </button>
          )}
          {!fixed && (
            <button
              type="button"
              className="icon-btn-sm grp-more"
              aria-label={`${group.name} options`}
              aria-haspopup="menu"
              onClick={(e) => onMenu(below(e.currentTarget), e.currentTarget)}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
                <circle cx="3" cy="7" r="1.3" />
                <circle cx="7" cy="7" r="1.3" />
                <circle cx="11" cy="7" r="1.3" />
              </svg>
            </button>
          )}
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
  hint,
  lineBefore,
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
}: {
  item: Item;
  name: string;
  hint: string;
  lineBefore: boolean;
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
}) {
  const row = useRef<HTMLButtonElement | null>(null);
  const drag = useDraggable({ id: item.key, type: "item", element: row, disabled: editing });
  useDroppable({ id: item.key, type: "item", accept: "item", element: row, collisionPriority: 3 });
  const session = item.kind === "session" ? item.session : null;
  return (
    <>
      {lineBefore && <li className="drop-line" aria-hidden="true" />}
      <li className={`gi-wrap ${drag.isDragSource ? "ghost" : ""} ${editing ? "editing" : ""}`}>
        {editing && session ? (
          <span className="gi gi-editing">
            <span className="gi-handle" aria-hidden="true" />
            <span className={`dot dot-${session.state}`} aria-hidden="true" />
            <RenameField label={`Rename ${name}`} initial={name} mono onDone={onRename} />
          </span>
        ) : (
          <button
            ref={(el) => {
              row.current = el;
              register(item.key, el);
            }}
            type="button"
            className={`gi ${on ? "on" : ""}`}
            data-item={item.key}
            title={title}
            aria-describedby={hint}
            aria-current={on ? "true" : undefined}
            onClick={onOpen}
            onDoubleClick={(e) => {
              if (!session) return;
              e.preventDefault();
              onStartRename();
            }}
            onKeyDown={(e) => {
              const by = step(e);
              if (by) {
                e.preventDefault();
                onNudge(by);
              } else if (e.key === "F2" && session) {
                e.preventDefault();
                onStartRename();
              } else if (isMenuKey(e)) {
                e.preventDefault();
                onMenu(below(e.currentTarget), e.currentTarget);
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              onMenu({ x: e.clientX, y: e.clientY }, row.current);
            }}
          >
            <span className="gi-handle" aria-hidden="true">
              <svg width="8" height="12" viewBox="0 0 8 12" fill="currentColor">
                <circle cx="2" cy="2" r="1" />
                <circle cx="6" cy="2" r="1" />
                <circle cx="2" cy="6" r="1" />
                <circle cx="6" cy="6" r="1" />
                <circle cx="2" cy="10" r="1" />
                <circle cx="6" cy="10" r="1" />
              </svg>
            </span>
            {session ? <span className={`dot dot-${session.state}`} aria-hidden="true" /> : <Mark name={name} size="sm" />}
            <span className={session ? "mono gi-name" : "display gi-name"}>{name}</span>
            <span className={`gi-meta small ${session?.state === "blocked" ? "state-blocked" : "faint"}`}>{meta}</span>
          </button>
        )}
      </li>
    </>
  );
}

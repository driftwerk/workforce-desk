import { DragDropProvider, DragOverlay, useDraggable, useDroppable } from "@dnd-kit/react";
import { useShallow } from "zustand/react/shallow";
import { useCallback, useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useChat } from "../chat/store";
import { agentKey, describeAgent, type Agent } from "../chat/types";
import { contentOfItem, dropOnGrid, endGridDrag, moveGridDrag, startGridDrag, useGridDrag } from "../grids/drag";
import { lookOf, statusOf, waitsOnYou } from "../floor/background";
import { filledPane, flashPanes, shownGrid, useGrids } from "../grids/store";
import { itemOf, placesOf } from "../grids/where";
import { InGrid, inGridSays, useGridNames } from "../grids/InGrid";
import { addToGrid as placeInGrid } from "../grids/windows";
import { putInGrid, useInGridMark } from "../grids/putIn";
import { floorItem } from "../grids/where";
import { floorContent } from "../grids/engine";
import { openAgentSettings } from "../rooms/AgentPanel";
import { sortedSessions, useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { useOverview } from "../overview/store";
import { openTarget, targetOfItem } from "../shell/navigate";
import { AgentMark } from "../ui/Mark";
import { Menu, type MenuEntry } from "../ui/Menu";
import { GroupMemoryDialog } from "../memory/GroupMemory";
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
import { setSectionOpen, SideSection } from "../shell/SideSection";
import { Marks, useBadgeData } from "../unread/Marks";
import { levelOf, NOTIFY_LEVELS, setLevel } from "../unread/prefs";
import { useSessionNames } from "./names";
import { ChargeBadge } from "../crew/ChargeBadge";
import { SessionTicketChip } from "../board/TicketChip";
import { chargeChoices } from "../crew/charge";
import { useBoss, useCharge, useCharges } from "../crew/chargeStore";
import { grantBossed, grantBossOf, REREAD_MS, useGrantBosses } from "../crew/grantBoss";
import { BossSheet } from "./BossSheet";
import { remoteBosses } from "./remoteBoss";
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
  type Deleted,
} from "./store";
import { ENGINE_SHORT } from "../engines/engines";
import { LOCAL, machineOf, sessionKey, splitKey, useMachines, type MachineId } from "../machines/engines";
import { MachineTag } from "../machines/OnMachine";
import { offlineWord } from "../machines/words";
import { useMachineSessions, type Seen } from "./machines";
import { lifecycleActions, sessionActions } from "../session/actions";
import { canHandOff } from "../handoff/LineageChips";
import { askHandoff } from "../handoff/store";
import { askLifecycle } from "../session/lifecycle";
import { Confirm } from "../ui/Confirm";
import type { GroupBoss } from "../hub/types";
import {
  asksBeforeOverseeing,
  bossOfGroup,
  deleteAsk,
  groupOfBoss,
  isSealed,
  overseeAsk,
  overseeChoices,
  overseeGroup,
  overseeSaid,
  stopOverseeing,
} from "./bosses";
import { plainError } from "../ui/plainError";
import { GroupDot } from "./GroupChip";
import { askMove, moveRow, type MoveSubject } from "./move";
import { crossesBoss } from "../hub/client";
import { useHubLayout } from "./hubLayout";

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

type Item =
  | { key: ItemKey; kind: "agent"; agent: Agent }
  | { key: ItemKey; kind: "session"; session: Session }
  /** A machine's session while its engine isn't here to say (the machine
   *  is offline, or Desk hasn't reached it yet): as last seen, in its place. */
  | { key: ItemKey; kind: "away"; machine: MachineId; seen: Seen };

/** The machine a session's row is on. */
const machineOfRow = (item: Exclude<Item, { kind: "agent" }>): MachineId => (item.kind === "away" ? item.machine : machineOf(item.session));

/** A session row's dot: how it is, or the idle ring when its machine can't
 *  say. */
const dotOf = (item: Exclude<Item, { kind: "agent" }>, away = false): string => (item.kind === "away" || away ? "idle" : lookOf(item.session));

type Editing = { kind: "group"; id: string } | { kind: "session"; key: ItemKey } | null;

type Opened =
  | { kind: "item"; key: ItemKey; at: { x: number; y: number }; from: HTMLElement | null }
  | { kind: "group"; id: string; at: { x: number; y: number }; from: HTMLElement | null }
  | null;

const newId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const GROUP_ACCEPTS = ["item", "group"];

/** One of the two things the sidebar asks before doing: a group the main
 *  overseer saw getting a boss, or deleting a group that has one. */
type Asking = { kind: "oversee"; agent: Agent; group: string } | { kind: "delete"; group: string; boss: GroupBoss } | null;

/** How long the pointer rests on a row before its panes are pointed out,
 *  so passing over rows on the way somewhere doesn't flash each. */
export const HOVER_MS = 150;

/** Groups of agents and sessions, kept by the hub (or, on a hub that can't,
 *  by Desk), with Ungrouped last. Drag to
 *  move and reorder; or Alt+↑/↓, F2 to rename, and Shift+F10 for the rest.
 *  One that's showing in a grid is shown there when clicked. In the Grids
 *  view, the one whose pane has focus is lit, and hovering one points out
 *  its panes. */
export function SidebarGroups({ onNewSession }: { onNewSession?: (group: string) => void } = {}) {
  const { sessions, openId, view, activeRoom, engines } = useDesk(
    useShallow((s) => ({ sessions: s.sessions, openId: s.openId, view: s.view, activeRoom: s.activeRoom, engines: s.engines })),
  );
  // Not the whole chat store: that changes with every word an agent streams.
  const { roster, hubs, activeAgent, panelAgent } = useChat(
    useShallow((s) => ({ roster: s.roster, hubs: s.hubs, activeAgent: s.activeAgent, panelAgent: s.panelAgent })),
  );
  const layout = useLayout();
  const { groups } = layout;
  const names = useSessionNames();
  const badges = useBadgeData();
  const manager = useOverview((s) => s.manager);
  const managerId = manager?.agentId ?? null;
  const [asking, setAsking] = useState<Asking>(null);
  const boss = useBoss();
  const gridOrder = useGrids((s) => s.order);
  const allGrids = useGrids((s) => s.grids);
  const shownId = useGrids((s) => shownGrid(s)?.id ?? null);
  const focusedPane = useGrids((s) => (shownId ? s.grids[shownId]?.panes.find((p) => p.id === s.focus[shownId]) : undefined));
  const machines = useMachines((s) => s.machines);
  const seen = useMachineSessions((s) => s.seen);
  const [editing, setEditing] = useState<Editing>(null);
  const [menu, setMenu] = useState<Opened>(null);
  // The group whose memory switches are open, on this computer's hub,
  // whose sidebar the groups are.
  const [memoryOf, setMemoryOf] = useState<string | null>(null);
  /** The group whose Boss sheet is open. */
  const [bossSheetOf, setBossSheetOf] = useState<string | null>(null);
  const localHub = useDesk((s) => s.hub);
  // Moves the hub previews need the hub to keep the groups.
  const keptOnHub = useHubLayout((s) => s.layout !== null);
  // A session that joins or leaves a group with a boss on another hub is
  // granted or taken out soon, not at the next renewal.
  useEffect(
    () =>
      useHubLayout.subscribe((now, was) => {
        if (now.layout && now.layout !== was.layout) void remoteBosses.layoutChanged();
      }),
    [],
  );
  const [drop, setDrop] = useState<Drop | null>(null);
  const [dragging, setDragging] = useState<{ kind: "item" | "group"; id: string } | null>(null);
  const [said, setSaid] = useState("");
  const focusNext = useRef<string | null>(null);
  const justDragged = useRef(false);
  const rows = useRef(new Map<string, HTMLElement>());
  const hint = useId();

  const items = new Map<ItemKey, Item>();
  for (const a of roster) items.set(agentItem(a), { key: agentItem(a), kind: "agent", agent: a });
  // Every session, this computer's and each machine's, in one order.
  for (const s of sortedSessions(sessions)) {
    const key = sessionItem(sessionKey(s));
    if (s.state !== "closed") items.set(key, { key, kind: "session", session: s });
  }
  // A machine's sessions its engine isn't here to show, as last seen, while
  // the machine is still Desk's.
  for (const [k, x] of Object.entries(seen)) {
    const key = sessionItem(k);
    const machine = splitKey(k).machine;
    if (items.has(key) || engines[machine]?.loaded || !machines.some((m) => m.id === machine)) continue;
    items.set(key, { key, kind: "away", machine, seen: x });
  }
  const present = [...items.keys()];
  const shown = resolve(layout, present);

  // The item the focused pane of the grid the Grids view shows is (see
  // `itemOf`), while that pane is laid out; none in any other view.
  const focusedItem = view === "grids" && focusedPane?.rect ? itemOf(sessions, focusedPane.content) : null;
  const inFocus = focusedItem && items.has(focusedItem) ? focusedItem : null;

  const hubLabel = (id: string) => hubs.find((h) => h.id === id)?.label ?? id;
  const nameOf = (item: Item | undefined): string =>
    !item
      ? ""
      : item.kind === "agent"
        ? item.agent.name
        : item.kind === "away"
          ? item.seen.displayName || item.seen.name
          : (names[sessionKey(item.session)] ?? item.session.name);
  const groupName = (id: string) => shown.find((g) => g.id === id)?.name ?? "";

  const register = useCallback((id: string, el: HTMLElement | null) => {
    if (el) rows.current.set(id, el);
    else rows.current.delete(id);
  }, []);

  // Each group's boss on another hub, read so its sessions' menus can hand
  // them to it.
  const groupIds = groups.map((g) => g.id).join("\n");
  useEffect(() => {
    const read = () => {
      for (const id of groupIds.split("\n")) if (id) useGrantBosses.getState().ensure(id);
    };
    read();
    // Paused, stopped or linked elsewhere meanwhile: read again while open.
    const again = setInterval(read, REREAD_MS);
    return () => clearInterval(again);
  }, [groupIds]);

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
    if (group) setSectionOpen("groups", true);
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

  /** The group `key` is in now. */
  const groupOf = (key: ItemKey): string => resolve(currentLayout(), present).find((g) => g.items.includes(key))?.id ?? UNGROUPED;

  /** What the move dialog moves for a row: a session of this computer's
   *  hub, or an agent's row; a machine's session only rearranges the
   *  sidebar. */
  const subjectOf = (key: ItemKey): MoveSubject | null => {
    const item = items.get(key);
    if (!item || item.kind === "away") return null;
    const from = groupOf(key);
    if (item.kind === "agent") return { kind: "agent", agent: item.agent, name: nameOf(item), from };
    return machineOf(item.session) === LOCAL ? { kind: "session", id: item.session.id, name: nameOf(item), from } : null;
  };

  /** Puts `key` in group `to` before `before`. Into another group, a
   *  session is moved as the hub previews it: asked about first when that
   *  crosses from one boss to another, and kept where it was until then. */
  const placeIn = (key: ItemKey, to: string, before: ItemKey | null, say: (next: Layout) => string, focus = true) => {
    const tell = (next: Layout) => (focus ? after(key, say(next)) : setSaid(say(next)));
    const subject = subjectOf(key);
    const layoutMove = () => {
      const next = moved(currentLayout(), present, key, to, before);
      moveItem(present, key, to, before, refusedAsMove(subject, to));
      tell(next);
    };
    if (!subject || subject.from === to) return layoutMove();
    void moveRow(subject, to, layoutMove, () => {
      // The hub put it at its new group's end: where it was dropped, then.
      if (before) moveItem(present, key, to, before);
      tell(currentLayout());
    }).catch(useDesk.getState().fail);
  };

  /** A sidebar change the hub refused because only a move may make it (a
   *  boss came to one side meanwhile): never tried again, but asked about
   *  with the move dialog. Anything else is said as before. */
  const refusedAsMove =
    (subject: MoveSubject | null, to: string) =>
    (e: unknown): void => {
      if (subject && crossesBoss(e)) askMove(subject, to);
      else useDesk.getState().fail(e);
    };

  const moveTo = (key: ItemKey, to: string) => placeIn(key, to, null, (next) => `Moved ${nameOf(items.get(key))} to ${where(next, key)}`);

  const nudge = (key: ItemKey, by: -1 | 1) => {
    const now = currentLayout();
    const t = nudgeTarget(now, present, key, by);
    if (!t) return setSaid(by < 0 ? "Already at the top" : "Already at the bottom");
    placeIn(key, t.to, t.before, (next) => `${nameOf(items.get(key))}: ${where(next, key)}`);
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
    // A session or agent leaving a group is moved into it as any move is
    // (previewed, or asked about when it crosses), once the group is there.
    const subject = with_ ? subjectOf(with_) : null;
    if (with_ && subject && subject.from !== UNGROUPED) {
      setEditing({ kind: "group", id });
      // The hub previews a move only to a group it has.
      void addGroup(id, NEW_GROUP, []).then((kept) => kept && placeIn(with_, id, null, () => `Moved ${nameOf(items.get(with_))} to a new group`));
      return;
    }
    void addGroup(id, NEW_GROUP, with_ ? [with_] : []);
    setEditing({ kind: "group", id });
    if (with_) setSaid(`Moved ${nameOf(items.get(with_))} to a new group`);
  };

  const deleteNow = async (id: string, failed?: (e: unknown) => void): Promise<Deleted> => {
    const name = groupName(id);
    const how = await deleteGroup(present, id, failed);
    if (how !== "failed") after(`group:${UNGROUPED}`, `Deleted ${name}; its members are in Ungrouped`);
    return how;
  };

  /** A group with a boss asks first; deleting it takes the boss off it. */
  const removeGroup = (id: string) => {
    const boss = bossOfGroup(manager, id);
    if (boss) return setAsking({ kind: "delete", group: id, boss });
    void deleteNow(id);
  };

  const isLocal = (a: Agent) => !!hubs.find((h) => h.id === a.hubId)?.local;
  /** A boss of this computer's hub, as its roster has it. */
  const localAgent = (id: string): Agent | null => roster.find((a) => a.id === id && isLocal(a)) ?? null;
  const openBoss = (b: GroupBoss) => {
    const a = localAgent(b.agentId);
    if (a) openTarget({ kind: "agent", key: agentKey(a) });
  };

  const overseeNow = async (agent: Agent, group: string) => {
    const left = groupOfBoss(manager, agent.id);
    await overseeGroup(useDesk.getState().hub, agent.id, group, agent);
    setSaid(overseeSaid(agent.name, groupName(group), left && left !== group ? groupName(left) : null, !!managerId));
  };
  /** Asks first only when the main overseer saw what's in the group. A boss
   *  of another group moves, as the hub previews it. */
  const oversee = (agent: Agent, group: string) => {
    const bossOf = groupOfBoss(manager, agent.id);
    if (keptOnHub && bossOf && bossOf !== group) return askMove({ kind: "boss", id: agent.id, name: agent.name, from: bossOf }, group);
    if (asksBeforeOverseeing(manager, group)) return setAsking({ kind: "oversee", agent, group });
    overseeNow(agent, group).catch(useDesk.getState().fail);
  };
  const stop = (agent: Agent) => {
    const group = groupOfBoss(manager, agent.id);
    stopOverseeing(useDesk.getState().hub, agent.id, agent)
      .then(() => setSaid(`${agent.name} no longer oversees ${group ? groupName(group) : "a group"}`))
      .catch(useDesk.getState().fail);
  };

  /** Opens it as always; or, when it's showing in a grid, shows it there. */
  const openItem = (item: Item) => {
    if (item.kind === "away") return;
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

  /** Why a machine's session's row can't say how it is: its machine can't
   *  be reached (or isn't yet); null for one whose machine can be. */
  const awayWord = (machine: MachineId): string | null => {
    if (machine === LOCAL) return null;
    const m = machines.find((x) => x.id === machine);
    return (m && offlineWord(m.state)) ?? (engines[machine]?.loaded ? null : "connecting");
  };

  /** The group the agent's row is the boss of, when it is one of this
   *  computer's. */
  const bossGroupOf = (item: Item): string | null => (item.kind === "agent" && isLocal(item.agent) ? groupOfBoss(manager, item.agent.id) : null);
  /** Its row wears the boss tag: in the group it oversees. */
  const tagged = (item: Item): boolean => {
    const g = bossGroupOf(item);
    return !!g && shown.find((x) => x.id === g)?.items.includes(item.key) === true;
  };

  const metaOf = (item: Item): string => {
    if (item.kind === "agent")
      return item.agent.id === managerId && isLocal(item.agent) ? "overseer" : tagged(item) ? "" : hubLabel(item.agent.hubId);
    const away = awayWord(machineOfRow(item));
    if (away) return away;
    if (item.kind === "away") return ENGINE[item.seen.engine];
    return waitsOnYou(item.session) ? STATE[item.session.state] : ENGINE[item.session.engine];
  };

  const titleOf = (item: Item): string => {
    if (item.kind === "agent") {
      const bossOf = bossGroupOf(item);
      const about = describeAgent(item.agent, hubLabel(item.agent.hubId));
      return bossOf ? `${about} · oversees ${groupName(bossOf)}` : about;
    }
    const on = item.kind === "away" ? item.machine : machineOf(item.session);
    const away = awayWord(on);
    const where = on === LOCAL ? "" : ` · on ${machines.find((m) => m.id === on)?.name ?? on}`;
    const engine = ENGINE[item.kind === "away" ? item.seen.engine : item.session.engine];
    return `${engine}${where} · ${away ?? (item.kind === "session" ? statusOf(item.session, STATE) : "")}`;
  };

  const itemMenu = (key: ItemKey): MenuEntry[] => {
    const item = items.get(key);
    if (!item) return [];
    const from = shown.find((g) => g.items.includes(key))?.id ?? UNGROUPED;
    const targets = shown.filter((g) => g.id !== UNGROUPED && g.id !== from);
    const removing: MenuEntry[] =
      from !== UNGROUPED
        ? [
            {
              kind: "item",
              label: "Remove from group",
              onSelect: () => {
                const subject = subjectOf(key);
                const layoutMove = () => {
                  const next = removed(currentLayout(), present, key);
                  removeFromGroup(present, key, refusedAsMove(subject, UNGROUPED));
                  after(key, `Moved ${nameOf(item)} to ${where(next, key)}`);
                };
                if (!subject) return layoutMove();
                void moveRow(subject, UNGROUPED, layoutMove, () => after(key, `Moved ${nameOf(item)} to Ungrouped`)).catch(useDesk.getState().fail);
              },
            },
          ]
        : [];
    const moving: MenuEntry = {
      kind: "item",
      label: "Move to group",
      submenu: [
        ...targets.map((g): MenuEntry => ({ kind: "item", label: g.name, onSelect: () => moveTo(key, g.id) })),
        ...(targets.length ? [{ kind: "separator" as const }] : []),
        { kind: "item", label: "New group…", onSelect: () => newGroup(key) },
        ...(subjectOf(key) && keptOnHub
          ? [{ kind: "item" as const, label: "See what moves first…", onSelect: () => askMove(subjectOf(key)!) }]
          : []),
      ],
    };
    // Its machine can't be reached: it can only be moved.
    if (item.kind === "away") return [moving, ...removing];
    const choices = item.kind === "agent" ? overseeChoices(manager, { id: item.agent.id, local: isLocal(item.agent) }, from) : { oversee: false, stop: false };
    const overseeing: MenuEntry[] =
      item.kind === "agent"
        ? [
            ...(choices.oversee ? [{ kind: "item" as const, label: "Oversee this group", onSelect: () => oversee(item.agent, from) }] : []),
            ...(choices.stop ? [{ kind: "item" as const, label: "Stop overseeing", onSelect: () => stop(item.agent) }] : []),
          ]
        : [];
    // A boss and the board are this computer's hub's: not for a machine's.
    const here = item.kind !== "session" || machineOf(item.session) === LOCAL;
    // Who runs a session: the boss its group's grant names on another hub,
    // wherever it runs; else this computer's, for its own.
    const sessionCharge = (session: Session, local: boolean): MenuEntry[] => {
      const by = grantBossOf(layout, session) ?? (local && !grantBossed(layout, session) ? boss : null);
      const key = sessionKey(session);
      if (!by && !local) return [];
      return chargeChoices(session, useCharges.getState().bySession[key], by).map(
        (c): MenuEntry => ({
          kind: "item",
          label: c.label,
          onSelect: () => void useCharges.getState().act(key, c.verb, by).catch(useDesk.getState().fail),
        }),
      );
    };
    return [
      ...(item.kind === "session" ? [{ kind: "item" as const, label: "Rename", kbd: "F2", onSelect: () => startRename(item) }] : []),
      moving,
      {
        kind: "item",
        label: "Add to grid",
        submenu: [
          ...gridOrder.flatMap((id): MenuEntry[] => (allGrids[id] ? [{ kind: "item", label: allGrids[id]!.name, onSelect: () => addToGrid(item, id) }] : [])),
          ...(gridOrder.length ? [{ kind: "separator" as const }] : []),
          { kind: "item", label: "New grid", onSelect: () => addToGrid(item, null) },
        ],
      },
      ...removing,
      ...overseeing,
      { kind: "separator" },
      { kind: "item", label: "Open", onSelect: () => openItem(item) },
      ...(item.kind === "session"
        ? [
            ...sessionActions(item.session).map((a): MenuEntry => ({ kind: "item", label: a.label, onSelect: a.run })),
            ...(canHandOff(item.session) ? [{ kind: "item" as const, label: "Continue in…", onSelect: () => askHandoff({ id: item.session.id }) }] : []),
            ...sessionCharge(item.session, here),
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
  /** A new session, in this group unless another is chosen. */
  const starting = (id: string): MenuEntry[] => (onNewSession ? [{ kind: "item", label: "New session…", onSelect: () => onNewSession(id) }] : []);
  /** A sealed group's way out: one of its agents oversees it. */
  const choosing = (id: string): MenuEntry[] => {
    if (!isSealed(manager, id) || bossOfGroup(manager, id)) return [];
    const agents = (shown.find((g) => g.id === id)?.items ?? []).flatMap((k) => {
      const item = items.get(k);
      return item?.kind === "agent" && overseeChoices(manager, { id: item.agent.id, local: isLocal(item.agent) }, id).oversee ? [item.agent] : [];
    });
    return [
      {
        kind: "item",
        label: "Choose who oversees",
        submenu: agents.length
          ? agents.map((a): MenuEntry => ({ kind: "item", label: a.name, onSelect: () => oversee(a, id) }))
          : [{ kind: "item", label: "Drag one of your agents here first", disabled: true }],
      },
    ];
  };
  const groupMenu = (id: string): MenuEntry[] =>
    id === UNGROUPED
      ? [...starting(id), ...(onNewSession ? [{ kind: "separator" as const }] : []), clearing]
      : [
          ...starting(id),
          ...choosing(id),
          // The group's Floor: what its sessions and agents need and do.
          putInGrid(floorContent(id), "its Floor"),
          { kind: "item", label: "Boss…", onSelect: () => setBossSheetOf(id) },
          { kind: "item", label: "Memory…", onSelect: () => setMemoryOf(id) },
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
        if (d.kind === "item") {
          const key = end(s).id;
          return placeIn(key, d.group, d.before, (next) => `Moved ${nameOf(items.get(key))} to ${where(next, key)}`, false);
        }
        dropItem(present, end(s).id, d);
      }}
    >
      <SideSection
        id="groups"
        label="Groups"
        className="groups"
        newLabel="New group"
        onNew={() => newGroup()}
        badge={badgeOfGroup(shown.flatMap((g) => g.items.map((key) => itemBadge(key, badges))))}
      >
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
            boss={g.id === UNGROUPED ? null : bossOfGroup(manager, g.id)}
            sealed={g.id !== UNGROUPED && isSealed(manager, g.id) && !bossOfGroup(manager, g.id)}
            onBoss={openBoss}
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
                  away={item.kind !== "agent" && !!awayWord(machineOfRow(item))}
                  on={
                    item.kind === "away"
                      ? false
                      : item.kind === "session"
                        ? openId === sessionKey(item.session)
                        : view === "rooms"
                          ? !activeRoom && activeAgent === agentKey(item.agent)
                          : view === "floor" && panelAgent === agentKey(item.agent)
                  }
                  meta={metaOf(item)}
                  boss={tagged(item)}
                  title={item.kind === "agent" ? titleOf(item) : `${nameOf(item)} · ${titleOf(item)}`}
                  editing={editing?.kind === "session" && editing.key === key}
                  register={register}
                  onOpen={() => {
                    hover(null);
                    if (!justDragged.current) openItem(item);
                  }}
                  onStartRename={() => startRename(item)}
                  onRename={(name) => {
                    setEditing(null);
                    if (name !== null && item.kind === "session") nameSession(sessionKey(item.session), name, item.session.name);
                    focusNext.current = key;
                  }}
                  onNudge={(by) => nudge(key, by)}
                  onMenu={(at, from) => setMenu({ kind: "item", key, at, from })}
                  onRemove={item.kind === "session" && !awayWord(machineOf(item.session)) ? () => lifecycleActions(item.session).at(-1)!.run() : undefined}
                  onHover={(over) => hover(over ? key : null)}
                />
              );
            })}
          </GroupSection>
        ))}
        <span className="sr-only" aria-live="polite">
          {said}
        </span>
      </SideSection>
      <DragOverlay dropAnimation={null}>
        {(source) => {
          const id = String(source.id);
          if (source.type === "group") return <DragChip>{groupName(id.slice(6))}</DragChip>;
          const item = items.get(id);
          return item ? (
            <DragChip mono={item.kind !== "agent"}>
              {item.kind === "agent" ? <AgentMark agent={agentKey(item.agent)} name={item.agent.name} size="sm" /> : <span className={`dot dot-${dotOf(item)}`} />}
              {nameOf(item)}
              {item.kind !== "agent" && <MachineTag machine={machineOfRow(item)} />}
            </DragChip>
          ) : null;
        }}
      </DragOverlay>
      {asking?.kind === "oversee" &&
        (() => {
          const ask = overseeAsk(asking.agent.name, groupName(asking.group));
          return (
            <Confirm title={ask.title} action={ask.action} tone="signal" onConfirm={() => overseeNow(asking.agent, asking.group)} onClose={() => setAsking(null)}>
              <p>{ask.body}</p>
            </Confirm>
          );
        })()}
      {asking?.kind === "delete" &&
        (() => {
          const ask = deleteAsk(asking.boss.name, groupName(asking.group));
          return (
            <Confirm
              title={ask.title}
              action={ask.action}
              onConfirm={async () => {
                const name = groupName(asking.group);
                // The boss first, so the group is no one's before it goes
                // (a hub that takes it off itself finds nothing left to do).
                await stopOverseeing(useDesk.getState().hub, asking.boss.agentId, localAgent(asking.boss.agentId));
                let why = "";
                const how = await deleteNow(asking.group, (e) => (why = plainError(e)));
                const reason = why ? `: ${why}` : ".";
                if (how === "failed") throw new Error(`${asking.boss.name} no longer oversees ${name}; ${name} couldn’t be deleted${reason}`);
                // Deleted; only where its members went in Ungrouped isn't kept.
                if (how === "unordered") useDesk.getState().fail(new Error(`${name} was deleted, but its members’ order in Ungrouped wasn’t saved${reason}`));
              }}
              onClose={() => setAsking(null)}
            >
              <p>{ask.body}</p>
            </Confirm>
          );
        })()}
      {bossSheetOf && <BossSheet group={bossSheetOf} onClose={() => setBossSheetOf(null)} />}
      {memoryOf && <GroupMemoryDialog group={{ id: memoryOf, name: groupName(memoryOf) }} hub={localHub} onClose={() => setMemoryOf(null)} />}
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
  boss,
  sealed,
  onBoss,
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
  /** Its boss, when it has one. */
  boss: GroupBoss | null;
  /** Closed to everyone but the person, with no boss now. */
  sealed: boolean;
  onBoss: (boss: GroupBoss) => void;
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
  /** Who oversees it is said on its header. */
  const noted = !!boss || sealed;
  const section = useRef<HTMLElement>(null);
  const handle = useRef<HTMLSpanElement>(null);
  const toggle = useRef<HTMLButtonElement | null>(null);
  const id = `group:${group.id}`;
  const drag = useDraggable({ id, type: "group", element: section, handle, disabled: fixed || editing });
  useDroppable({ id, type: "group", accept: GROUP_ACCEPTS, element: section, collisionPriority: 1 });
  const open = !group.collapsed;
  const listId = useId();
  // Its Floor in a grid: the row says so, as a room's or a board's does.
  const floorMark = useInGridMark(floorItem(group.id));
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
              className={`grp-toggle ${noted ? "grp-toggle-bossed" : ""}`}
              aria-expanded={open}
              aria-controls={open ? listId : undefined}
              aria-describedby={fixed ? undefined : [hint, floorMark.id].filter(Boolean).join(" ")}
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
              {!fixed && <GroupDot id={group.id} />}
              <span className="grp-name">{group.name}</span>
              {!fixed && floorMark.mark}
              {noted ? (
                // Shown at the header's end; said here, with its name.
                <span className="sr-only">
                  {" "}
                  {group.items.length} <Marks badge={badge} />
                </span>
              ) : (
                <>
                  <span className="grp-count">{group.items.length}</span>
                  <Marks badge={badge} />
                </>
              )}
            </button>
          )}
          {noted && !editing && (
            <>
              {boss ? (
                <button type="button" className="grp-boss" title={`Open ${boss.name}’s messages`} onClick={() => onBoss(boss)}>
                  {boss.name} oversees
                </button>
              ) : (
                <button
                  type="button"
                  className="grp-boss grp-sealed"
                  title="No one oversees it, and the main overseer doesn’t see it. Choose who oversees it."
                  aria-haspopup="menu"
                  onClick={(e) => onMenu(below(e.currentTarget), e.currentTarget)}
                >
                  nobody oversees
                </button>
              )}
              {/* The rest of the header still opens and closes the group. */}
              <span className="grp-tail" aria-hidden="true" onClick={onToggle}>
                <span className="grp-count">{group.items.length}</span>
                <Marks badge={badge} />
              </span>
            </>
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
  away,
  on,
  meta,
  boss,
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
  /** A machine's session whose machine can't be reached: shown as last seen. */
  away: boolean;
  on: boolean;
  meta: string;
  /** It oversees a group: the boss tag, which opens its messages as the
   *  row does. */
  boss: boolean;
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
  // A boss and the board are this computer's hub's.
  const local = !!session && machineOf(session) === LOCAL;
  const charge = useCharge(local ? session.id : undefined);
  const inGrids = useGridNames(item.key);
  const says = inGrids.length ? inGridSays(inGrids) : null;
  const markId = `${useId()}-grid`;
  return (
    <SortRow
      id={item.key}
      type="item"
      collisionPriority={3}
      lineBefore={lineBefore}
      on={on}
      className={lit ? "in-focus" : ""}
      editing={editing && session ? <RenameField label={`Rename ${name}`} initial={name} mono onDone={onRename} /> : null}
      lead={item.kind === "agent" ? <AgentMark agent={agentKey(item.agent)} name={name} size="sm" /> : <span className={`dot dot-${dotOf(item, away)}`} aria-hidden="true" />}
      name={name}
      nameClass={item.kind === "agent" ? "display" : "mono"}
      meta={
        <>
          {item.kind !== "agent" && <MachineTag machine={machineOfRow(item)} />}
          {meta && <span className={`gi-meta small ${session && !away && waitsOnYou(session) ? "state-blocked" : "faint"}`}>{meta}</span>}
          {boss && <span className="gi-boss">boss</span>}
        </>
      }
      title={title}
      describedBy={says ? `${hint} ${markId}` : hint}
      data={{ "data-item": item.key }}
      register={(el) => register(item.key, el)}
      onOpen={onOpen}
      onStartRename={session && !away ? onStartRename : undefined}
      onNudge={onNudge}
      onMenu={onMenu}
      onRemove={onRemove}
      onHover={onHover}
    >
      {/* One group, so the marks keep together at the row's end when they wrap. */}
      <span className="gi-trail">
        {local && <SessionTicketChip session={session.id} still className="gi-ticket" name={name} />}
        <ChargeBadge charge={charge} session={local ? session.id : undefined} short className="gi-charge" />
        {says && <InGrid id={markId} says={says} />}
        <Marks badge={badge} />
      </span>
    </SortRow>
  );
}

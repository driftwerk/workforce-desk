import { useEffect, useState } from "react";
import { SetupLauncher } from "../setup/SetupLauncher";
import { ShareAsk } from "../rooms/share";
import { useChat } from "../chat/store";
import { Dashboard } from "../dashboard/Dashboard";
import { watchFloor } from "../floor/store";
import { hearElsewhere } from "./elsewhere";
import { GridsMain } from "../grids/Grids";
import { newTerminalHere, useGrids } from "../grids/store";
import { startGridsHere, useGridWindows } from "../grids/windows";
import { useDesk } from "../hub/store";
import { nativeMachines, watchMachines } from "../hub/engines";
import { ProblemNote } from "../ui/ProblemNote";
import { setStarter } from "../ui/problem";
import { startLocalHelper } from "../hub/helperNote";
import { DeskReadyBanner, useDeskReady } from "../hub/DeskReady";
import { focusMainWindow, hubAccounts, inApp, listen, localHub, onThemesChanged, setOpenReporter, subscribe, windowBackground } from "../platform";
import { useSettings } from "../settings/store";
import { reloadDesk } from "../shortcuts/reload";
import { useAppShortcut, useGlobalShortcut, useShortcuts } from "../shortcuts/manager";
import { useTuple } from "../tuple/useTuple";
import { useVoice } from "../voice";
import { useHubLinks } from "../hubs/follow";
import { forgetHubs, startUnread } from "../unread/summary";
import { useAppBadge } from "../unread/icon";
import { prune, stop, stopTarget } from "../rooms/engine";
import { jumpers } from "../rooms/unread";
import { placeKey } from "../rooms/window";
import { NewCrew } from "../crew/NewCrew";
import { adoptDeskWelcome } from "../crew/welcome";
import { rememberFormerNames } from "../rooms/formerNames";
import { resumePairing } from "../hubs/PairHub";
import { NewRoom } from "../rooms/NewRoom";
import { Rooms } from "../rooms/Rooms";
import { ThreadPanel, useOpenThread } from "../rooms/RoomView";
import { DmThreadPanel, useOpenDmThread } from "../rooms/DmThread";
import { agentKey } from "../chat/types";
import { SearchPanel } from "../rooms/SearchPanel";
import { OpenRoomDetails } from "../rooms/RoomDetails";
import { MoveDialog } from "../groups/MoveDialog";
import { HandoffDialog } from "../handoff/HandoffDialog";
import { AgentPanel, useAgentPanel } from "../rooms/AgentPanel";
import { Stage, type OpenPanel } from "../panels/Stage";
import { useSessionName } from "../groups/names";
import { useMainKey, useMainName } from "./mainName";
import { NewSession } from "../session/NewSession";
import { SessionCard } from "../session/SessionCard";
import { LedgerPanel } from "../spend/Ledger";
import { Board } from "../board/BoardView";
import { BrowserPill } from "../browser/BrowserPill";
import { useBrowserWatch, useLocalBrowser } from "../browser/store";
import { OpenTicket } from "../board/TicketDetail";
import { BOARD_CHROME } from "../board/chrome";
import { useBoard } from "../board/store";
import { Settings } from "../settings/Settings";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import { applyTheme, useTheme, useThemeStore } from "../theme/store";
import { useTerminalColors } from "../theme/hubColors";
import { customThemesRead } from "../theme/boot";
import { loadCustomThemes } from "../theme/custom";
import { QuickAsk } from "./QuickAsk";
import { SearchMemory } from "../memory/SearchMemory";
import { LifecycleDialogs } from "../session/LifecycleDialogs";
import { Sidebar } from "./Sidebar";
import { useUi, type SettingsSection } from "./ui";
import { requestFocus } from "./focus";
import { dragWindow } from "../ui/drag";
import { useSetup } from "../setup/store";
import { WindowsSetup } from "../setup/WindowsSetup";
import { useHost } from "./host";
import { resumeAfterUpdate } from "../updates/store";
import { UpdateNotice, useRestartWhenIdle, useUpdateChecks } from "../updates/UpdateNotice";

// An `@` by an agent's name before a rename still reaches them.
rememberFormerNames();

/** Stops the answer nearest: in the open room, the open thread's when focus
 *  is in it, else the room's newest live one; else the open DM's turn. */
const stopNearest = () => {
  const desk = useDesk.getState();
  // Nothing is answering on the Unread page, whatever room it stands over.
  if (desk.view !== "rooms" || desk.inbox) return;
  const room = desk.activeRoom ? desk.rooms[desk.activeRoom] : undefined;
  if (room) {
    const inThread = document.activeElement?.closest(".thread-panel") ? (useUi.getState().roomThreads[room.id] ?? null) : null;
    const draft = stopTarget(desk.roomDrafts[room.id] ?? [], inThread);
    if (draft) stop(room.id, draft.id);
    return;
  }
  const chat = useChat.getState();
  if (chat.activeAgent && chat.conversations[chat.activeAgent]?.working) chat.cancel(chat.activeAgent);
};

/** Opens search: on the open room, or every room. */
const searchHere = (inRoom: boolean) => {
  const desk = useDesk.getState();
  const room = inRoom && desk.view === "rooms" && !desk.inbox && desk.activeRoom ? desk.rooms[desk.activeRoom] : undefined;
  useUi.getState().setSearch(room ? `in:#${room.slug} ` : "");
  requestFocus("search");
};

/** The open room's pill: the open thread's when focus is in it. */
const jumpNearest = () => {
  const desk = useDesk.getState();
  const room = desk.view === "rooms" && !desk.inbox ? desk.activeRoom : null;
  if (!room) return;
  const thread = document.activeElement?.closest(".thread-panel") ? (useUi.getState().roomThreads[room] ?? null) : null;
  jumpers.get(placeKey(room, thread))?.();
};

/** How often the agents every workspace lists are read again. */
const ROSTER_EVERY_MS = 60_000;

/** How often the local hub is asked for again while it can't be reached. */
const LOCAL_HUB_RETRY_MS = 5_000;

export function App() {
  // Each piece on its own: the whole store would draw everything again on
  // every event any engine sends.
  const connect = useDesk((s) => s.connect);
  const view = useDesk((s) => s.view);
  const error = useDesk((s) => s.error);
  const clearError = useDesk((s) => s.clearError);
  const fail = useDesk((s) => s.fail);
  const open = useDesk((s) => (s.openId ? s.sessions[s.openId] : undefined));
  const theme = useTheme();
  const { setCustom, setSystemDark } = useThemeStore();
  // New session's sheet, with the group it was started from, if any.
  const [newSession, setNewSession] = useState<{ group?: string } | null>(null);
  const [asking, setAsking] = useState(false);
  const [recalling, setRecalling] = useState(false);
  const [newRoom, setNewRoom] = useState(false);
  const newCrew = useUi((s) => s.newCrew);
  const setNewCrew = useUi((s) => s.setNewCrew);
  const rooms = useDesk((s) => s.rooms);
  const hubs = useChat((s) => s.hubs);
  useEffect(() => {
    prune(rooms, hubs);
  }, [rooms, hubs]);
  const { readiness, retry: retryReady } = useDeskReady();
  const hubDown = readiness.kind !== "ready";
  // A grid's window asks for Settings here, the only window that has them.
  useEffect(
    () =>
      subscribe(
        listen<{ section: SettingsSection }>("open-settings", (e) => {
          useUi.getState().openSettings(e.payload.section);
          void focusMainWindow().catch(() => undefined);
        }),
      ),
    [],
  );
  useEffect(() => {
    setStarter(startLocalHelper);
    return () => setStarter(null);
  }, []);
  // A privacy pane that wouldn't open is said, not only logged.
  useEffect(() => {
    setOpenReporter((e) => useDesk.getState().fail(e, { what: "opening a link or a setting" }));
    return () => setOpenReporter(null);
  }, []);
  useHubLinks();
  useEffect(() => startUnread(), []);
  useAppBadge();
  useEffect(() => forgetHubs(hubs), [hubs]);
  const settings = useUi((u) => u.settings !== null);
  const platform = useHost((h) => h.platform);
  const needsSetup = useHost((h) => h.platform === "windows" && h.host === null);
  const setupOpen = useSetup((s) => s.open);
  useEffect(() => {
    if (needsSetup) useSetup.getState().show();
  }, [needsSetup]);
  const { openSettings, closeSettings } = useUi.getState();
  const setHubs = useChat((s) => s.setHubs);
  const loadSettings = useSettings((s) => s.load);
  const tupleOn = useSettings((s) => s.tuple);
  useTuple(tupleOn);
  useVoice(useSettings((s) => s.voice));
  useUpdateChecks();
  useRestartWhenIdle();

  useEffect(() => {
    applyTheme(theme);
    if (inApp) void windowBackground(theme.colors.bg).catch(() => undefined);
  }, [theme]);
  useTerminalColors(theme);

  // Workspaces add, remove and share agents without telling Desk, so their
  // agent lists are read again every minute and whenever Desk comes forward.
  useEffect(() => {
    const again = () => void useChat.getState().refreshRoster();
    const every = setInterval(again, ROSTER_EVERY_MS);
    window.addEventListener("focus", again);
    return () => {
      clearInterval(every);
      window.removeEventListener("focus", again);
    };
  }, []);

  useEffect(watchFloor, []);
  // A thread or a ticket a grid's own window opens shows here.
  useEffect(() => hearElsewhere(), []);
  // Each machine's engine, beside this computer's.
  useEffect(() => watchMachines(nativeMachines, () => void hubAccounts().then(useChat.getState().setHubs).catch(useDesk.getState().fail)), []);

  // Agents on this computer still greeting with the hub's WELCOME.md get Desk's.
  const desk = useDesk((s) => s.hub);
  // Which browsers are open, for "Desk is using the browser", asked as the person.
  useBrowserWatch(useLocalBrowser());
  const localIds = useChat((s) =>
    s.roster
      .filter((a) => s.hubs.some((h) => h.local && h.id === a.hubId))
      .map((a) => a.id)
      .sort()
      .join(" "),
  );
  useEffect(() => {
    if (desk && localIds) void adoptDeskWelcome(desk, localIds.split(" "));
  }, [desk, localIds]);

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemDark(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [setSystemDark]);

  useEffect(() => {
    let stop: (() => void) | undefined;
    const refresh = () => loadCustomThemes().then(setCustom).catch(fail);
    // Read before the first render (theme/boot); again only if that failed.
    if (!useSettings.getState().loaded) loadSettings().catch(fail);
    void customThemesRead(() => loadCustomThemes().then(setCustom)).catch(fail);
    const unlisten = subscribe(onThemesChanged(refresh));
    // Workspaces connected from here work without the local hub (on
    // Windows, before Desk is set up in WSL).
    // Desk's helper may not be up yet, or may have stopped before Desk
    // opened: asked again until it answers. The banner says how far it has
    // got, and what to do if it can't start; never a toast.
    let gone = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const reach = (): Promise<void> =>
      localHub().then(
        (t) => {
          if (gone) return;
          stop = connect(t);
          return inApp ? resumeAfterUpdate() : undefined;
        },
        (e: unknown) => {
          console.warn("Desk's helper isn't answering yet:", e);
          // Not awaited: workspaces connected from here load meanwhile.
          if (!gone) retry = setTimeout(() => void reach().catch(fail), LOCAL_HUB_RETRY_MS);
        },
      );
    reach()
      .catch(fail)
      .then(() => hubAccounts())
      .then(setHubs)
      .then(resumePairing)
      .catch(fail);
    return () => {
      gone = true;
      clearTimeout(retry);
      stop?.();
      unlisten();
    };
  }, [connect, fail, loadSettings, setCustom, setHubs]);

  useGlobalShortcut(
    "ask",
    useSettings((s) => (s.loaded ? s.keys.ask : null)),
    (e) => {
      if (e.state !== "Pressed") return;
      // Shown and focused by Desk's native side: the page may not do it.
      void focusMainWindow().catch(() => undefined);
      setAsking(true);
    },
  );
  const askStatus = useShortcuts((s) => s.status.ask);
  useEffect(() => {
    if (askStatus.state === "taken") fail(`${askStatus.message} in Settings → Shortcuts.`);
  }, [askStatus, fail]);

  // Grids: kept in step with the other windows, and each detached one's
  // window kept open on its monitor.
  useEffect(() => {
    let stop: (() => void) | undefined;
    let gone = false;
    void startGridsHere({ kind: "main" }).then((s) => (gone ? s() : (stop = s)));
    return () => {
      gone = true;
      stop?.();
    };
  }, []);
  useGridWindows(useGrids((s) => s.ready));

  useAppShortcut("newSession", () => setNewSession({}));
  useAppShortcut("newTerminal", () => {
    useUi.getState().closeSettings();
    useDesk.getState().setView("grids");
    newTerminalHere();
  });
  useAppShortcut("reload", reloadDesk);
  useAppShortcut("settings", () => (useUi.getState().settings ? closeSettings() : openSettings()));
  useAppShortcut("stopAnswer", stopNearest, true, { fromFields: false });
  useAppShortcut("jumpNew", jumpNearest, true, { fromFields: false });
  useAppShortcut("searchRoom", () => searchHere(true), true, { fromFields: false });
  useAppShortcut("searchRooms", () => searchHere(false), true, { fromFields: false });
  useAppShortcut("searchMemory", () => setRecalling((on) => !on), true, { fromFields: "composers" });
  useAppShortcut("unread", () => {
    useUi.getState().closeSettings();
    useDesk.getState().setInbox(true);
  }, true, { fromFields: false });
  useAppShortcut("board", () => {
    useUi.getState().closeSettings();
    useDesk.getState().setView("board");
  }, true, { fromFields: false });

  const sessionName = useSessionName(open?.id, open?.name ?? "");
  const thread = useOpenThread();
  const dmThread = useOpenDmThread();
  const beside = useAgentPanel();
  const mainName = useMainName();
  const mainKey = useMainKey();
  const panels: OpenPanel[] = [];
  const searching = useUi((u) => u.search !== null);
  const ledger = useUi((u) => u.ledger);
  const ticketOpen = useBoard((s) => s.open !== null);
  if (thread) {
    panels.push({
      kind: "thread",
      label: "Thread",
      element: (
        <ErrorBoundary name="thread">
          <ThreadPanel key={`${thread.room.id}/${thread.thread}`} room={thread.room} thread={thread.thread} />
        </ErrorBoundary>
      ),
    });
  }
  if (dmThread && !thread) {
    panels.push({
      kind: "thread",
      label: "Thread",
      element: (
        <ErrorBoundary name="thread">
          <DmThreadPanel key={`${agentKey(dmThread.agent)}#${dmThread.parent}`} agent={dmThread.agent} hub={dmThread.hub} parent={dmThread.parent} />
        </ErrorBoundary>
      ),
    });
  }
  if (beside) {
    panels.push({
      kind: "agent",
      label: beside.name,
      element: (
        <ErrorBoundary name="agent">
          <AgentPanel agent={beside} />
        </ErrorBoundary>
      ),
    });
  }
  if (searching) {
    panels.push({
      kind: "search",
      label: "Search",
      element: (
        <ErrorBoundary name="search">
          <SearchPanel />
        </ErrorBoundary>
      ),
    });
  }
  if (ledger) {
    panels.push({
      kind: "ledger",
      label: "Ledger",
      element: (
        <ErrorBoundary name="ledger">
          <LedgerPanel />
        </ErrorBoundary>
      ),
    });
  }
  if (ticketOpen) {
    panels.push({
      kind: "ticket",
      label: "Ticket",
      element: (
        <ErrorBoundary name="ticket">
          <OpenTicket />
        </ErrorBoundary>
      ),
    });
  }
  if (open) {
    panels.push({
      kind: "session",
      label: sessionName,
      element: (
        <ErrorBoundary name="session">
          <SessionCard session={open} />
        </ErrorBoundary>
      ),
    });
  }
  return (
    <div className="app" data-hub-down={hubDown || undefined}>
      {/* On macOS the window has no title bar (traffic lights overlay the
          content), so this strip is what moves it; elsewhere the system's
          title bar does. */}
      {platform === "macos" && <div className="titlebar" onMouseDown={dragWindow} />}
      <BrowserPill place={platform === "macos" ? "titlebar" : "band"} />
      {setupOpen && (
        <ErrorBoundary name="setup">
          <WindowsSetup />
        </ErrorBoundary>
      )}
      {settings ? (
        <ErrorBoundary name="settings">
          <Settings onClose={closeSettings} />
        </ErrorBoundary>
      ) : (
        <>
          <ErrorBoundary name="sidebar">
            <Sidebar
              onAsk={() => setAsking(true)}
              onNewSession={(group) => setNewSession({ group })}
              onNewRoom={() => setNewRoom(true)}
              onNewCrew={() => setNewCrew(true)}
              onSettings={() => openSettings()}
            />
          </ErrorBoundary>
          <Stage
            mainKey={mainKey}
            mainName={mainName}
            panels={panels}
            notice={<UpdateNotice />}
            main={
              <ErrorBoundary name="main">
                {view === "floor" ? (
                  <Dashboard onNewSession={() => setNewSession({})} />
                ) : view === "grids" ? (
                  <GridsMain />
                ) : view === "board" ? (
                  <Board chrome={BOARD_CHROME} />
                ) : (
                  <Rooms />
                )}
              </ErrorBoundary>
            }
          />
        </>
      )}
      {newSession && <NewSession group={newSession.group} onClose={() => setNewSession(null)} />}
      {asking && <QuickAsk onClose={() => setAsking(false)} />}
      {recalling && <SearchMemory onClose={() => setRecalling(false)} />}
      {newRoom && <NewRoom onClose={() => setNewRoom(false)} />}
      <OpenRoomDetails />
      <MoveDialog />
      <HandoffDialog />
      <LifecycleDialogs />
      <ShareAsk />
      <SetupLauncher />
      {newCrew && <NewCrew onClose={() => setNewCrew(false)} />}
      <DeskReadyBanner readiness={readiness} onRetry={retryReady} />
      {error && (
        <div className="toast toast-error toast-problem" role="alert">
          <ProblemNote problem={error} onDone={clearError} />
        </div>
      )}
    </div>
  );
}

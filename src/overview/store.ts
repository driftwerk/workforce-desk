import { create } from "zustand";
import { HubError, type DeskHub } from "../hub/client";
import { deskListeners, useDesk } from "../hub/store";
import type { ActivityEvent, ActivityFilter, DeskEvent, Manager, Overview, Suggestion } from "../hub/types";
import { matches, mergeEvents } from "./activity";

/** Whether this hub has a route: not asked yet, yes, or no (an older hub). */
export type Support = "unknown" | "yes" | "no";

/** One filter's Activity list. */
export interface Feed {
  /** Newest first. */
  events: ActivityEvent[];
  more: boolean;
  state: "loading" | "ready" | "failed";
  /** Reading the page before the oldest event shown. */
  earlier: "idle" | "loading" | "failed";
}

export const PAGE = 100;

interface OverviewStore {
  overview: Overview | null;
  overviewSupport: Support;
  activitySupport: Support;
  feeds: Partial<Record<ActivityFilter, Feed>>;
  manager: Manager | null;
  managerSupport: Support;
  /** The overseer's suggestions, by id, once read. */
  suggestions: Record<string, Suggestion>;
  suggestionsLoaded: boolean;
  /** Approvals answered from Desk in this run, by approval id. */
  decided: Record<string, "allow" | "deny">;
  loadOverview: () => Promise<void>;
  /** A filter's latest page (again, replacing what was shown). */
  loadActivity: (filter: ActivityFilter) => Promise<void>;
  loadEarlier: (filter: ActivityFilter) => Promise<void>;
  /** An event from the socket, into every list it belongs in. */
  receive: (e: ActivityEvent) => void;
  loadManager: () => Promise<void>;
  loadSuggestions: () => Promise<void>;
  /** Reads the suggestions once, for the messages that show them. */
  wantSuggestions: () => void;
  accept: (id: string) => Promise<void>;
  dismiss: (id: string) => Promise<void>;
  decide: (sessionId: string, approvalId: string, decision: "allow" | "deny") => Promise<void>;
}

/** A hub without the route answers 404 (or, older still, with its web page,
 *  which the client turns into a 404). */
export const missing = (e: unknown): boolean => e instanceof HubError && (e.status === 404 || e.status === 405);

const hubNow = (): DeskHub | null => useDesk.getState().hub;

let asking: Promise<void> | null = null;

const timers: Partial<Record<"overview" | "suggestions", ReturnType<typeof setTimeout>>> = {};

/** Runs `f` once things settle: events close together cause one read. */
const soon = (what: "overview" | "suggestions", f: () => void, ms: number) => {
  clearTimeout(timers[what]);
  timers[what] = setTimeout(f, ms);
};

export const useOverview = create<OverviewStore>((set, get) => ({
  overview: null,
  overviewSupport: "unknown",
  activitySupport: "unknown",
  feeds: {},
  manager: null,
  managerSupport: "unknown",
  suggestions: {},
  suggestionsLoaded: false,
  decided: {},
  loadOverview: async () => {
    const hub = hubNow();
    if (!hub) return;
    try {
      const overview = await hub.overview();
      if (hubNow() === hub) set({ overview, overviewSupport: "yes" });
    } catch (e) {
      // Anything else keeps what's shown; the next event or tick asks again.
      if (missing(e) && hubNow() === hub) set({ overview: null, overviewSupport: "no" });
    }
  },
  loadActivity: async (filter) => {
    const hub = hubNow();
    if (!hub) return;
    const put = (f: Partial<Feed>) =>
      set((s) => ({
        feeds: { ...s.feeds, [filter]: { events: [], more: false, state: "loading", earlier: "idle", ...s.feeds[filter], ...f } },
      }));
    if (!get().feeds[filter]) put({ state: "loading" });
    try {
      const page = await hub.activity({ filter, limit: PAGE });
      if (hubNow() !== hub) return;
      // Live events that came in while the page was read stay.
      const live = (get().feeds[filter]?.events ?? []).filter((e) => !page.events.length || e.at > page.events[0]!.at);
      put({ events: mergeEvents(page.events, live), more: page.more, state: "ready", earlier: "idle" });
      set({ activitySupport: "yes" });
    } catch (e) {
      if (missing(e)) set({ activitySupport: "no" });
      if (get().feeds[filter]?.state === "loading") put({ state: "failed" });
    }
  },
  loadEarlier: async (filter) => {
    const hub = hubNow();
    const feed = get().feeds[filter];
    const last = feed?.events.at(-1);
    if (!hub || !feed || feed.state !== "ready" || !feed.more || feed.earlier === "loading" || !last) return;
    const put = (f: (feed: Feed) => Partial<Feed>) =>
      set((s) => (s.feeds[filter] ? { feeds: { ...s.feeds, [filter]: { ...s.feeds[filter]!, ...f(s.feeds[filter]!) } } } : {}));
    put(() => ({ earlier: "loading" }));
    try {
      const page = await hub.activity({ filter, before: last.id, limit: PAGE });
      put((f) => ({ earlier: "idle", events: mergeEvents(f.events, page.events), more: page.more && page.events.length > 0 }));
    } catch {
      put(() => ({ earlier: "failed" }));
    }
  },
  receive: (e) => {
    set((s) => ({
      feeds: Object.fromEntries(
        Object.entries(s.feeds).map(([filter, feed]) => [
          filter,
          matches(filter as ActivityFilter, e) ? { ...feed, events: mergeEvents(feed.events, [e]) } : feed,
        ]),
      ),
    }));
    if (get().overviewSupport === "yes") soon("overview", () => void get().loadOverview(), 1000);
    if (get().suggestionsLoaded && (e.suggestionId || e.kind === "suggested" || e.kind === "dismissed"))
      soon("suggestions", () => void get().loadSuggestions(), 500);
  },
  loadManager: async () => {
    const hub = hubNow();
    if (!hub) return;
    try {
      const manager = await hub.manager();
      if (hubNow() === hub) set({ manager, managerSupport: "yes" });
    } catch (e) {
      if (missing(e) && hubNow() === hub) set({ manager: null, managerSupport: "no" });
    }
  },
  loadSuggestions: async () => {
    const hub = hubNow();
    if (!hub) return;
    try {
      const list = await hub.suggestions();
      set({ suggestions: Object.fromEntries(list.map((s) => [s.id, s])), suggestionsLoaded: true });
    } catch {
      // The messages' own copies stand in.
    }
  },
  wantSuggestions: () => {
    if (get().suggestionsLoaded || asking) return;
    asking = get()
      .loadSuggestions()
      .finally(() => (asking = null));
  },
  accept: async (id) => {
    const hub = hubNow();
    if (!hub) return;
    await hub.acceptSuggestion(id);
    set((s) => ({ suggestions: { ...s.suggestions, [id]: { ...(s.suggestions[id] ?? stub(id)), state: "done" } } }));
  },
  dismiss: async (id) => {
    const hub = hubNow();
    if (!hub) return;
    await hub.dismissSuggestion(id);
    set((s) => ({ suggestions: { ...s.suggestions, [id]: { ...(s.suggestions[id] ?? stub(id)), state: "dismissed" } } }));
  },
  decide: async (sessionId, approvalId, decision) => {
    const hub = hubNow();
    if (!hub) return;
    await hub.decide(sessionId, approvalId, decision);
    set((s) => ({ decided: { ...s.decided, [approvalId]: decision } }));
  },
}));

const stub = (id: string): Suggestion => ({ id, at: "", text: "", action: {}, state: "open" });

/** What the socket says, for the overview: after a (re)connect everything is
 *  read again, since events may have been missed; a session's change shows
 *  in the overview soon after. */
export const onDeskEvent = (e: DeskEvent): void => {
  const s = useOverview.getState();
  if (e.type === "activity") s.receive(e.event);
  else if (e.type === "snapshot") {
    void s.loadOverview();
    void s.loadManager();
    for (const filter of Object.keys(s.feeds) as ActivityFilter[]) void s.loadActivity(filter);
    if (s.suggestionsLoaded) void s.loadSuggestions();
  } else if ((e.type === "session" || e.type === "removed") && s.overviewSupport === "yes")
    soon("overview", () => void useOverview.getState().loadOverview(), 500);
};

deskListeners.add(onDeskEvent);

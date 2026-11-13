// What each agent sees of the person's Desk work ("What they see", Sees
// K5): the rules kept on this computer's hub, the choice of what an agent
// keeps when a rule narrows, the rule's log, and linking an agent on
// another hub. The rule routes are the person's alone (the hub refuses its
// own token for them), so they go over the paired path as the person
// (`deskCall`), never through the broker.
//
// An agent on another hub is shared with by a `wfk_` token that Desk mints
// there on the native side, which holds the paired device token, and hands
// to this computer's hub: the token never reaches the page.

import { invoke } from "@tauri-apps/api/core";
import { deskCall, HubError } from "./client";
import type { HubRef } from "./net";

/** How an agent hears of the work beyond its tools. */
export type KnowsDigest = "off" | "live" | "daily";

/** One agent's rule, as the hub keeps it: `places` in the scope grammar
 *  (`everything`, `group:<id>`, `session:<id>`, `board:<id>`; none is its
 *  own work alone). */
export type KnowsRule = { agent: string; places: string[]; transcripts: boolean; digest: KnowsDigest; revision: number; changedAt: string | null };

/** What an agent holds, counted: items, transcripts among them, and the
 *  sessions they are of. */
export type KnowsHeld = { items: number; transcripts: number; sessions: number; by_kind: Record<string, number> };

/** One kind shared in the last day. */
export type KnowsShared = { kind: string; items: number; bytes: number };

/** One agent's rule, what it holds outside it, and what it was told today. */
export type KnowsView = { rule: KnowsRule; heldOutside: KnowsHeld; sharedToday: KnowsShared[] };

/** A change of rule: what the agent holds that the new rule no longer
 *  covers. Nothing more of it is shared meanwhile. */
export type KnowsChanged = { rule: KnowsRule; heldOutside: KnowsHeld };

/** One line of a rule's log: counts and places, never content. */
export type KnowsLogEntry = { id: string; at: string; what: string; detail: unknown; doneAt: string | null };

const path = (agent: string, rest = ""): string => {
  const [hub, id] = agent.split("/");
  return `/api/desk/knows/${encodeURIComponent(hub ?? "")}/${encodeURIComponent(id ?? "")}${rest}`;
};

/** The rules on hub `hub` (this computer's), as the person. `agent` is
 *  `<hub>/<agent id>`, as rules are kept by. */
export const knowsOf = (hub: HubRef) => ({
  rules: async (): Promise<KnowsRule[]> => (await deskCall<{ rules: KnowsRule[] }>(hub, "GET", "/api/desk/knows")).rules ?? [],
  rule: (agent: string): Promise<KnowsView> => deskCall(hub, "GET", path(agent)),
  /** Keeps the rule; left out, `transcripts` and `digest` stay as they were. */
  setRule: (agent: string, b: { places: string[]; transcripts?: boolean; digest?: KnowsDigest }): Promise<KnowsChanged> => deskCall(hub, "PUT", path(agent), b),
  /** The person's choice for what the agent holds outside its rule. */
  choose: (agent: string, choice: "delete" | "keep"): Promise<{ choice: string; covered: number }> => deskCall(hub, "POST", path(agent, "/held"), { choice }),
  log: async (agent: string): Promise<KnowsLogEntry[]> => (await deskCall<{ log: KnowsLogEntry[] }>(hub, "GET", path(agent, "/log"))).log ?? [],
});

export type KnowsApi = ReturnType<typeof knowsOf>;

/** What linking an agent did: kept on this computer's hub, an agent of
 *  this computer's hub (shared with in place), or not allowed there (its
 *  words). `unavailable`: this Desk can't link at all (the browser preview). */
export type KnowsLinked = { kind: "kept" } | { kind: "local" } | { kind: "notAllowed"; status: number; error: string } | { kind: "unavailable" };

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Links agent `agent` on paired hub `remote` for the person's Desk work:
 *  the token is minted there and kept here, all on the native side. */
export const linkKnows = async (remote: string, agent: string): Promise<KnowsLinked> => {
  if (!inTauri) return { kind: "unavailable" };
  try {
    return await invoke<KnowsLinked>("knows_link", { remote, agent });
  } catch (e) {
    throw new HubError(502, e instanceof Error ? e.message : String(e));
  }
};

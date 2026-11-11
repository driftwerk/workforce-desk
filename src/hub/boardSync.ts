// Sync with Linear or Jira (boss-gaps §13, the hub's BH10): the hubs a
// board may sync through, the link dialog's checks, linking, pausing and
// syncing now. These routes are the person's alone (the hub refuses its own
// token for them), so they go over the paired path as the person
// (`deskCall`), as moves do, never through the broker.
//
// A hub's `wfr_` token is given to the local hub once and never read back.
// Desk mints one where the hub allows it, on the native side, which holds
// the paired device token: the minted token never reaches the page. Where
// the hub doesn't allow it, the person pastes one made on that hub.

import { invoke } from "@tauri-apps/api/core";
import { deskCall, HubError, refusal } from "./client";
import { jsonBody, pairedHub, type HubRef } from "./net";
import type { Board, LinkBoard, LinkCheck, SyncFilter, SyncHub, SyncOffers, SyncPaused, SyncSystem, SyncVia, Ticket } from "./types";

/** What a check of a link answered with: what it found, or why the hub
 *  can't (its words, and the pause it would be), or a refusal. */
export type Checked = { ok: true; check: LinkCheck } | { ok: false; error: string; paused: SyncPaused | null; status: number };

const said = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The board sync on hub `hub` (the local hub), as the person. */
export const boardSyncOf = (hub: HubRef) => ({
  hubs: async (): Promise<SyncHub[]> => (await deskCall<{ hubs: SyncHub[] }>(hub, "GET", "/api/desk/sync-hubs")).hubs,
  /** Keeps hub `id` (named `name`, at `url`), with a pasted token; what it
   *  offers, once the token was tried. */
  putHub: async (id: string, b: { name: string; url: string; token?: string }): Promise<SyncOffers> =>
    (await deskCall<{ offers: SyncOffers }>(hub, "PUT", `/api/desk/sync-hubs/${encodeURIComponent(id)}`, b)).offers ?? null,
  forgetHub: (id: string): Promise<void> => deskCall(hub, "DELETE", `/api/desk/sync-hubs/${encodeURIComponent(id)}`),
  /** Whether `via` offers `system`'s tools, and what the dialog needs: the
   *  teams, the target's states, and how many issues the filter matches.
   *  The hub's reasons come back as an answer, not thrown. */
  check: async (b: { system: SyncSystem; via: SyncVia; target?: string; targetId?: string; filter?: SyncFilter; me?: string }): Promise<Checked> => {
    const res = await pairedHub(hub).fetch("POST", "/api/desk/boards/link/check", jsonBody(b));
    if (res.ok) return { ok: true, check: (await res.json()) as LinkCheck };
    const text = await res.text().catch(() => "");
    try {
      const body = JSON.parse(text) as { error?: unknown; paused?: unknown };
      if (typeof body.error === "string") return { ok: false, error: body.error, paused: (body.paused as SyncPaused | undefined) ?? null, status: res.status };
    } catch {
      /* not the hub's JSON */
    }
    return { ok: false, error: res.status === 404 || res.status === 405 ? "This computer's hub can't sync boards yet. Update Desk." : text.trim() || res.statusText || "The hub refused that.", paused: null, status: res.status };
  },
  link: (board: string, l: LinkBoard): Promise<Board> => deskCall(hub, "PUT", `/api/desk/boards/${encodeURIComponent(board)}/link`, l),
  unlink: (board: string): Promise<Board> => deskCall(hub, "DELETE", `/api/desk/boards/${encodeURIComponent(board)}/link`),
  pause: (board: string, paused: boolean): Promise<Board> => deskCall(hub, "POST", `/api/desk/boards/${encodeURIComponent(board)}/pause`, { paused }),
  /** Take it: the ticket's issue, which no one has there, is assigned to
   *  the person, as themselves, through the route its board syncs by. */
  take: (ticket: string): Promise<Ticket> => deskCall(hub, "POST", `/api/desk/tickets/${encodeURIComponent(ticket)}/take`),
  /** Asks for a pass at once; the hub answers 202 and runs it. */
  syncNow: async (board: string): Promise<void> => {
    const res = await pairedHub(hub).fetch("POST", `/api/desk/boards/${encodeURIComponent(board)}/sync`);
    if (!res.ok) throw await refusal(res);
  },
});

export type BoardSyncApi = ReturnType<typeof boardSyncOf>;

/** What minting a token on a hub did: kept on the local hub (with what the
 *  hub offers), or not allowed there (its words): then the person pastes
 *  one. `unavailable`: this Desk can't mint at all (the browser preview). */
export type Minted = { kind: "kept"; offers: SyncOffers } | { kind: "notAllowed"; status: number; error: string } | { kind: "unavailable" };

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Mints a token for board sync on paired hub `remote` with this Desk's
 *  device token, and hands it to the local hub as sync hub `id`: all on the
 *  native side, so the token is never in the page. */
export const mintSyncToken = async (remote: string, local: string, id: string, name: string): Promise<Minted> => {
  if (!inTauri) return { kind: "unavailable" };
  try {
    return await invoke<Minted>("board_sync_mint", { remote, local, id, name });
  } catch (e) {
    throw new HubError(502, said(e));
  }
};

/** A paired hub's id as the local hub may name a sync hub: lowercase
 *  letters, digits and dashes, at most 40. */
export const syncHubId = (pairedId: string): string => {
  const slug = pairedId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "hub";
};

/** Whether `s` can be pasted as a hub's token, as the local hub takes one:
 *  `wfr_`, letters, digits, `_` and `-`, longer than 20 and shorter than 200. */
export const looksLikeToken = (s: string): boolean => /^wfr_[A-Za-z0-9_-]{17,195}$/.test(s.trim());

/** Whether `target` can be `system`'s project or team key, as the hub
 *  checks it: a capital, then capitals or digits (and `_` on Jira); up to
 *  20 on Jira, 10 on Linear. */
export const targetOk = (system: SyncSystem, target: string): boolean =>
  system === "jira" ? /^[A-Z][A-Z0-9_]{0,19}$/.test(target) : /^[A-Z][A-Z0-9]{0,9}$/.test(target);

export const SYSTEM_TITLE: Record<SyncSystem, string> = { jira: "Jira", linear: "Linear" };

const hhmm = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** What a paused board says, as the hub's `Paused::say` words it. */
export const pausedWords = (p: SyncPaused, hub: string): string => {
  switch (p.kind) {
    case "byYou":
      return "Paused by you; changes go out when you resume it.";
    case "hubOffline":
      return `Paused: ${hub} is offline since ${hhmm(p.since)}; changes go out when it's back.`;
    case "hubUnpaired":
      return `Paused: ${hub} isn't linked any more. Unlink the board to keep it here, unsynced.`;
    case "noToken":
      return `Paused: ${hub} needs a new token.`;
    case "missing":
      return `Paused: ${hub} no longer offers ${p.tools.join(", ")}.`;
    case "refused":
      return `Paused: ${hub} refused: ${p.reason}`;
    case "leftGroup":
      return "Paused: this board left the group it was linked in; unlink it and link it again.";
  }
};

/** The status a synced board's chip shows: synced, paused (with why), or a
 *  problem (in the hub's words). A pause comes first, then a problem. */
export type SyncStatus = { kind: "synced" } | { kind: "paused"; words: string; byYou: boolean } | { kind: "problem"; words: string };

export const syncStatus = (b: Board, hub: string): SyncStatus | null => {
  const s = b.sync;
  if (!s) return null;
  if (s.paused) return { kind: "paused", words: pausedWords(s.paused, hub), byYou: s.paused.kind === "byYou" };
  if (s.problem) return { kind: "problem", words: s.problem };
  return { kind: "synced" };
};

/** "Jira ACME via Atlas": what a synced board is linked to. */
export const linkedTo = (b: Board, hub: string): string | null =>
  b.sync ? `${SYSTEM_TITLE[b.sync.system]} ${b.sync.target}${b.sync.via.kind === "hub" ? ` via ${hub}` : " with this computer's keys"}` : null;

/** Whether a ticket can be taken there: synced, no one has its issue, and
 *  it isn't finished. */
export const takeable = (b: Board | undefined, t: Ticket): boolean =>
  !!b?.sync && !b.sync.paused && !!t.external?.synced && !t.external.kept && t.external.assignee === null && t.state !== "done" && t.state !== "dropped";

/** The tickets on a board's Left-the-filter shelf. */
export const leftFilterOf = (tickets: readonly Ticket[]): Ticket[] => tickets.filter((t) => t.leftFilter && t.state !== "dropped");

/** An issue's address, only when it is a web address Desk may open. */
export const issueUrl = (t: Ticket): string | null => {
  const u = t.external?.url;
  if (!u) return null;
  try {
    return new URL(u).protocol === "https:" ? u : null;
  } catch {
    return null;
  }
};

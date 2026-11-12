import { deskCall, refusal, type BrowserLive, type BrowserSettings, type BrowserSettingsView } from "./client";
import { pairedHub, type HubRef } from "./net";

/** What Stop answers: the browsers closed, the turns ended, the session
 *  allowances dropped. */
export interface BrowserStopped {
  closed: number;
  turns_stopped: number;
  allowances_dropped: number;
}

/** Desk's browser on hub `hub` (this computer's), as the person: the hub
 *  answers only the person whose Desk it is, never the broker's token. */
export const browserOf = (hub: HubRef) => ({
  /** Desk's browser settings and the person's Chrome's standing. */
  settings: (): Promise<BrowserSettingsView> => deskCall(hub, "GET", "/api/desk/browser/settings"),
  save: (s: BrowserSettings): Promise<BrowserSettingsView> => deskCall(hub, "PUT", "/api/desk/browser/settings", s),
  /** The person confirms a Chrome profile asking to connect is theirs. */
  confirm: (id: string): Promise<BrowserSettingsView> => deskCall(hub, "POST", `/api/desk/browser/chrome/${encodeURIComponent(id)}/confirm`),
  /** The profile Desk uses, of those confirmed. */
  choose: (id: string): Promise<BrowserSettingsView> => deskCall(hub, "POST", `/api/desk/browser/chrome/${encodeURIComponent(id)}/choose`),
  /** Forgets a profile, or refuses one asking: it reaches nothing until confirmed again. */
  forget: (id: string): Promise<BrowserSettingsView> => deskCall(hub, "DELETE", `/api/desk/browser/chrome/${encodeURIComponent(id)}`),
  /** The browsers open now. */
  live: async (): Promise<BrowserLive[]> => (await deskCall<{ live: BrowserLive[] }>(hub, "GET", "/api/desk/browser")).live,
  /** Stop: the turns using the browser end, it closes, and its session allowances go. */
  stop: (agent?: string): Promise<BrowserStopped> => deskCall(hub, "POST", "/api/desk/browser/stop", agent ? { agent } : {}),
  /** A screenshot a browser's activity row names. */
  shot: async (file: string): Promise<Blob> => {
    const res = await pairedHub(hub).fetch("GET", `/api/desk/browser/shots/${encodeURIComponent(file)}`);
    if (!res.ok) throw await refusal(res);
    return res.blob();
  },
});

export type BrowserOf = ReturnType<typeof browserOf>;

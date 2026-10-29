import { hubFetch } from "../hub/net";

/** Pairing Desk with a remote hub: ask for a code, the person signs in to
 *  that hub in their browser and approves it there (which links Desk to
 *  their account), Desk collects a device token once. A hub that predates
 *  browser approval gives no page to open: its code is approved in its
 *  Pairing page, and the account is the one named by email when the code
 *  was asked for. */

/** Who a hub says approved a pairing. */
export interface PairedAs {
  name: string | null;
  email: string | null;
}

export type PairStatus =
  | { status: "pending" }
  | { status: "approved"; token: string; identity: PairedAs | null }
  | { status: "rejected" }
  | { status: "expired" };

export const normaliseHubUrl = (raw: string): string => {
  const trimmed = raw.trim().replace(/\/+$/, "");
  const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const u = new URL(withScheme);
  return `${u.protocol}//${u.host}`;
};

/** The kind of device Desk pairs as. The hub links a device to its person
 *  under this key and looks devices up only under the kinds it knows
 *  (`DEVICE_KINDS` in the hub's pairing crate: `ios_device`, `voice_device`,
 *  `desktop_device`); any other kind pairs and then never resolves to
 *  anyone. Desk's own hub pairs it as this too. */
export const DEVICE_KIND = "desktop_device";

/** A code asked for, and the page to approve it on — null from a hub that
 *  predates browser approval. */
export interface PairingCode {
  code: string;
  approveUrl: string | null;
}

/** The approval page as Desk opens it: an https page (the hub's sign-in may
 *  live on another host of the workspace), or plain http only on the hub's
 *  own host (a hub on this network); never another kind of link. */
const approvePage = (raw: unknown, hub: string): string | null => {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const page = new URL(raw, hub);
    const ok = page.protocol === "https:" || (page.protocol === "http:" && page.host === new URL(hub).host);
    return ok ? page.toString() : null;
  } catch {
    return null;
  }
};

/** Asks `url` for a pairing code. `email` matters only to a hub without
 *  browser approval: it links the device to that account when the code is
 *  approved, the only time such a hub does. */
export const requestPairing = async (url: string, deviceName: string, email?: string): Promise<PairingCode> => {
  const identity = email?.trim();
  const res = await hubFetch(`${url}/api/pair/device/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_name: deviceName, device_kind: DEVICE_KIND, ...(identity ? { identity_hint: identity } : {}) }),
  });
  if (res.status === 404) throw new Error("That workspace doesn't accept new devices.");
  if (res.status === 429) throw new Error("Too many pairing attempts — wait a minute and try again.");
  if (!res.ok) throw new Error(`The workspace refused the request (${res.status}).`);
  const body = (await res.json()) as { code: string; approve_url?: unknown };
  return { code: body.code, approveUrl: approvePage(body.approve_url, url) };
};

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export const pairingStatus = async (url: string, code: string): Promise<PairStatus> => {
  const res = await hubFetch(`${url}/api/pair/device/status/${encodeURIComponent(code)}`);
  if (res.status === 404) return { status: "expired" };
  if (!res.ok) throw new Error(`The workspace could not say how the request went (${res.status}).`);
  const body = (await res.json()) as { status: string; token?: string; identity?: { display_name?: unknown; email?: unknown } | null };
  if (body.status === "approved") {
    if (!body.token) throw new Error("Approved, but that code was already used. Try connecting again.");
    const who = body.identity && { name: text(body.identity.display_name), email: text(body.identity.email) };
    return { status: "approved", token: body.token, identity: who && (who.name || who.email) ? who : null };
  }
  return body.status === "rejected" ? { status: "rejected" } : { status: "pending" };
};

/** Who a hub takes Desk's token to be (`GET /api/me`): a person; nobody —
 *  the device is paired but linked to no account (401); or unknown, when
 *  the hub couldn't say. */
export type Who = { state: "person"; name: string | null; email: string | null } | { state: "nobody" } | { state: "unknown"; why: string };

export const whoAmI = async (url: string, token: string): Promise<Who> => {
  try {
    const res = await hubFetch(new URL("/api/me", url), { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 401) return { state: "nobody" };
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return { state: "unknown", why: `${res.status}` };
    const body = (await res.json()) as { display_name?: unknown; email?: unknown };
    return { state: "person", name: text(body.display_name), email: text(body.email) };
  } catch (e) {
    return { state: "unknown", why: e instanceof Error ? e.message : String(e) };
  }
};

/** A pairing Desk has asked for and not yet collected. It's kept, so a reload,
 *  a quit or a crash while you approve it doesn't lose it: an approved code
 *  keeps its token on the hub until Desk collects it. */
export interface PendingPairing {
  url: string;
  label: string;
  code: string;
  /** The page it's approved on, to open again; none from an older hub. */
  approveUrl?: string;
}

const PENDING = "pairing.pending";
const EMAIL = "pairing.email";

/** Where a pending pairing is kept: Desk's state store, or a stand-in. */
export interface PendingStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  remove(key: string): void;
}

export const pendingPairing = (store: PendingStore): PendingPairing | null => {
  const p = store.get(PENDING) as Partial<PendingPairing> | undefined;
  if (!p || typeof p.url !== "string" || typeof p.code !== "string" || !p.code) return null;
  const page = approvePage(p.approveUrl, p.url);
  return { url: p.url, label: typeof p.label === "string" ? p.label : "", code: p.code, ...(page ? { approveUrl: page } : {}) };
};

export const keepPending = (store: PendingStore, p: PendingPairing): void => store.set(PENDING, p);

/** The email Desk last asked an older hub for a code with, to offer next
 *  time. */
export const lastEmail = (store: PendingStore): string | null => {
  const e = store.get(EMAIL);
  return typeof e === "string" && e.includes("@") ? e : null;
};

export const rememberEmail = (store: PendingStore, email: string): void => store.set(EMAIL, email.trim());

export const dropPending = (store: PendingStore, code?: string): void => {
  if (!code || pendingPairing(store)?.code === code) store.remove(PENDING);
};

/** A pairing that ended without a token: turned down or expired. */
export class PairingEnded extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A pairing collected: the hub's label, and who approved it when the hub
 *  says. */
export interface Paired {
  label: string;
  as: PairedAs | null;
}

/** The one collection running per code: the token can be read only once, so
 *  the dialog and the resume at launch share it. */
const collecting = new Map<string, Promise<Paired>>();

/** Waits for `p` to be approved, then saves the hub with its token (`save`)
 *  and forgets the pending pairing. A refusal or expiry forgets it too and
 *  throws `PairingEnded`; anything else throws and keeps it for next time. */
export function collectPairing(
  store: PendingStore,
  p: PendingPairing,
  save: (label: string, url: string, token: string) => Promise<unknown>,
  every = 2000,
): Promise<Paired> {
  const running = collecting.get(p.code);
  if (running) return running;
  const run = (async () => {
    for (;;) {
      const s = await pairingStatus(p.url, p.code);
      if (s.status === "approved") {
        const label = p.label || new URL(p.url).hostname;
        await save(label, p.url, s.token);
        dropPending(store, p.code);
        return { label, as: s.identity };
      }
      if (s.status !== "pending") {
        dropPending(store, p.code);
        throw new PairingEnded(s.status === "rejected" ? "The workspace turned the request down." : "The code expired. Ask for a new one.");
      }
      await sleep(every);
    }
  })();
  collecting.set(p.code, run);
  void run.finally(() => collecting.delete(p.code)).catch(() => {});
  return run;
}

import { pairedHub, type HubRef } from "../hub/net";
import { invoke } from "../platform";

/** Pairing Desk with a remote hub: ask for a code, the person signs in to
 *  that hub in their browser and approves it there (which links Desk to
 *  their account), Desk collects a device token once. A hub that predates
 *  browser approval gives no page to open: its code is approved in its
 *  Pairing page, and the account is the one named by email when the code
 *  was asked for.
 *
 *  The requests go through Desk's native side (src-tauri/src/hub_io.rs),
 *  which collects the token and keeps it: the page is told the pairing
 *  went through, never the token. */

/** Who a hub says approved a pairing. */
export interface PairedAs {
  name: string | null;
  email: string | null;
}

/** How a pairing stands. An approved one has been kept, as hub `hub`. */
export type PairStatus =
  | { status: "pending" }
  | { status: "approved"; hub: string; identity: PairedAs | null }
  | { status: "rejected" }
  | { status: "expired" }
  | { status: "used" };

/** What a typed address that isn't one says. */
export const NOT_AN_ADDRESS = "That isn’t a workspace address. Type one like workforce.example.com.";

/** A typed workspace address as Desk keeps it: a bare host (`acme.io`), a
 *  full address or a link pasted from the workspace (its path dropped) all
 *  become `https://host[:port]`; `http` only as typed. Anything else is
 *  refused in plain words, never the browser's own ("Invalid URL"). */
export const normaliseHubUrl = (raw: string): string => {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed || /\s/.test(trimmed)) throw new Error(NOT_AN_ADDRESS);
  const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new Error(NOT_AN_ADDRESS);
  }
  // A host with a dot (or localhost, or an address): `acme` alone is a typo.
  const host = u.hostname;
  const named = host === "localhost" || host.includes(".") || host.startsWith("[");
  if ((u.protocol !== "https:" && u.protocol !== "http:") || !named) throw new Error(NOT_AN_ADDRESS);
  return `${u.protocol}//${u.host}`;
};

/** The words a hub's address often starts with, which say nothing of whose
 *  it is. */
const GENERIC = new Set(["www", "workforce", "hub", "app", "desk", "api", "gateway", "agents", "ai"]);

/** Second-level labels that, under a two-letter country code, are part of
 *  the public suffix (`acme.co.uk`): never a name. As the hub's. */
const SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "ac", "edu", "ltd", "plc", "ne", "or", "gen"]);

/** The longest name a workspace is shown or kept by; longer is cut. */
export const NAME_MAX = 60;

/** `v` as a workspace's name: trimmed, cut to `NAME_MAX`; null when empty
 *  or not text. Whatever a hub says of itself goes through this. */
export const capName = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = [...v.trim()].slice(0, NAME_MAX).join("").trim();
  return t || null;
};

/** What a workspace at `url` is called when it doesn't say (an older hub):
 *  the first part of its address that says whose it is —
 *  `workforce.driftwerk.xyz` → "Driftwerk". As the hub names itself
 *  (`name_of_host` in its gateway): the two give the same name. */
export const nameOfHost = (url: string): string => {
  let host: string;
  try {
    host = new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).hostname;
  } catch {
    return url;
  }
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2 || labels.every((l) => /^\d+$/.test(l)) || host.startsWith("[")) return capName(host) ?? host;
  const n = labels.length;
  const suffix = n >= 3 && labels[n - 1]!.length === 2 && SECOND_LEVEL.has(labels[n - 2]!.toLowerCase()) ? 2 : 1;
  const named = labels.slice(0, n - suffix).find((l) => !GENERIC.has(l.toLowerCase()));
  return capName(named ? named[0]!.toUpperCase() + named.slice(1) : host) ?? host;
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** A code asked for, and the page to approve it on — null from a hub that
 *  predates browser approval. */
export interface PairingCode {
  code: string;
  approveUrl: string | null;
  /** What the workspace calls itself; null from a hub that doesn't say. */
  name: string | null;
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
  const res = await invoke<{ status: number; body: { code?: unknown; approve_url?: unknown; name?: unknown } | null }>("pair_request", {
    url,
    deviceName,
    identityHint: identity || null,
  });
  const host = hostOf(url);
  if (res.status === 404) throw new PairingRefused(`${host} doesn’t let new devices connect. Ask its admin to turn on device pairing.`, res.status);
  if (res.status === 429) throw new PairingRefused(`${host} has had too many tries just now. Try again in a minute.`, res.status);
  if (res.status >= 500) throw new PairingRefused(`Something went wrong at ${host}. Try again in a moment.`, res.status);
  if (res.status < 200 || res.status >= 300) throw new PairingRefused(`${host} turned the request down.`, res.status);
  if (typeof res.body?.code !== "string" || !res.body.code) throw new PairingRefused(`${host} didn’t give Desk a code. Try again in a moment.`, res.status);
  return { code: res.body.code, approveUrl: approvePage(res.body.approve_url, url), name: capName(res.body.name) };
};

/** How pairing `code` at `url` stands; once approved, the native side has
 *  kept the hub as `label` with its token. */
export const pairingStatus = (url: string, code: string, label: string): Promise<PairStatus> =>
  invoke<PairStatus>("pair_collect", { url, code, label });

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Who a hub takes Desk's token to be (`GET /api/me`): a person; nobody —
 *  the device is paired but linked to no account (401); or unknown, when
 *  the hub couldn't say. */
export type Who =
  /** `workspace`: what the hub calls itself; null from one that doesn't say. */
  | { state: "person"; name: string | null; email: string | null; workspace: string | null }
  | { state: "nobody" }
  | { state: "unknown"; why: string };

export const whoAmI = async (hub: HubRef): Promise<Who> => {
  try {
    const res = await pairedHub(hub).fetch("GET", "/api/me");
    if (res.status === 401) return { state: "nobody" };
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return { state: "unknown", why: `${res.status}` };
    const body = (await res.json()) as { display_name?: unknown; email?: unknown; workspace?: unknown };
    return { state: "person", name: text(body.display_name), email: text(body.email), workspace: capName(body.workspace) };
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
  /** The email an older hub's code was asked for with, to ask again by. */
  email?: string;
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
  const email = typeof p.email === "string" && p.email.includes("@") ? p.email : null;
  return {
    url: p.url,
    label: capName(p.label) ?? "",
    code: p.code,
    ...(page ? { approveUrl: page } : {}),
    ...(email ? { email } : {}),
  };
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

/** A workspace's answer to a request for a code that isn't one: what it
 *  means, in plain words, and its status (kept for Details). */
export class PairingRefused extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** A pairing that ended without a token: turned down, or its code expired
 *  or was already used (an expired one Desk starts again with a new code by
 *  itself; a used one it leaves to the person, as someone else may have
 *  used it). */
export class PairingEnded extends Error {
  constructor(
    message: string,
    readonly reason: "rejected" | "expired" | "used" = "expired",
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A pairing collected: the hub's label, and who approved it when the hub
 *  says. */
export interface Paired {
  label: string;
  /** Its address, to sign in again there. */
  url: string;
  as: PairedAs | null;
}

/** The one collection running per code: the token can be read only once, so
 *  the dialog and the resume at launch share it. */
const collecting = new Map<string, Promise<Paired>>();

/** Waits for `p` to be approved (when the native side keeps the hub and
 *  its token), then tells `saved` and forgets the pending pairing. A
 *  refusal or expiry forgets it too and throws `PairingEnded`; anything
 *  else throws and keeps it for next time. */
export function collectPairing(
  store: PendingStore,
  p: PendingPairing,
  saved: (hub: string) => Promise<unknown>,
  every = 2000,
): Promise<Paired> {
  const running = collecting.get(p.code);
  if (running) return running;
  const run = (async () => {
    const label = capName(p.label) ?? nameOfHost(p.url);
    for (;;) {
      const s = await pairingStatus(p.url, p.code, label);
      if (s.status === "approved") {
        dropPending(store, p.code);
        await saved(s.hub);
        return { label, url: p.url, as: s.identity };
      }
      if (s.status === "used") {
        dropPending(store, p.code);
        throw new PairingEnded("Someone may have used that code already: if it wasn’t you, ask for a new one.", "used");
      }
      if (s.status !== "pending") {
        dropPending(store, p.code);
        throw new PairingEnded(s.status === "rejected" ? `${hostOf(p.url)} turned the request down.` : "The code expired.", s.status === "rejected" ? "rejected" : "expired");
      }
      await sleep(every);
    }
  })();
  collecting.set(p.code, run);
  void run.finally(() => collecting.delete(p.code)).catch(() => {});
  return run;
}

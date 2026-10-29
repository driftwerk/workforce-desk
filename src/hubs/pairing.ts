import { hubFetch } from "../hub/net";

/** Pairing Desk with a remote hub, the way the iPhone pairs: ask for a code,
 *  the person approves it on that hub, Desk collects a device token once. */

export type PairStatus =
  | { status: "pending" }
  | { status: "approved"; token: string }
  | { status: "rejected" }
  | { status: "expired" };

export const normaliseHubUrl = (raw: string): string => {
  const trimmed = raw.trim().replace(/\/+$/, "");
  const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const u = new URL(withScheme);
  return `${u.protocol}//${u.host}`;
};

export const requestPairing = async (url: string, deviceName: string, email: string): Promise<string> => {
  const res = await hubFetch(`${url}/api/pair/device/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_name: deviceName, identity_hint: email || undefined, device_kind: "desk" }),
  });
  if (res.status === 404) throw new Error("That workspace doesn't accept new devices.");
  if (res.status === 429) throw new Error("Too many pairing attempts — wait a minute and try again.");
  if (!res.ok) throw new Error(`The workspace refused the request (${res.status}).`);
  return ((await res.json()) as { code: string }).code;
};

export const pairingStatus = async (url: string, code: string): Promise<PairStatus> => {
  const res = await hubFetch(`${url}/api/pair/device/status/${encodeURIComponent(code)}`);
  if (res.status === 404) return { status: "expired" };
  if (!res.ok) throw new Error(`The workspace could not say how the request went (${res.status}).`);
  const body = (await res.json()) as { status: string; token?: string };
  if (body.status === "approved") {
    if (!body.token) throw new Error("Approved, but that code was already used. Try connecting again.");
    return { status: "approved", token: body.token };
  }
  return body.status === "rejected" ? { status: "rejected" } : { status: "pending" };
};

/** A pairing Desk has asked for and not yet collected. It's kept, so a reload,
 *  a quit or a crash while you approve it doesn't lose it: an approved code
 *  keeps its token on the hub until Desk collects it. */
export interface PendingPairing {
  url: string;
  label: string;
  code: string;
}

const PENDING = "pairing.pending";

/** Where a pending pairing is kept: Desk's state store, or a stand-in. */
export interface PendingStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  remove(key: string): void;
}

export const pendingPairing = (store: PendingStore): PendingPairing | null => {
  const p = store.get(PENDING) as Partial<PendingPairing> | undefined;
  return p && typeof p.url === "string" && typeof p.code === "string" && p.code
    ? { url: p.url, label: typeof p.label === "string" ? p.label : "", code: p.code }
    : null;
};

export const keepPending = (store: PendingStore, p: PendingPairing): void => store.set(PENDING, p);

export const dropPending = (store: PendingStore, code?: string): void => {
  if (!code || pendingPairing(store)?.code === code) store.remove(PENDING);
};

/** A pairing that ended without a token: turned down or expired. */
export class PairingEnded extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The one collection running per code: the token can be read only once, so
 *  the dialog and the resume at launch share it. */
const collecting = new Map<string, Promise<string>>();

/** Waits for `p` to be approved, then saves the hub with its token (`save`)
 *  and forgets the pending pairing; answers the hub's label. A refusal or
 *  expiry forgets it too and throws `PairingEnded`; anything else throws and
 *  keeps it for next time. */
export function collectPairing(
  store: PendingStore,
  p: PendingPairing,
  save: (label: string, url: string, token: string) => Promise<unknown>,
  every = 2000,
): Promise<string> {
  const running = collecting.get(p.code);
  if (running) return running;
  const run = (async () => {
    for (;;) {
      const s = await pairingStatus(p.url, p.code);
      if (s.status === "approved") {
        const label = p.label || new URL(p.url).hostname;
        await save(label, p.url, s.token);
        dropPending(store, p.code);
        return label;
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

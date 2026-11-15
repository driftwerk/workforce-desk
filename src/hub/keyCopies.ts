// The person's own connections on a hub they're paired with, offered for
// setting up here (Settings → Connections: "Patchwork has 4 of your
// connections"). The page lists them over the paired path (names and sites,
// never a value). Taking them is the native side's alone
// (src-tauri/src/key_copies.rs): it fetches the keys with the device token
// and hands them straight to this computer's hub, which checks each with
// its service's test call and keeps it, or keeps nothing. The page never
// sees a key, and can't ask the hub for one (hub_io::page_refused).

import type { HubAccount } from "../chat/types";
import { invoke } from "../platform";
import { HubError, hubCall } from "./client";
import type { Connector } from "./connections";

/** One connection of the person's on the paired hub. */
export interface RemoteConnection {
  connector: string;
  service: string;
  key: string;
  name: string;
  site: string | null;
  account: string | null;
  updatedAt: string | null;
}

/** A connection copied here from a paired hub before: no value. */
export interface CopyRecord {
  hub: string;
  connector: string;
  remoteKey: string;
  connection: string;
  updatedAt: string | null;
}

/** What the offer holds: a connection not here yet, or one copied here
 *  whose key changed there since (`into`: the connection here it goes over). */
export type OfferItem = (RemoteConnection & { state: "new" }) | (RemoteConnection & { state: "newer"; into: string; localName: string });

/** One pick, as the native side takes it. */
export interface CopyPick {
  connector: string;
  key: string;
  into?: string;
}

/** What became of one pick. */
export type Copied =
  | {
      kind: "saved";
      connector: string;
      key: string;
      connection: string;
      name: string;
      account: string | null;
    }
  | { kind: "failed"; connector: string; key: string; error: string }
  | { kind: "missing"; connector: string; key: string };

export type Taken = { kind: "done"; results: Copied[] } | { kind: "notAllowed"; status: number; error: string } | { kind: "unavailable" };

/** The hubs an offer may come from: paired, not this computer's, not a
 *  machine's. */
export const sources = (hubs: HubAccount[]): HubAccount[] => hubs.filter((h) => !h.local && !h.machine);

/** The person's connections on `hub`; null when it offers none (an older
 *  hub, its admin turned copying off, it can't be reached). */
export const remoteConnections = async (hub: HubAccount): Promise<RemoteConnection[] | null> => {
  try {
    const got = await hubCall<{ connections?: RemoteConnection[] }>(hub, "GET", "/api/me/desk-key-copies");
    return got.connections ?? [];
  } catch (e) {
    if (e instanceof HubError) return null;
    return null;
  }
};

/** Native commands, as the page reaches them; replaced in tests and the
 *  browser preview. */
export interface CopyNative {
  kept: (remote: string) => Promise<CopyRecord[]>;
  take: (remote: string, picks: CopyPick[]) => Promise<Taken>;
}

/** The native commands, as the main window installs them (`shell/App.tsx`):
 *  a grid's window isn't granted them, and offers nothing. */
export const liveCopier: CopyNative = {
  kept: (remote) => invoke<CopyRecord[]>("key_copies_kept", { remote }),
  take: async (remote, picks) => {
    try {
      return await invoke<Taken>("key_copies_take", { remote, picks });
    } catch (e) {
      return {
        kind: "notAllowed",
        status: 0,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
};

let copier: CopyNative | null = null;

export const setCopier = (c: CopyNative | null) => {
  copier = c;
};

export const currentCopier = (): CopyNative | null => copier;

const same = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const n = (s: string | null | undefined) =>
    (s ?? "")
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, "");
  return !!n(a) && n(a) === n(b);
};

const later = (a: string | null, b: string | null): boolean => {
  if (!a) return false;
  if (!b) return true;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isFinite(ta) && Number.isFinite(tb) && ta > tb;
};

/** What to offer from hub `hub`: each of its connections not here yet,
 *  and each copied here whose key there is newer than the copy. One the
 *  person made here by hand (the same service and site or account) isn't
 *  offered, nor a service this computer's hub doesn't connect. */
export const offerOf = (hub: string, remote: RemoteConnection[], records: CopyRecord[], local: Connector[]): OfferItem[] => {
  const out: OfferItem[] = [];
  for (const r of remote) {
    const here = local.find((c) => c.id === r.connector);
    if (!here) continue;
    const record = records.find((x) => x.hub === hub && x.connector === r.connector && x.remoteKey === r.key);
    const copy = record && here.connections.find((x) => x.id === record.connection);
    if (record && copy) {
      if (later(r.updatedAt, record.updatedAt)) out.push({ ...r, state: "newer", into: copy.id, localName: copy.name });
      continue;
    }
    const byHand = r.site
      ? here.connections.some((x) => same(x.site, r.site))
      : r.account
        ? here.connections.some((x) => same(x.account, r.account))
        : here.connections.length > 0;
    if (!byHand) out.push({ ...r, state: "new" });
  }
  return out;
};

/** "Jira, GitHub and Datadog" */
export const serviceList = (items: { service: string }[]): string => {
  const names = items.map((i) => i.service);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
};

/** Where "Not now" is kept, per viewer: an offer dismissed stays so until
 *  the key there changes again. */
const DISMISSED = "desk.keyCopies.dismissed";

export const dismissKey = (hub: string, i: RemoteConnection): string => `${hub}|${i.connector}|${i.key}|${i.updatedAt ?? ""}`;

export const dismissed = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(DISMISSED) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
};

export const dismiss = (keys: string[]) => {
  try {
    const all = dismissed();
    for (const k of keys) all.add(k);
    localStorage.setItem(DISMISSED, JSON.stringify([...all].slice(-200)));
  } catch {
    // Shown again next time.
  }
};

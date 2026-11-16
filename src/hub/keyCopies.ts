// The person's own connections on a hub they're paired with, offered for
// setting up here (Settings → Connections: "Patchwork has 4 of your
// connections"). The page lists them over the paired path (names and sites,
// never a value). Taking them is the native side's alone
// (src-tauri/src/key_copies.rs): it fetches the keys with the device token
// and hands them straight to this computer's hub, which checks each with
// its service's test call and keeps it, or keeps nothing. The page never
// sees a key, and can't ask the hub for one (hub_io::page_refused).
//
// A hub offers the person's keys from both tiers that are theirs alone:
// their personal one, and their own in each agent they use there ("through
// Allan"). Never a tier shared by everyone on the hub or everyone using an
// agent. One connection in both is offered once, from the personal tier
// (the hub picks: `connections_of` in its desk_key_copies.rs). An older
// hub says no tier: every one of its connections is personal.

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
  /** `global_per_user` (personal) or `agent_per_user` (through `agent`);
   *  absent from an older hub, which offers personal ones only. */
  tier?: string;
  /** The agent it is kept through there, and its name. */
  agent?: string | null;
  agentName?: string | null;
}

/** What a hub says of the person's connections there. */
export interface RemoteList {
  connections: RemoteConnection[];
  /** Services the person signed in to there whose sign-in can't be copied
   *  (Google, on that hub's own client). */
  signInOnly: { connector: string; service: string }[];
}

/** The agent a connection is kept through, or null for the personal tier. */
export const agentOf = (i: { agent?: string | null }): string | null =>
  i.agent ?? null;

/** Whether two say the same connection there: the same service, key and
 *  tier. */
export const sameRemote = (
  a: { connector: string; key: string; agent?: string | null },
  b: { connector: string; key: string; agent?: string | null },
): boolean =>
  a.connector === b.connector && a.key === b.key && agentOf(a) === agentOf(b);

/** A connection copied here from a paired hub before: no value. */
export interface CopyRecord {
  hub: string;
  connector: string;
  remoteKey: string;
  /** The agent it was copied through there; absent: the personal tier. */
  agent?: string | null;
  connection: string;
  updatedAt: string | null;
  /** When this computer's hub kept the copy: kept again since, it's no
   *  longer the copy. */
  connectedAt?: string | null;
}

/** What the offer holds: a connection not here yet, or one copied here
 *  whose key changed there since (`into`: the connection here it goes over). */
export type OfferItem =
  | (RemoteConnection & { state: "new" })
  | (RemoteConnection & { state: "newer"; into: string; localName: string });

/** One pick, as the native side takes it. */
export interface CopyPick {
  connector: string;
  key: string;
  agent?: string;
  into?: string;
}

/** What became of one pick. */
export type Copied =
  | {
      kind: "saved";
      connector: string;
      key: string;
      agent?: string | null;
      connection: string;
      name: string;
      account: string | null;
    }
  | {
      kind: "failed";
      connector: string;
      key: string;
      agent?: string | null;
      error: string;
    }
  | { kind: "missing"; connector: string; key: string; agent?: string | null };

export type Taken =
  | { kind: "done"; results: Copied[] }
  | { kind: "notAllowed"; status: number; error: string }
  | { kind: "unavailable" };

/** The hubs an offer may come from: paired, not this computer's, not a
 *  machine's. */
export const sources = (hubs: HubAccount[]): HubAccount[] =>
  hubs.filter((h) => !h.local && !h.machine);

/** The person's connections on `hub`, through its agents too; null when it
 *  offers none (an older hub, its admin turned copying off, it can't be
 *  reached). */
export const remoteConnections = async (
  hub: HubAccount,
): Promise<RemoteList | null> => {
  try {
    const got = await hubCall<{
      connections?: RemoteConnection[];
      signInOnly?: RemoteList["signInOnly"];
    }>(hub, "GET", "/api/me/desk-key-copies?with=agents");
    return {
      connections: got.connections ?? [],
      signInOnly: got.signInOnly ?? [],
    };
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

const same = (
  a: string | null | undefined,
  b: string | null | undefined,
): boolean => {
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
export const offerOf = (
  hub: string,
  remote: RemoteConnection[],
  records: CopyRecord[],
  local: Connector[],
): OfferItem[] => {
  const out: OfferItem[] = [];
  for (const r of remote) {
    const here = local.find((c) => c.id === r.connector);
    if (!here) continue;
    const record = records.find(
      (x) =>
        x.hub === hub &&
        sameRemote(
          { connector: x.connector, key: x.remoteKey, agent: x.agent },
          r,
        ),
    );
    // Still the copy: not kept again here since (by hand, or removed and
    // made anew under the same id).
    const copy =
      record && record.connectedAt
        ? here.connections.find(
            (x) =>
              x.id === record.connection &&
              x.connectedAt === record.connectedAt,
          )
        : undefined;
    if (record && copy) {
      if (later(r.updatedAt, record.updatedAt))
        out.push({ ...r, state: "newer", into: copy.id, localName: copy.name });
      continue;
    }
    // With neither site nor account (a Linear workspace), one named is told
    // by its name (as a copy here is named, or the account a check found);
    // one of the service's name alone, by any connection of it here.
    const named = r.name && r.name !== r.service;
    const byHand = r.site
      ? here.connections.some((x) => same(x.site, r.site))
      : r.account
        ? here.connections.some((x) => same(x.account, r.account))
        : named
          ? here.connections.some(
              (x) => same(x.name, r.name) || same(x.account, r.name),
            )
          : here.connections.length > 0;
    if (!byHand) out.push({ ...r, state: "new" });
  }
  return out;
};

/** "Jira, GitHub and Datadog" */
export const serviceList = (items: { service: string }[]): string => {
  const names = items.map((i) => i.service);
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
};

/** Where "Not now" is kept, per viewer: an offer dismissed stays so until
 *  the key there changes again. */
const DISMISSED = "desk.keyCopies.dismissed";

export const dismissKey = (hub: string, i: RemoteConnection): string => {
  const agent = agentOf(i);
  // A personal one's as before, so a "Not now" given then still holds.
  return `${hub}|${i.connector}|${i.key}|${i.updatedAt ?? ""}${agent ? `|@${agent}` : ""}`;
};

export const dismissed = (): Set<string> => {
  try {
    return new Set(
      JSON.parse(localStorage.getItem(DISMISSED) ?? "[]") as string[],
    );
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

/** What a connection's name is, by service, where it has no site: a
 *  Linear workspace, a GitHub account. */
const NAMED: Record<string, string> = {
  linear: "workspace",
  github: "account",
  email: "mailbox",
  datadog: "workspace",
  metabase: "instance",
  jira: "site",
};

/** A site as it reads: "metabase.acme.example", not its scheme. */
const bare = (site: string): string =>
  site
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");

/** The name the person gave a connection, when it isn't the service's. */
const givenName = (i: RemoteConnection): string | null =>
  i.name && i.name !== i.service ? i.name : null;

/** Where one connection is, labelled: "patchwork.atlassian.net",
 *  "workspace ‘driftwerk’", "ann@acme.example"; null when only the
 *  service says it. */
export const placeOf = (i: RemoteConnection): string | null => {
  if (i.site)
    return i.account ? `${bare(i.site)} · ${i.account}` : bare(i.site);
  const name = givenName(i);
  if (name) return `${NAMED[i.connector] ?? "workspace"} ‘${name}’`;
  return i.account;
};

/** One service's connections from one tier, in a line: "Jira
 *  (patchwork.atlassian.net)", "Linear — workspace ‘driftwerk’",
 *  "Linear — driftwerk, mantiscrm, petmobile workspaces", "Email". */
export const serviceLine = (items: RemoteConnection[]): string => {
  const service = items[0]?.service ?? "";
  const noun = NAMED[items[0]?.connector ?? ""] ?? "workspace";
  const sites = items.flatMap((i) => (i.site ? [bare(i.site)] : []));
  const names = items.flatMap((i) => (i.site ? [] : (givenName(i) ?? [])));
  const accounts = items.flatMap((i) =>
    !i.site && !givenName(i) && i.account ? [i.account] : [],
  );
  let line = service;
  const inBrackets = [...sites, ...accounts];
  if (inBrackets.length > 0) line += ` (${inBrackets.join(", ")})`;
  if (names.length === 1) line += ` — ${noun} ‘${names[0]}’`;
  else if (names.length > 1) line += ` — ${names.join(", ")} ${noun}s`;
  return line;
};

/** Where a hub's connections are kept, in words: "Driftwerk", or
 *  "Driftwerk (through Allan)" for those kept through an agent there. */
export const fromOf = (hub: string, i: RemoteConnection): string => {
  const agent = agentOf(i);
  return agent ? `${hub} (through ${i.agentName || agent})` : hub;
};

/** A hub's offer, a line per tier (its personal one first) and in it a
 *  part per service, in the order the hub listed them:
 *  [{ from: "Driftwerk (through Allan)", services: ["Linear — …", "Email"] }]. */
export const offerLines = (
  hub: string,
  items: RemoteConnection[],
): { from: string; services: string[] }[] => {
  const tiers: {
    agent: string | null;
    from: string;
    by: Map<string, RemoteConnection[]>;
  }[] = [];
  for (const i of items) {
    const agent = agentOf(i);
    let tier = tiers.find((t) => t.agent === agent);
    if (!tier) {
      tier = { agent, from: fromOf(hub, i), by: new Map() };
      tiers.push(tier);
    }
    tier.by.set(i.connector, [...(tier.by.get(i.connector) ?? []), i]);
  }
  tiers.sort((a, b) => (a.agent === null ? -1 : b.agent === null ? 1 : 0));
  return tiers.map((t) => ({
    from: t.from,
    services: [...t.by.values()].map(serviceLine),
  }));
};

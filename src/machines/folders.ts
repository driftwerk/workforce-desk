// A machine's folders, to complete New session's folder on it: the hub's
// `GET /api/desk/folders?path=&hidden=` (PR MH1), folders only, under the
// home of the account Desk runs as there. Read leniently: a hub without the
// route has no suggestions, and the page goes on with what is typed.

import type { DeskTransport } from "../hub/transport";

export interface Folder {
  /** Where it is, as typed: under `~` when it's in the home folder. */
  path: string;
  /** It's a git repository. */
  git: boolean;
}

/** `path` with the home folder as `~`. */
export const tilde = (path: string, home: string | null): string =>
  home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;

/** The folder a typed path lists from, and what the next part starts with:
 *  `~/src/wo` lists `~/src` for `wo`; a path ending in `/` lists itself. */
export const splitTyped = (typed: string): { dir: string | null; prefix: string } => {
  const at = typed.lastIndexOf("/");
  if (at < 0) return { dir: null, prefix: typed };
  const dir = typed.slice(0, at) || "/";
  return { dir: dir === "~" ? null : dir, prefix: typed.slice(at + 1) };
};

/** The home folder a listing asked for no folder says: the hub lists home
 *  then, and names it as the folder listed (`path`); `home` where a hub
 *  names it outright. Null when it says neither. */
export const homeOfListing = (body: unknown): string | null => {
  const o = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (typeof o.home === "string" && o.home) return o.home;
  return typeof o.path === "string" && o.path.startsWith("/") ? o.path : null;
};

/** What the hub said, as folders; anything it didn't say right is left out.
 *  `home`: the home folder, where the caller knows it (a listing asked for
 *  no folder is of home). */
export const readFolders = (body: unknown, known: string | null = null): { folders: Folder[]; home: string | null } => {
  const o = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const rows = Array.isArray(body) ? body : Array.isArray(o.folders) ? o.folders : [];
  const home = typeof o.home === "string" ? o.home : known;
  const folders = rows.flatMap((r): Folder[] => {
    if (!r || typeof r !== "object") return [];
    const f = r as Record<string, unknown>;
    if (typeof f.path !== "string" || !f.path) return [];
    return [{ path: tilde(f.path, home), git: f.git === true || f.repo === true }];
  });
  return { folders, home };
};

/** The folders in `dir` (the home folder when null), git repositories first. */
export const listFolders = async (t: DeskTransport, dir: string | null): Promise<Folder[]> => {
  const q = new URLSearchParams();
  if (dir) q.set("path", dir);
  const res = await t.fetch("GET", `/api/desk/folders${q.size ? `?${q.toString()}` : ""}`);
  if (!res.ok) return [];
  const body: unknown = await res.json().catch(() => null);
  const { folders } = readFolders(body, dir ? null : homeOfListing(body));
  return [...folders].sort((a, b) => Number(b.git) - Number(a.git) || a.path.localeCompare(b.path));
};

/** The suggestions for `typed`: what's in the folder it's in that starts
 *  as its last part does, at most `max`. */
export const suggest = (folders: readonly Folder[], typed: string, max = 6): Folder[] => {
  const { prefix } = splitTyped(typed);
  const name = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  return folders.filter((f) => f.path !== typed && name(f.path).toLowerCase().startsWith(prefix.toLowerCase())).slice(0, max);
};

/** How long a folder listing may take before Desk says so. */
export const LIST_WITHIN_MS = 10_000;

/** A path as typed (`~`, `~/src`, `src`, `/srv`) as the machine's own:
 *  absolute, under `home` unless it says otherwise. */
export const onMachine = (typed: string, home: string): string => {
  const t = typed.trim().replace(/\/+$/, "") || "~";
  if (t === "~") return home;
  if (t.startsWith("~/")) return `${home}/${t.slice(2)}`;
  if (t.startsWith("/")) return t;
  return `${home}/${t}`;
};

/** The folder above `path` (as typed), or null at the top. */
export const parentOf = (path: string): string | null => {
  const t = path.replace(/\/+$/, "");
  if (t === "" || t === "~" || t === "/") return null;
  const at = t.lastIndexOf("/");
  if (at < 0) return "~";
  return at === 0 ? "/" : t.slice(0, at);
};

/** What listing a folder found. */
export type Listed =
  | { kind: "ok"; folders: Folder[]; home: string | null }
  /** There's no such folder there. */
  | { kind: "missing" }
  /** Outside what the machine lists (its home, and where sessions run). */
  | { kind: "outside" }
  /** No answer within `LIST_WITHIN_MS`. */
  | { kind: "slow" }
  | { kind: "failed"; why: string };

/** The folders in `dir` (home when null), saying why when there are none
 *  to show; never waits more than `within`. */
export const listIn = async (t: DeskTransport, dir: string | null, within = LIST_WITHIN_MS): Promise<Listed> => {
  const q = new URLSearchParams();
  if (dir) q.set("path", dir);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = new Promise<Listed>((r) => (timer = setTimeout(() => r({ kind: "slow" }), within)));
  const read = (async (): Promise<Listed> => {
    const res = await t.fetch("GET", `/api/desk/folders${q.size ? `?${q.toString()}` : ""}`);
    if (res.status === 404) {
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
      // The route itself missing (an old hub) isn't the folder missing.
      return typeof body?.error === "string" && /no such folder/i.test(body.error) ? { kind: "missing" } : { kind: "failed", why: "Desk there can’t list folders yet." };
    }
    if (res.status === 403) return { kind: "outside" };
    if (res.status === 400) return { kind: "missing" };
    if (!res.ok) return { kind: "failed", why: `its Desk answered ${res.status}` };
    const body: unknown = await res.json().catch(() => null);
    const { folders, home } = readFolders(body, dir ? null : homeOfListing(body));
    return { kind: "ok", folders: [...folders].sort((a, b) => Number(b.git) - Number(a.git) || a.path.localeCompare(b.path)), home };
  })().catch((e: unknown): Listed => ({ kind: "failed", why: e instanceof Error ? e.message : String(e) }));
  try {
    return await Promise.race([read, slow]);
  } finally {
    clearTimeout(timer);
  }
};

/** How many single-letter edits turn `a` into `b`. */
const edits = (a: string, b: string): number => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
};

/** The folder among `folders` a mistyped `path` most likely meant: one or
 *  two letters off its last part. */
export const meant = (path: string, folders: readonly Folder[]): string | null => {
  const name = path.replace(/\/+$/, "").split("/").pop()?.toLowerCase() ?? "";
  if (!name) return null;
  let best: { path: string; d: number } | null = null;
  for (const f of folders) {
    const d = edits(name, (f.path.split("/").pop() ?? "").toLowerCase());
    if (d > 0 && d <= 2 && (!best || d < best.d)) best = { path: f.path, d };
  }
  return best?.path ?? null;
};

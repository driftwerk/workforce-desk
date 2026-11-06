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

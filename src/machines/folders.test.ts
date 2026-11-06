import { expect, it } from "vitest";
import { homeOfListing, listFolders, readFolders, splitTyped, suggest, tilde } from "./folders";
import { foldersTransport } from "./testing";

it("splits what's typed into the folder to list and what the next part starts with", () => {
  expect(splitTyped("")).toEqual({ dir: null, prefix: "" });
  expect(splitTyped("~/")).toEqual({ dir: null, prefix: "" });
  expect(splitTyped("~/src/wo")).toEqual({ dir: "~/src", prefix: "wo" });
  expect(splitTyped("/srv/")).toEqual({ dir: "/srv", prefix: "" });
  expect(splitTyped("/x")).toEqual({ dir: "/", prefix: "x" });
});

it("reads the hub's folders leniently, under ~ in the home folder", () => {
  expect(tilde("/home/dev/src", "/home/dev")).toBe("~/src");
  expect(tilde("/home/devx", "/home/dev")).toBe("/home/devx");
  expect(
    readFolders({
      home: "/home/dev",
      folders: [{ path: "/home/dev/src/workforce", git: true }, { path: "/srv/data" }, { name: "no path" }, null],
    }),
  ).toEqual({ home: "/home/dev", folders: [{ path: "~/src/workforce", git: true }, { path: "/srv/data", git: false }] });
  expect(readFolders(null).folders).toEqual([]);
  expect(readFolders([{ path: "~/a", repo: true }]).folders).toEqual([{ path: "~/a", git: true }]);
});

it("asks the machine for a folder's folders, git repositories first, and none from a hub without the route", async () => {
  const seen: string[] = [];
  const t = foldersTransport({ home: "/home/dev", folders: [{ path: "/home/dev/src/notes" }, { path: "/home/dev/src/workforce", git: true }] }, seen);
  expect(await listFolders(t, "~/src")).toEqual([
    { path: "~/src/workforce", git: true },
    { path: "~/src/notes", git: false },
  ]);
  expect(seen).toEqual(["/api/desk/folders?path=%7E%2Fsrc"]);
  await listFolders(t, null);
  expect(seen.at(-1)).toBe("/api/desk/folders");
  const old = { ...t, fetch: async () => new Response(null, { status: 404 }) };
  expect(await listFolders(old, null)).toEqual([]);
});

it("suggests what starts as the last part typed", () => {
  const folders = [
    { path: "~/src/workforce", git: true },
    { path: "~/src/workforce-desk", git: true },
    { path: "~/src/notes", git: false },
  ];
  expect(suggest(folders, "~/src/wo").map((f) => f.path)).toEqual(["~/src/workforce", "~/src/workforce-desk"]);
  expect(suggest(folders, "~/src/workforce").map((f) => f.path)).toEqual(["~/src/workforce-desk"]);
  expect(suggest(folders, "~/src/", 2)).toHaveLength(2);
});

// The hub's own answer (crates/desk/src/folders.rs `Listing`): it names the
// folder listed, never `home`. Read for `home`, a machine with no session
// yet had no folder to open a terminal in ("Desk doesn't know a folder on
// this machine…") however often it was asked.
const HUB_LISTING = {
  path: "/home/dev",
  parent: null,
  truncated: false,
  folders: [
    { name: "src", path: "/home/dev/src", git: false, hidden: false },
    { name: "acme-api", path: "/home/dev/acme-api", git: true, hidden: false },
  ],
};

it("takes a listing asked for no folder as the home folder, as the hub answers it", async () => {
  expect(homeOfListing(HUB_LISTING)).toBe("/home/dev");
  expect(homeOfListing({ home: "/root", path: "/root/src" })).toBe("/root");
  expect(homeOfListing({ folders: [] })).toBeNull();
  expect(homeOfListing({ path: "relative" })).toBeNull();
  expect(homeOfListing(null)).toBeNull();
  // Listed from home, its folders read under ~.
  expect(await listFolders(foldersTransport(HUB_LISTING), null)).toEqual([
    { path: "~/acme-api", git: true },
    { path: "~/src", git: false },
  ]);
});

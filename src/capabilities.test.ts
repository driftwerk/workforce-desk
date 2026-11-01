// The windows' capabilities (src-tauri/capabilities/*.json) against what
// their pages use. A grid's window runs `main.tsx` without the shell, so
// what it can reach from there is what it may call; a command it reaches
// that its capability doesn't grant would fail in that window alone.

import { describe, expect, it } from "vitest";
import commandsRs from "../src-tauri/src/commands.rs?raw";
import gridCap from "../src-tauri/capabilities/grid.json";
import mainCap from "../src-tauri/capabilities/main.json";
import tauriConf from "../src-tauri/tauri.conf.json";
import pkg from "../package.json";

/** Every source file the page is built from, as text, by path (`./x.ts`). */
const sources = import.meta.glob(["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}", "!./**/*.d.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const read = (f: string): string => sources[f]!;

/** `spec` imported from `from`, as a key of `sources`. */
const resolve = (from: string, spec: string): string | null => {
  const parts = from.split("/").slice(0, -1);
  for (const p of spec.split("/")) {
    if (p === "..") parts.pop();
    else if (p !== ".") parts.push(p);
  }
  const base = parts.join("/");
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) if (c in sources) return c;
  return null;
};

const IMPORT = /(?:import|export)\s[^;]*?from\s+"(\.[^"]+)"|import\(\s*"(\.[^"]+)"\s*\)|import\s+"(\.[^"]+)"/g;

const importsOf = (f: string): string[] =>
  [...read(f).matchAll(IMPORT)].map((m) => resolve(f, m[1] ?? m[2] ?? m[3]!)).filter((r): r is string => !!r);

/** Every module reachable from `entries` by their imports. */
const reachable = (entries: string[]): Set<string> => {
  const seen = new Set<string>();
  const walk = (f: string) => {
    if (seen.has(f)) return;
    seen.add(f);
    importsOf(f).forEach(walk);
  };
  entries.forEach(walk);
  return seen;
};

/** What a grid's window loads: `main.tsx`'s imports, but not the shell. */
const gridRoots = (): string[] => importsOf("./main.tsx").filter((f) => f !== "./shell/App.tsx");

const INVOKE = /\b(?:tauriInvoke|invoke)(?:<[^>]*>)?\(\s*"([a-z_]+)"/g;
const EXPORT = /export\s+(?:const|async\s+function|function|class)\s+([A-Za-z0-9_]+)/g;

/** The commands `file` invokes, each with the export it is inside (none for
 *  one outside every export, counted as used wherever the file is). */
const invokesIn = (file: string): { cmd: string; within: string | null }[] => {
  const text = read(file);
  const exports = [...text.matchAll(EXPORT)].map((m) => ({ at: m.index, name: m[1]! }));
  return [...text.matchAll(INVOKE)].map((m) => ({
    cmd: m[1]!,
    within: exports.filter((e) => e.at < m.index).at(-1)?.name ?? null,
  }));
};

/** Whether what's inside export `within` of `file` can run in a window
 *  whose page reaches `reach`: it is outside every export, or the export is
 *  used from another module reached. */
const runs = (reach: Set<string>, file: string, within: string | null): boolean => {
  const word = within && new RegExp(`\\b${within}\\b`);
  return !word || [...reach].some((other) => other !== file && word.test(read(other)));
};

/** The commands code reachable in a grid's window can invoke. */
const gridCommands = (): Set<string> => {
  const reach = reachable(gridRoots());
  const used = new Set<string>();
  for (const file of reach) for (const { cmd, within } of invokesIn(file)) if (runs(reach, file, within)) used.add(cmd);
  return used;
};

/** The permission each plugin function the page imports needs. */
const PLUGIN_PERMISSIONS: Record<string, Record<string, string>> = {
  "@tauri-apps/plugin-dialog": { open: "dialog:allow-open", save: "dialog:allow-save" },
  "@tauri-apps/plugin-fs": {
    readTextFile: "fs:allow-read-text-file",
    writeTextFile: "fs:allow-write-text-file",
    writeFile: "fs:allow-write-file",
  },
  "@tauri-apps/plugin-opener": { openUrl: "opener:allow-open-url" },
  "@tauri-apps/plugin-notification": {
    isPermissionGranted: "notification:default",
    requestPermission: "notification:default",
    sendNotification: "notification:default",
  },
  "@tauri-apps/plugin-global-shortcut": { register: "global-shortcut:allow-register", unregister: "global-shortcut:allow-unregister" },
  "@tauri-apps/plugin-process": { relaunch: "process:allow-restart", exit: "process:allow-exit" },
  "@tauri-apps/plugin-updater": { check: "updater:default" },
};

const PLUGIN_IMPORT = /import\s*\{([^}]*)\}\s*from\s*"(@tauri-apps\/plugin-[a-z-]+)"/g;

/** The plugin permissions the code reachable from `reach` can use; an
 *  imported plugin function this test doesn't know fails it. */
const pluginPermissions = (reach: Set<string>): Set<string> => {
  const used = new Set<string>();
  for (const file of reach) {
    const text = read(file);
    const exports = [...text.matchAll(EXPORT)].map((m) => ({ at: m.index, name: m[1]! }));
    for (const m of text.matchAll(PLUGIN_IMPORT)) {
      const plugin = m[2]!;
      for (const item of m[1]!.split(",").map((x) => x.trim()).filter((x) => x && !x.startsWith("type "))) {
        const [name, local = name] = item.split(/\s+as\s+/) as [string, string?];
        const permission = PLUGIN_PERMISSIONS[plugin]?.[name];
        if (!permission) throw new Error(`${file}: which permission does ${plugin}'s ${name} need?`);
        // A call of it, not of a method of the same name (`window.open(`).
        const calls = [...text.matchAll(new RegExp(`(?<![\\w.$])${local}\\(`, "g"))];
        const within = (at: number) => exports.filter((e) => e.at < at).at(-1)?.name ?? null;
        if (calls.some((c) => runs(reach, file, within(c.index)))) used.add(permission);
      }
    }
  }
  return used;
};

const identifiers = (cap: Capability): Set<string> => new Set(cap.permissions.map((p) => (typeof p === "string" ? p : p.identifier)));

type Capability = { windows: string[]; permissions: (string | { identifier: string })[] };
const capability = (name: "main" | "grid"): Capability => (name === "main" ? mainCap : gridCap) as Capability;

const commandsOf = (cap: ReturnType<typeof capability>): Set<string> =>
  new Set(
    cap.permissions
      .map((p) => (typeof p === "string" ? p : p.identifier))
      .filter((p) => p.startsWith("allow-"))
      .map((p) => p.slice("allow-".length).replaceAll("-", "_")),
  );

const declared = (): string[] => [...commandsRs.matchAll(/^ {4}"([a-z_]+)",$/gm)].map((m) => m[1]!);

describe("each window's capabilities", () => {
  it("grant a grid's window every command its panes can reach", () => {
    const granted = commandsOf(capability("grid"));
    const missing = [...gridCommands()].filter((c) => !granted.has(c));
    expect(missing).toEqual([]);
  });

  it("grant each window the plugin permissions its code can use", () => {
    const grid = identifiers(capability("grid"));
    expect([...pluginPermissions(reachable(gridRoots()))].filter((p) => !grid.has(p))).toEqual([]);
    const main = identifiers(capability("main"));
    expect([...pluginPermissions(reachable(["./main.tsx"]))].filter((p) => !main.has(p))).toEqual([]);
  });

  it("keep pairing, setup, removal and reports to the main window", () => {
    const grid = commandsOf(capability("grid"));
    for (const c of ["pair_request", "pair_collect", "hubs_remove", "data_remove", "report_save", "wsl_install", "wsl_setup", "helper_status"])
      expect(grid.has(c), c).toBe(false);
    expect(capability("grid").windows).toEqual(["grid-*"]);
    expect(capability("main").windows).toEqual(["main"]);
  });

  it("grant the main window every command, and name none that isn't one", () => {
    const all = declared();
    expect(all.length).toBeGreaterThan(50);
    expect([...commandsOf(capability("main"))].sort()).toEqual([...all].sort());
    for (const c of commandsOf(capability("grid"))) expect(all).toContain(c);
  });

  it("let no window send requests itself, only through Desk's native side", () => {
    for (const name of ["main", "grid"] as const) {
      const ids = capability(name).permissions.map((p) => (typeof p === "string" ? p : p.identifier));
      expect(ids.filter((p) => p.startsWith("http:"))).toEqual([]);
    }
    expect(Object.keys(pkg.dependencies)).not.toContain("@tauri-apps/plugin-http");
  });

  it("let the page reach no host but its own, in its policy", () => {
    const directives = Object.fromEntries(
      tauriConf.app.security.csp.split(";").map((d) => {
        const [name, ...values] = d.trim().split(/\s+/);
        return [name!, values];
      }),
    );
    for (const d of ["connect-src", "img-src", "media-src", "default-src", "font-src", "script-src"]) {
      const values = directives[d] ?? [];
      expect(values.filter((v) => ["https:", "http:", "wss:", "ws:", "*"].includes(v) || v.includes("*")), d).toEqual([]);
    }
    expect(directives["connect-src"]).toEqual(["'self'", "ipc:", "http://ipc.localhost"]);
  });
});

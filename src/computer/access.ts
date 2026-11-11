import { parse, stringify } from "smol-toml";
import type { ComputerActivityRow, ComputerGrant, DeskHub } from "../hub/client";

/** How far an agent reaches on this computer: its `[computer] access`. An
 *  agent whose file says nothing is at Full access, asking only before
 *  what can't be undone. */
export type Level = "own_folder" | "read_anywhere" | "full";

/** At Full access, what asks first: `[computer] asks`. */
export type Asking = "irreversible" | "never";

export const ASKING: { id: Asking; title: string; line: string }[] = [
  {
    id: "irreversible",
    title: "Ask only before irreversible things",
    line: "Deleting outside its folder, force pushes and hard resets, and sending to people ask you first. Everything else runs.",
  },
  {
    id: "never",
    title: "Do anything",
    line: "Never asks before what it does on this computer, deleting and force pushes included. Sending to people still asks you in your Desk chats.",
  },
];

export const LEVELS: { id: Level; title: string; line: string }[] = [
  { id: "own_folder", title: "Its own folder", line: "Reads and changes only its own folder." },
  { id: "read_anywhere", title: "Read anywhere", line: "Reads any of your files; changes only its own folder." },
  { id: "full", title: "Full access", line: "Reads, changes and runs anything you can. You choose what it asks you about first." },
];

/** As Settings → This computer lists it. */
export const levelLabel = (level: Level, asks: Asking = "irreversible"): string =>
  level === "own_folder"
    ? "Own folder"
    : level === "read_anywhere"
      ? "Read anywhere"
      : asks === "never"
        ? "Full access · does anything"
        : "Full access · asks before irreversible things";

type Doc = Record<string, unknown>;
const table = (v: unknown): Doc => (v && typeof v === "object" && !Array.isArray(v) ? (v as Doc) : {});

/** The agent's level, as its `config.toml` says it. */
export const levelOf = (source: string): Level => {
  try {
    const access = table(table(source.trim() ? parse(source) : {}).computer).access;
    return access === "own_folder" || access === "read_anywhere" ? access : "full";
  } catch {
    return "full";
  }
};

/** At Full access, what the agent's file says it asks first. */
export const askingOf = (source: string): Asking => {
  try {
    return table(table(source.trim() ? parse(source) : {}).computer).asks === "never" ? "never" : "irreversible";
  } catch {
    return "irreversible";
  }
};

/** The config with `level` (and, at Full access, `asks`): everything else
 *  in it kept. A level below Full access can't work on its own, so
 *  `autonomous` goes with it, and `asks` with it too. */
export const withLevel = (source: string, level: Level, asks?: Asking): string => {
  const doc = (source.trim() ? parse(source) : {}) as Doc;
  const computer: Doc = { ...table(doc.computer), access: level };
  if (level !== "full") {
    delete computer.autonomous;
    delete computer.asks;
  } else if (asks) computer.asks = asks;
  doc.computer = computer;
  return stringify(doc).trim() + "\n";
};

/** Writes the agent's level into its config as it is now; answers with the
 *  config as written. */
export async function setLevel(hub: DeskHub, id: string, level: Level, asks?: Asking): Promise<string> {
  const source = await hub.agentConfig(id);
  if (source.trim()) {
    try {
      parse(source);
    } catch {
      throw new Error("Their settings file has a mistake in it, so Desk won’t change it.");
    }
  }
  const toml = withLevel(source, level, asks);
  await hub.saveAgentConfig(id, toml);
  return toml;
}

/** The folders the agent works in beside its own (`[computer] works_in`),
 *  as its `config.toml` says. */
export const worksInOf = (source: string): string[] => {
  try {
    const list = table(table(source.trim() ? parse(source) : {}).computer).works_in;
    return Array.isArray(list) ? list.filter((f): f is string => typeof f === "string") : [];
  } catch {
    return [];
  }
};

/** The config with `folders` as the ones the agent works in (none: the key
 *  goes), everything else in it kept. */
export const withWorksIn = (source: string, folders: string[]): string => {
  const doc = (source.trim() ? parse(source) : {}) as Doc;
  const computer: Doc = { ...table(doc.computer) };
  if (folders.length) computer.works_in = folders;
  else delete computer.works_in;
  if (Object.keys(computer).length) doc.computer = computer;
  else delete doc.computer;
  return stringify(doc).trim() + "\n";
};

/** Writes the folders the agent works in into its config as it is now;
 *  answers with the config as written. The hub refuses a folder no agent may
 *  work in, in words Desk shows as they are. */
export async function setWorksIn(hub: DeskHub, id: string, change: (folders: string[]) => string[]): Promise<string> {
  const source = await hub.agentConfig(id);
  if (source.trim()) {
    try {
      parse(source);
    } catch {
      throw new Error("Their settings file has a mistake in it, so Desk won’t change it.");
    }
  }
  const toml = withWorksIn(source, change(worksInOf(source)));
  await hub.saveAgentConfig(id, toml);
  return toml;
}

/** `folder` added to `folders`, once; and why it can't be, in a line. */
export const addFolder = (folders: string[], folder: string, home: string | null): { folders: string[]; problem: string | null } => {
  const f = folder.replace(/\/+$/, "") || "/";
  if (f === "/" || (home && (f === home || home.startsWith(`${f}/`)))) {
    return { folders, problem: "Choose a folder inside your home, not your home itself or above it." };
  }
  return { folders: folders.includes(f) ? folders : [...folders, f], problem: null };
};

const ABILITY: Record<ComputerGrant["ability"], string> = {
  write: "change files",
  delete: "delete files",
  run: "run commands",
  session: "start sessions",
  connector_write: "write",
};

/** "run commands in ~/dev/acme-web", "write to linear". */
export const grantText = (g: ComputerGrant): string =>
  g.connector ? `write to ${g.connector}` : `${ABILITY[g.ability]}${g.folder ? ` in ${g.folder}` : ""}`;

/** The chip an activity row shows, and how it reads. */
export const outcomeOf = (row: ComputerActivityRow): { text: string; tone: "done" | "blocked" | "" } => {
  switch (row.outcome.outcome) {
    case "ran":
      return row.decided_by === "grant" || row.decided_by === "session"
        ? { text: "Always allowed", tone: "done" }
        : { text: "Ran", tone: "done" };
    case "allowed":
      return { text: "You allowed", tone: "done" };
    case "declined":
      return { text: "Declined", tone: "" };
    case "not_answered":
      return { text: "Not answered", tone: "" };
    case "unattended":
      return { text: "Nobody to ask", tone: "" };
    case "refused":
      return { text: row.reason ? `Refused: ${row.reason}` : "Refused", tone: "blocked" };
  }
};

/** When a row happened, as a list reads it. */
export const whenText = (iso: string, now = Date.now()): string => {
  const t = new Date(iso);
  const sameDay = new Date(now).toDateString() === t.toDateString();
  return sameDay
    ? t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : t.toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

export const KINDS: { id: string; label: string; kinds: string[] }[] = [
  { id: "", label: "Everything", kinds: [] },
  { id: "files", label: "Files", kinds: ["read", "write", "delete"] },
  { id: "commands", label: "Commands", kinds: ["exec", "session"] },
  { id: "connectors", label: "Connectors", kinds: ["connector"] },
  { id: "browser", label: "Browser", kinds: ["browser"] },
];

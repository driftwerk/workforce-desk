import type { Agent, HubAccount } from "../chat/types";
import type { Room } from "../hub/types";
import { resolveMentions } from "./mentions";

// Searching your rooms: what's typed is read into the hub's filters, so
// `from:@allan in:#release has:file is:thread before:2026-10-27` and the
// Filters menu are one state, written back as text by `filtersText`.

export type Has = "file" | "approval";

export interface SearchFilters {
  q: string;
  room?: string;
  /** An author key: `you`, `desk` or `hub/agent`. */
  from?: string;
  has: Has[];
  inThread: boolean;
  /** RFC 3339: on or after. */
  after?: string;
  /** RFC 3339: before. */
  before?: string;
}

export interface Parsed {
  filters: SearchFilters;
  problems: string[];
}

const FILTER = /^(from|in|has|is|before|after|on):(.+)$/i;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The start of local day `ymd` (`YYYY-MM-DD`), `plus` days on, as RFC 3339;
 *  null for a day that isn't one. */
const dayStart = (ymd: string, plus = 0): string | null => {
  const m = DAY.exec(ymd);
  if (!m) return null;
  const [y, mo, day] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const d = new Date(y, mo, day);
  if (d.getFullYear() !== y || d.getMonth() !== mo || d.getDate() !== day) return null;
  d.setDate(d.getDate() + plus);
  return d.toISOString();
};

/** `YYYY-MM-DD` of the local day `iso` starts. */
const ymdOf = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const roomNamed = (name: string, rooms: readonly Room[]): Room | undefined => {
  const n = name.replace(/^#/, "").toLowerCase();
  return rooms.find((r) => r.slug.toLowerCase() === n) ?? rooms.find((r) => r.name.toLowerCase() === n);
};

/** What `text` asks: the words to find, and each filter it names. A filter
 *  that names nothing is said in `problems` and not sent; a word before a
 *  colon Desk doesn't know stays part of the text. */
export const parseSearch = (text: string, rooms: readonly Room[], roster: readonly Agent[], hubs: readonly HubAccount[]): Parsed => {
  const filters: SearchFilters = { q: "", has: [], inThread: false };
  const problems: string[] = [];
  const words: string[] = [];
  for (const token of text.trim().split(/\s+/).filter(Boolean)) {
    const m = FILTER.exec(token);
    if (!m) {
      words.push(token);
      continue;
    }
    const key = m[1]!.toLowerCase();
    const value = m[2]!;
    switch (key) {
      case "from": {
        const who = value.replace(/^@/, "");
        if (who.toLowerCase() === "you") {
          filters.from = "you";
          break;
        }
        const found = resolveMentions(`@${who}`, [], roster, hubs);
        if (found.ambiguous.length) problems.push(`More than one of your crew is called @${who}: add its workspace, as @${who}@workspace`);
        else if (found.outsiders[0]) filters.from = `${found.outsiders[0].hubId}/${found.outsiders[0].id}`;
        else problems.push(`No one in your crew is called @${who}`);
        break;
      }
      case "in": {
        const room = roomNamed(value, rooms);
        if (room) filters.room = room.id;
        else problems.push(`No room is called ${value.startsWith("#") ? value : `#${value}`}`);
        break;
      }
      case "has": {
        const v = value.toLowerCase();
        if ((v === "file" || v === "approval") && !filters.has.includes(v)) filters.has.push(v);
        else if (v !== "file" && v !== "approval") problems.push(`has: takes file or approval`);
        break;
      }
      case "is":
        if (value.toLowerCase() === "thread") filters.inThread = true;
        else words.push(token);
        break;
      default: {
        const from = key === "after" ? dayStart(value, 1) : dayStart(value);
        const to = key === "on" ? dayStart(value, 1) : null;
        if (!from || (key === "on" && !to)) {
          problems.push(`${key}: takes a day, as ${key}:2026-10-27`);
          break;
        }
        if (key === "before") filters.before = from;
        else if (key === "after") filters.after = from;
        else {
          filters.after = from;
          filters.before = to!;
        }
      }
    }
  }
  filters.q = words.join(" ");
  return { filters, problems };
};

/** The filters as text, so the Filters menu and typing stay one state. */
export const filtersText = (f: SearchFilters, rooms: readonly Room[], handleOf: (author: string) => string): string => {
  const parts: string[] = [];
  if (f.from) parts.push(`from:${f.from === "you" ? "you" : `@${handleOf(f.from)}`}`);
  const room = f.room ? rooms.find((r) => r.id === f.room) : undefined;
  if (room) parts.push(`in:#${room.slug}`);
  for (const h of f.has) parts.push(`has:${h}`);
  if (f.inThread) parts.push("is:thread");
  if (f.after && f.before && ymdOf(new Date(Date.parse(f.before) - 1).toISOString()) === ymdOf(f.after)) parts.push(`on:${ymdOf(f.after)}`);
  else {
    if (f.after) parts.push(`after:${ymdOf(new Date(Date.parse(f.after) - 1).toISOString())}`);
    if (f.before) parts.push(`before:${ymdOf(f.before)}`);
  }
  if (f.q) parts.push(f.q);
  return parts.join(" ");
};

/** Whether there's anything to search for. */
export const isEmpty = (f: SearchFilters): boolean => !f.q && !f.room && !f.from && !f.has.length && !f.inThread && !f.after && !f.before;

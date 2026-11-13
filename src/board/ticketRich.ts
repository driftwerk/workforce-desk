// What a ticket's view draws of its issue besides its words, worked out
// apart from drawing it: how wide the view is, its pull requests from both
// sources once each, one timeline of its comments and history, which facts
// it shows where, and how its description folds.

import type { ActivityEvent, DevPr, HistoryEvent, SyncSystem, Ticket, TicketComment, TicketDev, TicketState } from "../hub/types";
import { STATE_TITLE } from "./board";

/** How the view lays itself out by its own width: two columns; one, with
 *  what to do with it in a band under its title; or one, as short as it
 *  goes (a popup over a grid). */
export type Layout = "wide" | "stacked" | "compact";

/** Under this, the view stacks. */
export const STACK_PX = 760;
/** Under this, it is as short as it goes. */
export const COMPACT_PX = 600;

/** The layout for a view `width` wide; unmeasured (0), it is wide. */
export const layoutOf = (width: number): Layout => (width <= 0 || width >= STACK_PX ? "wide" : width >= COMPACT_PX ? "stacked" : "compact");

/** A ticket's development, wherever the hub keeps it. */
export const devOf = (t: Ticket): TicketDev | undefined => t.external?.dev ?? t.external?.details?.dev;

/** An address as compared: no scheme, case or trailing slash. */
const sameUrl = (u: string): string => u.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();

/** One pull request as the view lists it: what its issue says of it, and
 *  whether a Desk session's link is to it too. */
export interface PrRow {
  number?: number;
  url: string;
  title?: string;
  state?: DevPr["state"];
  checks?: DevPr["checks"];
  author?: string;
  /** A Desk session linked it to the ticket. */
  ours: boolean;
}

/** Its issue's pull requests, then those its sessions linked that the
 *  issue doesn't know of: each once, matched by address. */
export const prRows = (t: Pick<Ticket, "links">, dev: TicketDev | undefined): PrRow[] => {
  const own = t.links.flatMap((l) => (l.kind === "pr" ? [l] : []));
  const ours = new Set(own.map((l) => sameUrl(l.url)));
  const theirs = (dev?.prs ?? []).map((p) => ({ ...p, ours: ours.has(sameUrl(p.url)) }));
  const known = new Set(theirs.map((p) => sameUrl(p.url)));
  const left = own.filter((l) => !known.has(sameUrl(l.url))).map((l) => ({ number: l.number, url: l.url, ours: true }));
  // The same PR linked twice by sessions shows once too; one at no https
  // address isn't shown at all.
  const seen = new Set<string>();
  return [...theirs, ...left].filter((p) => /^https:\/\//i.test(p.url) && !seen.has(sameUrl(p.url)) && !!seen.add(sameUrl(p.url)));
};

/** What a PR's checks say in words: "14/14", "2 running", "1 failing". */
export const checksText = (c: NonNullable<DevPr["checks"]>): string =>
  c.state === "pass" ? `${c.passed}/${c.total}` : c.state === "run" ? `${c.total - c.passed} running` : `${c.total - c.passed} failing`;

// ── One timeline: comments, Desk's history and its issue's ──────────────

/** A row of the timeline: a comment with its replies, an event there with
 *  Desk's move that followed it, or Desk's own event with what it changed
 *  there. */
export type TimelineRow =
  | { kind: "comment"; at: string; comment: TicketComment; replies: TicketComment[] }
  | { kind: "remote"; at: string; event: HistoryEvent; desk?: ActivityEvent }
  | { kind: "desk"; at: string; event: ActivityEvent; remote?: HistoryEvent };

export type ActivityFilter = "all" | "comments" | "history" | "desk";

/** How near a Desk move and a change of state there are, to be one row. */
export const JOIN_MS = 10 * 60 * 1000;

const time = (iso: string): number => new Date(iso).getTime();

/** Comments, Desk's own events and its issue's, oldest first, as rows.
 *  Replies (Linear's) sit under their comment, one level deep. A Desk move
 *  and a change of state there within {@link JOIN_MS} are one row: Desk's
 *  leads when it made the change there for the person; the change there
 *  leads when Desk followed it. */
export const timeline = (comments: readonly TicketComment[], desk: readonly ActivityEvent[], remote: readonly HistoryEvent[]): TimelineRow[] => {
  const ids = new Set(comments.map((c) => c.id));
  const top = comments.filter((c) => !c.parent || !ids.has(c.parent));
  const replies = (id: string) => comments.filter((c) => c.parent === id && c.id !== id);
  const rows: TimelineRow[] = top.map((c) => ({ kind: "comment", at: c.at, comment: c, replies: replies(c.id) }));
  const joined = new Set<HistoryEvent>();
  const deskRows: TimelineRow[] = [];
  const followed = new Map<HistoryEvent, ActivityEvent>();
  for (const e of [...desk].sort((a, b) => time(a.at) - time(b.at))) {
    const near = e.kind === "ticket_moved" ? nearest(e.at, remote.filter((r) => r.kind === "state" && !joined.has(r))) : undefined;
    if (near) joined.add(near);
    if (near && near.by !== "desk") followed.set(near, e);
    else deskRows.push({ kind: "desk", at: e.at, event: e, remote: near });
  }
  for (const r of remote) {
    if (joined.has(r) && !followed.has(r)) continue;
    rows.push({ kind: "remote", at: r.at, event: r, desk: followed.get(r) });
  }
  rows.push(...deskRows);
  return rows.map((r, i) => [r, i] as const).sort(([a, i], [b, j]) => time(a.at) - time(b.at) || i - j).map(([r]) => r);
};

const nearest = (at: string, among: readonly HistoryEvent[]): HistoryEvent | undefined => {
  let best: HistoryEvent | undefined;
  for (const r of among) {
    const d = Math.abs(time(r.at) - time(at));
    if (d <= JOIN_MS && (!best || d < Math.abs(time(best.at) - time(at)))) best = r;
  }
  return best;
};

const onlyHere = (r: TimelineRow): boolean => r.kind === "comment" && (r.comment.onlyHere || r.replies.some((c) => c.onlyHere));

/** The rows a filter shows. */
export const filtered = (rows: readonly TimelineRow[], f: ActivityFilter): TimelineRow[] =>
  f === "all" ? [...rows] : rows.filter((r) => (f === "comments" ? r.kind === "comment" : f === "history" ? r.kind !== "comment" : onlyHere(r)));

/** What each filter's chip counts: comments with their replies, history
 *  rows, and comments that stayed in Desk. */
export const counts = (rows: readonly TimelineRow[]): Record<Exclude<ActivityFilter, "all">, number> => {
  const said = rows.flatMap((r) => (r.kind === "comment" ? [r.comment, ...r.replies] : []));
  return { comments: said.length, history: rows.filter((r) => r.kind !== "comment").length, desk: said.filter((c) => c.onlyHere).length };
};

/** A piece of an event's line: words, bold, mono, faint, a glyph, or where
 *  it happened (" on Jira"), said only where there's room. */
export type Part =
  | { text: string; look?: "b" | "mono" | "faint" | "on" }
  | { icon: "pr" | "merge" | "branch" };

export interface EventWords {
  system: SyncSystem | null;
  /** The person's name there: an event by them says "You". */
  me?: string | null;
  /** Ticket key, said "it" in Desk's own lines. */
  ticketKey: string | null;
  /** A Desk event's actor by its name here. */
  actorName: (e: ActivityEvent) => string;
  /** Desk's own line for its event, its key said "it". */
  deskLine: (e: ActivityEvent) => string;
}

const SYSTEM: Record<SyncSystem, string> = { jira: "Jira", linear: "Linear" };

const who = (name: string | undefined, w: EventWords): string =>
  name && w.me && name === w.me ? "You" : (name ?? (w.system ? SYSTEM[w.system] : "Someone"));

const on = (w: EventWords): Part[] => (w.system ? [{ text: ` on ${SYSTEM[w.system]}`, look: "on" }] : []);

/** A change there, in words. */
export const remoteParts = (e: HistoryEvent, w: EventWords): Part[] => {
  const actor = e.by === "desk" ? "Desk" : e.by === "github" ? (e.actor ?? "GitHub") : who(e.actor, w);
  switch (e.kind) {
    case "created":
      return [{ text: actor, look: "b" }, { text: " created it" }, ...on(w)];
    case "state":
      return [{ text: actor, look: "b" }, { text: e.from ? ` moved it from ${e.from} to ` : " moved it to " }, { text: e.to ?? "", look: "b" }];
    case "assignee":
      if (e.by === "desk" && e.to && w.me && e.to === w.me) return [{ text: "You", look: "b" }, { text: " took it" }, ...on(w), { text: " · " }, { text: "Desk, on my behalf", look: "faint" }];
      return e.to
        ? [{ text: actor, look: "b" }, { text: " gave it to " }, { text: who(e.to, w), look: "b" }]
        : [{ text: actor, look: "b" }, { text: " unassigned it" }];
    case "link":
      return [{ text: actor, look: "b" }, { text: " linked " }, ...(e.to?.startsWith("#") ? [{ icon: "pr" as const }] : []), { text: e.to ?? "", look: "b" }];
    default: {
      if (e.kind === "field" && e.by === "github" && e.field) {
        const pr = e.field.startsWith("#");
        return [
          { text: `${actor} · ` },
          { icon: pr ? (e.to === "merged" ? "merge" : "pr") : "branch" },
          { text: e.field, look: pr ? "b" : "mono" },
          { text: ` ${e.to ?? ""}` },
        ];
      }
      // A field changed there: what it is, and what it became.
      return [
        { text: actor, look: "b" },
        { text: ` changed ${e.field ?? e.kind}${e.from ? ` from ${e.from}` : ""} to ` },
        { text: e.to ?? "nothing", look: "b" },
      ];
    }
  }
};

/** A row of history in words: Desk's own event, or one there, with what
 *  joined it. */
export const eventParts = (r: Exclude<TimelineRow, { kind: "comment" }>, w: EventWords): Part[] => {
  if (r.kind === "remote") {
    const parts = remoteParts(r.event, w);
    return r.desk ? [...parts, { text: ` · Desk ${followLine(w.deskLine(r.desk))}` }] : parts;
  }
  const session = r.event.subject?.kind === "session" ? r.event.subject.name : null;
  const line = w.deskLine(r.event);
  const parts: Part[] = [{ text: w.actorName(r.event) }, { text: " " }, ...monoName(line, session)];
  return r.remote ? [...parts, { text: ", " }, { text: r.remote.to ?? "", look: "b" }, ...on(w)] : parts;
};

/** Desk's line for a move it made following the issue: "moved it to
 *  Doing", without the "on <key>" its record says. */
const followLine = (line: string): string => line.replace(/ on it$/, "");

/** `line` with a session's name in it set in mono. */
const monoName = (line: string, name: string | null): Part[] => {
  const at = name ? line.indexOf(name) : -1;
  if (!name || at < 0) return [{ text: line }];
  return [{ text: line.slice(0, at) }, { text: name, look: "mono" }, { text: line.slice(at + name.length) }];
};

// ── The facts ─────────────────────────────────────────────────────────────

export type FactId =
  | "type"
  | "state"
  | "working"
  | "spent"
  | "assignee"
  | "reporter"
  | "priority"
  | "points"
  | "sprint"
  | "labels"
  | "project"
  | "components"
  | "fixVersion"
  | "start"
  | "due"
  | "created";

/** The facts in the order the details column says them, by system; a
 *  ticket of your own has no system. */
const ORDER: Record<SyncSystem | "local", FactId[]> = {
  jira: ["type", "state", "working", "spent", "assignee", "reporter", "priority", "points", "sprint", "labels", "components", "fixVersion", "start", "due"],
  linear: ["state", "working", "spent", "assignee", "priority", "points", "labels", "project", "sprint", "created", "start", "due"],
  local: ["state", "assignee", "spent", "priority", "labels", "project", "due"],
};

/** The facts the stacked view's band shows first, two columns of four;
 *  the rest are a click away. */
const BAND: Record<SyncSystem | "local", FactId[]> = {
  jira: ["state", "working", "assignee", "priority", "type", "points", "sprint", "due"],
  linear: ["state", "working", "assignee", "priority", "points", "labels", "project", "sprint", "created", "due"],
  local: ["state", "assignee", "spent", "priority", "labels", "project", "due"],
};

/** How many facts the band shows before "All n details". */
export const BAND_MAX = 8;

/** The facts a ticket has, in order: all of them, or the band's. */
export const factOrder = (system: SyncSystem | null, has: (f: FactId) => boolean, band = false): FactId[] => {
  const all = ORDER[system ?? "local"].filter(has);
  if (!band) return all;
  const first = BAND[system ?? "local"].filter(has).slice(0, BAND_MAX);
  return first;
};

/** What its issue calls its state, where Desk's column says otherwise:
 *  "In Progress" beside Doing; none when they agree. */
export const remoteStateWord = (state: TicketState, remote: string | undefined): string | null =>
  remote && remote.trim().toLowerCase() !== STATE_TITLE[state].toLowerCase() ? remote : null;

// ── The words ───────────────────────────────────────────────────────────

/** A short date: `Aug 24`. */
export const dayText = (iso: string): string => {
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
};

/** How long ago, in words: "2 hours ago", "3 days ago", "just now". */
export const agoText = (iso: string, now = Date.now()): string => {
  const m = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (Number.isNaN(m)) return "";
  if (m < 1) return "just now";
  const say = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  if (m < 60) return say(m, "minute");
  if (m < 48 * 60) return say(Math.floor(m / 60), "hour");
  return say(Math.floor(m / (24 * 60)), "day");
};

/** A cycle's days: `Nov 9–22`, or `Oct 27–Nov 9`. */
export const spanText = (starts: string, ends: string): string => {
  const a = dayText(starts);
  const b = dayText(ends);
  return a.split(" ")[0] === b.split(" ")[0] ? `${a}–${b.split(" ")[1]}` : `${a}–${b}`;
};

/** The line under the title: what it is, who wrote it there and when, and
 *  (where there's room) when it last changed. */
export const bylineText = (t: Ticket, layout: Layout): string | null => {
  const e = t.external;
  const d = e?.details;
  if (!e || !d?.reporter) return null;
  const where = `${d.reporter} on ${SYSTEM[e.system]}${d.created ? `, ${dayText(d.created)}` : ""}`;
  const parts = [d.kind, layout === "compact" ? where : `written by ${where}`];
  if (layout === "wide" && e.remoteUpdatedAt && (!d.created || dayText(d.created) !== dayText(e.remoteUpdatedAt))) parts.push(`updated ${dayText(e.remoteUpdatedAt)}`);
  return parts.filter(Boolean).join(" · ");
};

/** A comment's mark: a person's initials, a session's word starts in
 *  small letters (`bo` for brisk-otter). */
export const markText = (name: string, agent: boolean): string => {
  const words = name.trim().split(agent ? /[\s\-_]+/ : /\s+/).filter(Boolean);
  const two = words.length > 1 ? words[0]![0]! + words.at(-1)![0]! : (words[0]?.[0] ?? "?");
  return agent ? two.toLowerCase() : two.toUpperCase();
};

// ── The description ────────────────────────────────────────────────────

/** A description cut to its first `keep` sections (a heading and what's
 *  under it), and how many more it has. Fenced code is never cut into. */
export const foldSections = (body: string, keep = 2): { shown: string; more: number } => {
  const lines = body.split("\n");
  const starts: number[] = [];
  let fenced = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fenced = !fenced;
    else if (!fenced && /^#{1,6}\s/.test(l)) starts.push(i);
  });
  // Words before the first heading are a section of their own.
  if (starts[0] !== 0) starts.unshift(0);
  if (starts.length <= keep + 1) return { shown: body, more: 0 };
  return { shown: lines.slice(0, starts[keep]).join("\n").trimEnd(), more: starts.length - keep };
};

/** A description's first paragraph, for the shortest view: no heading. */
export const firstParagraph = (body: string): string =>
  body
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .find((b) => b && !/^#{1,6}\s/.test(b) && !/^(```|~~~)/.test(b)) ?? "";

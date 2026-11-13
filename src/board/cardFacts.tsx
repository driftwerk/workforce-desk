import type { ReactNode } from "react";
import type { PrSummary, Ticket, TicketDetails } from "../hub/types";

/** What a synced card and its ticket's view draw of what its issue says of
 *  itself: its type or state, its priority as bars, the epic or project
 *  it belongs to, its labels, sub-items and pull requests. Every colour is
 *  one of Desk's tokens: an epic, a project or a label takes a chart
 *  series by its name, so a theme stays in charge of them. */

const Svg = ({ children, size = 14, color = "currentColor", label }: { children: ReactNode; size?: number; color?: string; label?: string }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke={color}
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    className="board-glyph"
    {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
  >
    {label && <title>{label}</title>}
    {children}
  </svg>
);

/** The type glyphs Desk draws, by what a Jira issue type is. */
export type TypeShape = "epic" | "story" | "bug" | "task" | "sub";

/** The glyph an issue's type takes: by its level (an epic, a sub-task),
 *  else by its name; a type Desk doesn't know reads as a task. */
export const typeShape = (kind: string | undefined, level?: number): TypeShape | null => {
  if (!kind) return null;
  const k = kind.toLowerCase();
  if (level === 1 || k === "epic") return "epic";
  if (level === -1 || k.includes("sub")) return "sub";
  if (k.includes("bug") || k.includes("defect") || k.includes("incident")) return "bug";
  if (k.includes("story")) return "story";
  return "task";
};

/** An issue type's glyph, titled with its name there. */
export function TypeGlyph({ kind, level, size = 14 }: { kind?: string; level?: number; size?: number }) {
  const shape = typeShape(kind, level);
  if (!shape) return null;
  switch (shape) {
    case "epic":
      return (
        <Svg size={size} color="var(--ansi-magenta)" label={kind}>
          <path d="M9.2 1.8 3.6 9h4l-1 5.2L12.4 7h-4z" fill="var(--ansi-magenta)" fillOpacity={0.18} />
        </Svg>
      );
    case "story":
      return (
        <Svg size={size} color="var(--done)" label={kind}>
          <path d="M4.2 2.2h7.6v11.6L8 11l-3.8 2.8z" fill="var(--done)" fillOpacity={0.16} />
        </Svg>
      );
    case "bug":
      return (
        <Svg size={size} color="var(--ansi-red)" label={kind}>
          <ellipse cx="8" cy="9.2" rx="3.6" ry="4.2" fill="var(--ansi-red)" fillOpacity={0.16} />
          <path d="M8 5v8.4M4.4 9.2H2.2M13.8 9.2h-2.2M5.2 5.4 3.6 3.8M10.8 5.4l1.6-1.6M6.2 3.6h3.6" />
        </Svg>
      );
    case "task":
      return (
        <Svg size={size} color="var(--working)" label={kind}>
          <rect x="2.4" y="2.4" width="11.2" height="11.2" rx="3" fill="var(--working)" fillOpacity={0.14} />
          <path d="M5.4 8.2l1.8 1.8 3.4-4" />
        </Svg>
      );
    case "sub":
      return (
        <Svg size={size} color="var(--muted)" label={kind}>
          <rect x="2.4" y="2.4" width="6.6" height="6.6" rx="2" />
          <rect x="7" y="7" width="6.6" height="6.6" rx="2" fill="var(--muted)" fillOpacity={0.14} />
        </Svg>
      );
  }
}

/** The state icons Linear's state types take. */
export type StateShape = "backlog" | "todo" | "progress" | "review" | "done" | "canceled";

/** A Linear state's icon: by its type, and "In Review" (a started state)
 *  by its name. */
export const stateShape = (kind: string | undefined, name?: string): StateShape | null => {
  switch (kind) {
    case "backlog":
    case "triage":
      return "backlog";
    case "unstarted":
      return "todo";
    case "started":
      return /review/i.test(name ?? "") ? "review" : "progress";
    case "completed":
      return "done";
    case "canceled":
    case "cancelled":
      return "canceled";
    default:
      return null;
  }
};

/** A Linear issue's state icon, titled with the state's name there. */
export function StateGlyph({ kind, name, size = 14 }: { kind?: string; name?: string; size?: number }) {
  const shape = stateShape(kind, name);
  switch (shape) {
    case "backlog":
      return (
        <Svg size={size} color="var(--faint)" label={name}>
          <circle cx="8" cy="8" r="5.6" strokeDasharray="2 2.2" />
        </Svg>
      );
    case "todo":
      return (
        <Svg size={size} color="var(--muted)" label={name}>
          <circle cx="8" cy="8" r="5.6" />
        </Svg>
      );
    case "progress":
      return (
        <Svg size={size} color="var(--blocked)" label={name}>
          <circle cx="8" cy="8" r="5.6" />
          <path d="M8 4.4a3.6 3.6 0 0 1 0 7.2z" fill="var(--blocked)" stroke="none" />
        </Svg>
      );
    case "review":
      return (
        <Svg size={size} color="var(--working)" label={name}>
          <circle cx="8" cy="8" r="5.6" />
          <path d="M8 4.4a3.6 3.6 0 1 1-3.6 3.6H8z" fill="var(--working)" stroke="none" />
        </Svg>
      );
    case "done":
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" className="board-glyph" role="img" aria-label={name}>
          {name && <title>{name}</title>}
          <circle cx="8" cy="8" r="6.4" fill="var(--done)" />
          <path d="M5.2 8.2l2 2 3.6-4" fill="none" stroke="var(--bg)" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "canceled":
      return (
        <Svg size={size} color="var(--faint)" label={name}>
          <circle cx="8" cy="8" r="5.6" />
          <path d="M6 6l4 4M10 6l-4 4" />
        </Svg>
      );
    default:
      return null;
  }
}

/** The head glyph a synced card shows: a Jira issue's type, a Linear
 *  issue's state. */
export function IssueGlyph({ details, size }: { details: TicketDetails | undefined; size?: number }) {
  if (!details) return null;
  if (details.kind) return <TypeGlyph kind={details.kind} level={details.kindLevel} size={size} />;
  if (details.stateKind) return <StateGlyph kind={details.stateKind} name={details.remoteState} size={size} />;
  return null;
}

/** A priority as bars (rank 1, the most urgent, an amber "!"), titled with
 *  its name there. */
export function PriorityBars({ rank, name }: { rank: number; name?: string }) {
  const title = name ?? ["Urgent", "High", "Medium", "Low"][rank - 1] ?? "";
  if (rank <= 1)
    return (
      <span className="board-prio-urgent" title={title} role="img" aria-label={`Priority ${title}`}>
        !
      </span>
    );
  const level = 5 - rank;
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" className="board-glyph" role="img" aria-label={`Priority ${title}`}>
      <title>{title}</title>
      {[4, 7, 10].map((h, i) => {
        const on = i < level;
        return <rect key={h} x={2 + i * 4.4} y={13 - h} width={2.8} height={h} rx={1} fill={on ? "var(--muted)" : "var(--faint)"} fillOpacity={on ? 1 : 0.35} />;
      })}
    </svg>
  );
}

/** The chart series a name takes, 1 to 8, the same every time. */
export const seriesOf = (name: string): number => {
  let h = 2166136261;
  for (const c of name.toLowerCase()) {
    h ^= c.codePointAt(0)!;
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 8) + 1;
};

/** The epic (Jira) or project (Linear) chip in a card's head: a dot in its
 *  series colour and its name, cut to fit. */
export function GroupChip({ name, title }: { name: string; title: string }) {
  return (
    <span className="board-group" title={title}>
      <i className="board-group-dot" style={{ background: `var(--series${seriesOf(name)})` }} aria-hidden="true" />
      <span>{name}</span>
    </span>
  );
}

/** A label: a dot in its series colour and its name. */
export function LabelChip({ name }: { name: string }) {
  return (
    <span className="board-label">
      <i style={{ background: `var(--series${seriesOf(name)})` }} aria-hidden="true" />
      {name}
    </span>
  );
}

/** How many of something are done, as a ring. */
export function Ring({ done, total, size = 12 }: { done: number; total: number; size?: number }) {
  const r = 5.2;
  const c = 2 * Math.PI * r;
  const frac = total ? done / total : 0;
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true" className="board-glyph">
      <circle cx="7" cy="7" r={r} fill="none" stroke="var(--border)" strokeWidth={2.2} />
      <circle
        cx="7"
        cy="7"
        r={r}
        fill="none"
        stroke="var(--done)"
        strokeWidth={2.2}
        strokeDasharray={`${(c * frac).toFixed(2)} ${c.toFixed(2)}`}
        transform="rotate(-90 7 7)"
        strokeLinecap="round"
      />
    </svg>
  );
}

export const PrIcon = ({ size = 11 }: { size?: number }) => (
  <Svg size={size}>
    <circle cx="4.5" cy="3.8" r="1.7" />
    <circle cx="4.5" cy="12.2" r="1.7" />
    <circle cx="11.5" cy="12.2" r="1.7" />
    <path d="M4.5 5.5v5M11.5 10.5V6.4a2 2 0 0 0-2-2H7.6M9 2.8 7.4 4.4 9 6" />
  </Svg>
);

export const MergeIcon = ({ size = 11 }: { size?: number }) => (
  <Svg size={size}>
    <circle cx="4.5" cy="3.8" r="1.7" />
    <circle cx="4.5" cy="12.2" r="1.7" />
    <circle cx="11.5" cy="8" r="1.7" />
    <path d="M4.5 5.5v5M4.5 5.5c0 2.2 2 2.5 5.3 2.5" />
  </Svg>
);

export const CommentIcon = ({ size = 11 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M2.5 3.5h11v7.2H7.2L4.4 13v-2.3H2.5z" />
  </Svg>
);

export const ClipIcon = ({ size = 11 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M10.8 6.2 6.4 10.6a1.6 1.6 0 0 1-2.3-2.3l5-5a2.8 2.8 0 0 1 4 4l-5.2 5.2a4 4 0 0 1-5.6-5.6l4.3-4.3" />
  </Svg>
);

export const LinkIcon = ({ size = 11 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M6.6 9.4 9.4 6.6M7.4 4.6l1-1a2.8 2.8 0 0 1 4 4l-1 1M8.6 11.4l-1 1a2.8 2.8 0 0 1-4-4l1-1" />
  </Svg>
);

export const CycleIcon = ({ size = 11 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.6v2.6h-2.6" />
  </Svg>
);

/** A PR chip's state: Desk's chip-live, by where the PR stands. */
export type PrLook = "open" | "review" | "changes" | "merged" | "draft";

/** What a PR's checks say, when anyone has said. */
export type Checks = "pass" | "run" | "fail";

const CHECK_TOKEN: Record<Checks, string> = { pass: "done", run: "blocked", fail: "red" };
const CHECK_WORDS: Record<Checks, string> = { pass: "Checks pass", run: "Checks running", fail: "Checks failing" };

/** A PR chip: its icon, what it says (`#5897`, `2 PRs`), and its checks'
 *  dot when they are known. */
export function PrChip({ look, text, checks, title }: { look: PrLook; text: string; checks?: Checks; title?: string }) {
  return (
    <span className={`board-pr board-pr-${look}`} title={title}>
      {look === "merged" ? <MergeIcon /> : <PrIcon />}
      {text}
      {checks && <i className="board-pr-checks" style={{ background: `var(--${CHECK_TOKEN[checks]})` }} title={CHECK_WORDS[checks]} />}
    </span>
  );
}

const LOOK_WORDS: Record<PrLook, string> = { open: "open", review: "in review", changes: "changes asked", merged: "merged", draft: "a draft" };

/** The one PR chip a card shows for its issue's pull requests (from Jira's
 *  Development field or Linear's attachments) and the PRs its sessions
 *  opened, each once: `#n` when there is one whose number is known, else
 *  how many. Null when it has none. */
export const prChip = (t: Pick<Ticket, "links">, prs: PrSummary | undefined): { look: PrLook; text: string; title: string } | null => {
  const own = t.links.flatMap((l) => (l.kind === "pr" ? [l] : []));
  const look: PrLook = prs ? (prs.state === "declined" ? "draft" : prs.state) : "open";
  const count = Math.max(prs?.count ?? 0, own.length);
  if (count === 0) return null;
  const number = prs?.number ?? (count === 1 ? own[0]?.number : undefined);
  const text = number !== undefined ? `#${number}` : look === "merged" ? `${count} merged` : `${count} PRs`;
  const title = count === 1 ? `Pull request ${number !== undefined ? `#${number} ` : ""}${LOOK_WORDS[look]}` : `${count} pull requests, ${LOOK_WORDS[look]}`;
  return { look, text, title };
};

/** A short date the way a card's foot says it: `Sep 27`. */
export const shortDate = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
};

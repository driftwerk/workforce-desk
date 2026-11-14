import type { Directive } from "@workforce/rich";
import type { ReactNode } from "react";
import { openLink } from "../shell/links";

// What a synced ticket's description says that plain markdown can't, drawn
// as the Description mockup draws it. The hub writes it as directives (see
// the hub's crates/desk/src/ticket_markdown.rs): a mention, a status, a
// date, a panel, a collapsible (a file of the ticket's, `desk-file:<id>`, is
// ticketFileImage's).

/** The tones the hub says a status or a panel in. Anything else is said
 *  as neutral: an attribute is the author's words. */
export const TONES = ["info", "success", "warning", "danger", "purple", "neutral"] as const;
export type Tone = (typeof TONES)[number];

export const toneOf = (value: string | undefined): Tone => (TONES as readonly string[]).includes(value ?? "") ? (value as Tone) : "neutral";

/** A `:date[2026-11-30]` in words: `Nov 30, 2026`. A day, so in UTC; one
 *  that isn't a date stays as written. */
export const dateWords = (iso: string): string => {
  const day = iso.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  const d = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};

export const Svg = ({ size, children, className }: { size: number; children: ReactNode; className?: string }) => (
  <svg className={className} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {children}
  </svg>
);

export const CalendarIcon = ({ size = 11 }: { size?: number }) => (
  <Svg size={size}>
    <rect x="2.5" y="3.2" width="11" height="10.3" rx="2" />
    <path d="M2.5 6.6h11M5.6 1.8v2.6M10.4 1.8v2.6" />
  </Svg>
);

export const LinkIcon = ({ size = 11 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M6.6 9.4 9.4 6.6M7.4 4.6l1-1a2.8 2.8 0 0 1 4 4l-1 1M8.6 11.4l-1 1a2.8 2.8 0 0 1-4-4l1-1" />
  </Svg>
);

export const ExternalIcon = ({ size = 10 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M6 3H3v10h10v-3M9 2.5h4.5V7M13.5 2.5 7.5 8.5" />
  </Svg>
);

export const FileIcon = ({ size = 12 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M4 1.8h5.2L12 4.6v9.6H4z" />
    <path d="M9 1.8v3h3" />
  </Svg>
);

/** A panel's icon, by its tone. */
const PANEL_ICON: Record<Tone, ReactNode> = {
  info: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.2v3.6M8 5h.01" />
    </>
  ),
  neutral: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.2v3.6M8 5h.01" />
    </>
  ),
  warning: (
    <>
      <path d="M8 2.2 14 13H2z" />
      <path d="M8 6.6v3M8 11.4h.01" />
    </>
  ),
  purple: (
    <>
      <path d="M3 2.5h7.5L13 5v8.5H3z" />
      <path d="M5.5 7h5M5.5 9.6h3.5" />
    </>
  ),
  success: <path d="M3.5 8.4l2.8 2.8L12.6 5" />,
  danger: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2" />
    </>
  ),
};

/** What a panel's tone is called, for a reader that hears it. */
const PANEL_NAME: Record<Tone, string> = {
  info: "Info",
  neutral: "Panel",
  warning: "Warning",
  purple: "Note",
  success: "Success",
  danger: "Error",
};

/** A collapsible: closed until clicked. */
function Expand({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <details className="ticket-expand">
      <summary>
        <span className="ticket-expand-mark" aria-hidden="true">
          ▸
        </span>{" "}
        <b>{label ?? "Details"}</b>
      </summary>
      <div className="ticket-expand-body">{children}</div>
    </details>
  );
}

/** The directives the hub writes, which Desk draws. */
export const TICKET_DIRECTIVES = ["mention", "status", "date", "panel", "details"] as const;

/** `inline` where the directive stands: in a paragraph as it is; a leaf
 *  directive's line a paragraph of it; a container's that line over its
 *  content. */
const standing = (d: Directive, inline: ReactNode): ReactNode =>
  d.kind === "text" ? (
    inline
  ) : d.kind === "leaf" ? (
    <p>{inline}</p>
  ) : (
    <>
      <p>{inline}</p>
      {d.children}
    </>
  );

/** A directive in a ticket's text, drawn: every name the hub writes, in
 *  every form, whatever its label; one it isn't is never asked for. */
export const ticketDirective = (d: Directive): ReactNode => {
  const said = d.labelText.trim();
  switch (d.name) {
    case "mention":
      return standing(d, <span className="ticket-mention">@{said.replace(/^@/, "") || "someone"}</span>);
    case "status":
      return standing(d, said ? <span className={`ticket-lozenge tone-${toneOf(d.attributes.tone)}`}>{said}</span> : <></>);
    case "date":
      return standing(
        d,
        said ? (
          <span className="ticket-inline-chip ticket-date">
            <CalendarIcon />
            {dateWords(said)}
          </span>
        ) : (
          <></>
        ),
      );
    case "panel": {
      if (d.kind !== "container") return standing(d, d.label);
      const tone = toneOf(d.attributes.tone);
      return (
        <div className={`ticket-panel-note tone-${tone}`} role="note" aria-label={PANEL_NAME[tone]}>
          <Svg size={14} className="ticket-panel-icon">
            {PANEL_ICON[tone]}
          </Svg>
          <div className="ticket-panel-body">{d.children}</div>
        </div>
      );
    }
    case "details":
      return d.kind === "container" ? <Expand label={d.label}>{d.children}</Expand> : standing(d, d.label);
    default:
      return d.kind === "text" ? d.label : standing(d, d.label);
  }
};

/** An autolink's address as its chip says it: no scheme, no trailing slash. */
export const linkWords = (href: string): string => href.replace(/^https?:\/\//i, "").replace(/\/$/, "");

/** A bare web address in a ticket's text (a Jira smart link to a page that
 *  isn't an issue): a chip with its address, opened where links open. */
export function SmartLink({ href }: { href: string }) {
  return (
    <a
      className="ticket-inline-chip ticket-smart-link"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={href}
      onClick={(e) => {
        e.preventDefault();
        openLink(href);
      }}
    >
      <LinkIcon />
      <span className="ticket-smart-link-text">{linkWords(href)}</span>
      <ExternalIcon />
    </a>
  );
}

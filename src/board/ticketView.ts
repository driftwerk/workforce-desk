// What a ticket's view reads and writes on this computer's hub, as the
// person: its files' bytes, the files dropped on a ticket of your own, its
// issue read whole, and its comments. These routes are the person's alone
// (a synced ticket's go through the route its board syncs by, as them), so
// they go over the paired path, as Take it does, never through the broker.

import { deskCall, HubError, refusal } from "../hub/client";
import { pairedHub, type HubRef } from "../hub/net";
import type { Ticket, TicketComment, TicketFile } from "../hub/types";
import { localHubRef } from "./syncStore";

/** The largest file Desk drops on a ticket: what one request to a hub may
 *  carry. */
export const UPLOAD_MAX = 16 * 1024 * 1024;

/** The pictures Desk draws in place: never SVG. */
export const RASTER = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

/** What a file is, as the view draws it. */
export type FileKind = "image" | "pdf" | "link" | "file";

export const fileKind = (f: Pick<TicketFile, "source" | "mediaType">): FileKind =>
  f.source === "linear_link" ? "link" : RASTER.has(f.mediaType) ? "image" : f.mediaType === "application/pdf" ? "pdf" : "file";

/** A file's size in words: "240 KB". */
export const sizeText = (n: number | null | undefined): string | null => {
  if (n == null) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
};

/** What a file's card says under its name. */
export const fileLine = (f: TicketFile): string => {
  if (f.source === "linear_link") {
    try {
      return new URL(f.url ?? "").host.replace(/^www\./, "");
    } catch {
      return "Link";
    }
  }
  const kind = fileKind(f);
  const what = kind === "image" ? "Picture" : kind === "pdf" ? "PDF" : "File";
  const size = sizeText(f.size);
  return size ? `${what} · ${size}` : what;
};

/** What posting a comment did: posted, or held on the hub for your approval. */
export type Posted = { kind: "posted"; comment: TicketComment } | { kind: "pending"; message: string };

const path = (ticket: string) => `/api/desk/tickets/${encodeURIComponent(ticket)}`;

/** The ticket view on hub `hub` (this computer's), as the person. */
export const ticketViewOf = (hub: HubRef) => ({
  /** A file's bytes (Jira's small picture of it, with `thumb`): what they
   *  are by their first bytes, as the hub serves them. */
  fileBlob: async (ticket: string, file: string, thumb = false): Promise<Blob> => {
    const res = await pairedHub(hub).fetch("GET", `${path(ticket)}/files/${encodeURIComponent(file)}${thumb ? "?thumb=1" : ""}`);
    if (!res.ok) throw await refusal(res);
    return res.blob();
  },
  /** Drops `file` on a ticket of your own. */
  upload: async (ticket: string, file: File): Promise<TicketFile> => {
    if (file.size > UPLOAD_MAX) throw new HubError(413, `${file.name} is over ${UPLOAD_MAX / (1024 * 1024)} MB.`);
    const res = await pairedHub(hub).fetch("POST", `${path(ticket)}/files?name=${encodeURIComponent(file.name)}`, {
      // The hub sees what it is by its bytes; it is sent as bytes.
      type: "application/octet-stream",
      data: file,
    });
    if (!res.ok) throw await refusal(res);
    return (await res.json()) as TicketFile;
  },
  removeFile: (ticket: string, file: string): Promise<void> => deskCall(hub, "DELETE", `${path(ticket)}/files/${encodeURIComponent(file)}`),
  /** Reads a synced ticket's issue whole for its files, unless it was read
   *  in the last few minutes (or `force`): the ticket as it now is. */
  readIssue: (ticket: string, force = false): Promise<Ticket> => deskCall(hub, "POST", `${path(ticket)}/read${force ? "?force=1" : ""}`),
  /** Its comments, oldest first, read from its issue first when stale; a
   *  read that failed says why in `problem`. */
  comments: (ticket: string): Promise<{ comments: TicketComment[]; problem: string | null }> => deskCall(hub, "GET", `${path(ticket)}/comments`),
  /** Your comment: to its issue as you, or kept here on a ticket of your own. */
  comment: async (ticket: string, body: string): Promise<Posted> => {
    const res = await pairedHub(hub).fetch("POST", `${path(ticket)}/comments`, { type: "application/json", data: JSON.stringify({ body }) });
    if (!res.ok) throw await refusal(res);
    const got = (await res.json()) as TicketComment & { pending?: boolean; kept?: boolean; message?: string };
    if (res.status === 202 || got.pending) return { kind: "pending", message: got.message ?? "Waiting for your approval." };
    // Posted to its issue, but the hub couldn't keep its copy (it has no
    // id): it shows when the comments are read again.
    if (got.kept === false || !got.id) return { kind: "pending", message: got.message ?? "Posted. It shows when the comments are read again." };
    return { kind: "posted", comment: got };
  },
});

export type TicketViewApi = ReturnType<typeof ticketViewOf>;

/** The ticket view on this computer's hub; null while it isn't known. */
export const localTicketView = (): TicketViewApi | null => {
  const h = localHubRef();
  return h ? ticketViewOf(h) : null;
};

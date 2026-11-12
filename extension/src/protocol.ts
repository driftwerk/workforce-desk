// Desk's wire protocol with Chrome, version 1. The extension speaks it to
// Desk Helper over native messaging, and Desk Helper relays it, frame for
// frame, to the local hub's `/ws/desk/chrome`. `protocol/v1.json` holds a
// sample of every message; the extension's tests and the hub's read it, so
// the two can't drift.

export const PROTOCOL = 1;

/** What the signature over a challenge covers: this prefix, then the nonce. */
export const PROOF_PREFIX = "desk-chrome-v1:";

/** The longest page text the extension sends back, in characters. */
export const MAX_TEXT = 200_000;
/** The longest page HTML it sends back, in characters. */
export const MAX_HTML = 400_000;
/** The most file bytes one upload carries: a native message to Chrome is
 *  at most 1 MB, and base64 grows by a third. */
export const MAX_UPLOAD_BYTES = 700_000;

/** The extension, first thing on a connection. */
export interface Hello {
  type: "hello";
  protocol: number;
  version: string;
  /** Who it is: its public key (P-256, raw, base64), made once per profile. */
  key: string;
  /** What the person sees to tell this profile apart: the key's fingerprint. */
  label: string;
}

/** The hub: sign this. `state` says whether the person has confirmed this
 *  profile yet. */
export interface Challenge {
  type: "challenge";
  nonce: string;
  state: "confirmed" | "pending";
}

export interface Proof {
  type: "proof";
  /** ECDSA P-256 SHA-256 over `PROOF_PREFIX + nonce`, IEEE P1363, base64. */
  signature: string;
}

/** The hub: calls may come now. */
export interface Ready {
  type: "ready";
}

/** The hub: waiting for the person to confirm this profile in Desk. */
export interface Waiting {
  type: "waiting";
  why: string;
}

/** The hub: this connection won't be used, and why. */
export interface Refused {
  type: "refused";
  why: string;
}

/** What Desk is doing now, for the popup. */
export interface Status {
  type: "status";
  activity: { agent: string; url: string; host: string | null } | null;
}

export type Command =
  | { cmd: "open"; session: string }
  | { cmd: "navigate"; session: string; url: string }
  | { cmd: "where"; session: string }
  | { cmd: "read"; session: string; what: "text" | "html" | "all" }
  | { cmd: "shown"; session: string; selector: string | null; form: boolean }
  | { cmd: "click"; session: string; selector: string }
  | { cmd: "fill"; session: string; selector: string; value: string }
  | { cmd: "type"; session: string; selector: string | null; text: string }
  | { cmd: "press"; session: string; selector: string | null; key: string }
  | { cmd: "select"; session: string; selector: string; value: string }
  | { cmd: "wait"; session: string; selector: string; timeout_ms: number }
  | { cmd: "upload"; session: string; selector: string; files: UploadFile[] }
  | { cmd: "capture"; session: string; refuse?: KeyPage[] }
  | { cmd: "capture_key"; session: string; selector: string; origin: string; paths: string[] }
  | { cmd: "front"; session: string }
  | { cmd: "close"; session: string }
  | { cmd: "stop" };

/** A page where a service shows a new key: its exact origin, and the path
 *  prefixes its key pages are under. */
export interface KeyPage {
  origin: string;
  paths: string[];
}

/** The longest key Desk reads. */
export const MAX_KEY = 512;

export interface UploadFile {
  name: string;
  type: string;
  base64: string;
}

/** The hub asks; `id` comes back on the result. */
export type Call = { type: "call"; id: number } & Command;

export type Result = { type: "result"; id: number; ok: true; value: unknown } | { type: "result"; id: number; ok: false; error: string };

/** Something the person did in Chrome. */
export interface Event {
  type: "event";
  event: "tab-closed" | "stopped";
  session?: string;
}

export type FromHub = Challenge | Ready | Waiting | Refused | Status | Call;
export type ToHub = Hello | Proof | Result | Event;

/** Whether `m` reads as a message from the hub (Desk Helper relays only
 *  what the hub sent, but nothing is taken on trust). */
export const fromHub = (m: unknown): FromHub | null => {
  if (!m || typeof m !== "object") return null;
  const t = (m as { type?: unknown }).type;
  switch (t) {
    case "challenge":
      return typeof (m as Challenge).nonce === "string" ? (m as Challenge) : null;
    case "ready":
      return m as Ready;
    case "waiting":
    case "refused":
      return typeof (m as Waiting).why === "string" ? (m as Waiting | Refused) : null;
    case "status":
      return m as Status;
    case "call": {
      const c = m as Call;
      return Number.isSafeInteger(c.id) && typeof c.cmd === "string" ? c : null;
    }
    default:
      return null;
  }
};

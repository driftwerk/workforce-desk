// How the page reaches a paired hub: the local hub as the person, and every
// remote hub. In the app that is by the hub's id, through Desk's native side
// (src-tauri/src/hub_io.rs), which holds every hub's token and adds it there:
// the page has none to send anywhere, and nothing it asks decides where a
// request goes beyond the path on the hub it names. Sockets are held there
// too, with the token in their handshake's header, never in a URL.
//
// Outside the app (the browser preview, tests) there is no native side, so
// this is the window's own fetch and WebSocket, with a token of the preview's.

import { invoke } from "@tauri-apps/api/core";
import { BridgedSocket } from "./broker";
import { devToken } from "./devTokens";
import { direct, type Body, type DeskTransport } from "./transport";

/** Which hub: its id (what the native side knows it by) and, for the
 *  preview, where it is. */
export interface HubRef {
  id: string;
  url: string;
}

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Statuses whose answer has no body (a Response refuses one). */
const EMPTY = new Set([101, 204, 205, 304]);

const bytesOf = async (body: Body | undefined): Promise<Uint8Array> => {
  if (!body) return new Uint8Array();
  if (typeof body.data === "string") return new TextEncoder().encode(body.data);
  return new Uint8Array(await body.data.arrayBuffer());
};

/** The native side's answer: the length of its head (four bytes,
 *  big-endian), the head's JSON, then the body's bytes. */
export const unframe = (frame: ArrayBuffer): Response => {
  const view = new DataView(frame);
  const n = view.getUint32(0);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(frame, 4, n))) as { status: number; contentType: string | null };
  const body = frame.slice(4 + n);
  return new Response(EMPTY.has(meta.status) ? null : body, {
    status: meta.status,
    headers: meta.contentType ? { "content-type": meta.contentType } : {},
  });
};

const native = (hub: HubRef): DeskTransport => ({
  fetch: async (method, path, body) => {
    const headers: Record<string, string> = {
      "x-desk-hub": encodeURIComponent(hub.id),
      "x-desk-method": encodeURIComponent(method),
      "x-desk-path": encodeURIComponent(path),
    };
    if (body) headers["x-desk-type"] = encodeURIComponent(body.type);
    return unframe(await invoke<ArrayBuffer>("hub_fetch", await bytesOf(body), { headers }));
  },
  socket: (path) => new BridgedSocket((events) => invoke<number>("hub_socket_open", { hub: hub.id, path, events })),
});

/** Hub `hub`, as the page reaches it. */
export const pairedHub = (hub: HubRef): DeskTransport => (inTauri ? native(hub) : direct({ url: hub.url, token: devToken(hub.id) }));

/** `body` as JSON, for a request. */
export const jsonBody = (body: unknown): Body | undefined =>
  body === undefined ? undefined : { type: "application/json", data: JSON.stringify(body) };

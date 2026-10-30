import { vi } from "vitest";

/** A picture's bytes, as a hub serves them. */
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** Hubs that answer every `…/picture` path with an image (and `other` for
 *  the rest), and blob URLs named after what they show (jsdom has none). */
export function servePictures(other: (url: URL) => Response = () => new Response("{}", { headers: { "content-type": "application/json" } })) {
  const fetch = vi.fn(async (input: URL | string) => {
    const url = new URL(String(input));
    return url.pathname.endsWith("/picture") ? new Response(new Blob([PNG_BYTES], { type: "image/png" }), { headers: { "content-type": "image/png" } }) : other(url);
  });
  vi.stubGlobal("fetch", fetch);
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:picture-${++n}`);
  URL.revokeObjectURL = vi.fn();
  return fetch;
}

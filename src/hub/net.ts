import { fetch as nativeFetch } from "@tauri-apps/plugin-http";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** fetch for talking to hubs. In the app it goes through Desk's native
 *  layer, so a hub needs no CORS set-up to let Desk in (a remote hub only
 *  allows its own dashboard's origin); outside the app (the browser
 *  preview, tests) it is the window's own fetch. */
export const hubFetch = (input: string | URL, init?: RequestInit): Promise<Response> =>
  inTauri ? nativeFetch(input, init) : globalThis.fetch(input, init);

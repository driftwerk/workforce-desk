import { invoke } from "@tauri-apps/api/core";

/** The page in Chrome where the person turns remote debugging on. Chrome
 *  won't open a chrome:// address handed to it from outside, so Desk copies
 *  it for the person to paste. */
export const TURN_ON = "chrome://inspect/#remote-debugging";

/** Where to get Chrome. */
export const GET_CHROME = "https://www.google.com/chrome/";

/** Opens the person's Chrome, or brings it forward (natively: no address,
 *  no switches). Rejects with "Chrome isn't installed on this computer." */
export const openChrome = (): Promise<void> => invoke<void>("open_chrome");

/** How often the guide asks whether Chrome has turned debugging on. */
export const CONNECT_POLL_MS = 2000;

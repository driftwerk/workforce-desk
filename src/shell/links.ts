import { useDesk } from "../hub/store";
import { openUrl } from "../platform";
import { openTarget } from "./navigate";
import { useBoard } from "../board/store";
import { revealSetup } from "../chat/SetupCard";

// Links to a room message, within Desk: `desk://room/<room>/msg/<message>`.
// Copy link writes one; a click on one, in your messages or an agent's,
// takes you there. Nothing registers the scheme with the system.

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const DESK_LINK = new RegExp(`^desk://room/(${UUID})/msg/(${UUID})$`, "i");
const TICKET_LINK = new RegExp(`^desk://ticket/(${UUID})$`, "i");
const SETUP_LINK = /^desk:\/\/setup\/([0-9a-f]{32})$/i;

/** The connection setup a `desk:` link names (the card an agent says it
 *  put up: `desk://setup/<id>`); null for anything else. */
export const parseSetupLink = (url: string): string | null => SETUP_LINK.exec(url.trim())?.[1]?.toLowerCase() ?? null;

/** A link to a board's ticket, within Desk: `desk://ticket/<ticket>`. */
export const ticketLink = (id: string): string => `desk://ticket/${id}`;

/** The ticket a `desk:` link names; null for anything else. */
export const parseTicketLink = (url: string): string | null => TICKET_LINK.exec(url.trim())?.[1]?.toLowerCase() ?? null;

export const deskLink = (at: { room: string; message: string }): string => `desk://room/${at.room}/msg/${at.message}`;

/** The room message a `desk:` link names; null for anything else. */
export const parseDeskLink = (url: string): { room: string; message: string } | null => {
  const m = DESK_LINK.exec(url.trim());
  return m ? { room: m[1]!.toLowerCase(), message: m[2]!.toLowerCase() } : null;
};

/** Opens a link: a `desk:` one in Desk, anything else as the system does. */
export const openLink = (url: string): void => {
  if (!/^desk:/i.test(url)) return openUrl(url);
  const ticket = parseTicketLink(url);
  if (ticket) return useBoard.getState().openTicket(ticket);
  const setup = parseSetupLink(url);
  if (setup) {
    // Its card is in the chat that asked for it, else at the top of the
    // stage: brought into view either way.
    if (!revealSetup(setup)) useDesk.getState().fail("That setup’s card isn’t open any more. Ask the agent to show it again.");
    return;
  }
  const at = parseDeskLink(url);
  if (!at || !useDesk.getState().rooms[at.room]) {
    useDesk.getState().fail("That message isn’t in any of your rooms.");
    return;
  }
  openTarget({ kind: "room", roomId: at.room, threadId: null, messageId: at.message });
};

export type LinkPart = { kind: "text"; text: string } | { kind: "link"; text: string; url: string };

const LINK = /\b(?:https?:\/\/|desk:\/\/)[^\s<>"']+/gi;
/** Punctuation that ends a sentence rather than the link it follows. */
const TRAILING = /[.,;:!?)\]]+$/;

/** Plain text in parts: text, and the http(s) and `desk:` links in it. */
export const linkParts = (text: string): LinkPart[] => {
  const parts: LinkPart[] = [];
  let at = 0;
  for (const m of text.matchAll(LINK)) {
    const url = m[0].replace(TRAILING, "");
    const start = m.index!;
    if (start > at) parts.push({ kind: "text", text: text.slice(at, start) });
    parts.push({ kind: "link", text: url, url });
    at = start + url.length;
  }
  if (at < text.length) parts.push({ kind: "text", text: text.slice(at) });
  return parts;
};

import { HubError } from "../hub/client";

/** An error as the person should read it: never a route, a status code or
 *  the hub's internals. */
export const plainError = (e: unknown): string => {
  if (e instanceof HubError) {
    if (e.status === 401 || e.status === 403) return "Desk isn’t allowed to do that on this Mac.";
    if (e.status === 404) return "That isn’t there any more.";
    if (e.status >= 500) return "Something went wrong on this Mac. Try again in a moment.";
    return e.message;
  }
  if (e instanceof TypeError) return "Desk can’t reach your agents right now. Try again in a moment.";
  return e instanceof Error ? e.message : String(e);
};

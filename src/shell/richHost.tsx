import { RichHostProvider, type RichHost } from "@workforce/rich";
import type { ReactNode } from "react";
import { openLink } from "./links";

/** What every piece of agent markdown in Desk starts from: links open through
 *  Desk, its own `desk:` links survive, and a remote image is a link to it, since
 *  the page neither may (its CSP) nor should (an agent's text would choose what
 *  it fetches) load one. */
export const DESK_RICH_HOST = {
  openUrl: openLink,
  linkSchemes: ["desk"],
  remoteImages: "link",
} as const satisfies RichHost;

/** Around both windows' roots, so markdown with no host of its own (a reply as it
 *  streams, the Floor's brief, a session's last reply) follows the same rules. */
export function DeskRichHost({ children }: { children: ReactNode }) {
  return <RichHostProvider host={DESK_RICH_HOST}>{children}</RichHostProvider>;
}

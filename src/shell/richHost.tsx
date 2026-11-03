import { RichHostProvider, type RemoteImage, type RichHost } from "@workforce/rich";
import type { ReactNode } from "react";
import { openLink } from "./links";
import { RemoteImagePlaceholder } from "./RemoteImage";

/** What every piece of agent markdown in Desk starts from: links open through
 *  Desk, its own `desk:` links survive, and a remote image is a placeholder
 *  with its caption and site. The page never loads one (its CSP bars them, and
 *  an agent's text would choose what it fetched): Desk fetches it once the
 *  person asks, or always for a site they chose, and the page draws the bytes. */
export const DESK_RICH_HOST = {
  openUrl: openLink,
  linkSchemes: ["desk"],
  remoteImages: "link",
  remoteImage: (image: RemoteImage) => <RemoteImagePlaceholder key={image.url} image={image} />,
} as const satisfies RichHost;

/** Around both windows' roots, so markdown with no host of its own (a reply as it
 *  streams, the Floor's brief, a session's last reply) follows the same rules. */
export function DeskRichHost({ children }: { children: ReactNode }) {
  return <RichHostProvider host={DESK_RICH_HOST}>{children}</RichHostProvider>;
}

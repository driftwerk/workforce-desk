import type { HubAccount } from "../chat/types";
import { HubError } from "../hub/client";
import { plainError } from "../ui/plainError";
import type { Picture } from "./pictures";

/** Why a hub refused a picture, as it said it (it may be another
 *  computer's, so not as the local hub's errors are worded). */
export const pictureRefusal = (e: unknown): string => (e instanceof HubError && e.message ? e.message : plainError(e));

export interface Spread {
  /** Each hub that took it, with the picture it shows now. */
  done: { hub: HubAccount; picture: Picture | null }[];
  failed: { hub: HubAccount; why: string }[];
}

/** Chooses `image` as your picture on every hub of `targets`; one that
 *  refuses is said, and the others keep it. */
export const spreadPicture = async (
  image: Blob,
  targets: readonly HubAccount[],
  send: (hub: HubAccount, image: Blob) => Promise<Picture | null>,
): Promise<Spread> => {
  const results = await Promise.allSettled(targets.map((hub) => send(hub, image)));
  return results.reduce<Spread>(
    (out, r, i) => {
      const hub = targets[i]!;
      if (r.status === "fulfilled") out.done.push({ hub, picture: r.value });
      else out.failed.push({ hub, why: pictureRefusal(r.reason) });
      return out;
    },
    { done: [], failed: [] },
  );
};

const list = (names: string[]): string =>
  names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** What a spread did, in a sentence or two. */
export const spreadSaid = ({ done, failed }: Spread): string =>
  [
    done.length ? `Now your picture on ${list(done.map((d) => d.hub.label))}.` : "",
    ...failed.map((f) => `Couldn’t set it on ${f.hub.label}: ${f.why}`),
  ]
    .filter(Boolean)
    .join(" ");

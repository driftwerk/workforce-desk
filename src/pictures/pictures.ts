// Agents' and people's pictures, as each hub resolves them: one chosen for
// them, else their Slack picture, else none (the letter shows). The images
// come through the native side, which adds the hub's token (`pairedHub`),
// and are shown from `blob:` URLs kept per version: a new version fetches
// once, and the old one's URL is let go.

import { useEffect, useState } from "react";
import { pairedHub, type HubRef } from "../hub/net";

export interface Picture {
  /** Changes whenever the image does. */
  version: string;
  source: "chosen" | "slack";
  /** When it was chosen, or fetched from Slack. */
  at: string;
  /** The Slack workspace a Slack picture is held from, also while a chosen
   *  one overrides it. */
  slack?: string | null;
}

/** A hub's `picture`, when it's one. */
export const pictureOf = (x: unknown): Picture | null => {
  if (!x || typeof x !== "object") return null;
  const p = x as Record<string, unknown>;
  if (typeof p.version !== "string" || !p.version || (p.source !== "chosen" && p.source !== "slack")) return null;
  return {
    version: p.version,
    source: p.source,
    at: typeof p.at === "string" ? p.at : "",
    slack: typeof p.slack === "string" ? p.slack : null,
  };
};

export const agentPicturePath = (id: string): string => `/api/agents/${encodeURIComponent(id)}/picture`;
export const MY_PICTURE = "/api/me/picture";

/** Where an image is: on which hub (and how to reach it), at which path,
 *  in which version. */
export interface ImageRef {
  hubId: string;
  conn: HubRef;
  path: string;
  version: string;
}

const loaded = new Map<string, Promise<string | null>>();
/** The version each place was last asked for. */
const latest = new Map<string, string>();

const fetchImage = async (conn: HubRef, path: string): Promise<Blob | null> => {
  const res = await pairedHub(conn).fetch("GET", path);
  // An older hub answers a route it hasn't with its web page.
  if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("image/")) return null;
  return res.blob();
};

/** The image's bytes, read now. */
export const imageBlob = (ref: Pick<ImageRef, "conn" | "path">): Promise<Blob | null> => fetchImage(ref.conn, ref.path);

/** A `blob:` URL showing `ref`'s image; null when it can't be read (so the
 *  letter shows). Read once per version; the place's older one is let go. */
export const imageUrl = (ref: ImageRef): Promise<string | null> => {
  const place = `${ref.hubId} ${ref.path}`;
  const key = `${place} ${ref.version}`;
  const was = latest.get(place);
  if (was !== undefined && was !== key) {
    const old = loaded.get(was);
    loaded.delete(was);
    void old?.then((url) => url && URL.revokeObjectURL(url));
  }
  latest.set(place, key);
  let url = loaded.get(key);
  if (!url) {
    url = fetchImage(ref.conn, ref.path).then(
      (blob) => (blob ? URL.createObjectURL(blob) : null),
      () => null,
    );
    // A failure is tried again the next time it's shown.
    void url.then((u) => u || (loaded.get(key) === url && loaded.delete(key)));
    loaded.set(key, url);
  }
  return url;
};

/** Forgets every image read (for tests). */
export const forgetImages = (): void => {
  loaded.clear();
  latest.clear();
};

/** The `blob:` URL of `ref`'s image once it's read; null until then, or
 *  without one. */
export function useImage(ref: ImageRef | null): string | null {
  const [src, setSrc] = useState<{ key: string; url: string | null } | null>(null);
  const key = ref ? `${ref.hubId} ${ref.path} ${ref.version}` : null;
  useEffect(() => {
    if (!ref || !key) return;
    let live = true;
    void imageUrl(ref).then((url) => live && setSrc({ key, url }));
    return () => {
      live = false;
    };
    // `ref` is new each render; what it names is `key`.
  }, [key]);
  return src && src.key === key ? src.url : null;
}

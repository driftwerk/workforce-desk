import type { RemoteImage } from "@workforce/rich";
import { useEffect, useState } from "react";
import { remoteImageFetch } from "../platform";
import { alwaysShowImagesFrom, useSettings } from "../settings/store";

/** How a picture's fetch came out: drawn from a `blob:` URL, or not, and why
 *  in plain words. */
export type Outcome = { kind: "shown"; src: string } | { kind: "refused" | "failed"; reason: string };

type View = { kind: "waiting" } | { kind: "loading" } | Outcome;

/** The types Desk's fetcher sends; anything else is never drawn. */
const RASTER = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

/** Fetches, by address, for the whole session: a reply re-rendered as it
 *  streams, or a picture shown in two places, is fetched once. A failure is
 *  forgotten, so it can be tried again; a refusal is kept. */
const fetches = new Map<string, Promise<Outcome>>();
const outcomes = new Map<string, Outcome>();

const asOutcome = (e: unknown): Outcome => {
  const err = e as { kind?: unknown; reason?: unknown } | null;
  if (err && (err.kind === "refused" || err.kind === "failed") && typeof err.reason === "string") {
    return { kind: err.kind, reason: err.reason };
  }
  return { kind: "failed", reason: "The picture didn't arrive." };
};

const unframe = (frame: ArrayBuffer): Outcome => {
  const n = new DataView(frame).getUint32(0);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(frame, 4, n))) as { mime?: unknown };
  if (typeof meta.mime !== "string" || !RASTER.has(meta.mime)) {
    return { kind: "refused", reason: "It isn't a PNG, JPEG, GIF, WebP or AVIF picture." };
  }
  return { kind: "shown", src: URL.createObjectURL(new Blob([frame.slice(4 + n)], { type: meta.mime })) };
};

export function fetchRemoteImage(url: string): Promise<Outcome> {
  let pending = fetches.get(url);
  if (!pending) {
    pending = remoteImageFetch(url).then(unframe, asOutcome);
    fetches.set(url, pending);
    void pending.then((o) => {
      if (o.kind === "failed") fetches.delete(url);
      else outcomes.set(url, o);
    });
  }
  return pending;
}

/** For tests: forget every fetch. */
export const forgetRemoteImages = (): void => {
  fetches.clear();
  outcomes.clear();
};

const PictureIcon = () => (
  <svg className="rimg-icon" viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" focusable="false">
    <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="5.5" cy="6" r="1.2" fill="currentColor" />
    <path d="M2 12l3.5-3.5 2.5 2.5 2-2L14 12.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
  </svg>
);

/** A remote picture in agent markdown: its caption and site, and nothing
 *  fetched until "Show image" (or the site is one the person always shows).
 *  Desk fetches it, never the page. It stands where an inline image would,
 *  inside a paragraph, so it is spans and buttons only. */
export function RemoteImagePlaceholder({ image }: { image: RemoteImage }) {
  const site = image.site.toLowerCase();
  const always = useSettings((s) => s.imageSites.includes(site));
  const [view, setView] = useState<View>(() => outcomes.get(image.url) ?? { kind: "waiting" });

  const show = () => {
    setView({ kind: "loading" });
    void fetchRemoteImage(image.url).then(setView);
  };

  useEffect(() => {
    if (!always || view.kind !== "waiting") return;
    let live = true;
    setView({ kind: "loading" });
    void fetchRemoteImage(image.url).then((o) => live && setView(o));
    return () => {
      live = false;
    };
    // Only when the site becomes one to always show, or the picture changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [always, image.url]);

  if (view.kind === "shown") {
    return (
      <span className="rimg-shown" title={site}>
        <img src={view.src} alt={image.alt} />
      </span>
    );
  }

  const caption = image.alt || "A picture";
  const loading = view.kind === "loading";
  return (
    <span className={`rimg rimg-${view.kind}`} role="group" aria-label={`Picture from ${site}: ${caption}`} aria-busy={loading || undefined}>
      <span className="rimg-head">
        <span className="att-badge att-badge-sm att-badge-media rimg-badge">
          <PictureIcon />
        </span>
        <span className="rimg-title">
          <span className="rimg-caption">{caption}</span>
          <span className="small muted rimg-site">{site}</span>
        </span>
        {view.kind !== "refused" && (
          <span className="rimg-actions">
            <button type="button" className="btn att-btn" disabled={loading} onClick={show}>
              {loading ? "Showing…" : view.kind === "failed" ? "Try again" : "Show image"}
            </button>
          </span>
        )}
      </span>
      {(view.kind === "failed" || view.kind === "refused") && (
        <span className="small state-blocked rimg-problem" role="alert">
          {view.kind === "refused" ? "Desk won't show it. " : "Couldn't show it. "}
          {view.reason}
        </span>
      )}
      {view.kind !== "refused" && (
        <span className="small faint rimg-foot">
          <span>Showing it tells {site} your IP address.</span>
          {!always && (
            <button type="button" className="link rimg-always" disabled={loading} onClick={() => alwaysShowImagesFrom(site)}>
              Always show from this site
            </button>
          )}
        </span>
      )}
    </span>
  );
}

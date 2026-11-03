import type { RemoteImage } from "@workforce/rich";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { remoteImageFetch } from "../platform";
import { alwaysShowImagesFrom, useSettings } from "../settings/store";
import { openLink } from "./links";

/** How a picture's fetch came out: drawn from a `blob:` URL, or not, and why
 *  in plain words. `moved`: shown without a click, it redirected off its
 *  site, so it waits for a click instead. */
export type Outcome = { kind: "shown"; src: string } | { kind: "refused" | "failed" | "moved"; reason: string };

type View = { kind: "waiting" } | { kind: "loading" } | Outcome;

/** The types Desk's fetcher sends; anything else is never drawn. */
const RASTER = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

/** The most pictures kept fetched (as `blob:` URLs) at once. */
export const KEPT = 64;
/** The most pictures in one message shown without a click. */
export const AUTO_PER_MESSAGE = 10;

/** A fetched picture, and how many placeholders are drawing it now. */
interface Kept {
  outcome: Outcome;
  users: number;
  evicted: boolean;
}

/** Fetches in flight, by address, so one picture is fetched once. */
const fetching = new Map<string, Promise<Outcome>>();
/** Settled fetches, by address, least recently used first: a reply re-rendered
 *  as it streams, or a picture shown twice, isn't fetched again. A failure (or
 *  a "moved") isn't kept, so it can be tried again. Past {@link KEPT}, the
 *  oldest goes, and its `blob:` URL is revoked once nothing draws it. */
const kept = new Map<string, Kept>();

const revoke = (k: Kept): void => {
  if (k.outcome.kind === "shown") URL.revokeObjectURL(k.outcome.src);
};

const keep = (url: string, outcome: Outcome): void => {
  kept.set(url, { outcome, users: 0, evicted: false });
  while (kept.size > KEPT) {
    const [oldest, k] = kept.entries().next().value!;
    kept.delete(oldest);
    if (k.users === 0) revoke(k);
    else k.evicted = true;
  }
};

/** The kept outcome for `url`, marked as the most recently used. */
const recall = (url: string): Kept | undefined => {
  const k = kept.get(url);
  if (k) {
    kept.delete(url);
    kept.set(url, k);
  }
  return k;
};

const asOutcome = (e: unknown): Outcome => {
  const err = e as { kind?: unknown; reason?: unknown } | null;
  if (err && (err.kind === "refused" || err.kind === "failed" || err.kind === "moved") && typeof err.reason === "string") {
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

/** The picture at `url`, fetched by Desk; `sameSite` when it's shown without
 *  a click. */
export function fetchRemoteImage(url: string, sameSite = false): Promise<Outcome> {
  const done = recall(url);
  if (done) return Promise.resolve(done.outcome);
  let pending = fetching.get(url);
  if (!pending) {
    pending = remoteImageFetch(url, sameSite).then(unframe, asOutcome);
    fetching.set(url, pending);
    void pending.then((o) => {
      fetching.delete(url);
      if (o.kind === "shown" || o.kind === "refused") keep(url, o);
    });
  }
  return pending;
}

/** For tests: forget every fetch. */
export const forgetRemoteImages = (): void => {
  fetching.clear();
  for (const k of kept.values()) revoke(k);
  kept.clear();
};

/** Which pictures one message may show without a click: the first
 *  {@link AUTO_PER_MESSAGE} addresses that ask. */
type Budget = Set<string>;
const BudgetContext = createContext<Budget | null>(null);

/** Around one message's markdown: at most {@link AUTO_PER_MESSAGE} of its
 *  pictures show without a click; the rest wait as placeholders. */
export function ImageBudget({ children }: { children: ReactNode }) {
  const budget = useRef<Budget>(new Set());
  return <BudgetContext.Provider value={budget.current}>{children}</BudgetContext.Provider>;
}

const claim = (budget: Budget | null, url: string): boolean => {
  if (!budget || budget.has(url)) return true;
  if (budget.size >= AUTO_PER_MESSAGE) return false;
  budget.add(url);
  return true;
};

/** The site a picture's address names, as "always show" keeps it: the host,
 *  and its port unless that's https's own. */
export const siteKey = (url: string): string => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
};

const PictureIcon = () => (
  <svg className="rimg-icon" viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" focusable="false">
    <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="5.5" cy="6" r="1.2" fill="currentColor" />
    <path d="M2 12l3.5-3.5 2.5 2.5 2-2L14 12.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
  </svg>
);

/** Opens the picture's address in the browser, as a remote image's link did
 *  before: an http picture, or one Desk refuses, can still be looked at. */
const OpenInBrowser = ({ url }: { url: string }) => (
  <button type="button" className="link rimg-open" onClick={() => openLink(url)}>
    Open in browser
  </button>
);

/** A remote picture in agent markdown: its caption and site, and nothing
 *  fetched until "Show image" (or the site is one the person always shows,
 *  for the first {@link AUTO_PER_MESSAGE} in a message). Desk fetches it,
 *  never the page. It stands where an inline image would, inside a
 *  paragraph, so it is spans and buttons only. */
export function RemoteImagePlaceholder({ image }: { image: RemoteImage }) {
  const key = siteKey(image.url);
  const always = useSettings((s) => s.imageSites.includes(key));
  const budget = useContext(BudgetContext);
  const [view, setView] = useState<View>(() => kept.get(image.url)?.outcome ?? { kind: "waiting" });

  // Count this placeholder as drawing its picture while it does, so an
  // evicted picture's blob: URL is revoked only once nothing draws it.
  const shown = view.kind === "shown";
  useEffect(() => {
    if (!shown) return;
    const k = kept.get(image.url);
    if (!k) return;
    k.users += 1;
    return () => {
      k.users -= 1;
      if (k.evicted && k.users === 0) revoke(k);
    };
  }, [shown, image.url]);

  const show = () => {
    setView({ kind: "loading" });
    // A click follows any redirect: an in-flight "always show" fetch that
    // turned out to move is asked again.
    void fetchRemoteImage(image.url)
      .then((o) => (o.kind === "moved" ? fetchRemoteImage(image.url) : o))
      .then(setView);
  };

  useEffect(() => {
    if (!always || view.kind !== "waiting" || !claim(budget, image.url)) return;
    let live = true;
    setView({ kind: "loading" });
    void fetchRemoteImage(image.url, true).then((o) => {
      // Off its site: it waits for a click like any other.
      if (live) setView(o.kind === "moved" ? { kind: "waiting" } : o);
    });
    return () => {
      live = false;
    };
    // Only when the site becomes one to always show, or the picture changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [always, image.url]);

  if (view.kind === "shown") {
    return (
      <span className="rimg-shown">
        <span className="rimg-frame" title={image.site}>
          <img src={view.src} alt={image.alt} />
        </span>
        <span className="small faint rimg-foot">
          <span>{image.site}</span>
          <OpenInBrowser url={image.url} />
        </span>
      </span>
    );
  }

  const caption = image.alt || "A picture";
  const loading = view.kind === "loading";
  const problem = view.kind === "failed" || view.kind === "refused" ? view : null;
  return (
    <span className={`rimg rimg-${view.kind}`} role="group" aria-label={`Picture from ${image.site}: ${caption}`} aria-busy={loading || undefined}>
      <span className="rimg-head">
        <span className="att-badge att-badge-sm att-badge-media rimg-badge">
          <PictureIcon />
        </span>
        <span className="rimg-title">
          <span className="rimg-caption">{caption}</span>
          <span className="small muted rimg-site">{image.site}</span>
        </span>
        {view.kind !== "refused" && (
          <span className="rimg-actions">
            <button type="button" className="btn att-btn" disabled={loading} onClick={show}>
              {loading ? "Showing…" : view.kind === "failed" ? "Try again" : "Show image"}
            </button>
          </span>
        )}
      </span>
      {problem && (
        <span className="small state-blocked rimg-problem" role="alert">
          {problem.kind === "refused" ? "Desk won't show it. " : "Couldn't show it. "}
          {problem.reason}
        </span>
      )}
      <span className="small faint rimg-foot">
        {view.kind !== "refused" && <span>Showing it tells {image.site} your IP address.</span>}
        {view.kind !== "refused" && !always && key && (
          <button type="button" className="link rimg-always" disabled={loading} onClick={() => alwaysShowImagesFrom(key)}>
            Always show from this site
          </button>
        )}
        <OpenInBrowser url={image.url} />
      </span>
    </span>
  );
}

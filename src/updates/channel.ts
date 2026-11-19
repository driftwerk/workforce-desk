/** Which builds Desk updates to. Stable: the releases everyone gets.
 *  Nightly: a build of each day's changes as well, and Stable's releases
 *  when they're newer. Desk's native side reads the channel from
 *  settings.json and checks every download and install against it; this
 *  is what the page says about it. */
export type Channel = "stable" | "nightly";

export const CHANNELS: readonly [Channel, string][] = [
  ["stable", "Stable"],
  ["nightly", "Nightly"],
];

/** The channel a setting means: Stable unless it says nightly. */
export const channelOf = (setting: string | null | undefined): Channel => (setting === "nightly" ? "nightly" : "stable");

/** A nightly build's version: `0.2.11-nightly.20261120.42`. */
export const isNightly = (version: string): boolean => /^v?\d+\.\d+\.\d+-nightly\./.test(version.trim());

/** The first stable a nightly leads up to: `0.2.11` for
 *  `0.2.11-nightly.20261120.42`. */
export const stableOf = (version: string): string => version.trim().replace(/^v/, "").split(/[-+]/)[0]!;

/** What Help says under the channel, for a Desk at `version` (empty while
 *  it's being read). */
export const channelLine = (channel: Channel, version: string, packaged = false): string => {
  if (packaged)
    return "The releases everyone gets. Nightlies come only as the AppImage and the macOS and Windows apps, so a Desk installed as a package follows Stable.";
  if (channel === "nightly")
    return "A build of each day’s changes, out overnight: newer than Stable and less tested. Stable releases still reach you when they’re newer.";
  if (version && isNightly(version))
    return `This is a nightly build. Desk never goes back to an older version, so it stays on this one until Stable reaches Desk ${stableOf(version)} or newer, then updates as usual.`;
  return "The releases everyone gets.";
};

/** Where a version a package manager installs can be downloaded by hand:
 *  its own release (a nightly isn't the latest), else the latest. */
export const downloadFor = (version: string, how: { download: string | null; releases?: string | null }): string | null =>
  how.releases ? `${how.releases}/tag/v${version.replace(/^v/, "")}` : how.download;

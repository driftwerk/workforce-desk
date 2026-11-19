// The update channel as the page reads and says it: Stable unless the
// setting says nightly, what a nightly version is, the stable it waits for
// once back on Stable, and where a package's nightly is downloaded.

import { describe, expect, it } from "vitest";
import { channelLine, channelOf, downloadFor, isNightly, stableOf } from "./channel";
import { olderThan } from "./store";

describe("update channel", () => {
  it("is Stable unless the setting says nightly", () => {
    expect(channelOf("nightly")).toBe("nightly");
    for (const s of ["stable", "", undefined, null, "Nightly", "beta"]) expect(channelOf(s)).toBe("stable");
  });

  it("tells a nightly's version from a release's", () => {
    expect(isNightly("0.2.11-nightly.20261120.42")).toBe(true);
    expect(isNightly("v0.2.11-nightly.20261120.42")).toBe(true);
    expect(isNightly("0.2.11")).toBe(false);
    expect(isNightly("0.2.11-rc.1")).toBe(false);
    expect(stableOf("0.2.11-nightly.20261120.42")).toBe("0.2.11");
    expect(stableOf("v1.0.0+build")).toBe("1.0.0");
  });

  it("orders nightlies after the stable they follow and before the one they lead to", () => {
    const nightly = "0.2.11-nightly.20261120.42";
    expect(olderThan("0.2.10", nightly)).toBe(true);
    expect(olderThan(nightly, "0.2.11")).toBe(true);
    expect(olderThan(nightly, "0.2.11-nightly.20261121.1")).toBe(true);
    expect(olderThan("0.2.11-nightly.20261120.9", "0.2.11-nightly.20261120.10")).toBe(true);
  });

  it("says plainly that a nightly back on Stable waits for the next newer stable", () => {
    expect(channelLine("stable", "0.2.10")).toBe("The releases everyone gets.");
    expect(channelLine("stable", "")).toBe("The releases everyone gets.");
    const back = channelLine("stable", "0.2.11-nightly.20261120.42");
    expect(back).toContain("never goes back to an older version");
    expect(back).toContain("Desk 0.2.11 or newer");
    expect(channelLine("nightly", "0.2.10")).toContain("each day’s changes");
    expect(channelLine("nightly", "0.2.10")).toContain("Stable releases still reach you");
  });

  it("links a package's version to its own release", () => {
    const how = { download: "https://github.com/a/desk/releases/latest", releases: "https://github.com/a/desk/releases" };
    expect(downloadFor("0.2.11-nightly.20261120.42", how)).toBe("https://github.com/a/desk/releases/tag/v0.2.11-nightly.20261120.42");
    expect(downloadFor("0.2.11", how)).toBe("https://github.com/a/desk/releases/tag/v0.2.11");
    expect(downloadFor("0.2.11", { download: how.download, releases: null })).toBe(how.download);
  });
});

// Desk's Chrome Web Store id is the one the store's public key gives, and
// the one Desk Helper serves (`crates/desk-chrome-host`), so the store's
// extension and an unpacked build with that key are the same to Desk.
import { describe, expect, it } from "vitest";

type Fs = { readFileSync: (path: string, enc: "utf8") => string };
type Hash = {
  update: (data: Uint8Array) => Hash;
  digest: (enc: "hex") => string;
};
type Crypto = { createHash: (alg: "sha256") => Hash };

describe("Desk's Chrome Web Store id", () => {
  it("is the one its public key gives, and the one Desk Helper serves", async () => {
    const fs = (await import("node:fs" as string)) as Fs;
    const crypto = (await import("node:crypto" as string)) as Crypto;
    const key = fs
      .readFileSync("extension/store/public-key.txt", "utf8")
      .trim();
    const der = Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
    const id = [
      ...crypto.createHash("sha256").update(der).digest("hex").slice(0, 32),
    ]
      .map((h) => String.fromCharCode(97 + parseInt(h, 16)))
      .join("");
    const host = fs.readFileSync("crates/desk-chrome-host/src/lib.rs", "utf8");
    expect(host).toContain(`pub const STORE_ID: &str = "${id}";`);
  });
});

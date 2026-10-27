import { describe, expect, it } from "vitest";
import { plain } from "./plain";

describe("plain", () => {
  it("drops markdown syntax but keeps the words", () => {
    expect(plain("**Done.** See [PR #441](https://x) and `cargo test`.\n- one\n## Next")).toBe(
      "Done. See PR #441 and cargo test.\none\nNext",
    );
    expect(plain("before\n```rust\nfn x() {}\n```\nafter")).toBe("before\n\nafter");
  });
});

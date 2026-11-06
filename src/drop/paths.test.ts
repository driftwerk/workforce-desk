import { describe, expect, it } from "vitest";
import { escapePath, hasControl, pathsLine } from "./paths";

describe("a dropped path, as a terminal is given it", () => {
  it("escapes what a shell reads specially with a backslash, as Ghostty does", () => {
    expect(escapePath("/Users/me/Desktop/Screenshot 2026-11-06 at 10.15.32.png")).toBe(
      "/Users/me/Desktop/Screenshot\\ 2026-11-06\\ at\\ 10.15.32.png",
    );
    expect(escapePath(`/tmp/it's "quoted" $(rm -rf ~) \`x\`; a&b|c *?!#<>[]{}\\`)).toBe(
      "/tmp/it\\'s\\ \\\"quoted\\\"\\ \\$\\(rm\\ -rf\\ ~\\)\\ \\`x\\`\\;\\ a\\&b\\|c\\ \\*\\?\\!\\#\\<\\>\\[\\]\\{\\}\\\\",
    );
    expect(escapePath("/plain/path-with_ok.chars,+@%=:")).toBe("/plain/path-with_ok.chars,+@%=:");
  });

  it("leaves Unicode as it is, composed or decomposed", () => {
    expect(escapePath("/Users/me/café ☕/日本語.png")).toBe("/Users/me/café\\ ☕/日本語.png");
    // Finder hands names over decomposed (NFD): kept byte for byte.
    const nfd = "/Users/me/café.png";
    expect(escapePath(nfd)).toBe(nfd);
    expect(escapePath(nfd)).not.toBe(nfd.normalize("NFC"));
  });

  it("joins several with spaces, and adds nothing after: no Enter", () => {
    expect(pathsLine(["/a/one.png", "/b/two three.pdf"])).toBe("/a/one.png /b/two\\ three.pdf");
    expect(pathsLine(["/a/x"]).endsWith("\n")).toBe(false);
    expect(pathsLine(["/a/x"]).endsWith("\r")).toBe(false);
  });

  it("refuses a name holding a control character, which would act as a key", () => {
    for (const bad of ["/tmp/a\nb", "/tmp/a\rb", "/tmp/esc\u001b[201~ls\r", "/tmp/tab\there", "/tmp/del\u007f", "/tmp/c1\u009b"]) {
      expect(hasControl(bad), JSON.stringify(bad)).toBe(true);
      expect(() => pathsLine(["/ok", bad])).toThrow(/control or invisible character/);
    }
    expect(hasControl("/Users/me/café ☕.png")).toBe(false);
    expect(hasControl("/Users/me/cafe\u0301 日本語.png")).toBe(false);
  });

  it("refuses invisible formatting too, which shows a name as other than it is", () => {
    for (const bad of ["/tmp/invoice\u202efdp.exe", "/tmp/zero\u200bwidth", "/tmp/bom\ufeff", "/tmp/iso\u2066x\u2069", "/tmp/tag\u{e0041}"]) {
      expect(hasControl(bad), JSON.stringify(bad)).toBe(true);
      expect(() => pathsLine([bad])).toThrow(/invisible/);
    }
    expect(() => pathsLine(["/tmp/invoice\u202efdp.exe"])).toThrow("“/tmp/invoice?fdp.exe”");
  });
});

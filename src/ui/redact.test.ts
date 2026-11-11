import { describe, expect, it } from "vitest";
import { redact } from "./redact";

// Fixture secrets are put together here, so no source line reads as a real one.
const j = (...parts: string[]): string => parts.join("");
const body = (n: number, seed = "aB3xK9"): string => seed.repeat(Math.ceil(n / seed.length)).slice(0, n);

const gone = (text: string, secret: string) => {
  const out = redact(text);
  expect(out).not.toContain(secret);
  expect(out).toContain("[redacted]");
  expect(redact(out)).toBe(out);
  return out;
};

describe("redact", () => {
  it("Authorization and Bearer values", () => {
    gone(j("Authoriz", "ation: Bea", "rer ", "q1w2e3.", "r4t5y6-u7"), "q1w2e3");
    gone(j("curl -H 'Authoriz", "ation: Ba", "sic ", "Zm9vOmJhcg", "Zm9v", "' x"), "Zm9vOmJhcg");
    gone(j("sent bea", "rer ", "ey", "Jh", "bGciOi.payload.sig"), "bGciOi");
  });
  it("token prefixes", () => {
    for (const [a, b] of <[string, string][]>[
      ["s", "k-ant-api03-"],
      ["gh", "p_"],
      ["gh", "o_"],
      ["xo", "xb-1234-5678-"],
      ["w", "fp_"],
      ["w", "fr_"],
      ["w", "fb_"],
      ["AK", "IA"],
    ]) {
      const t = j(a, b, a === "AK" ? "Q7ZX3M9PL2VB4N8K" : body(20));
      gone(`failed with ${t} in header`, t);
    }
  });
  it("name=value secrets, in several spellings", () => {
    gone(j("tok", "en=", body(24)), body(24));
    gone(j("pass", "word: '", body(20, "p@sS1-"), "'"), body(20, "p@sS1-"));
    gone(j('{"api', '_key": "', body(22), '"}'), body(22));
    gone(j("CLIENT_SEC", "RET=", body(22, "s3Cr3t"), "&x=1"), body(22, "s3Cr3t"));
    gone(j("x-api", "-key: ", body(20, "Zk3jQ9")), body(20, "Zk3jQ9"));
  });
  it("userinfo in URLs", () => {
    const out = gone("git clone https://me:pa55@github.com/o/r.git", "pa55");
    expect(out).toContain("github.com/o/r.git");
    gone(j("https://", "ghp", "_", body(12), "@github.com/x"), body(12));
  });
  it("long hex and base64 runs", () => {
    gone(j("id ", "0123456789abcdef".repeat(3)), "0123456789abcdef0123456789abcdef");
    gone(j("blob ", "QWxhZGRpbjpvcGVuIHNlc2FtZQ", "1234567890AbCdEfGhIjKlMn rest"), "QWxhZGRpbjpvcGVuIHNlc2FtZQ");
  });
  it("keeps what isn't a secret", () => {
    for (const t of [
      "git worktree add /Users/me/dev/projects/driftwerk/workforce-desk/.git/worktrees/Fix_Login-Branch2/HEAD: fatal: exists",
      "cwd=/Users/me/dev/projects/driftwerk/Workforce-Desk-Install-2/some/deep/path",
      "C:\\Users\\me\\AppData\\Local\\Desk\\logs\\desk-hubd-2026-11-11.log",
      "at commit 3f2c1d9a8b7e6f5d4c3b2a1908f7e6d5c4b3a291 on main",
      "digest sha256:" + "ab12".repeat(16),
      "Missing token: expired",
      "No such secret: stripe-prod",
      "keyboard: layout",
      "monkey=banana and passwords: none",
      "token=short",
      "key=/home/me/.ssh/id_ed25519_long_name",
    ])
      expect(redact(t)).toBe(t);
  });
  it("leaves ordinary text and short ids alone", () => {
    const t = "git worktree add /Users/me/p: fatal: a branch called fix-1 already exists (exit 128)";
    expect(redact(t)).toBe(t);
    expect(redact("session s-1234 on devbox")).toBe("session s-1234 on devbox");
  });
});

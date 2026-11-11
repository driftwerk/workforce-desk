import { describe, expect, it } from "vitest";
import { redact } from "./redact";

const gone = (text: string, secret: string) => {
  const out = redact(text);
  expect(out).not.toContain(secret);
  expect(out).toContain("[redacted]");
  expect(redact(out)).toBe(out);
  return out;
};

describe("redact", () => {
  it("Authorization and Bearer values", () => {
    gone("Authorization: Bearer abc123.def456-ghi", "abc123");
    gone("curl -H 'Authorization: Basic dXNlcjpwYXNz' x", "dXNlcjpwYXNz");
    gone("sent bearer eyJhbGciOiJIUzI1NiJ9.payload.sig", "eyJhbGci");
  });
  it("token prefixes", () => {
    for (const s of ["sk-ant-api03-AbCdEfGh12345678", "ghp_abcdefghij1234567890", "gho_abcdefghij1234567890", "xoxb-1234-5678-abcdef", "wfp_AbCdEf123456", "wfr_AbCdEf123456", "wfb_AbCdEf123456", "AKIAIOSFODNN7EXAMPLE"])
      gone(`failed with ${s} in header`, s);
  });
  it("name=value secrets, in several spellings", () => {
    gone("token=Hunter2-Hunter2-Hunter2", "Hunter2-Hunter2");
    gone("password: 'p@ssw0rd-Long-Enough-1'", "p@ssw0rd-Long-Enough-1");
    gone('{"api_key": "abc-DEF-0123456789xyz"}', "abc-DEF-0123456789xyz");
    gone("CLIENT_SECRET=s3cr3tValue0123456789&x=1", "s3cr3tValue0123456789");
    gone("x-api-key: Zk3jQ9vLmN2pR7sT1uVw", "Zk3jQ9vLmN2pR7sT1uVw");
  });
  it("userinfo in URLs", () => {
    const out = gone("git clone https://me:pa55@github.com/o/r.git", "pa55");
    expect(out).toContain("github.com/o/r.git");
    gone("https://ghp_token123456789@github.com/x", "ghp_token123456789");
  });
  it("long hex and base64 runs", () => {
    gone("id 0123456789abcdef0123456789abcdef0123456789abcdef", "0123456789abcdef0123456789abcdef");
    gone("blob QWxhZGRpbjpvcGVuIHNlc2FtZQ1234567890AbCdEfGhIjKlMn rest", "QWxhZGRpbjpvcGVuIHNlc2FtZQ");
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

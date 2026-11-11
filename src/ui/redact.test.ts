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
    gone("token=hunter2xyz", "hunter2xyz");
    gone("password: 'p@ss w0rd'", "p@ss w0rd");
    gone('{"api_key": "abc-def"}', "abc-def");
    gone("CLIENT_SECRET=s3cr3t&x=1", "s3cr3t");
    gone("ssh key=/home/me/.ssh/id", "/home/me/.ssh/id");
  });
  it("userinfo in URLs", () => {
    const out = gone("git clone https://me:pa55@github.com/o/r.git", "pa55");
    expect(out).toContain("github.com/o/r.git");
    gone("https://ghp_token123456789@github.com/x", "ghp_token123456789");
  });
  it("long hex and base64 runs", () => {
    gone("id 0123456789abcdef0123456789abcdef0123", "0123456789abcdef0123456789abcdef");
    gone("blob QWxhZGRpbjpvcGVuIHNlc2FtZQ1234567890AbCdEfGhIjKlMn rest", "QWxhZGRpbjpvcGVuIHNlc2FtZQ");
  });
  it("leaves ordinary text and short ids alone", () => {
    const t = "git worktree add /Users/me/p: fatal: a branch called fix-1 already exists (exit 128)";
    expect(redact(t)).toBe(t);
    expect(redact("session s-1234 on devbox")).toBe("session s-1234 on devbox");
  });
});

import { expect, it } from "vitest";
import type { EngineAccount } from "../hub/types";
import { OWN_SIGN_IN, accountOfCard, accountOfChoice, accountsOf, defaultChoice, hasAccounts, problemText, sessionsText, signInStep, switchingText, withAccount, ownSignInWorks } from "./accounts";

const account = (id: string, isDefault = false, engine: EngineAccount["engine"] = "claude", sessions: string[] = []): EngineAccount => ({
  id,
  engine,
  name: id,
  isDefault,
  signedIn: true,
  sessions,
  createdAt: "2026-11-03T09:00:00Z",
});

it("lists an engine's accounts default first, and starts on the default or the CLI's own sign-in", () => {
  const all = [account("Personal"), account("Work", true), account("Team", true, "codex")];
  expect(accountsOf(all, "claude").map((a) => a.id)).toEqual(["Work", "Personal"]);
  expect(defaultChoice(all, "claude")).toBe("Work");
  expect(defaultChoice([account("Personal")], "claude")).toBe(OWN_SIGN_IN);
  // Where Claude Code isn't signed in by itself: the first account signed in.
  expect(defaultChoice([account("Personal")], "claude", false)).toBe("Personal");
  expect(defaultChoice([{ ...account("Personal"), signedIn: false }], "claude", false)).toBe(OWN_SIGN_IN);
  expect(ownSignInWorks({ state: "out" })).toBe(false);
  expect(ownSignInWorks({ state: "unknown" })).toBe(true);
  expect(ownSignInWorks(undefined)).toBe(true);
  expect(accountOfChoice(OWN_SIGN_IN)).toBeNull();
  expect(accountOfChoice("Work")).toBe("Work");
  expect(hasAccounts({ accounts: "token" } as never)).toBe(true);
  expect(hasAccounts({ accounts: "none" } as never)).toBe(false);
  expect(hasAccounts(undefined)).toBe(false);
});

it("names a session's account beside its engine, and a switch that waits", () => {
  expect(withAccount("Claude Code", { account: { id: "a", name: "Work" } })).toBe("Claude Code · Work");
  expect(withAccount("Claude Code", { account: null })).toBe("Claude Code");
  expect(switchingText({ switchingTo: { id: "b", name: "Personal" } })).toBe("Moves to Personal when this turn ends");
  expect(switchingText({ switchingTo: null })).toBeNull();
  expect(sessionsText(account("x", false, "claude", ["s1", "s2", "s3"]))).toBe("3 sessions on it");
  expect(sessionsText(account("x"))).toBe("No sessions on it now");
});

it("says where a sign-in is in plain words, and why it failed as the hub says", () => {
  const base = { id: "i", engine: "claude" as const, name: "Work" };
  expect(signInStep({ ...base, state: "open", url: null })).toBe("Finish signing in in your browser.");
  expect(signInStep({ ...base, state: "done", account: "a" })).toBe("Work is added.");
  expect(signInStep({ ...base, state: "failed", why: "the sign-in took too long: start it again" })).toBe("the sign-in took too long: start it again");
});

it("finds a plan card's account by the key its readings have", () => {
  const work = { ...account("Work"), planKey: "ab12" };
  expect(accountOfCard([work], "claude:ab12")?.name).toBe("Work");
  expect(accountOfCard([work], "claude:zz")).toBeNull();
  expect(accountOfCard([account("x")], "claude:ab12")).toBeNull();
});

it("says each sign-in problem with where the sign-ins are kept", () => {
  const p = (problem: "gone" | "unreadable" | "notRemoved") => problemText({ account: "a", name: "Work", problem }, "the keychain");
  expect(p("gone")).toBe("Work’s sign-in is no longer in the keychain: sign it in again from its row. Nothing is switched to it.");
  expect(p("notRemoved")).toContain("couldn’t delete its sign-in from the keychain");
});

import { expect, it } from "vitest";
import type { SortRule } from "../hub/client";
import { alsoWatched, changeRequest, noRules, reachesEmail, removeText, ruleKey, withEnabled, without } from "./sortRules";

const rule = (over: Partial<SortRule> = {}): SortRule => ({ rule_id: "sort-1", owner: null, says: "Move news to News", enabled: true, watched_by: [], ...over });

it("words the change request to be finished by the person", () => {
  expect(changeRequest(rule())).toBe('Change my mail sorting rule "Move news to News" (sort-1) so that ');
});

it("names who else watches the mail, or nothing", () => {
  expect(alsoWatched(rule())).toBeNull();
  expect(alsoWatched(rule({ watched_by: ["A", "B"] }))).toBe("Also watched by: A, B");
});

it("words the empty state and the removal", () => {
  expect(noRules("Kat")).toBe("You have no mail sorting rules yet. Ask Kat to set one up.");
  expect(removeText(rule())).toContain("Move news to News");
});

it("changes or drops one rule by its id and owner only", () => {
  const a = rule();
  const b = rule({ owner: "me" });
  expect(withEnabled([a, b], a, false)).toEqual([{ ...a, enabled: false }, b]);
  expect(without([a, b], b)).toEqual([a]);
});

it("keys a rule by its owner and id", () => {
  expect(ruleKey(rule())).toBe("/sort-1");
  expect(ruleKey(rule({ owner: "me" }))).toBe("me/sort-1");
});

it("finds the email connector reaching an agent by its config, and none until it is read", () => {
  expect(reachesEmail(undefined)).toBe(false);
  expect(reachesEmail("")).toBe(true);
  expect(reachesEmail('[skills]\nenabled = ["linear", "email"]\n')).toBe(true);
  expect(reachesEmail('[skills]\nenabled = ["linear"]\n')).toBe(false);
  expect(reachesEmail("[skills]\nenabled = []\n")).toBe(false);
});

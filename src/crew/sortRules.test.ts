import { expect, it } from "vitest";
import type { SortRule } from "../hub/client";
import { alsoWatched, changeRequest, noRules, removeText, withEnabled, without } from "./sortRules";

const rule = (over: Partial<SortRule> = {}): SortRule => ({ rule_id: "sort-1", owner: null, says: "Move news to News", enabled: true, watched_by: [], ...over });

it("words the change request to be finished by the person", () => {
  expect(changeRequest(rule())).toBe('Change my mail sorting rule "Move news to News" (sort-1) so that ');
});

it("names who else watches the mail, or nothing", () => {
  expect(alsoWatched(rule())).toBeNull();
  expect(alsoWatched(rule({ watched_by: ["A", "B"] }))).toBe("Also watched by: A, B");
});

it("words the empty state and the removal", () => {
  expect(noRules("Kat")).toBe("Kat can sort new mail for you. Ask Kat to set up a rule.");
  expect(removeText(rule())).toContain("Move news to News");
});

it("changes or drops one rule by its id and owner only", () => {
  const a = rule();
  const b = rule({ owner: "me" });
  expect(withEnabled([a, b], a, false)).toEqual([{ ...a, enabled: false }, b]);
  expect(without([a, b], b)).toEqual([a]);
});

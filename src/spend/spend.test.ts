import { expect, it } from "vitest";
import type { SpendTotals } from "../hub/types";
import { breakdownText, tokensText, totalsText, unpricedText, usdText } from "./spend";

const totals = (t: Partial<SpendTotals> = {}): SpendTotals => ({
  tokens: { input: 1200, output: 30_000, cacheRead: 4_100_000, cacheWrite: 220_000, reasoning: 9000 },
  usd: 4.1,
  calls: 40,
  unpricedCalls: 0,
  unpricedModels: [],
  billing: ["plan"],
  ...t,
});

it("says tokens and dollars short", () => {
  expect([830, 34_000, 1_234_567, 3_400_000_000].map(tokensText)).toEqual(["830", "34k", "1.2M", "3.4B"]);
  expect([0, 0.004, 4.1, 1234.5].map(usdText)).toEqual(["$0", "<$0.01", "$4.10", "$1,235"]);
});

it("counts reasoning inside output and calls a plan's dollars API-equivalent", () => {
  expect(totalsText(totals())).toBe("4.4M tokens · $4.10 API-equivalent");
  expect(totalsText(totals({ billing: ["key"] }))).toBe("4.4M tokens · $4.10 billed to your API key");
  expect(totalsText(totals({ billing: ["key", "unknown"] }))).toContain("API-equivalent");
  expect(breakdownText(totals().tokens)).toBe("input 1.2k · output 30k · cache read 4.1M · cache write 220k");
});

it("names the models it can't price", () => {
  expect(unpricedText(totals())).toBeNull();
  expect(unpricedText(totals({ unpricedCalls: 3, unpricedModels: ["claude-mystery-1"] }))).toBe(
    "No price for claude-mystery-1: its tokens are counted, not its dollars.",
  );
});

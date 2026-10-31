import type { SpendTotals, Tokens } from "../hub/types";

/** Every token a call moved: reasoning is inside output. */
export const totalTokens = (t: Tokens): number => t.input + t.output + t.cacheRead + t.cacheWrite;

/** "830", "34k", "1.2M", "3.4B". */
export const tokensText = (n: number): string => {
  const at = (div: number, unit: string) => {
    const v = n / div;
    return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10}${unit}`;
  };
  return n < 1000 ? String(n) : n < 1e6 ? at(1e3, "k") : n < 1e9 ? at(1e6, "M") : at(1e9, "B");
};

/** "$4.10", "<$0.01", "$0". */
export const usdText = (usd: number): string =>
  usd === 0 ? "$0" : usd < 0.01 ? "<$0.01" : `$${usd >= 100 ? Math.round(usd).toLocaleString("en-US") : usd.toFixed(2)}`;

/** What the dollars are: a plan's calls are worth them at API prices
 *  (API-equivalent); a key's calls cost them. */
export const usdMeans = (t: SpendTotals): string =>
  t.billing.length === 1 && t.billing[0] === "key" ? "billed to your API key" : "API-equivalent";

/** A total's line: "1.2M tokens · $4.10 API-equivalent". */
export const totalsText = (t: SpendTotals): string => `${tokensText(totalTokens(t.tokens))} tokens · ${usdText(t.usd)} ${usdMeans(t)}`;

/** What a total can't price, when anything: "No price for claude-x-1". */
export const unpricedText = (t: SpendTotals): string | null =>
  t.unpricedCalls === 0
    ? null
    : t.unpricedModels.length
      ? `No price for ${t.unpricedModels.join(", ")}: its tokens are counted, not its dollars.`
      : "Some calls have no price: their tokens are counted, not their dollars.";

/** "input 12k · output 3k · cache read 1.1M · cache write 40k". */
export const breakdownText = (t: Tokens): string =>
  [
    ["input", t.input],
    ["output", t.output],
    ["cache read", t.cacheRead],
    ["cache write", t.cacheWrite],
  ]
    .map(([k, v]) => `${k} ${tokensText(v as number)}`)
    .join(" · ");

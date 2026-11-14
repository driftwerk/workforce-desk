import { describe, expect, it } from "vitest";
import { DAY, NIGHT } from "./builtin";
import { contrast, contrastChecks, derive, SERIES_MARK_TOKENS, type Palette, type Token } from "./tokens";

/** Every text/ground pair the Day design lists (designs: tokens.md, "Key
 *  ratios"), with its bar: 4.5 for text, 3 for what is seen but not read. */
const PAIRS: [fg: Token, bg: Token, bar: number][] = [
  ["text", "bg", 4.5],
  ["text", "surface", 4.5],
  ["text", "sunken", 4.5],
  ["muted", "bg", 4.5],
  ["muted", "surface", 4.5],
  ["muted", "sunken", 4.5],
  ["faint", "bg", 4.5],
  ["faint", "surface", 4.5],
  ["faint", "sunken", 4.5],
  ["signal", "bg", 4.5],
  ["onSignal", "signal", 4.5],
  ["signalSoftText", "signalSoft", 4.5],
  ["working", "surface", 4.5],
  ["working", "sunken", 4.5],
  ["blocked", "surface", 4.5],
  ["blocked", "blockedSoft", 4.5],
  ["onBlocked", "blocked", 4.5],
  ["onApprove", "approve", 4.5],
  ["onModeFill", "modeFill", 4.5],
  ["approve", "blockedSoft", 3],
  ["text", "cardFill", 4.5],
  ["muted", "cardFill", 4.5],
  ["faint", "cardFill", 4.5],
  ["done", "surface", 4.5],
  ["done", "sunken", 4.5],
  ["termText", "sunken", 4.5],
  ["ansiRed", "sunken", 4.5],
  ["ansiGreen", "sunken", 4.5],
  ["ansiCyan", "sunken", 4.5],
  ["ansiYellow", "sunken", 4.5],
  ["ansiBlue", "sunken", 4.5],
  ["ansiMagenta", "sunken", 4.5],
  ["ansiWhite", "sunken", 4.5],
  ["ansiGreen", "diffAdd", 4.5],
  ["ansiRed", "diffDel", 4.5],
  ["onMark", "mark1", 4.5],
  ["onMark", "mark2", 4.5],
  ["onMark", "mark3", 4.5],
  ["onMark", "mark4", 4.5],
  ["onMark", "mark5", 4.5],
  ["onMark", "mark6", 4.5],
  ...SERIES_MARK_TOKENS.map((m): [Token, Token, number] => ["onSeriesMark", m, 4.5]),
  ["idle", "surface", 3],
  ["logoDot", "surface", 1.5],
  ...([1, 2, 3, 4, 5, 6, 7, 8] as const).flatMap((n) => [[`series${n}`, "bg", 3] as [Token, Token, number], [`series${n}`, "sunken", 3] as [Token, Token, number]]),
];

const ratio = (c: Palette, fg: Token, bg: Token) => contrast(c[fg], c[bg]);

describe("the built-in themes read", () => {
  for (const spec of [NIGHT, DAY]) {
    it(`${spec.name}: every pair the design lists, at its bar`, () => {
      const c = derive(spec).colors;
      const low = PAIRS.filter(([fg, bg, bar]) => ratio(c, fg, bg) < bar).map(([fg, bg, bar]) => `${fg} on ${bg} ${ratio(c, fg, bg).toFixed(2)} < ${bar}`);
      expect(low).toEqual([]);
    });

    it(`${spec.name}: passes the editor's own checks`, () => {
      expect(contrastChecks(derive(spec)).filter((ch) => !ch.pass).map((ch) => `${ch.label} ${ch.ratio.toFixed(2)}`)).toEqual([]);
    });
  }

  it("Day: its key ratios are the design's", () => {
    const c = derive(DAY).colors;
    const at = (fg: Token, bg: Token) => Math.round(ratio(c, fg, bg) * 10) / 10;
    expect([at("text", "bg"), at("muted", "bg"), at("faint", "bg"), at("faint", "sunken"), at("signal", "bg"), at("onSignal", "signal")]).toEqual([16.4, 7.5, 5.7, 4.9, 7.5, 7.4]);
    expect([at("blocked", "surface"), at("done", "surface"), at("termText", "sunken"), at("ansiMagenta", "sunken")]).toEqual([5.2, 5.5, 12.7, 5.3]);
    // Four levels, each a step from the next; the terminal no longer shares the cards' white.
    expect(new Set([c.bg, c.surface, c.raised, c.sunken]).size).toBe(4);
  });
});

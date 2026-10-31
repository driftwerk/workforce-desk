// Text cut where a reader sees characters end, so an emoji made of several
// code points (👩🏽‍💻, 🇬🇧, ❤️) is kept whole or left out, never split.

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export const graphemes = (text: string): string[] => Array.from(segmenter.segment(text), (s) => s.segment);

/** The first character `text` shows, if any. */
export const firstGrapheme = (text: string): string | undefined => segmenter.segment(text)[Symbol.iterator]().next().value?.segment;

/** At most `n` characters of `text`, then `more` when it's cut. */
export const clip = (text: string, n: number, more = "…"): string => {
  if (text.length <= n) return text;
  const kept = graphemes(text);
  return kept.length > n ? kept.slice(0, n).join("") + more : text;
};

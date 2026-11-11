import { explain, GENERIC } from "./problem";

const SHOWN = 400;
/** The raw text behind an inline headline that had to cut it, by headline. */
const longer = new Map<string, string>();

/** The whole raw text behind `text`, when `plainError` cut it short. */
export const fullDetailsOf = (text: string): string | null => longer.get(text) ?? null;

/** An error as the person should read it: never a route, a status code or
 *  the hub's internals. Inline places have no Details, so when the headline
 *  is the generic one the raw text (secrets taken out) follows it on one line
 *  rather than being lost; a longer one is cut and kept for `CopyDetails`. */
export const plainError = (e: unknown): string => {
  const p = explain(e);
  if (!p.details || !(GENERIC as readonly string[]).includes(p.plain)) return p.plain;
  const raw = p.details.replace(/\s+/g, " ").trim();
  if (raw.length <= SHOWN) return `${p.plain} (${raw})`;
  const shown = `${p.plain} (${raw.slice(0, SHOWN)}…)`;
  if (longer.size >= 50) longer.delete(longer.keys().next().value!);
  longer.set(shown, p.details);
  return shown;
};

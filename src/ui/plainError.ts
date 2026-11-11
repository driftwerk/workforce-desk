import { explain, GENERIC } from "./problem";

/** An error as the person should read it: never a route, a status code or
 *  the hub's internals. Inline places have no Details, so when the headline
 *  is the generic one the raw text follows it, one line, rather than being lost. */
export const plainError = (e: unknown): string => {
  const p = explain(e);
  if (!p.details || !(GENERIC as readonly string[]).includes(p.plain)) return p.plain;
  const raw = p.details.replace(/\s+/g, " ").trim();
  return `${p.plain} (${raw.length > 200 ? `${raw.slice(0, 200)}…` : raw})`;
};

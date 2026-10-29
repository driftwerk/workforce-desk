// Moving one id within an ordered list, as the sidebar's lists are moved.

/** `ids` with `id` moved before `before` (last when null); null when that
 *  changes nothing. */
export const moved = (ids: readonly string[], id: string, before: string | null): string[] | null => {
  if (!ids.includes(id) || id === before) return null;
  const rest = ids.filter((x) => x !== id);
  const at = before === null ? rest.length : rest.indexOf(before);
  if (at < 0) return null;
  rest.splice(at, 0, id);
  return rest.join("\u0000") === ids.join("\u0000") ? null : rest;
};

/** `ids` with `id` swapped one place up or down; null at that end. */
export const nudged = (ids: readonly string[], id: string, by: -1 | 1): string[] | null => {
  const i = ids.indexOf(id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= ids.length) return null;
  const next = [...ids];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
};

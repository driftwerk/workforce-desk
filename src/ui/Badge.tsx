/** A count beside a row, read out as `says` ("2 need you", "3 unread"). */
export function Badge({ count, says }: { count: number; says: string }) {
  return (
    <span className="badge">
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">{says}</span>
    </span>
  );
}

/** How many things wait on the person, as every badge says it. */
export const needsYou = (count: number): string => `${count} ${count === 1 ? "needs" : "need"} you`;

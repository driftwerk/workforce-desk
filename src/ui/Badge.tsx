/** A count beside a row, read out as `says` ("2 need you", "3 unread");
 *  "99+" past 99. */
export function Badge({ count, says, tone }: { count: number; says: string; tone?: "needs" }) {
  return (
    <span className={tone ? `badge badge-${tone}` : "badge"} title={says}>
      <span aria-hidden="true">{count > 99 ? "99+" : count}</span>
      <span className="sr-only">{says}</span>
    </span>
  );
}

/** How many things wait on the person, as every badge says it. */
export const needsYou = (count: number): string => `${count} ${count === 1 ? "needs" : "need"} you`;

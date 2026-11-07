import { groupDot } from "./bosses";
import type { ItemKey } from "./model";
import { useLayout } from "./store";

/** The group's dot, in its colour. */
export function GroupDot({ id }: { id: string }) {
  return <span className="grp-dot" style={{ background: groupDot(id) }} aria-hidden="true" />;
}

/** "● Acme" beside a session's or an agent's name, for what sits in a group
 *  (nothing for Ungrouped). */
export function GroupChip({ item, className = "" }: { item: ItemKey; className?: string }) {
  const { groups } = useLayout();
  const group = groups.find((g) => g.items.includes(item));
  if (!group) return null;
  return (
    <span className={`chip chip-group ${className}`} title={`In ${group.name}`}>
      <GroupDot id={group.id} />
      {group.name}
    </span>
  );
}

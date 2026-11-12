import { UNGROUPED, type DeskGroup } from "../groups/model";

/** Which sidebar group a new session shows in: one chip per group, then
 *  Ungrouped. New session and a board's Start a session both use it. */
export function GroupChoice({ group, groups, onPick }: { group: string; groups: readonly Pick<DeskGroup, "id" | "name">[]; onPick: (id: string) => void }) {
  return (
    <div className="chip-row" role="radiogroup" aria-label="Group">
      {[...groups, { id: UNGROUPED, name: "Ungrouped" }].map((g) => (
        <button key={g.id} type="button" role="radio" className="chip-btn" aria-checked={group === g.id} aria-pressed={group === g.id} onClick={() => onPick(g.id)}>
          {g.name}
        </button>
      ))}
    </div>
  );
}

// Under the Floor's header, in sections: how many needs wait in each
// ("Needs you: Acme 2 · Globex 1 · Desk 2"), each a jump to its section. The
// header's count stays the total; each need is shown once, in its section.

import { sectionDomId, sectionName, type Section } from "./sections";

/** Takes the Floor to a section and its first need. */
const jumpTo = (id: string) => {
  const el = document.getElementById(sectionDomId(id));
  if (!el) return;
  el.scrollIntoView?.({ block: "start", behavior: "smooth" });
  el.querySelector<HTMLElement>('[role="list"]')?.focus({ preventScroll: true });
};

export function NeedsJump({ sections }: { sections: readonly Section[] }) {
  const needing = sections.filter((s) => s.needs.length > 0);
  if (needing.length === 0) return null;
  return (
    <nav className="needs-jump" aria-label="Needs you, by group">
      <span className="needs-jump-label">Needs you</span>
      {needing.map((s) => {
        const name = sectionName(s);
        return (
          <button key={s.id} type="button" className="needs-jump-to" aria-label={`${name}: ${s.needs.length} need${s.needs.length === 1 ? "s" : ""} you`} onClick={() => jumpTo(s.id)}>
            {name} <b>{s.needs.length}</b>
          </button>
        );
      })}
    </nav>
  );
}

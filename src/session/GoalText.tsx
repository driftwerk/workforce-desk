import { useLayoutEffect, useRef, useState } from "react";

/** A session's goal, at most two lines (the session keeps its height): a
 *  longer one says "more", and "less" again once open. All of it is in its
 *  tooltip; clicking it edits it, as before. */
export function GoalText({ goal, onEdit }: { goal: string; onEdit: () => void }) {
  const text = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  /** Whether two lines cut it short, measured while it's clamped. */
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = text.current;
    if (!el || open) return;
    const measure = () => setLong(el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
    measure();
    // Again as the panel's width changes it.
    if (typeof ResizeObserver === "undefined") return;
    const seen = new ResizeObserver(measure);
    seen.observe(el);
    return () => seen.disconnect();
  }, [goal, open]);
  if (!goal) {
    return (
      <button type="button" className="goal-text" onClick={onEdit}>
        <span className="faint">Add a goal so you know what this one is for</span>
      </button>
    );
  }
  return (
    <span className="goal-wrap">
      <button type="button" className={`goal-text ${open ? "goal-open" : "goal-clamped"}`} title={goal} onClick={onEdit}>
        <span ref={text}>{goal}</span>
      </button>
      {(long || open) && (
        <button type="button" className="link small goal-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "less" : "more"}
        </button>
      )}
    </span>
  );
}

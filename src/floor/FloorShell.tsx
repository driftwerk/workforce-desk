import type { ReactNode, Ref } from "react";

/** The Floor's own page (a `main`), or, given the heading of the section
 *  it shows in (the Dashboard's), a part of that page. */
export function FloorShell({ heading, className, children, scroller }: { heading: ReactNode | undefined; className: string; children: ReactNode; scroller?: Ref<HTMLElement> }) {
  return heading ? (
    <div ref={scroller as Ref<HTMLDivElement>} className={`${className} floor-in`}>
      {children}
    </div>
  ) : (
    <main ref={scroller} className={className} aria-label="Floor">
      {children}
    </main>
  );
}

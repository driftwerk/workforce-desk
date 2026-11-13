import { createContext, useContext, type ReactNode, type Ref } from "react";

/** The level of the Floor's own headings (its cards', groups', Activity's):
 *  h2 on its own page, h3 under a Dashboard section's h2. */
const SubHeading = createContext<"h2" | "h3">("h2");
export const useSubHeading = (): "h2" | "h3" => useContext(SubHeading);

/** The Floor's own page (a `main`), or, given the heading of the section
 *  it shows in (the Dashboard's), a part of that page. */
export function FloorShell({ heading, className, children, scroller }: { heading: ReactNode | undefined; className: string; children: ReactNode; scroller?: Ref<HTMLElement> }) {
  return heading ? (
    <div ref={scroller as Ref<HTMLDivElement>} className={`${className} floor-in`}>
      <SubHeading.Provider value="h3">{children}</SubHeading.Provider>
    </div>
  ) : (
    <main ref={scroller} className={className} aria-label="Floor">
      {children}
    </main>
  );
}

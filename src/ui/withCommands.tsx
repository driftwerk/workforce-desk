import type { ReactNode } from "react";

/** `text` with each `command` in it drawn as code: plain words may name a
 *  command to run by hand that way (Devin's sign-in, from its hub). Text
 *  with no pair of backticks comes back as it is. */
export const withCommands = (text: string): ReactNode[] =>
  text.split(/`([^`]+)`/).map((part, i) =>
    i % 2 ? (
      <code key={i} className="mono">
        {part}
      </code>
    ) : (
      part
    ),
  );

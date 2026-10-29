import type { Look } from "../floor/background";
import { markFor } from "../theme/tokens";

const RING: Partial<Record<Look, string>> = {
  working: "ring-working",
  starting: "ring-working",
  background: "ring-background",
  blocked: "ring-blocked",
  done: "ring-done",
};

export const initialsFor = (name: string, engine?: string): string =>
  engine === "claude" ? "cc" : engine === "codex" ? "cx" : (name[0] ?? "?").toUpperCase();

export function Mark({
  name,
  engine,
  state,
  size = "md",
}: {
  name: string;
  engine?: string;
  state?: Look;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <span className={`mark mark-${size} ${state ? (RING[state] ?? "") : ""}`}>
      <span className="mark-face" style={{ background: engine ? "#E8DDB5" : markFor(name) }}>
        {initialsFor(name, engine)}
      </span>
    </span>
  );
}

/** The count a hub's heartbeat adds to a tool's line while it runs. */
const HEARTBEAT = / · \d+s$/;

/** A tool's name, from the line a turn shows it by: a live turn's is the
 *  hub's `connections.setup: Set up GitHub for …`, its heartbeat adds
 *  ` · 12s`, and a kept turn's is the bare name. */
export const toolNameOf = (line: string): string => (line.split(": ")[0] ?? line).replace(HEARTBEAT, "").trim();

/** Whether `line` is the same call of a tool as `before`, only said again
 *  by the hub's heartbeat. */
export const sameCall = (before: string, line: string): boolean => before.replace(HEARTBEAT, "") === line.replace(HEARTBEAT, "");

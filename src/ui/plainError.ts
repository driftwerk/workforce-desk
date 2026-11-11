import { explain } from "./problem";

/** An error as the person should read it: never a route, a status code or
 *  the hub's internals. */
export const plainError = (e: unknown): string => explain(e).plain;

import type { Engine, SessionMemory } from "../hub/types";
import { ENGINE_TITLE } from "../engines/engines";
import { Confirm } from "../ui/Confirm";
import { count, noteCount } from "./words";

/** What the dialog says of how long search may still find it: Desk
 *  Memory's search index keeps what it deletes for up to a day (§13 D5). */
export const RESTORE_WINDOW = "Desk Memory's search may keep a copy for up to 24 hours before it's gone for good.";

/** "Forget what Desk remembers of …?": its exact counts, that its cost
 *  history stays, that it's never remembered again, and the restore window. */
export function ForgetMemory({
  name,
  memory,
  engine,
  onForget,
  onClose,
}: {
  name: string;
  memory: SessionMemory;
  engine: Engine;
  onForget: () => Promise<void>;
  onClose: () => void;
}) {
  const notes = noteCount(memory.notes);
  const what = [count(memory.counts.exchanges, "exchange"), notes > 0 ? count(notes, "note") : null].filter(Boolean).join(" and ");
  return (
    <Confirm title={`Forget what Desk remembers of “${name}”?`} action="Forget" onConfirm={onForget} onClose={onClose}>
      <p>This removes its {what} from Desk.</p>
      <p className="muted">Its cost history stays (numbers only). Desk won't remember this conversation again, and {ENGINE_TITLE[engine]}'s own record of it isn't touched.</p>
      <p className="muted">{RESTORE_WINDOW}</p>
    </Confirm>
  );
}

import type { Look } from "../floor/background";
import { AgentMark, YouMark, type MarkSize } from "../ui/Mark";

/** The one way rooms draw a member, or you: an agent's picture, or yours. */
export function MemberMark({ member, name, size, state }: { member: string; name: string; size?: MarkSize; state?: Look }) {
  return member === "you" ? <YouMark hub={null} size={size} /> : <AgentMark agent={member} name={name} size={size} state={state} />;
}

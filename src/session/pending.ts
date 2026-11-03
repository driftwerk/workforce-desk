import type { PendingApproval } from "../hub/types";

/** What a request only its terminal answers asks: a question in its own
 *  words, a plan to approve, else the tool and what it would act on. */
export const terminalAsk = (p: Pick<PendingApproval, "tool" | "detail" | "why">): string => {
  if (p.tool === "Question") return p.why ? `${p.detail} ${p.why}` : p.detail;
  if (p.tool === "Plan") return p.detail ? `Approve the plan · ${p.detail}` : "Approve the plan";
  return p.detail ? `${p.tool} · ${p.detail}` : p.tool;
};

/** Whether it is something the engine asks the person, not a tool to allow. */
export const isQuestion = (p: Pick<PendingApproval, "tool">): boolean => p.tool === "Question" || p.tool === "Plan";

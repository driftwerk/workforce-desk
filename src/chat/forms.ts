/** What a form you filled in says back to the agent that asked: its own
 *  summary of your answer, then the values as JSON. */
export const formAnswer = (summary: string, values: Record<string, unknown>): string =>
  `${summary}\n\n\`\`\`json\n${JSON.stringify(values, null, 2)}\n\`\`\``;

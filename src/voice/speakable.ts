/** Said instead of anything that only works on screen: code, tables, the
 *  rest of a long answer. */
export const DETAILS_IN_DESK = "I've put the details in Desk.";

const MAX_CHARS = 600;
const SHORT_CODE = 30;

const endSentence = (s: string): string => (/[.!?:;]$/.test(s) ? s : `${s}.`);

/** Cuts at the last sentence end that fits. */
const trimToSentence = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const end = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  return end > 0 ? head.slice(0, end + 1) : `${head.slice(0, head.lastIndexOf(" "))}…`;
};

/** Markdown as something worth hearing: formatting dropped, links read as
 *  their text, code and tables left on screen. */
export const speakable = (markdown: string, maxChars = MAX_CHARS): string => {
  let elsewhere = false;
  let text = markdown.replace(/\r\n?/g, "\n");
  text = text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?(^\1[^\n]*$|(?![\s\S]))/gm, () => {
    elsewhere = true;
    return "\n";
  });
  text = text.replace(/^\s*\|.*\|\s*$/gm, () => {
    elsewhere = true;
    return "";
  });
  text = text.replace(/`([^`\n]+)`/g, (_, code: string) => {
    if (code.length <= SHORT_CODE) return code;
    elsewhere = true;
    return "";
  });
  text = text
    .replace(/<[^>\n]+>/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\bhttps?:\/\/\S+/g, "a link")
    .replace(/^\s{0,3}([-*_])(\s*\1){2,}\s*$/gm, "")
    .replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*$/gm, (_, h: string) => endSentence(h))
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(.+)$/gm, (_, item: string) => endSentence(item.trim()))
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?![\w*])/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\p{Extended_Pictographic}️?/gu, "");
  const lines = text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);
  let spoken = lines.map((p, i) => (i < lines.length - 1 ? endSentence(p) : p)).join(" ").replace(/\s+/g, " ").trim();
  if (spoken.length > maxChars) {
    spoken = trimToSentence(spoken, maxChars);
    elsewhere = true;
  }
  if (!elsewhere) return spoken;
  return spoken ? `${endSentence(spoken)} ${DETAILS_IN_DESK}` : DETAILS_IN_DESK;
};

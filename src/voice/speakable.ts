/** Said when a turn fails: the error itself is on screen. */
export const ERROR_IN_CHAT = "The error is in the chat.";

/** What only works on screen: left there, and said so. */
type Skipped = "code" | "table" | "list";

const SKIPPED_NOTICE: Record<Skipped, string> = {
  code: "The code is in the chat.",
  table: "The table is in the chat.",
  list: "The full list is in the chat.",
};
const SEVERAL_NOTICE = "The rest is in the chat.";

/** The reply already says where it is, in its own words. */
const SAYS_WHERE = /\b(?:in|on)\s+(?:the\s+|your\s+)?(?:chat|screen|desk)\b/i;

const SHORT_CODE = 30;
/** A list longer than this is for reading, not for hearing. */
const LONG_LIST = 8;

const endSentence = (s: string): string => (/[.!?:;]$/.test(s) ? s : `${s}.`);

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\S/;

/** `lines` with each long list taken out, and whether there were any. */
const withoutLongLists = (text: string): { text: string; found: boolean } => {
  const lines = text.split("\n");
  const kept: string[] = [];
  let found = false;
  for (let i = 0; i < lines.length; ) {
    if (!LIST_ITEM.test(lines[i]!)) {
      kept.push(lines[i++]!);
      continue;
    }
    // A run of items, with what's indented under them and blank lines between.
    const start = i;
    let items = 0;
    let end = i;
    for (; i < lines.length; i++) {
      const line = lines[i]!;
      if (LIST_ITEM.test(line)) {
        items++;
        end = i + 1;
      } else if (/^\s+\S/.test(line)) {
        end = i + 1;
      } else if (line.trim() !== "") {
        break;
      }
    }
    i = end;
    if (items > LONG_LIST) found = true;
    else kept.push(...lines.slice(start, end));
  }
  return { text: kept.join("\n"), found };
};

/** Markdown as something to hear, all of it: formatting dropped, links read
 *  as their text. Only what doesn't work aloud stays on screen: code, tables
 *  and long lists, which it says, once, unless the reply already has.
 *  Voice directions (`(excited)`, `[whispering]`) pass through for the voice. */
export const speakable = (markdown: string): string => {
  const skipped = new Set<Skipped>();
  let text = markdown.replace(/\r\n?/g, "\n");
  text = text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?(^\1[^\n]*$|(?![\s\S]))/gm, () => {
    skipped.add("code");
    return "\n";
  });
  text = text.replace(/^\s*\|.*\|\s*$/gm, () => {
    skipped.add("table");
    return "";
  });
  const lists = withoutLongLists(text);
  text = lists.text;
  if (lists.found) skipped.add("list");
  text = text.replace(/`([^`\n]+)`/g, (_, code: string) => {
    if (code.length <= SHORT_CODE) return code;
    skipped.add("code");
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
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);
  const spoken = paragraphs
    .map((p, i) => (i < paragraphs.length - 1 ? endSentence(p) : p))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!skipped.size || SAYS_WHERE.test(spoken)) return spoken;
  const notice = skipped.size > 1 ? SEVERAL_NOTICE : SKIPPED_NOTICE[[...skipped][0]!];
  return spoken ? `${endSentence(spoken)} ${notice}` : notice;
};

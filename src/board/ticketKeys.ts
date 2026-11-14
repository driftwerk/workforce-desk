import { ticketLink } from "../shell/links";

// Ticket keys in a comment's text ("PLT-2554") become links to the ticket
// they name when it's on the same board here, so the comment draws each as a
// chip with its state. Keys in code, in links already, and in addresses are
// left as written.

/** A key: a project's letters, a dash, a number; not inside a word, an
 *  address or a longer key. */
const KEY = /(?<![\w/#.-])([A-Z][A-Z0-9]{1,9}-\d{1,7})(?![\w-])/g;

/** What on a line is never rewritten: code spans, links and images, autolinks
 *  and bare addresses. */
const KEEP = /(`+)[\s\S]*?\1|!?\[[^\]\n]*\]\([^)\n]*\)|!?\[[^\]\n]*\]\[[^\]\n]*\]|<[^>\s]+>|\b(?:https?|desk):\/\/[^\s<>"']+/gi;

/** A fence's opening line: three or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

const linkKeys = (text: string, idOf: (key: string) => string | undefined): string =>
  text.replace(KEY, (key) => {
    const id = idOf(key);
    return id ? `[${key}](${ticketLink(id)})` : key;
  });

/** `md` with each key that `idOf` knows made a link to its ticket. */
export const linkTicketKeys = (md: string, idOf: (key: string) => string | undefined): string => {
  let fence: string | null = null;
  return md
    .split("\n")
    .map((line) => {
      const open = FENCE.exec(line)?.[1];
      if (fence) {
        if (open && open[0] === fence[0] && open.length >= fence.length && line.trim() === open) fence = null;
        return line;
      }
      if (open) {
        fence = open;
        return line;
      }
      // Indented code: four spaces or a tab in, and not a list's own line.
      if (/^( {4}|\t)/.test(line) && !/^\s*([-*+]|\d+[.)])\s/.test(line)) return line;
      let out = "";
      let at = 0;
      for (const m of line.matchAll(KEEP)) {
        out += linkKeys(line.slice(at, m.index), idOf) + m[0];
        at = m.index! + m[0].length;
      }
      return out + linkKeys(line.slice(at), idOf);
    })
    .join("\n");
};

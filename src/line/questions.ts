import type { LineMessage } from "../hub/types";
import { dayClock } from "../floor/time";
import { waitsOnYou } from "./rows";

/** What on a session's line is still open: the questions it asked you,
 *  waiting on you or gone ahead without an answer, and messages to it that
 *  haven't gone in. Answered, dismissed, delivered, withdrawn and noted
 *  ones are history, and never keep its panel up. */
export interface Open {
  questions: LineMessage[];
  waiting: LineMessage[];
}

/** Whether `m` is a question to you still open: waiting on you, or one the
 *  session went ahead without (you can still dismiss it). */
export const openQuestion = (m: LineMessage): boolean => waitsOnYou(m) || (m.kind === "ask" && m.asked === "lapsed");

export const openOf = (thread: readonly LineMessage[], sessionId: string): Open => ({
  questions: thread.filter((m) => m.from.kind === "session" && m.from.id === sessionId && openQuestion(m)),
  waiting: thread.filter(
    (m) => m.to.kind === "session" && m.to.id === sessionId && (m.delivery === "queued" || m.delivery === "held" || m.delivery === "handed"),
  ),
});

export const anyOpen = (o: Open): boolean => o.questions.length > 0 || o.waiting.length > 0;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** A question's one line, as its card heads it: the hub's headline, or (from
 *  an older hub) all it said. */
export const headlineOf = (m: LineMessage): string => m.question?.headline ?? m.text;

/** What it said beyond its one line, when it said more. */
export const detailsOf = (m: LineMessage): string | null => (m.question ? (m.question.details ?? null) : (m.details ?? null)) || null;

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Where a question stands, in a few words: paused on you, or gone ahead
 *  (with its default, or without an answer). */
const whereOf = (m: LineMessage): string =>
  waitsOnYou(m) ? "waiting on you" : m.chose ? "went ahead" : "went ahead without an answer";

/** The slim bar's words: one question's work item, headline and where it
 *  stands; for more, how many and where they stand; else what waits to go
 *  in. */
export const barText = (o: Open): string => {
  const q = o.questions.length;
  if (q === 1) {
    const m = o.questions[0]!;
    return [m.about, oneLine(headlineOf(m)), whereOf(m)].filter(Boolean).join(" · ");
  }
  if (q > 0) {
    const onYou = o.questions.some(waitsOnYou);
    const where = onYou ? "waiting on you" : o.questions.some((m) => m.chose) ? "went ahead with its defaults" : "went ahead without an answer";
    return `It asked you ${plural(q, "question")} · ${where}`;
  }
  return `${plural(o.waiting.length, "message")} waiting to go in`;
};

/** Where one question stands, and when it asked, as its card heads it
 *  after its work item ("W7 · PR 2 · went ahead · 07:19"). Capitalised when
 *  it comes first. */
export const statusOf = (m: LineMessage, now = Date.now()): string => {
  const words = waitsOnYou(m) ? "paused until you answer" : whereOf(m);
  const said = `${words} · ${dayClock(m.at, now)}`;
  return m.about ? said : said[0]!.toUpperCase() + said.slice(1);
};

/** The questions, all of each (its work item, question, why, what it chose
 *  and details), as the person takes them up in its terminal (Discuss in
 *  terminal) or copies them (Copy all): nothing it said is left out. Plain
 *  text with line breaks only: no carriage return, so put in its prompt it
 *  sends nothing until the person does. */
export const discussText = (questions: readonly LineMessage[]): string => {
  const lines = questions.flatMap((m) => {
    const about = m.about ? `${oneLine(m.about)}: ` : "";
    const where = waitsOnYou(m) ? "You're still waiting on my answer." : m.chose ? `You went ahead with: ${oneLine(m.chose)}` : "You went ahead without my answer.";
    const out = [`- ${about}“${oneLine(headlineOf(m))}” ${where}`];
    if (m.why) out.push(`  Why: ${oneLine(m.why)}`);
    const details = detailsOf(m);
    if (details) {
      out.push("  Details:");
      for (const line of details.replace(/\r\n?/g, "\n").trimEnd().split("\n")) out.push(line.trim() ? `    ${line.trimEnd()}` : "");
    }
    return out;
  });
  const head = questions.length === 1 ? "About the question you asked me on Desk:" : "About the questions you asked me on Desk:";
  return `${head}\n${lines.join("\n")}\n`;
};

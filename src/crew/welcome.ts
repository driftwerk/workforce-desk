import type { DeskHub } from "../hub/client";

/** What the hub writes into a new agent's WELCOME.md. */
const HUB_WELCOME =
  "Read your IDENTITY.md and SOUL.md to know who you are.\n" +
  "If the memory/ directory has any files, briefly mention what's in progress.\n" +
  "If memory/ is empty, just introduce yourself based on your identity.\n" +
  "Keep it to 2-3 sentences. Don't mention or apologise about empty files.\n";

/** The WELCOME.md agents on this Mac start with: a greeting that fits how
 *  long it's been since you last spoke. */
export const DESK_WELCOME = `# WELCOME.md — Dynamic Session Start Greeting

## Time-Based Greeting Rules

Always check the current date and time first and compute the time since the last interaction.

Trust what daily notes and the timeline say when deciding.

**Just finished talking** (same session or voice chat within ~5 minutes):
- Vary the greeting: "hey, back for more!", "what's next?", "alright, what's on your mind?", "you got it", "ready when you are"
- No recap, no tasks list — we're in the middle of a flow
- Casual, immediate continuation

**Couple of hours gap** (~2-6 hours since last interaction):
- Vary the transition: "back at it", "hey, picking up where we left off", "alright, let's continue"
- Brief recap of last topic (1-2 sentences)
- Any blockers or next steps worth noting
- Still casual, but with context bridge

**1-2 days gap** (significant but not major):
- Time-of-day greeting with variation: "good morning — been a bit", "afternoon — let me catch you up", "hey — been a couple days"
- Substantial recap of last conversation
- Outstanding tasks or decisions

**Longer break** (more than a couple of days):
- Time-of-day greeting with variation: "morning — been a while", "hey — good to see you back", "alright, it's been a few"
- Recap since we last spoke
- Check if priorities have shifted
- More substantial reconnection

## Time-of-Day Greetings

Use the person's local time. Vary these naturally — don't repeat the exact same phrase:
- 05:00–11:59: "good morning", "morning", "up early", "nice day for it"
- 12:00–17:59: "good afternoon", "afternoon", "hey there", "what's up"
- 18:00–04:59: "good evening", "evening", "hey", "what's going on"

## Implementation Notes

Use \`memory timeline\` with date ranges to find last interaction context.
Use \`notes read_daily\` for recent session notes.
Use \`notes list_all_tasks\` for outstanding work (only for 1+ day gaps).

The greeting should feel natural and human — not a status report.
`;

const GREETING = /^Greet them as [^\n]*\n?/;

/** Whether `welcome` is still what the hub wrote, apart from the greeting
 *  line Desk puts first; an empty file counts too. */
export const isHubWelcome = (welcome: string): boolean => {
  const body = welcome.replace(GREETING, "").trim();
  return body === "" || body === HUB_WELCOME.trim();
};

/** `welcome` with Desk's in place of the hub's, keeping Desk's greeting
 *  line; one the person has written stays as it is. */
export const withDeskWelcome = (welcome: string): string =>
  isHubWelcome(welcome) ? `${welcome.match(GREETING)?.[0] ?? ""}${DESK_WELCOME}` : welcome;

/** Gives each of `ids` Desk's WELCOME.md where theirs is still the hub's. */
export async function adoptDeskWelcome(hub: DeskHub, ids: readonly string[]): Promise<void> {
  await Promise.allSettled(
    ids.map(async (id) => {
      const welcome = await hub.identityFile(id, "WELCOME.md");
      const next = withDeskWelcome(welcome);
      if (next !== welcome) await hub.saveIdentityFile(id, "WELCOME.md", next);
    }),
  );
}

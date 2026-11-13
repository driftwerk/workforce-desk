import { SETTINGS_SECTIONS, type SettingsSection } from "../shell/ui";

/** What each section has in it, in the words people search with. */
const WORDS: Record<SettingsSection, string> = {
  profile: "name picture photo you me",
  appearance: "theme dark light night day colours colors font size",
  chat: "messages emoji emoticons pictures images replies",
  hubs: "workspace workspaces pair pairing team hub sign in again",
  computer: "this computer helper login items permissions access folders",
  browser: "browser chrome web pages",
  machines: "machine machines server devbox ssh build box remote",
  providers: "plan plans claude chatgpt api key keys model models brain sign in openai anthropic bedrock",
  connections: "github jira linear slack google notion services connect integrations tokens",
  engines: "claude code codex gemini cursor engines cli install sign in accounts",
  sessions: "sessions terminals worktrees",
  memory: "memory remember notes recall",
  budgets: "budget spend money cost limit",
  voices: "voice voices speech tts calls talk microphone push to talk wake tuple elevenlabs fish",
  shortcuts: "keys keyboard shortcuts hotkeys",
  help: "help setup set up report logs agent",
};

/** The sections that match `query`: by their name first, then by what's in them. */
export const searchSections = (query: string): SettingsSection[] => {
  const q = query.trim().toLowerCase();
  const all = Object.keys(SETTINGS_SECTIONS) as SettingsSection[];
  if (!q) return all;
  const words = q.split(/\s+/);
  const named = all.filter((s) => SETTINGS_SECTIONS[s].toLowerCase().includes(q));
  const within = all.filter((s) => !named.includes(s) && words.every((w) => `${SETTINGS_SECTIONS[s]} ${WORDS[s]}`.toLowerCase().includes(w)));
  return [...named, ...within];
};

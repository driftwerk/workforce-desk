import { RichMarkdown } from "@workforce/rich";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatMessage } from "../chat/types";
import { Message } from "../rooms/Message";

// The real renderer, not the stand-in other tests use: emoji built from
// several code points come through it whole.
const SEQUENCES = ["👨‍👩‍👧‍👦", "👩🏽‍💻", "🏳️‍🌈", "👍🏿", "❤️", "🧑🏻‍🤝‍🧑🏿", "🇬🇧", "1️⃣"];

afterEach(cleanup);

describe("emoji in messages", () => {
  it("an agent's markdown keeps ZWJ sequences, skin tones, flags and keycaps", () => {
    const text = `**Team** ${SEQUENCES.join(" ")}\n\n- item ${SEQUENCES[1]}\n\n| a | b |\n|---|---|\n| ${SEQUENCES[0]} | ${SEQUENCES[2]} |\n\n_${SEQUENCES[3]}_ and \`code ${SEQUENCES[4]}\``;
    const { container } = render(<RichMarkdown text={text} />);
    const shown = container.textContent ?? "";
    for (const s of SEQUENCES) expect(shown, s).toContain(s);
    expect(shown).not.toContain("�");
  });

  it("what you typed is shown as typed", () => {
    const message: ChatMessage = { id: "m1", role: "user", content: `hi ${SEQUENCES.join("")}`, at: "", status: "complete", tools: [] };
    const { container } = render(<Message message={message} author="Atlas" onSubmitForm={() => true} />);
    expect(container.querySelector(".msg-text")?.textContent).toBe(`hi ${SEQUENCES.join("")}`);
  });
});

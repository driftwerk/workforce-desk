import { RichMarkdown } from "@workforce/rich";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../chat/types";
import { Message } from "../rooms/Message";
import { DeskRichHost } from "./richHost";

const openLink = vi.hoisted(() => vi.fn());
vi.mock("./links", async (real) => ({ ...(await real<typeof import("./links")>()), openLink }));

const IMAGE = "![the chart](https://images.example/chart.png)";

afterEach(() => {
  cleanup();
  openLink.mockClear();
});

// The real renderer: a remote image must reach the page as a link, never as an
// <img> the CSP then blocks.
describe("remote images in agent markdown", () => {
  it("a message shows one as a link, and fetches nothing", () => {
    const message: ChatMessage = { id: "m1", role: "assistant", content: IMAGE, at: "", status: "complete", tools: [] };
    const { container } = render(<Message message={message} author="Atlas" onSubmitForm={() => true} />);
    expect(container.querySelector("img")).toBeNull();
    const link = container.querySelector("a.wf-remote-image");
    expect(link?.textContent).toContain("the chart");
    fireEvent.click(link!);
    expect(openLink).toHaveBeenCalledWith("https://images.example/chart.png");
  });

  it("markdown with no host of its own follows the same rule under the root's", () => {
    const { container } = render(
      <DeskRichHost>
        <RichMarkdown text={IMAGE} />
      </DeskRichHost>,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a.wf-remote-image")).not.toBeNull();
  });

  it("an image of Desk's own is still drawn", () => {
    const { container } = render(
      <DeskRichHost>
        <RichMarkdown text="![a file](deskfile://localhost/a.png)" />
      </DeskRichHost>,
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe("deskfile://localhost/a.png");
  });
});

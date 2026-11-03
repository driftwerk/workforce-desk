import { RichMarkdown } from "@workforce/rich";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../chat/types";
import { Message } from "../rooms/Message";
import { DeskRichHost } from "./richHost";
import { forgetRemoteImages } from "./RemoteImage";

const invoke = vi.hoisted(() => vi.fn((_cmd: string, _args?: unknown) => Promise.resolve()));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const IMAGE = "![the chart](https://images.example/chart.png)";

afterEach(() => {
  cleanup();
  invoke.mockClear();
  forgetRemoteImages();
});

// The real renderer: a remote image must reach the page as Desk's placeholder,
// never as an <img> the page would fetch.
describe("remote images in agent markdown", () => {
  it("a message shows one as a placeholder, and fetches nothing", () => {
    const message: ChatMessage = { id: "m1", role: "assistant", content: IMAGE, at: "", status: "complete", tools: [] };
    const { container } = render(<Message message={message} author="Atlas" onSubmitForm={() => true} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("group", { name: "Picture from images.example: the chart" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Show image" })).not.toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("remote_image_fetch", expect.anything());
  });

  it("markdown with no host of its own follows the same rule under the root's", () => {
    const { container } = render(
      <DeskRichHost>
        <RichMarkdown text={IMAGE} />
      </DeskRichHost>,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".rimg")).not.toBeNull();
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

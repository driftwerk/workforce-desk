import { RichMarkdown } from "@workforce/rich";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../settings/Chat";
import { useSettings } from "../settings/store";
import { AUTO_PER_MESSAGE, forgetRemoteImages, ImageBudget, KEPT } from "./RemoteImage";
import { DeskRichHost } from "./richHost";

/** Desk's side: what `remote_image_fetch` does next, set per test. */
let fetchImage: (url: string, sameSite?: boolean) => Promise<ArrayBuffer>;
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const openLink = vi.hoisted(() => vi.fn());
vi.mock("./links", async (real) => ({ ...(await real<typeof import("./links")>()), openLink }));

/** The bytes as Desk frames them. */
const framed = (mime: string, body: Uint8Array): ArrayBuffer => {
  const head = new TextEncoder().encode(JSON.stringify({ mime }));
  const out = new Uint8Array(4 + head.length + body.length);
  new DataView(out.buffer).setUint32(0, head.length);
  out.set(head, 4);
  out.set(body, 4 + head.length);
  return out.buffer;
};
const PNG = framed("image/png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

const URL_ = "https://images.example/chart.png";
const show = (text = `Look: ![The burndown chart](${URL_})`) =>
  render(
    <DeskRichHost>
      <RichMarkdown text={text} />
    </DeskRichHost>,
  );
const fetched = () => invoke.mock.calls.filter(([cmd]) => cmd === "remote_image_fetch");
const button = (name: string | RegExp) => screen.getByRole("button", { name });

beforeEach(() => {
  invoke.mockImplementation((cmd: string, args?: { url: string; sameSite: boolean }) =>
    cmd === "remote_image_fetch" ? fetchImage(args!.url, args!.sameSite) : Promise.resolve(),
  );
  fetchImage = () => Promise.resolve(PNG);
  URL.createObjectURL = vi.fn(() => "blob:desk/picture-1");
  URL.revokeObjectURL = vi.fn();
  useSettings.setState({ loaded: true, imageSites: [] });
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
  openLink.mockClear();
  forgetRemoteImages();
});

describe("a remote picture in agent markdown", () => {
  it("waits as a placeholder with its caption, site and what showing it tells the site, fetching nothing", () => {
    const { container } = show();
    const card = screen.getByRole("group", { name: "Picture from images.example: The burndown chart" });
    expect(card.textContent).toContain("The burndown chart");
    expect(card.textContent).toContain("images.example");
    expect(card.textContent).toContain("Showing it tells images.example your IP address.");
    expect(button("Show image")).not.toBeNull();
    expect(button("Always show from this site")).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(fetched()).toHaveLength(0);
    // Inside a paragraph, so spans and buttons only.
    expect(card.closest("p")).not.toBeNull();
    expect(card.querySelector("div, p, ul")).toBeNull();
  });

  it("says when it has no caption", () => {
    show(`![](${URL_})`);
    expect(screen.getByRole("group", { name: "Picture from images.example: A picture" })).not.toBeNull();
  });

  it("is fetched by Desk on Show image, loading meanwhile, then shown from a blob: URL", async () => {
    let arrive!: (b: ArrayBuffer) => void;
    fetchImage = () => new Promise((r) => (arrive = r));
    const { container } = show();
    fireEvent.click(button("Show image"));
    expect(fetched()).toEqual([["remote_image_fetch", { url: URL_, sameSite: false }]]);
    const loading = button("Showing…") as HTMLButtonElement;
    expect(loading.disabled).toBe(true);
    expect(screen.getByRole("group").getAttribute("aria-busy")).toBe("true");
    await act(async () => arrive(PNG));
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("blob:desk/picture-1");
    expect(img.getAttribute("alt")).toBe("The burndown chart");
    expect(vi.mocked(URL.createObjectURL).mock.lastCall![0]).toMatchObject({ type: "image/png", size: 4 });
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("stays shown when the reply renders again, without fetching again", async () => {
    const { container, rerender } = show();
    await act(async () => fireEvent.click(button("Show image")));
    rerender(
      <DeskRichHost>
        <RichMarkdown text={`Look again: ![The burndown chart](${URL_}) and more`} />
      </DeskRichHost>,
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:desk/picture-1");
    expect(fetched()).toHaveLength(1);
  });

  it("says plainly why it failed, and can be tried again", async () => {
    fetchImage = () => Promise.reject({ kind: "failed", reason: "The site answered 404." });
    show();
    await act(async () => fireEvent.click(button("Show image")));
    expect(screen.getByRole("alert").textContent).toBe("Couldn't show it. The site answered 404.");
    fetchImage = () => Promise.resolve(PNG);
    await act(async () => fireEvent.click(button("Try again")));
    expect(fetched()).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says why Desk refused it (a private address, or not a picture), with nothing to retry", async () => {
    for (const reason of [
      "It's on this computer or a private network, so Desk won't fetch it.",
      "It isn't a PNG, JPEG, GIF, WebP or AVIF picture.",
    ]) {
      fetchImage = () => Promise.reject({ kind: "refused", reason });
      const { container, unmount } = show();
      await act(async () => fireEvent.click(button("Show image")));
      expect(screen.getByRole("alert").textContent).toBe(`Desk won't show it. ${reason}`);
      expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Open in browser"]);
      expect(container.querySelector("img")).toBeNull();
      unmount();
      forgetRemoteImages();
    }
  });

  it("never draws bytes of a type Desk doesn't send", async () => {
    fetchImage = () => Promise.resolve(framed("image/svg+xml", new TextEncoder().encode("<svg/>")));
    const { container } = show();
    await act(async () => fireEvent.click(button("Show image")));
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("isn't a PNG");
  });

  it("an unexpected error is a plain failure", async () => {
    fetchImage = () => Promise.reject("boom");
    show();
    await act(async () => fireEvent.click(button("Show image")));
    expect(screen.getByRole("alert").textContent).toBe("Couldn't show it. The picture didn't arrive.");
  });
});

describe("opening a picture in the browser, as its link did before", () => {
  it("is offered while waiting, failed, refused and shown", async () => {
    show(`![a](http://plain.example/a.png)`);
    fireEvent.click(button("Open in browser"));
    expect(openLink).toHaveBeenCalledWith("http://plain.example/a.png");
    cleanup();
    for (const kind of ["failed", "refused"]) {
      fetchImage = () => Promise.reject({ kind, reason: "No." });
      const { unmount } = show();
      await act(async () => fireEvent.click(button("Show image")));
      expect(button("Open in browser")).not.toBeNull();
      unmount();
      forgetRemoteImages();
    }
    fetchImage = () => Promise.resolve(PNG);
    show();
    await act(async () => fireEvent.click(button("Show image")));
    fireEvent.click(button("Open in browser"));
    expect(openLink).toHaveBeenLastCalledWith(URL_);
  });
});

describe("memory", () => {
  it(`keeps at most ${KEPT} pictures, revoking the oldest once nothing draws it`, async () => {
    let n = 0;
    vi.mocked(URL.createObjectURL).mockImplementation(() => `blob:desk/${n++}`);
    const { unmount } = show(`![first](https://images.example/0.png)`);
    await act(async () => fireEvent.click(button("Show image")));
    const { fetchRemoteImage } = await import("./RemoteImage");
    for (let i = 1; i <= KEPT; i++) await fetchRemoteImage(`https://images.example/${i}.png`);
    // The first is evicted, but still drawn: not revoked yet.
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:desk/0");
    // One more evicts the second, which nothing draws: revoked at once.
    await fetchRemoteImage(`https://images.example/${KEPT + 1}.png`);
    expect(URL.revokeObjectURL).toHaveBeenLastCalledWith("blob:desk/1");
  });

  it(`shows at most ${AUTO_PER_MESSAGE} of a message's pictures without a click`, async () => {
    useSettings.setState({ imageSites: ["images.example"] });
    const text = Array.from({ length: 13 }, (_, i) => `![p${i}](https://images.example/${i}.png)`).join(" ");
    await act(async () => {
      render(
        <DeskRichHost>
          <ImageBudget>
            <RichMarkdown text={text} />
          </ImageBudget>
        </DeskRichHost>,
      );
    });
    expect(fetched()).toHaveLength(AUTO_PER_MESSAGE);
    expect(screen.getAllByRole("button", { name: "Show image" })).toHaveLength(3);
  });
});

describe("always showing a site's pictures", () => {
  it("falls back to the placeholder when the picture moves off its site", async () => {
    useSettings.setState({ imageSites: ["images.example"] });
    fetchImage = (_url, sameSite) =>
      sameSite ? Promise.reject({ kind: "moved", reason: "It moved." }) : Promise.resolve(PNG);
    const { container } = show();
    await act(async () => undefined);
    expect(fetched()).toEqual([["remote_image_fetch", { url: URL_, sameSite: true }]]);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    // A click follows it.
    await act(async () => fireEvent.click(button("Show image")));
    expect(fetched()[1]).toEqual(["remote_image_fetch", { url: URL_, sameSite: false }]);
    expect(container.querySelector("img")).not.toBeNull();
  });

  it("is kept with its port when that isn't https's own, and a site's other ports aren't covered", async () => {
    useSettings.setState({ imageSites: ["images.example"] });
    await act(async () => {
      show(`![a](https://images.example:8443/a.png)`);
    });
    expect(fetched()).toHaveLength(0);
    await act(async () => fireEvent.click(button("Always show from this site")));
    expect(useSettings.getState().imageSites).toEqual(["images.example", "images.example:8443"]);
  });

  it("is chosen under a picture, which then shows, and is saved", async () => {
    const { container } = show();
    await act(async () => fireEvent.click(button("Always show from this site")));
    expect(useSettings.getState().imageSites).toEqual(["images.example"]);
    expect(invoke).toHaveBeenCalledWith("settings_save", { settings: expect.objectContaining({ imageSites: ["images.example"] }) });
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:desk/picture-1");
  });

  it("shows that site's pictures without a click, and no other's", async () => {
    useSettings.setState({ imageSites: ["images.example"] });
    await act(async () => {
      show(`![a](${URL_}) ![b](https://elsewhere.example/b.png)`);
    });
    expect(fetched()).toEqual([["remote_image_fetch", { url: URL_, sameSite: true }]]);
    expect(screen.getByRole("group", { name: "Picture from elsewhere.example: b" })).not.toBeNull();
  });

  it("is listed in Settings → Chat and can be taken back there", () => {
    useSettings.setState({ imageSites: ["images.example", "cdn.example"] });
    render(<Chat />);
    const list = screen.getByRole("list", { name: "Sites whose pictures always show" });
    expect(list.textContent).toContain("images.example");
    fireEvent.click(screen.getByRole("button", { name: "Stop always showing pictures from images.example" }));
    expect(useSettings.getState().imageSites).toEqual(["cdn.example"]);
    expect(invoke).toHaveBeenCalledWith("settings_save", { settings: expect.objectContaining({ imageSites: ["cdn.example"] }) });
  });

  it("says when there are none, and that sites anyone can post to are best left off", () => {
    render(<Chat />);
    expect(screen.getByText(/None yet/)).not.toBeNull();
    expect(screen.getByText(/sites where anyone can post a picture/)).not.toBeNull();
  });
});

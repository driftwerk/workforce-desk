import { describe, expect, it } from "vitest";
import { linkTicketKeys } from "./ticketKeys";

const ID = "0f3c2a9e-1b2c-4d5e-8f90-123456789abc";
const known = (key: string) => (key === "PLT-2554" ? ID : undefined);
const link = `[PLT-2554](desk://ticket/${ID})`;

describe("ticket keys in a comment", () => {
  it("links a key of a ticket here, and leaves one that isn't", () => {
    expect(linkTicketKeys("Left: the admin page PLT-2554 and PLT-9999.", known)).toBe(`Left: the admin page ${link} and PLT-9999.`);
  });
  it("leaves keys in code, links, addresses and longer words alone", () => {
    const md = [
      "`PLT-2554` and [see PLT-2554](https://x.test/browse/PLT-2554) and <https://x.test/PLT-2554>",
      "https://site.test/browse/PLT-2554 xPLT-2554 PLT-25540 PLT-2554-b #PLT-2554",
      "```",
      "PLT-2554",
      "```",
      "    PLT-2554 in indented code",
    ].join("\n");
    expect(linkTicketKeys(md, known)).toBe(md);
  });
  it("links a key in a list item and around punctuation", () => {
    expect(linkTicketKeys("- PLT-2554, then (PLT-2554)", known)).toBe(`- ${link}, then (${link})`);
  });
  it("keeps going after a fence closes", () => {
    expect(linkTicketKeys("~~~\nPLT-2554\n~~~\nPLT-2554", known)).toBe(`~~~\nPLT-2554\n~~~\n${link}`);
  });

  it("leaves reference links whole", () => {
    const md = ["See [PLT-2554] for it.", "", `[PLT-2554]: https://x.test/browse/PLT-2554 "PLT-2554"`].join("\n");
    expect(linkTicketKeys(md, known)).toBe(md);
  });
  it("links a key in emphasis, and leaves HTML tags alone", () => {
    expect(linkTicketKeys("_PLT-2554_ and *PLT-2554*", known)).toBe(`_${link}_ and *${link}*`);
    expect(linkTicketKeys(`<abbr title="PLT-2554">x</abbr>`, known)).toBe(`<abbr title="PLT-2554">x</abbr>`);
  });
  it("reads a long hostile line in linear time", () => {
    for (const run of ["[", "![", "<", "<a", "`", "PLT-1 "]) {
      const line = run.repeat(Math.ceil(100_000 / run.length));
      const start = performance.now();
      linkTicketKeys(line, known);
      expect(performance.now() - start).toBeLessThan(250);
    }
  });
});

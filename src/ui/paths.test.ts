import { describe, expect, it } from "vitest";
import { baseName, homeShort } from "./paths";

describe("a path as Desk shows it", () => {
  it("starts from ~ in the home folder on any system", () => {
    expect(homeShort("/Users/sarah/acme-web")).toBe("~/acme-web");
    expect(homeShort("/home/sarah/acme-web")).toBe("~/acme-web");
    expect(homeShort("C:\\Users\\sarah\\acme-web")).toBe("~\\acme-web");
    expect(homeShort("/Users/sarah")).toBe("~");
    expect(homeShort("/srv/acme")).toBe("/srv/acme");
    expect(homeShort("/Users/sarahs-old/x")).toBe("~/x");
  });

  it("ends in its last part, whichever separator it uses", () => {
    expect(baseName("/usr/bin/zsh")).toBe("zsh");
    expect(baseName("C:\\Program Files\\PowerShell\\pwsh.exe")).toBe("pwsh.exe");
    expect(baseName("/srv/acme/")).toBe("acme");
    expect(baseName("theme.toml")).toBe("theme.toml");
  });
});

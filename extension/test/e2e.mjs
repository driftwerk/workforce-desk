// End to end: Chrome for Testing, with a throwaway profile, loads Desk's
// extension unpacked; a test native messaging host (this file, run by
// Chrome as `e2e.mjs host`) plays the hub over the real protocol; a local
// fixture site is the page. Nothing touches the person's Chrome: the host
// manifest goes into the throwaway profile's own NativeMessagingHosts.
//
//   npm run extension && CHROME_FOR_TESTING=/path/to/chrome node extension/test/e2e.mjs
//
// Exits non-zero on the first thing that isn't as it should be.

import { createHash, webcrypto } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect, createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "../protocol/v1.json"), "utf8"));

// ── As the host Chrome starts: relay native messages to the test's socket.
if (process.argv[2] === "host" || process.argv[2]?.startsWith("chrome-extension://")) {
  const sock = connect(process.env.DESK_E2E_SOCKET ?? readFileSync(join(here, ".e2e-socket"), "utf8").trim());
  let buf = Buffer.alloc(0);
  process.stdin.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4) {
      const n = buf.readUInt32LE(0);
      if (buf.length < 4 + n) break;
      sock.write(buf.subarray(4, 4 + n).toString("utf8") + "\n");
      buf = buf.subarray(4 + n);
    }
  });
  let line = "";
  sock.on("data", (d) => {
    line += d.toString("utf8");
    let i;
    while ((i = line.indexOf("\n")) >= 0) {
      const body = Buffer.from(line.slice(0, i), "utf8");
      line = line.slice(i + 1);
      const len = Buffer.alloc(4);
      len.writeUInt32LE(body.length);
      process.stdout.write(Buffer.concat([len, body]));
    }
  });
  sock.on("close", () => process.exit(0));
  process.stdin.on("end", () => process.exit(0));
} else {
  await main();
}

async function main() {
  const chrome = process.env.CHROME_FOR_TESTING;
  if (!chrome) {
    console.log("e2e: CHROME_FOR_TESTING isn't set; skipped");
    return;
  }
  const dist = realpathSync(resolve(here, "../dist"));
  const id = extensionId(dist);
  const work = mkdtempSync(join(tmpdir(), "desk-ext-e2e-"));
  const profile = join(work, "profile");
  const socket = join(work, "hub.sock");
  mkdirSync(join(profile, "NativeMessagingHosts"), { recursive: true });
  // Chrome starts the host with nothing of this process's environment it
  // can rely on, so the socket's path goes beside the script too.
  writeFileSync(join(here, ".e2e-socket"), socket);
  const hostScript = join(work, "host.sh");
  writeFileSync(hostScript, `#!/bin/sh\nexec "${process.execPath}" "${join(here, "e2e.mjs")}" host\n`);
  chmodSync(hostScript, 0o755);
  writeFileSync(
    join(profile, "NativeMessagingHosts", `${fixture.host}.json`),
    JSON.stringify({ name: fixture.host, description: "e2e", path: hostScript, type: "stdio", allowed_origins: [`chrome-extension://${id}/`] }),
  );

  const site = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url === "/form")
      return res.end(`<!doctype html><title>Form</title><body><form id="f"><input id="name"><button id="send" type="submit">Send</button></form><div id="out"></div>
<script>document.getElementById('f').addEventListener('submit', e => { e.preventDefault(); const p = document.createElement('p'); p.id = 'done'; p.textContent = 'Thanks, ' + document.getElementById('name').value; document.getElementById('out').appendChild(p); });</script></body>`);
    res.end("<!doctype html><title>Home</title><body><p>Welcome</p></body>");
  });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${site.address().port}`;

  // The person's own tab, open before Desk: it must be left alone.
  const theirs = `${base}/`;
  let hub;
  const connected = new Promise((resolveConn) => {
    hub = netServer((s) => resolveConn(s));
  });
  await new Promise((r) => hub.listen(socket, r));
  const proc = spawn(
    chrome,
    [`--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", `--load-extension=${dist}`, `--disable-extensions-except=${dist}`, "--window-size=1200,900", theirs],
    { stdio: "ignore" },
  );
  const fail = (why) => {
    console.error(`e2e: ${why}`);
    void finish(1);
  };
  const finish = async (code) => {
    // Chrome writes to its profile as it closes: wait for it, then remove
    // the throwaway profile.
    const exited = new Promise((r) => (proc.exitCode !== null ? r() : proc.once("exit", r)));
    proc.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
    site.close();
    hub.close();
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    rmSync(join(here, ".e2e-socket"), { force: true });
    process.exit(code);
  };
  const timer = setTimeout(() => fail("timed out"), 90_000);

  const conn = await connected;
  const inbox = [];
  const waiters = [];
  let line = "";
  conn.on("data", (d) => {
    line += d.toString("utf8");
    let i;
    while ((i = line.indexOf("\n")) >= 0) {
      const m = JSON.parse(line.slice(0, i));
      line = line.slice(i + 1);
      const w = waiters.shift();
      if (w) w(m);
      else inbox.push(m);
    }
  });
  const next = () => (inbox.length ? Promise.resolve(inbox.shift()) : new Promise((r) => waiters.push(r)));
  const send = (m) => conn.write(JSON.stringify(m) + "\n");
  let callId = 0;
  const call = async (cmd, args = {}) => {
    const id = ++callId;
    send({ type: "call", id, cmd, session: "s-e2e", ...args });
    for (;;) {
      const m = await next();
      if (m.type === "result" && m.id === id) return m;
    }
  };
  const expect = (ok, what) => {
    if (!ok) fail(what);
    else console.log(`e2e: ✓ ${what}`);
  };

  // Who it is, and the proof.
  const hello = await next();
  expect(hello.type === "hello" && hello.protocol === fixture.protocol && /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/.test(hello.label), "says hello with its key and code");
  const nonce = Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString("base64");
  send({ type: "challenge", nonce, state: "pending" });
  const proof = await next();
  const key = await webcrypto.subtle.importKey("raw", Buffer.from(hello.key, "base64"), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const good = await webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, Buffer.from(proof.signature, "base64"), new TextEncoder().encode(fixture.proof_prefix + nonce));
  expect(proof.type === "proof" && good, "signs the challenge with its key");
  const early = await call("where");
  expect(!early.ok && /isn.t confirmed/.test(early.error), "does nothing before the person confirms it");
  send({ type: "ready" });
  await new Promise((r) => setTimeout(r, 200));

  const opened = await call("navigate", { url: `${base}/form` });
  expect(opened.ok && opened.value.url === `${base}/form`, "opens a page in Desk's own tab");
  const refused = await call("navigate", { url: "chrome://settings" });
  expect(!refused.ok, "never opens Chrome's own pages");
  const read = await call("read", { what: "text" });
  expect(read.ok && read.value.title === "Form", "reads the page");
  expect((await call("fill", { selector: "#name", value: "Allan" })).ok, "fills a field");
  expect((await call("click", { selector: "#send" })).ok, "clicks a button");
  const waited = await call("wait", { selector: "#done", timeout_ms: 5000 });
  expect(waited.ok, "the page reacted to the click");
  const after = await call("read", { what: "text" });
  expect(after.ok && after.value.text.includes("Thanks, Allan"), "what was typed reached the page");
  const shot = await call("capture");
  expect(shot.ok && (shot.value.png_base64?.length > 1000 || shot.value.skipped === "minimised"), "takes a picture of Desk's window");
  const missing = await call("click", { selector: "#nope" });
  expect(!missing.ok && missing.error.includes("Nothing on the page matches"), "says plainly what it couldn't do");
  // Something that isn't the hub's is ignored.
  send({ type: "exec", code: "alert(1)" });
  const closed = await call("close");
  expect(closed.ok && closed.value.closed === true, "closes its own tab");
  const stopped = await call("stop");
  expect(stopped.ok, "Stop closes Desk's window");
  clearTimeout(timer);
  await finish(0);
}

/** An unpacked extension's id: from its folder's path. */
function extensionId(path) {
  const hex = createHash("sha256").update(path).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

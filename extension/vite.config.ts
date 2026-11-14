// Builds the extension into extension/dist: the service worker and the
// popup, with the manifest and icons beside them. `DESK_EXTENSION_KEY`
// (the store's public key, from its dashboard) goes into a development
// build's manifest so an unpacked build has the store's id; the store's own
// zip never carries a key.
//
// `revision.json` goes first (the folder is emptied) and is written last:
// an unpacked build that reloads itself (src/update.ts) reads that file
// first, so it never reloads into a folder that's half built.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const here = import.meta.dirname;
const dist = resolve(here, "dist");

const manifest = (): Plugin => ({
  name: "desk-manifest",
  // Only after a build that was written: closeBundle runs after a failed
  // one too, and revision.json must never mark a broken folder as built.
  writeBundle() {
    const out = dist;
    const m = JSON.parse(readFileSync(resolve(here, "manifest.json"), "utf8"));
    const key = process.env.DESK_EXTENSION_KEY?.trim();
    if (key) m.key = key;
    writeFileSync(resolve(out, "manifest.json"), JSON.stringify(m, null, 2) + "\n");
    mkdirSync(resolve(out, "icons"), { recursive: true });
    for (const s of [16, 32, 48, 128]) copyFileSync(resolve(here, `icons/icon-${s}.png`), resolve(out, `icons/icon-${s}.png`));
    const { revision } = JSON.parse(readFileSync(resolve(here, "protocol/desk-helper.json"), "utf8"));
    writeFileSync(resolve(out, "revision.json"), JSON.stringify({ revision }) + "\n");
  },
});

export default defineConfig({
  root: here,
  base: "./",
  publicDir: false,
  plugins: [manifest()],
  build: {
    outDir: dist,
    emptyOutDir: true,
    target: "chrome116",
    modulePreload: false,
    minify: false,
    rollupOptions: {
      input: { background: resolve(here, "src/background.ts"), popup: resolve(here, "popup.html") },
      output: { entryFileNames: "[name].js", chunkFileNames: "[name].js", assetFileNames: "[name][extname]" },
    },
  },
});

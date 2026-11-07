import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // Worktrees link one node_modules; each keeps its own prebundled deps.
  cacheDir: ".vite",
  // The linked @workforce/rich has its own React; there must be one.
  resolve: { dedupe: ["react", "react-dom"] },
  server: { port: 5183, strictPort: true },
  build: { target: "safari16", outDir: "dist" },
  // Styles read as text (?raw) are read as they are; other CSS is left out.
  test: { environment: "jsdom", css: { include: [/\.css\?raw$/] } },
});

/** True only when `vite dev` serves the UI to a plain browser (no Tauri):
 *  the dev bridge then stands in for the app process, and for hub routes the
 *  running hub doesn't have yet. Never true in tests or builds. */
export const preview = import.meta.env.MODE === "development" && !("__TAURI_INTERNALS__" in window);

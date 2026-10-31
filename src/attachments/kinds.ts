/** What kind of file something is, as Desk shows it: how it is shown in a
 *  conversation, what it's called, and the badge on its card. */
export type Shown = "image" | "chart" | "pdf" | "video" | "audio" | "file";

/** A chart an agent drew, delivered as the spec it was drawn from (the
 *  hub's chart tool, to a Desk that says it draws them). */
export const CHART_MEDIA_TYPE = "application/vnd.workforce.chart+json";

export interface Kind {
  shown: Shown;
  /** "PDF", "Spreadsheet", "Video", … */
  label: string;
  /** The few letters on its card: "PDF", "XLSX". */
  badge: string;
  /** Its badge's family, for colour. */
  family: "doc" | "sheet" | "slides" | "media" | "archive" | "code" | "other";
}

const FAMILIES: Record<string, [Kind["family"], string]> = {
  pdf: ["doc", "PDF"],
  doc: ["doc", "Document"],
  docx: ["doc", "Document"],
  odt: ["doc", "Document"],
  rtf: ["doc", "Document"],
  pages: ["doc", "Document"],
  txt: ["doc", "Text"],
  md: ["doc", "Text"],
  xls: ["sheet", "Spreadsheet"],
  xlsx: ["sheet", "Spreadsheet"],
  ods: ["sheet", "Spreadsheet"],
  csv: ["sheet", "Spreadsheet"],
  tsv: ["sheet", "Spreadsheet"],
  numbers: ["sheet", "Spreadsheet"],
  ppt: ["slides", "Presentation"],
  pptx: ["slides", "Presentation"],
  odp: ["slides", "Presentation"],
  key: ["slides", "Presentation"],
  zip: ["archive", "Archive"],
  gz: ["archive", "Archive"],
  tgz: ["archive", "Archive"],
  tar: ["archive", "Archive"],
  "7z": ["archive", "Archive"],
  rar: ["archive", "Archive"],
  json: ["code", "Data"],
  xml: ["code", "Data"],
  yaml: ["code", "Data"],
  yml: ["code", "Data"],
  toml: ["code", "Data"],
  sql: ["code", "Code"],
  js: ["code", "Code"],
  ts: ["code", "Code"],
  py: ["code", "Code"],
  rs: ["code", "Code"],
  go: ["code", "Code"],
  sh: ["code", "Code"],
  html: ["code", "Code"],
  css: ["code", "Code"],
};

const extensionOf = (filename: string): string => {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
};

/** The kind of `filename`, of `mediaType`. */
export const kindOf = (mediaType: string, filename: string): Kind => {
  const type = mediaType.split(";")[0]!.trim().toLowerCase();
  const ext = extensionOf(filename);
  const badge = (ext || type.split("/")[1] || "file").slice(0, 4).toUpperCase();
  if (type.startsWith("image/")) return { shown: "image", label: "Image", badge, family: "media" };
  if (type === CHART_MEDIA_TYPE) return { shown: "chart", label: "Chart", badge: "CHRT", family: "sheet" };
  if (type === "application/pdf" || ext === "pdf") return { shown: "pdf", label: "PDF", badge: "PDF", family: "doc" };
  if (type.startsWith("video/")) return { shown: "video", label: "Video", badge, family: "media" };
  if (type.startsWith("audio/")) return { shown: "audio", label: "Audio", badge, family: "media" };
  const [family, label] = FAMILIES[ext] ?? (type.startsWith("text/") ? (["doc", "Text"] as const) : (["other", "File"] as const));
  return { shown: "file", label, badge, family };
};

/** 412 KB, 9.2 MB. */
export const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let n = bytes / 1024;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return `${n >= 10 || u === 0 ? Math.round(n) : n.toFixed(1)} ${units[u]}`;
};

/** 0:48, 1:02:03. */
export const formatDuration = (seconds: number): string => {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

/** "PDF · 412 KB", "Video · 0:48 · 9.2 MB". */
export const describe = (kind: Kind, size: number, duration?: number): string =>
  [kind.label, duration ? formatDuration(duration) : null, size ? formatSize(size) : null].filter(Boolean).join(" · ");

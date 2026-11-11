/** Takes secrets out of text before it's shown under Details or handed to an
 *  agent: auth headers, well-known token prefixes, name=value secrets, URL
 *  credentials and long opaque runs. Idempotent. */
const MARK = "[redacted]";

const RULES: [RegExp, string | ((...m: string[]) => string)][] = [
  // Authorization / Proxy-Authorization / Bearer: the whole value.
  [/\b((?:proxy-)?authorization\s*[:=]\s*)(?!\[redacted\])(?:bearer\s+|basic\s+|token\s+)?[^\s"',;]+(?:\s+[A-Za-z0-9._~+/=-]{8,})?/gi, `$1${MARK}`],
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, `$1${MARK}`],
  // user:password@ in URLs.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, `$1${MARK}@`],
  // token=..., secret: "...", password=..., api_key=..., "key": "..."
  [/(["']?\b[\w.-]*(?:token|secret|passw(?:or)?d|passwd|pwd|api[_-]?key|apikey|private[_-]?key|access[_-]?key|credential|key)[\w.-]*["']?\s*[:=]\s*)(?!\[redacted\])(?:"[^"]*"|'[^']*'|[^\s"',;&]+)/gi, `$1${MARK}`],
  // Well-known prefixes.
  [/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[abprs]-[A-Za-z0-9-]{8,}|wf[prb]_[A-Za-z0-9_-]{6,}|AKIA[0-9A-Z]{8,}|ASIA[0-9A-Z]{8,}|AIza[0-9A-Za-z_-]{20,})/g, MARK],
  // Long hex (32+) and long base64/base64url runs (40+) that mix cases or digits.
  [/\b[0-9a-fA-F]{32,}\b/g, MARK],
  [/(?<![A-Za-z0-9+/=_-])(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*[0-9])[A-Za-z0-9+/_-]{40,}={0,2}/g, MARK],
];

export const redact = (text: string): string => RULES.reduce((t, [re, to]) => t.replace(re, to as string), text);

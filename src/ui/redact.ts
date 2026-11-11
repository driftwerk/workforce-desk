/** Takes secrets out of text before it is sent to an agent: auth headers,
 *  well-known token prefixes, name=value pairs whose value looks like a secret,
 *  URL credentials and long opaque runs. Shown text (Details, Copy) is left as
 *  it is: it's the person's own machine. Idempotent. */
const MARK = "[redacted]";

/** A value that could be a secret: long, and a mix of character kinds. A
 *  path, a short word or a name like `stripe-prod` is not. */
const looksSecret = (v: string): boolean => {
  const t = v.replace(/^["']|["']$/g, "");
  if (t.length < 16 || /^(?:[/~]|[A-Za-z]:[\\/])/.test(t) || t === MARK) return false;
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9\s]/].filter((r) => r.test(t)).length;
  return kinds >= 2;
};

/** A name that says it holds a secret, as a whole word (`api_key`, `CLIENT_SECRET`,
 *  `x-api-key`), never inside another (`keyboard`, `monkey`). */
const NAME = String.raw`(?<![A-Za-z0-9])(?:[A-Za-z0-9]+[_.-])*(?:token|secret|passw(?:or)?d|pwd|credentials?|key)(?![A-Za-z0-9])`;

const RULES: [RegExp, string | ((...m: string[]) => string)][] = [
  // Authorization / Proxy-Authorization / Bearer: the whole value.
  [/\b((?:proxy-)?authorization\s*[:=]\s*)(?!\[redacted\])(?:bearer\s+|basic\s+|token\s+)?[^\s"',;]+(?:\s+[A-Za-z0-9._~+/=-]{8,})?/gi, `$1${MARK}`],
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, `$1${MARK}`],
  // user:password@ in URLs.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, `$1${MARK}@`],
  // token=..., secret: "...", password=..., "api_key": "...": only a value that looks secret.
  [new RegExp(String.raw`(["']?${NAME}["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s"',;&]+)`, "gi"), (_m, head, value) => (looksSecret(value) ? `${head}${MARK}` : `${head}${value}`)],
  // Well-known prefixes.
  [/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[abprs]-[A-Za-z0-9-]{8,}|wf[prb]_[A-Za-z0-9_-]{6,}|AKIA[0-9A-Z]{8,}|ASIA[0-9A-Z]{8,}|AIza[0-9A-Za-z_-]{20,})/g, MARK],
  // Long hex: 41 or more. Git SHAs (40, or a 64-character sha256) are kept: they aren't secrets.
  [/\b[0-9a-fA-F]{41,}\b/g, (m) => (/^[0-9a-f]{64}$/i.test(m) ? m : MARK)],
  // Long base64 runs (40+) that mix cases and digits, unless path-shaped.
  [
    /(?<![A-Za-z0-9+/=_~.-])(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*[0-9])[A-Za-z0-9+/_-]{40,}={0,2}/g,
    (m) => (/^[/~]/.test(m) ? m : MARK),
  ],
];

export const redact = (text: string): string => RULES.reduce((t, [re, to]) => t.replace(re, to as string), text);

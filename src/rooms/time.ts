import type { RoomMessage } from "../hub/types";

// The hub writes RFC 3339 with anywhere from no fractional digits to nine,
// so "…:30Z" and "…:30.5Z" don't compare as strings: times are compared as
// microseconds instead, and messages at one instant by id, as the hub pages
// them.

const RFC3339 = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/i;

/** Microseconds since the epoch; 0 for a time that doesn't parse. */
export const instant = (iso: string): bigint => {
  const m = RFC3339.exec(iso);
  const whole = Date.parse(m ? `${m[1]}${m[3]}` : iso);
  if (Number.isNaN(whole)) return 0n;
  const micros = m?.[2] ? BigInt(m[2].slice(0, 6).padEnd(6, "0")) : 0n;
  return BigInt(whole) * 1000n + micros;
};

/** Oldest first; one instant's messages by id. */
export const byTime = (a: Pick<RoomMessage, "createdAt" | "id">, b: Pick<RoomMessage, "createdAt" | "id">): number => {
  const x = instant(a.createdAt);
  const y = instant(b.createdAt);
  return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/** Whether `m` came after the moment `at`. */
export const after = (m: Pick<RoomMessage, "createdAt">, at: string): boolean => instant(m.createdAt) > instant(at);

/** The later of two times, either possibly absent. */
export const later = (a: string | null | undefined, b: string): string => (a && instant(a) > instant(b) ? a : b);

/** `iso` less one microsecond, written back as RFC 3339 with six digits. */
export const justBefore = (iso: string): string => {
  const t = instant(iso) - 1n;
  const ms = Number(t / 1000n);
  const micros = String(t % 1000n).padStart(3, "0");
  return new Date(ms).toISOString().replace(/Z$/, `${micros}Z`);
};

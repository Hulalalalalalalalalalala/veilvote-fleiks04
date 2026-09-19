/**
 * Strict, timezone-aware ISO 8601 instant parsing.
 *
 * `Date.parse` accepts far more than ISO 8601 (date-only strings, space
 * separators, missing time zones...), which would silently turn an audit
 * filter typo into a query bound. The parser below only accepts the explicit
 * profile `YYYY-MM-DDTHH:mm:ss[.fraction](Z|±hh:mm)` and validates the
 * calendar date itself, so values like `2026-03-32` or `2026-02-29` in a
 * non-leap year are rejected instead of being rolled over.
 *
 * The canonical result is the same UTC millisecond string produced by
 * `Date.prototype.toISOString()` (`YYYY-MM-DDTHH:mm:ss.sssZ`), which is what
 * the database stores, so lexicographic range comparisons stay exact.
 */
const INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|z|[+-]\d{2}:\d{2})$/;

/** Parse a strict ISO 8601 instant with an explicit zone; returns the canonical UTC string or undefined. */
export function parseInstant(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = INSTANT_PATTERN.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7];
  const zone = match[8];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return undefined;

  let ms = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(ms)) return undefined;
  // Read the wall-clock fields back before applying the zone: an impossible
  // calendar date (e.g. 31 April, 29 February in a common year) rolls over in
  // Date.UTC and must be rejected rather than normalized.
  const probe = new Date(ms);
  if (
    probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day ||
    probe.getUTCHours() !== hour || probe.getUTCMinutes() !== minute || probe.getUTCSeconds() !== second
  ) return undefined;

  if (fraction) {
    // "3" is 300 ms, "34" is 340 ms, "3456" keeps 345 ms; stored events have
    // millisecond resolution, so the dropped digits never span a real row.
    ms += Number(fraction.padEnd(3, "0").slice(0, 3));
  }
  if (zone !== "Z" && zone !== "z") {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMinutes = Number(zone.slice(4, 6));
    if (offsetHours > 23 || offsetMinutes > 59) return undefined;
    ms -= (zone[0] === "+" ? 1 : -1) * (offsetHours * 3_600_000 + offsetMinutes * 60_000);
  }
  return new Date(ms).toISOString();
}

/** Whether a value is a strict timezone-aware ISO 8601 instant. */
export function isInstant(value: unknown): value is string {
  return parseInstant(value) !== undefined;
}

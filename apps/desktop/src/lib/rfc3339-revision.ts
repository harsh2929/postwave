const RFC3339_NANOS_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/u;

/** Exact RFC3339 instant parser that retains the server's sub-millisecond revision. */
export function rfc3339EpochNanoseconds(value: string): bigint | null {
  const match = RFC3339_NANOS_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const offsetSign = match[8] ?? "+";
  const offsetHours = Number(match[9] ?? 0);
  const offsetMinutes = Number(match[10] ?? 0);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    year < 2000 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (daysInMonth[month - 1] ?? 0) ||
    offsetHours > 14 ||
    offsetMinutes > 59 ||
    (offsetHours === 14 && offsetMinutes !== 0)
  ) {
    return null;
  }
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  const localMillis = calendar.getTime();
  if (!Number.isFinite(localMillis)) return null;
  const signedOffsetMinutes =
    (offsetSign === "-" ? -1 : 1) * (offsetHours * 60 + offsetMinutes);
  const epochMillis = localMillis - signedOffsetMinutes * 60_000;
  return (
    BigInt(epochMillis) * 1_000_000n + BigInt(fraction.padEnd(9, "0") || "0")
  );
}

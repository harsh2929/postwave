const encoder = new TextEncoder();

/** Expand the canonical exponent spelling PostgreSQL jsonb normalizes. */
function expandExponent(token: string): string {
  const [rawMantissa, rawExponent] = token.toLowerCase().split("e");
  if (rawExponent === undefined || rawMantissa === undefined) return token;
  const negative = rawMantissa.startsWith("-");
  const mantissa = negative ? rawMantissa.slice(1) : rawMantissa;
  const point = mantissa.indexOf(".");
  const digits = mantissa.replace(".", "");
  const initialPoint = point === -1 ? digits.length : point;
  const finalPoint = initialPoint + Number.parseInt(rawExponent, 10);
  const expanded =
    finalPoint <= 0
      ? `0.${"0".repeat(-finalPoint)}${digits}`
      : finalPoint >= digits.length
        ? `${digits}${"0".repeat(finalPoint - digits.length)}`
        : `${digits.slice(0, finalPoint)}.${digits.slice(finalPoint)}`;
  return negative ? `-${expanded}` : expanded;
}

function numericNormalizationDelta(value: unknown): number {
  if (typeof value === "number") {
    const token = JSON.stringify(value);
    if (!token.includes("e")) return 0;
    return expandExponent(token).length - token.length;
  }
  if (Array.isArray(value)) {
    return value.reduce(
      (total, item) => total + numericNormalizationDelta(item),
      0,
    );
  }
  if (value === null || typeof value !== "object") return 0;
  return Object.values(value).reduce(
    (total, item) => total + numericNormalizationDelta(item),
    0,
  );
}

/**
 * Compact JSON bytes after Go's mandatory line-separator escaping and
 * PostgreSQL jsonb's exponent-to-decimal normalization.
 */
export function collectionPersistenceJsonBytes(value: unknown): number {
  const json = JSON.stringify(value).replace(
    /[\u2028\u2029]/gu,
    (character) =>
      `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
  );
  return encoder.encode(json).byteLength + numericNormalizationDelta(value);
}

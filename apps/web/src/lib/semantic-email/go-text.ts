// SPDX-License-Identifier: AGPL-3.0-only
//
// The small pieces of Go's standard library that the semantic-email
// normalizer, validator, and renderer depend on, reimplemented so the
// TypeScript mirror agrees with the Go original byte for byte.
//
// These are not "close enough" helpers. Each one is a specific behaviour the
// projections observably depend on:
//
//   * html.EscapeString escapes FIVE characters, and writes `&#39;` / `&#34;`
//     rather than the HTML5 named entities. A preview using the browser's own
//     escaping would render the same to a human and hash differently from what
//     the API sends.
//   * unicode.IsSpace is not JavaScript's \s. Go includes U+0085 and excludes
//     U+FEFF; \s is the other way round. Whitespace collapsing is what decides
//     whether two authored spans join into one word.
//   * unicode.IsControl is exactly category Cc.

/** Go's html.EscapeString. */
export function escapeHTML(value: string): string {
  let out = "";
  for (const character of value) {
    switch (character) {
      case "&":
        out += "&amp;";
        break;
      case "'":
        out += "&#39;";
        break;
      case "<":
        out += "&lt;";
        break;
      case ">":
        out += "&gt;";
        break;
      case '"':
        out += "&#34;";
        break;
      default:
        out += character;
    }
  }
  return out;
}

const GO_SPACE_RANGES: readonly (readonly [number, number])[] = [
  [0x09, 0x0d],
  [0x20, 0x20],
  [0x85, 0x85],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
];

/** Go's unicode.IsSpace, by code point. */
export function isGoSpace(codePoint: number): boolean {
  for (const [low, high] of GO_SPACE_RANGES) {
    if (codePoint >= low && codePoint <= high) return true;
  }
  return false;
}

/** Go's unicode.IsControl — Unicode category Cc. */
export function isGoControl(codePoint: number): boolean {
  return (
    (codePoint >= 0x00 && codePoint <= 0x1f) ||
    (codePoint >= 0x7f && codePoint <= 0x9f)
  );
}

export function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    if (isGoControl(character.codePointAt(0) ?? 0)) return true;
  }
  return false;
}

/**
 * Go's strings.FieldsFunc(value, unicode.IsSpace) — split on runs of space,
 * dropping empty fields.
 */
export function goFields(value: string): string[] {
  const fields: string[] = [];
  let current = "";
  for (const character of value) {
    if (isGoSpace(character.codePointAt(0) ?? 0)) {
      if (current !== "") {
        fields.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (current !== "") fields.push(current);
  return fields;
}

/** Number of Unicode code points — Go's utf8.RuneCountInString. */
export function runeCount(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
    }
    count += 1;
  }
  return count;
}

/** Byte length of the UTF-8 encoding — Go's len(string). */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Go's utf8.ValidString. A JavaScript string holding an unpaired surrogate has
 * no valid UTF-8 encoding, which is the case Go's check exists for.
 */
export function isValidUTF8(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Go's strings.TrimSpace, which trims by unicode.IsSpace. */
export function goTrimSpace(value: string): string {
  const characters = [...value];
  let start = 0;
  let end = characters.length;
  while (start < end && isGoSpace(characters[start].codePointAt(0) ?? 0)) {
    start += 1;
  }
  while (end > start && isGoSpace(characters[end - 1].codePointAt(0) ?? 0)) {
    end -= 1;
  }
  return characters.slice(start, end).join("");
}

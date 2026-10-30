const UNSAFE_OPERATOR_TEXT =
  /[\p{Cc}\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;
const MAX_OPERATOR_TEXT_CODE_POINTS = 200;

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function validateOperatorText(value: string, label: string): string | null {
  if (!isWellFormedUnicode(value)) return `${label} contains invalid Unicode.`;
  if (Array.from(value).length > MAX_OPERATOR_TEXT_CODE_POINTS) {
    return `${label} must be ${MAX_OPERATOR_TEXT_CODE_POINTS.toLocaleString()} characters or fewer.`;
  }
  if (UNSAFE_OPERATOR_TEXT.test(value)) {
    return `${label} cannot contain control or bidirectional formatting characters.`;
  }
  return null;
}

export function validateCollectionName(value: string): string | null {
  if (value.trim().length === 0) return "Enter a collection name.";
  if (value !== value.trim()) {
    return "Remove leading or trailing whitespace from the collection name.";
  }
  return validateOperatorText(value, "Collection name");
}

export function validateCollectionQuery(value: string): string | null {
  return validateOperatorText(value.trim(), "Search");
}

export function collectionNameFromFile(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/u, "").trim();
  return Array.from(base).slice(0, MAX_OPERATOR_TEXT_CODE_POINTS).join("");
}

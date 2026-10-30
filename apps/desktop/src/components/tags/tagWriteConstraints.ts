export const TAG_NAME_MAX_RUNES = 64;
export const TAG_DESCRIPTION_MAX_RUNES = 1_024;

export function runeLength(value: string): number {
  return Array.from(value).length;
}

export function limitRunes(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join("");
}

export function normalizedNewTagName(value: string): string | null {
  const normalized = value.trim();
  return normalized && runeLength(normalized) <= TAG_NAME_MAX_RUNES
    ? normalized
    : null;
}

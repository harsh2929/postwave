// SPDX-License-Identifier: AGPL-3.0-only

export function sanitizeOgText(value: string | null, maxLength: number): string {
  if (!value || maxLength <= 0) return "";
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, maxLength).trim();
}

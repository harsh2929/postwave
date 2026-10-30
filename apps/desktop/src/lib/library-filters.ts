/**
 * Pure helpers for the Library: formatting + sort comparators + the
 * file-to-upload-payload transformer. No I/O, no React, fully unit-testable.
 *
 * Server-side filtering / counts live in the Go assets package; this
 * module is used for client-side sort (when the user changes sort
 * order without refetching) and presentational helpers.
 */

import { fileToBase64 as readFileToBase64 } from "./file-transfer";

export type SortMode = "newest" | "oldest" | "largest" | "name" | "most-used";

export interface AssetLike {
  id: string;
  filename: string;
  bytes: number;
  createdAt: string;
  referencesCount?: number;
}

export function fmtBytes(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function fmtDims(w?: number, h?: number): string {
  if (!w || !h) return "—";
  return `${w}×${h}`;
}

export function fmtRelDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diffMs = Date.now() - d.getTime();
  const day = 86_400_000;
  if (diffMs < 0) return d.toLocaleDateString();
  if (diffMs < day) return "today";
  if (diffMs < 2 * day) return "yesterday";
  if (diffMs < 7 * day) return `${Math.floor(diffMs / day)} days ago`;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function isLikelyImage(mime: string | null | undefined): boolean {
  return typeof mime === "string" && mime.startsWith("image/");
}

export function sortAssets<T extends AssetLike>(
  list: readonly T[],
  mode: SortMode,
): T[] {
  const arr = [...list];
  const t = (s: string) => new Date(s).getTime();
  switch (mode) {
    case "newest":
      arr.sort((a, b) => t(b.createdAt) - t(a.createdAt));
      break;
    case "oldest":
      arr.sort((a, b) => t(a.createdAt) - t(b.createdAt));
      break;
    case "largest":
      arr.sort((a, b) => b.bytes - a.bytes);
      break;
    case "name":
      arr.sort((a, b) =>
        a.filename.toLowerCase().localeCompare(b.filename.toLowerCase()),
      );
      break;
    case "most-used":
      arr.sort(
        (a, b) =>
          (b.referencesCount ?? 0) - (a.referencesCount ?? 0) ||
          t(b.createdAt) - t(a.createdAt),
      );
      break;
  }
  return arr;
}

/**
 * Coerce the `unknown` we get from the Asset index signature into a
 * non-empty string, or fall back. Avoids each call-site re-doing
 * `typeof x === 'string' && x` ceremony.
 */
export function asNonEmptyString(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  return fallback;
}

/** Coerce an optional/unknown asset count into a non-negative integer. */
export function asCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return 0;
}

/**
 * Read a File as base64 (no `data:…;base64,` prefix). Reused by the
 * dropzone + upload modal — keeping it here makes it independently
 * testable and avoids two implementations.
 */
export function fileToBase64(file: File): Promise<string> {
  return readFileToBase64(file);
}

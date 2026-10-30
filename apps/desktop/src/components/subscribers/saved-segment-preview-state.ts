import type { SavedSegmentPreview } from "../../lib/api-client";
import type { RemoteFailure } from "../../lib/remote-resource";

export const SAVED_SEGMENT_PREVIEW_STALE_MS = 5 * 60 * 1_000;

export type SavedPreviewEntry =
  | { kind: "loading" }
  | { kind: "ok"; preview: SavedSegmentPreview; invalidated: boolean }
  | { kind: "unevaluable" }
  | { kind: "err"; failure: RemoteFailure };

export function validSavedSegmentPreview(
  value: SavedSegmentPreview | null | undefined,
): value is SavedSegmentPreview {
  const expectedPercentage =
    value && value.workspace_total > 0
      ? Math.round((value.count / value.workspace_total) * 1_000) / 10
      : 0;
  return Boolean(
    value &&
    typeof value.id === "string" &&
    Number.isSafeInteger(value.count) &&
    value.count >= 0 &&
    Number.isSafeInteger(value.workspace_total) &&
    value.workspace_total >= 0 &&
    value.count <= value.workspace_total &&
    Number.isFinite(value.workspace_percentage) &&
    value.workspace_percentage >= 0 &&
    value.workspace_percentage <= 100 &&
    Math.abs(value.workspace_percentage - expectedPercentage) < 0.05 &&
    typeof value.generated_at === "string" &&
    !Number.isNaN(Date.parse(value.generated_at)),
  );
}

export function savedPreviewIsStale(
  entry: SavedPreviewEntry | undefined,
  now = Date.now(),
): boolean {
  if (!entry || entry.kind !== "ok") return false;
  const generatedAt = Date.parse(entry.preview.generated_at);
  return (
    entry.invalidated ||
    generatedAt - now > SAVED_SEGMENT_PREVIEW_STALE_MS ||
    now - generatedAt > SAVED_SEGMENT_PREVIEW_STALE_MS
  );
}

export function savedCountIsStale(
  evaluatedAt: string | undefined,
  now = Date.now(),
): boolean {
  if (!evaluatedAt) return true;
  const timestamp = Date.parse(evaluatedAt);
  return (
    Number.isNaN(timestamp) ||
    timestamp - now > SAVED_SEGMENT_PREVIEW_STALE_MS ||
    now - timestamp > SAVED_SEGMENT_PREVIEW_STALE_MS
  );
}

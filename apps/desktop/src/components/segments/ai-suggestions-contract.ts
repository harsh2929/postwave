import type {
  AISuggestion,
  AISuggestionsResponse,
} from "./segmentsClient";

function isSuggestion(value: unknown): value is AISuggestion {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.key === "string" &&
    item.key.length > 0 &&
    typeof item.name === "string" &&
    typeof item.description === "string" &&
    typeof item.estimated_size === "number" &&
    Number.isFinite(item.estimated_size) &&
    item.estimated_size >= 0 &&
    typeof item.rationale === "string" &&
    typeof item.category === "string" &&
    Object.prototype.hasOwnProperty.call(item, "predicate_json")
  );
}

/** Reject successful-but-incompatible payloads before card rendering. */
export function parseAISuggestions(
  value: unknown,
): AISuggestionsResponse | null {
  if (!value || typeof value !== "object") return null;
  const envelope = value as Record<string, unknown>;
  if (
    !Array.isArray(envelope.items) ||
    !envelope.items.every(isSuggestion) ||
    typeof envelope.generated !== "string" ||
    typeof envelope.notice !== "string"
  ) {
    return null;
  }
  return envelope as unknown as AISuggestionsResponse;
}

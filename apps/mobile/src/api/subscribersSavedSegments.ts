/**
 * api/subscribersSavedSegments.ts — the WRITE half of the saved-segment
 * bookmarks (the read lives in hooks/useSavedSegments.ts).
 *
 *   POST   /api/v1/segments/saved              editor — create from the applied view
 *   POST   /api/v1/segments/saved/{id}/preview editor — stamp last_count for the badge
 *   DELETE /api/v1/segments/saved/{id}         editor — remove a bookmark
 *
 * Predicate building and the round-trip honesty rules live in
 * lib/subscriberSavedSegmentDraft.ts. This module is only the transport, kept
 * react-native-free (its one impure import is ./request) so the node vitest
 * run can pin the wire bodies with `rawRequest` mocked.
 *
 * UNWRAP BEFORE USING: `rawRequest` resolves to the {data, error} ENVELOPE
 * (api/request.ts:79), never the body. Errors are surfaced as throws so a
 * failed create can never look like a saved one.
 */
import { rawRequest } from "@/api/request";

const BASE = "/api/v1/segments/saved";

function surface(error: { message: string } | null, fallback: string): never {
  throw Object.assign(new Error(error?.message || fallback), error ?? {});
}

export interface CreateSavedSegmentInput {
  name: string;
  description: string;
  predicate: unknown;
  /** "personal" (default server-side) or "workspace". */
  visibilityScope: "personal" | "workspace";
}

/** Returns the created row's id ("" if the server answered an odd shape). */
export async function createSavedSegment(
  input: CreateSavedSegmentInput,
): Promise<string> {
  const res = await rawRequest<{ id?: unknown }>("POST", BASE, {
    name: input.name.trim(),
    description: input.description.trim(),
    predicate_json: input.predicate,
    visibility_scope: input.visibilityScope,
  });
  if (res.error) surface(res.error, "Couldn't save this view.");
  const id = res.data && typeof res.data.id === "string" ? res.data.id : "";
  return id;
}

/**
 * Stamp the new bookmark's live count so its chip shows a size instead of an
 * em-dash. Best-effort BY THE CALLER's choice — the create already succeeded,
 * so this failing must not be reported as a failed save.
 */
export async function previewSavedSegment(id: string): Promise<void> {
  const res = await rawRequest<unknown>(
    "POST",
    `${BASE}/${encodeURIComponent(id)}/preview`,
  );
  if (res.error) surface(res.error, "Couldn't preview the saved view.");
}

export async function deleteSavedSegment(id: string): Promise<void> {
  const res = await rawRequest<unknown>(
    "DELETE",
    `${BASE}/${encodeURIComponent(id)}`,
  );
  if (res.error) surface(res.error, "Couldn't delete the saved view.");
}

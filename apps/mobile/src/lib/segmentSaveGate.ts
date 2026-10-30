/**
 * segmentSaveGate — whether the "describe an audience" sheet may SAVE, and
 * the sentence that says why not.
 *
 * Kept separate from the compile/preview policy because the two ride
 * different scopes and conflating them is what would produce the wrong
 * screen. Read off the Go mount (apps/api/internal/segments/handlers.go):
 *
 *   POST /api/v1/segments/compile-from-text  read:subscribers  → every role
 *   POST /api/v1/segments/preview-count      read:subscribers  → every role
 *   POST /api/v1/segments                    write:subscribers → owner|admin|
 *                                                                editor
 *
 * `write:subscribers` is in `editorWriteScopes`
 * (apps/api/internal/apikeys/middleware.go), so an EDITOR can save — which is
 * why the role check is "editor", not "admin". Gating this on admin would
 * hide a button an editor is entitled to press.
 *
 * Ordering matters and mirrors `bulkAvailability` in
 * src/lib/subscriberSelection.ts: the most durable reason wins, so a viewer
 * who is also offline hears about their role (still true when the signal
 * returns) rather than the connection.
 *
 * Import-free so it is unit-tested.
 */

export interface SegmentSaveGate {
  canSave: boolean;
  /** Rendered as visible text beside the button, not only as a dim state. */
  reason?: string;
}

export function describeSaveGate(input: {
  /** canAccessMinimumRole("editor", role, mode). */
  hasWriteRole: boolean;
  online: boolean;
  /** True when the session is restored-but-unvalidated and must not write. */
  gated: boolean;
}): SegmentSaveGate {
  if (!input.hasWriteRole) {
    return {
      canSave: false,
      reason:
        "Saving a segment needs an editor role or higher. You can still check what an audience would match.",
    };
  }
  if (input.gated) {
    return {
      canSave: false,
      reason: "Reconnect this session before saving a segment.",
    };
  }
  if (!input.online) {
    return {
      canSave: false,
      // Deliberately not queued: the rule is compiled server-side against
      // live data, so a segment saved from a stale phone would encode a
      // definition nobody previewed.
      reason: "You're offline. Saving needs a connection.",
    };
  }
  return { canSave: true };
}

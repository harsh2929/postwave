/**
 * api/viewerMode.ts — PATCH /api/v1/auth/me/viewer-mode (SUB-091).
 *
 * A separate module rather than another function on src/api/auth.ts: that file
 * sits one line under its source-budget ratchet, and viewer preview is a
 * self-contained per-session affordance rather than part of the sign-in
 * pipeline.
 *
 * Wire facts (apps/api openapi.json, `authToggleViewerMode`):
 *   - session-cookie auth ONLY; an api-key install gets 401.
 *   - body { enabled: boolean, role?: "owner"|"admin"|"editor"|"viewer" }.
 *   - `role` must be a strict downgrade of the caller's durable role and is
 *     ignored when `enabled` is false, so we only ever send it on the way in.
 *   - the override is per-session and never mutates users.role; the resulting
 *     state surfaces as `effective_role` on GET /api/v1/auth/me, which is why
 *     callers must refresh the session profile after a successful toggle.
 */
import { rawRequest, type AIApiResult } from "./request";

export type ViewerPreviewRole = "owner" | "admin" | "editor" | "viewer";

export interface ViewerModeResponse {
  viewer_mode?: boolean;
  /** The caller's durable role — unchanged by this call. */
  role?: string;
  effective_role?: string;
}

export async function setViewerMode(
  enabled: boolean,
  role?: ViewerPreviewRole,
): Promise<AIApiResult<ViewerModeResponse>> {
  return rawRequest<ViewerModeResponse>(
    "PATCH",
    "/api/v1/auth/me/viewer-mode",
    { enabled, ...(enabled && role ? { role } : {}) },
  );
}

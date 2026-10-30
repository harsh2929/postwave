/**
 * api/suppressionMirror.ts — the transport for the ESP suppression mirror.
 *
 * POST /api/v1/suppressions/mirror/{provider}, admin
 * (main.go mounts MountX1MirrorRoutes inside RequireScope(ScopeAdmin)).
 *
 * The 503 `not_configured` reply is folded into the RESULT rather than thrown
 * — an unconfigured provider is an expected workspace state that renders as a
 * setup pointer (see lib/suppressionMirror.ts). Every other failure throws
 * with the status kept, so the sheet can tell a 403 permission rule apart
 * from a genuine fault.
 */
import {
  interpretMirrorFailure,
  parseMirrorResult,
  type MirrorOutcome,
} from "@/lib/suppressionMirror";

import { rawRequest, type AIApiError } from "./request";

export class SuppressionMirrorError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(error: AIApiError) {
    super(
      error.status === 403
        ? "Mirroring suppressions is restricted to workspace owners and admins."
        : error.message || "The mirror run failed.",
    );
    this.name = "SuppressionMirrorError";
    this.status = error.status;
    this.code = error.code;
  }
}

export async function runSuppressionMirror(
  provider: string,
): Promise<MirrorOutcome> {
  const res = await rawRequest<unknown>(
    "POST",
    `/api/v1/suppressions/mirror/${encodeURIComponent(provider)}`,
    {},
  );
  if (res.error) {
    const folded = interpretMirrorFailure(
      res.error.status,
      res.error.payload,
      provider,
    );
    if (folded) return folded;
    throw new SuppressionMirrorError(res.error);
  }
  return { kind: "imported", result: parseMirrorResult(res.data, provider) };
}

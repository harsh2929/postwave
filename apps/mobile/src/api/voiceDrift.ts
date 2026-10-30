/**
 * api/voiceDrift.ts — the pre-send voice-fidelity check.
 *
 *   POST /api/v1/voice/drift   (write:campaigns · session role >= editor)
 *
 * Registered at apps/api/main.go:4146 behind
 * `apikeys.RequireScope(apikeys.ScopeWriteCampaigns)`, and independently
 * evaluated by routeauth.Middleware against
 * apps/api/internal/routeauth/manifest.json, whose row for this path is
 * `{"session_minimum_role": "editor", "api_key_scopes": ["write:campaigns"],
 * "review_status": "reviewed"}`. Both floors agree at editor, so the caller
 * gates its affordance on `editor` — a viewer gets no button that could only
 * ever 403.
 *
 * The gateway enriches the request before proxying to services/voice: it maps
 * `html`/`text` onto the scorer's `body`, and attaches the tenant's ACTIVE
 * authored brand-voice profile (id + descriptors + banned terms derived from
 * the writing rules). That is why this module deliberately sends neither —
 * anything a client guessed here would be overridden or, worse, would score
 * against a profile the operator did not select.
 *
 * Response handling lives in lib/voiceDrift.ts so it stays unit-testable in
 * mobile's node vitest environment (this module reaches the SDK, which reaches
 * react-native, and can therefore never be imported by a .test.ts).
 */
import { rawRequest, type AIApiResult } from "./request";
import { readVoiceDrift, type VoiceDriftReading } from "@/lib/voiceDrift";

const PATH = "/api/v1/voice/drift";

export interface VoiceDriftInput {
  /** Weighted less than the body by the scorer, but included in the buffer. */
  subject?: string | undefined;
  /** The campaign body. HTML is fine — services/voice strips tags itself. */
  bodyHtml: string;
}

/**
 * Score a draft against the workspace's measured voice.
 *
 * Returns the normalised reading rather than the wire body: every caller wants
 * the same four-state verdict, and the "no voice profile" answer (a 200 that
 * looks like a perfect score) must not be re-derived per screen.
 */
export async function runVoiceDriftCheck(
  input: VoiceDriftInput,
): Promise<AIApiResult<VoiceDriftReading>> {
  const subject = (input.subject ?? "").trim();
  const body: Record<string, unknown> = {
    html: input.bodyHtml,
    ...(subject ? { subject } : {}),
  };
  const res = await rawRequest<unknown>("POST", PATH, body);
  if (res.error) return { data: null, error: res.error };
  return { data: readVoiceDrift(res.data), error: null };
}

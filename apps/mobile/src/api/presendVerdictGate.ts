/**
 * api/presendVerdictGate.ts — the send sheet's BODY-ONLY pre-send verdict.
 *
 *   POST /api/v1/presend/verdict   (write:campaigns · session role >= editor)
 *
 * Mounted at apps/api/internal/presend/verdict.go:116 behind
 * `apikeys.RequireScope(apikeys.ScopeWriteCampaigns)`; routeauth/manifest.json
 * carries `{"session_minimum_role": "editor", "api_key_scopes":
 * ["write:campaigns"]}` for the path. Both floors agree at editor, so the
 * card gates its affordance on `editor`.
 *
 * WHY A SECOND TRANSPORT FOR THE SAME PATH. api/campaignPresend.ts's
 * requestPresendVerdict always sends `campaign_id`, and verdict.go treats a
 * campaign id WITHOUT content_revision_id + source_hash as an explicit failed
 * `campaign_assurance` component (campaignAssuranceCampaignOnly →
 * "No frozen Campaign Assurance run is available for this campaign."), which
 * forces every non-critical verdict to `incomplete`. The send sheet knows
 * neither the revision id nor the hash, so it asks the generic body-only
 * question desktop asks (PresendCheckPanel.tsx:407 — subject/from/html) and
 * lets the sheet's own CampaignAssuranceSendStatus carry the assurance leg.
 *
 * `text` is deliberately NOT mirrored from desktop: eqscore counts link
 * domains across HTML and Text together (content.go:124-133), so sending the
 * body twice double-counts every link.
 *
 * Response handling lives in lib/campaignVerdict.ts + lib/presendVerdictGate.ts
 * (node-pure); this module reaches the SDK and cannot be imported by a .test.ts.
 */
import { rawRequest, type AIApiResult } from "./request";

const PATH = "/api/v1/presend/verdict";

export interface DraftPresendVerdictInput {
  subject: string;
  /** The campaign body. HTML is fine — every leg strips tags itself. */
  html: string;
  /** A bare address (lib/presendVerdictGate.presendFromAddress). */
  from: string;
}

/** Ask for one verdict on a draft — no campaign identity, no assurance leg. */
export async function requestDraftPresendVerdict(
  input: DraftPresendVerdictInput,
): Promise<AIApiResult<unknown>> {
  return rawRequest<unknown>("POST", PATH, {
    subject: input.subject,
    html: input.html,
    from: input.from,
  });
}

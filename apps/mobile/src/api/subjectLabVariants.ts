/**
 * api/subjectLabVariants.ts — POST /api/v1/subject-lab/variants.
 *
 * A separate module from api/subjectLab.ts (the two READS) because the
 * authorization story is not the same one, and collapsing them would bury the
 * difference:
 *
 *   buckets   mount read:reports (subject_analyzer.go)
 *             manifest session_minimum_role "viewer"       → viewer
 *   score     mount write:campaigns (subject_lab.go MountRoutes)
 *             manifest session_minimum_role "editor"       → editor
 *   variants  mount write:campaigns (subject_lab.go MountRoutes)
 *             manifest session_minimum_role "editor"       → editor
 *             PLUS the per-tenant `subject_lab` feature flag, off by default
 *
 * Both gates were re-measured for this route rather than inherited from its
 * sibling: apps/api authorises twice — `apikeys.RequireScope(...)` at the
 * mount site and `routeauth.Middleware` reading routeauth/manifest.json
 * (middleware.go enforces `session_minimum_role` independently) — and only
 * the stricter of the two is the real floor.
 *
 * THE FLAG IS NOT A ROLE AND IS NOT A RELEASE HOLD. `/variants` is the
 * LLM-spend endpoint, so it is opt-in per tenant and answers a workspace that
 * does not have it with the shared entitlement envelope (`reason: "flag"`,
 * `remedy: "contact_workspace_admin"`), which mobile's lib/denialEnvelope
 * already turns into the right sentence. There is no probe for it, so the
 * control is offered and the refusal is rendered — hiding it in advance would
 * lie to every workspace that DOES have the flag.
 *
 * Response shaping lives in lib/subjectLabVariants.ts — this module reaches
 * the SDK (and therefore react-native), so it can never be imported by a
 * .test.ts in mobile's node vitest environment.
 */
import { rawRequest, type AIApiResult } from "./request";
import {
  clampVariantCount,
  readSubjectVariants,
  type SubjectLabAxis,
  type SubjectVariantsReading,
} from "@/lib/subjectLabVariants";

export interface SubjectVariantsInput {
  seedSubject: string;
  axis: SubjectLabAxis;
  count?: number;
  /**
   * A REAL brand-voice profile id, or nothing. Never lib/aiVoiceProfile's
   * "active" sentinel.
   *
   * This route does not resolve the field, it prints it: subject_lab.go passes
   * it to `ComposeVariantsInput.ProfileID`, and aicompose's
   * `profileBindingExtra` (aicompose.go:441-447) emits the literal context line
   * "Bound brand voice profile: " + id. The sentinel is a contract of the CHAT
   * `context_refs` path (`renderVoiceProfileRef`), which never reads the id at
   * all, and it means nothing here.
   *
   * Omitting it loses no conditioning. `ContextText` calls
   * `loadBrandVoice(ctx, tenantID, tone)` (aicompose.go:420-422) regardless of
   * this field, so the tenant's authored voice — descriptors, writing rules,
   * sample snippets and its real id — is already in the context block. The
   * field only exists to record an EXPLICIT binding (G10) when a caller has
   * chosen a specific profile, which is why desktop sends it solely when
   * `getBrandVoiceProfile()` came back `is_active`
   * (apps/desktop/src/components/SubjectLab.tsx:577). Mobile's panel has no
   * profile picker, so it sends nothing.
   */
  voiceProfileId?: string;
}

export async function generateSubjectVariants(
  input: SubjectVariantsInput,
): Promise<AIApiResult<SubjectVariantsReading>> {
  const res = await rawRequest<unknown>("POST", "/api/v1/subject-lab/variants", {
    seed_subject: input.seedSubject.trim(),
    axis: input.axis,
    count: clampVariantCount(input.count),
    ...(input.voiceProfileId
      ? { voice_profile_id: input.voiceProfileId }
      : {}),
  });
  if (res.error) return { data: null, error: res.error };
  return { data: readSubjectVariants(res.data), error: null };
}

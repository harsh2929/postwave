/**
 * api/brandVoice.ts — the operator-AUTHORED brand voice profile.
 *
 *   GET /api/v1/voice/brand-profile   (read:campaigns)  → 200 Profile | 404
 *   PUT /api/v1/voice/brand-profile   (admin)           → 200 Profile
 *
 * Registered by apiserver.MountBrandVoiceRoutes (apps/api/main.go:3892), with
 * the handlers in apps/api/internal/brand_voice/brand_voice.go:78-80.
 *
 * A 404 means "this tenant has authored nothing yet" (brand_voice.go:147), not
 * "the endpoint is missing", so the read helper resolves it to `null` data
 * with a `notFound` flag instead of an error the UI would render as a fault.
 * 405/501 remain errors — those are the deployment-doesn't-have-it statuses.
 *
 * PUT is a FULL REPLACE of all three arrays (brand_voice.go:159-176 rebuilds
 * the row from the request body). Every caller must therefore send back the
 * sample snippets it read, or editing two descriptors silently deletes ten
 * snippets. `putBrandVoiceProfile` takes all three for exactly that reason —
 * there is no partial form of this write.
 */
import { rawRequest, type AIApiResult } from "./request";
import type { BrandVoiceProfileWire } from "@/lib/brandVoice";

const PATH = "/api/v1/voice/brand-profile";

export interface BrandVoiceReadResult {
  profile: BrandVoiceProfileWire | null;
  /** True when the server answered 404 — authored nothing yet. */
  notFound: boolean;
  error: AIApiResult<BrandVoiceProfileWire>["error"];
}

export async function getBrandVoiceProfile(): Promise<BrandVoiceReadResult> {
  const res = await rawRequest<BrandVoiceProfileWire>("GET", PATH);
  if (res.error) {
    if (res.error.status === 404) {
      return { profile: null, notFound: true, error: null };
    }
    return { profile: null, notFound: false, error: res.error };
  }
  return { profile: res.data, notFound: false, error: null };
}

export function putBrandVoiceProfile(input: {
  descriptors: string[];
  writing_rules: string[];
  sample_snippets: string[];
}): Promise<AIApiResult<BrandVoiceProfileWire>> {
  return rawRequest<BrandVoiceProfileWire>("PUT", PATH, input);
}

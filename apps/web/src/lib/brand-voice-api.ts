// SPDX-License-Identifier: AGPL-3.0-only
/**
 * lib/brand-voice-api.ts — the tenant-wide brand-voice profile.
 *
 *   GET /api/v1/voice/brand-profile   (read_campaigns) — 404 means "no profile yet"
 *   PUT /api/v1/voice/brand-profile   (admin)          — upsert of the three lists
 *
 * The read keeps two things apart that a lenient spread would merge: that a
 * profile EXISTS (any 200) and that its lists could be VERIFIED for editing.
 * A profile whose lists fail the bounds below still reads as active — AI
 * compose is using it — but the editor must not seed a replacement from it,
 * because saving would overwrite values it never showed.
 */
import { api, isApiError } from "@/lib/api";

/** Server caps (apps/api/internal/brand_voice). Bytes, not characters. */
export const BRAND_VOICE_LIMITS = {
  descriptors: 20,
  writingRules: 30,
  sampleSnippets: 10,
  descriptorBytes: 64,
  ruleBytes: 512,
  snippetBytes: 4096,
} as const;

export interface BrandVoiceProfileFields {
  descriptors: string[];
  writingRules: string[];
  sampleSnippets: string[];
}

export interface VerifiedBrandVoiceProfile extends BrandVoiceProfileFields {
  updatedAt: string | null;
  extractedAt: string | null;
}

export type BrandVoiceProfileRead =
  | { active: false }
  | {
      active: true;
      /** Display label when the server sends one; the profile has no name field today. */
      name: string | null;
      /** Null when the lists could not be verified; editing is then withheld. */
      profile: VerifiedBrandVoiceProfile | null;
    };

export class BrandVoiceContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrandVoiceContractError";
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function stringList(
  value: unknown,
  maxItems: number,
  maxBytes: number,
): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (utf8Bytes(trimmed) > maxBytes) return null;
    out.push(trimmed);
  }
  return out;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return Number.isFinite(Date.parse(value)) && !value.startsWith("0001-01-01")
    ? value
    : null;
}

/** Strict decode of the server Profile; null when any list is out of contract. */
export function decodeBrandVoiceProfile(
  raw: unknown,
): VerifiedBrandVoiceProfile | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const descriptors = stringList(
    row["descriptors"],
    BRAND_VOICE_LIMITS.descriptors,
    BRAND_VOICE_LIMITS.descriptorBytes,
  );
  const writingRules = stringList(
    row["writing_rules"],
    BRAND_VOICE_LIMITS.writingRules,
    BRAND_VOICE_LIMITS.ruleBytes,
  );
  const sampleSnippets = stringList(
    row["sample_snippets"],
    BRAND_VOICE_LIMITS.sampleSnippets,
    BRAND_VOICE_LIMITS.snippetBytes,
  );
  if (!descriptors || !writingRules || !sampleSnippets) return null;
  return {
    descriptors,
    writingRules,
    sampleSnippets,
    updatedAt: timestamp(row["updated_at"]),
    extractedAt: timestamp(row["extracted_at"]),
  };
}

/**
 * The first reason these lists cannot be saved, or null. Mirrors the server
 * validation (1..20 descriptors, 0..30 rules, 0..10 samples) and its per-item
 * byte caps, which the server would otherwise enforce by silently truncating.
 */
export function brandVoiceValidationError(
  fields: BrandVoiceProfileFields,
): string | null {
  const { descriptors, writingRules, sampleSnippets } = fields;
  const L = BRAND_VOICE_LIMITS;
  const oversize = (values: string[], max: number) =>
    values.findIndex((value) => utf8Bytes(value) > max) + 1;
  if (descriptors.length < 1) return "Add at least one descriptor before saving.";
  if (descriptors.length > L.descriptors) {
    return `Reduce descriptors to ${L.descriptors} or fewer.`;
  }
  const descriptor = oversize(descriptors, L.descriptorBytes);
  if (descriptor) {
    return `Descriptor ${descriptor} exceeds the ${L.descriptorBytes}-byte limit.`;
  }
  if (writingRules.length > L.writingRules) {
    return `Reduce writing rules to ${L.writingRules} or fewer.`;
  }
  const rule = oversize(writingRules, L.ruleBytes);
  if (rule) return `Writing rule ${rule} exceeds the ${L.ruleBytes}-byte limit.`;
  if (sampleSnippets.length > L.sampleSnippets) {
    return `Reduce sample snippets to ${L.sampleSnippets} or fewer.`;
  }
  const snippet = oversize(sampleSnippets, L.snippetBytes);
  if (snippet) {
    return `Sample snippet ${snippet} exceeds the ${L.snippetBytes.toLocaleString()}-byte limit.`;
  }
  return null;
}

export async function readBrandVoiceProfile(
  options: { signal?: AbortSignal } = {},
): Promise<BrandVoiceProfileRead> {
  let raw: unknown;
  try {
    raw = await api.get<unknown>("/api/v1/voice/brand-profile", {
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    // "No active profile" is an ordinary state, not a failed read.
    if (isApiError(error) && error.status === 404) return { active: false };
    throw error;
  }
  const row =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const name = typeof row["name"] === "string" ? row["name"].trim() : "";
  return {
    active: true,
    name: name || null,
    profile: decodeBrandVoiceProfile(raw),
  };
}

/**
 * PUT the complete three-list profile. One attempt and never queued offline;
 * the save is a whole-profile replacement, so a stale queued copy would
 * overwrite whatever an administrator saved in between.
 */
export async function saveBrandVoiceProfile(
  fields: BrandVoiceProfileFields,
): Promise<VerifiedBrandVoiceProfile> {
  const invalid = brandVoiceValidationError(fields);
  if (invalid) throw new BrandVoiceContractError(invalid);
  const raw = await api.put<unknown>(
    "/api/v1/voice/brand-profile",
    {
      descriptors: fields.descriptors,
      writing_rules: fields.writingRules,
      sample_snippets: fields.sampleSnippets,
    },
    { requireOnline: true, maxAttempts: 1 },
  );
  const saved = decodeBrandVoiceProfile(raw);
  if (!saved) {
    throw new BrandVoiceContractError(
      "The server accepted the request, but its response couldn't be verified. Reload the profile before making another change.",
    );
  }
  return saved;
}

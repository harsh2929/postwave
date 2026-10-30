import {
  vaultDelete,
  vaultReadJSON,
  vaultSetJSON,
} from "../../lib/secure-vault";
import type { CampaignDraft } from "./campaigns-page-utils";

const LEGACY_CAMPAIGN_DRAFT_KEY = "lifecycle-draft:campaign-create:v1";
const CAMPAIGN_DRAFT_KEY_PREFIX = "lifecycle-draft:campaign-create:v2";
const IDENTITY_SCOPE_RE = /^[a-f0-9]{16}$/u;
const MAX_DRAFT_BYTES = 500 * 1024;
export const CAMPAIGN_DRAFT_FIELD_LIMITS: Record<keyof CampaignDraft, number> =
  {
    body: 480 * 1024,
    fromEmail: 254,
    name: 256,
    previewText: 200,
    subject: 998,
  };

export type CampaignDraftRead =
  | { status: "ready"; draft: CampaignDraft }
  | { status: "missing" | "unavailable" | "invalid-identity" | "invalid" };

export function campaignDraftJournalKey(
  identityScope: string | null,
): string | null {
  return identityScope && IDENTITY_SCOPE_RE.test(identityScope)
    ? `${CAMPAIGN_DRAFT_KEY_PREFIX}:${identityScope}`
    : null;
}

export function sanitizeCampaignDraft(value: unknown): CampaignDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<Record<keyof CampaignDraft, unknown>>;
  const draft = {} as CampaignDraft;
  for (const field of Object.keys(CAMPAIGN_DRAFT_FIELD_LIMITS) as Array<
    keyof CampaignDraft
  >) {
    const fieldValue = candidate[field];
    if (
      typeof fieldValue !== "string" ||
      fieldValue.length > CAMPAIGN_DRAFT_FIELD_LIMITS[field] ||
      /[\u0000]/u.test(fieldValue)
    ) {
      return null;
    }
    draft[field] = fieldValue;
  }
  return new TextEncoder().encode(JSON.stringify(draft)).byteLength <=
    MAX_DRAFT_BYTES
    ? draft
    : null;
}

/** The v1 key has no ownership proof, so it is deleted without adoption. */
export function purgeAmbiguousCampaignDraft(): void {
  try {
    vaultDelete(LEGACY_CAMPAIGN_DRAFT_KEY);
  } catch {
    /* storage unavailable */
  }
}

export async function readCampaignDraft(
  identityScope: string | null,
): Promise<CampaignDraftRead> {
  const key = campaignDraftJournalKey(identityScope);
  if (!key) return { status: "invalid-identity" };
  const result = await vaultReadJSON<unknown>(key);
  if (result.status === "corrupt") return { status: "invalid" };
  if (result.status !== "ready") return result;
  const draft = sanitizeCampaignDraft(result.value);
  if (draft) return { status: "ready", draft };
  vaultDelete(key);
  return { status: "invalid" };
}

export async function writeCampaignDraft(
  identityScope: string | null,
  value: CampaignDraft,
): Promise<CampaignDraft> {
  const key = campaignDraftJournalKey(identityScope);
  if (!key) throw new Error("Campaign draft identity is unavailable.");
  const draft = sanitizeCampaignDraft(value);
  if (!draft) throw new Error("Campaign draft is too large or invalid.");
  await vaultSetJSON(key, draft);
  return draft;
}

export function deleteCampaignDraft(identityScope: string | null): void {
  const key = campaignDraftJournalKey(identityScope);
  if (key) vaultDelete(key);
}

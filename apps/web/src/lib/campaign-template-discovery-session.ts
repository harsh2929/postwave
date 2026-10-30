// SPDX-License-Identifier: AGPL-3.0-only

import {
  CAMPAIGN_TEMPLATE_DISCOVERY_SESSION_PREFIX,
  type CampaignTemplateDiscoveryCreateOperation,
} from "./campaign-template-session-cleanup";

export { clearCampaignTemplateDiscoveryCreateRecovery } from "./campaign-template-session-cleanup";

const PREFIX = CAMPAIGN_TEMPLATE_DISCOVERY_SESSION_PREFIX;
const MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_FINGERPRINT_LENGTH = 4_096;

export type { CampaignTemplateDiscoveryCreateOperation } from "./campaign-template-session-cleanup";

export interface CampaignTemplateDiscoveryCreateRecovery {
  version: 1;
  fingerprint: string;
  key: string;
  updatedAt: number;
}

function storageOrNull(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function storageKey(operation: CampaignTemplateDiscoveryCreateOperation) {
  return `${PREFIX}:${operation}`;
}

function validRecovery(
  value: unknown,
): value is CampaignTemplateDiscoveryCreateRecovery {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    typeof candidate.fingerprint === "string" &&
    candidate.fingerprint.length > 0 &&
    candidate.fingerprint.length <= MAX_FINGERPRINT_LENGTH &&
    typeof candidate.key === "string" &&
    candidate.key.length > 0 &&
    !/[\u0000-\u001f\u007f]/.test(candidate.key) &&
    new TextEncoder().encode(candidate.key).byteLength <= 255 &&
    typeof candidate.updatedAt === "number" &&
    Number.isFinite(candidate.updatedAt) &&
    candidate.updatedAt <= Date.now() + 60_000 &&
    Date.now() - candidate.updatedAt <= MAX_AGE_MS
  );
}

export function readCampaignTemplateDiscoveryCreateRecovery(
  operation: CampaignTemplateDiscoveryCreateOperation,
): CampaignTemplateDiscoveryCreateRecovery | null {
  const storage = storageOrNull();
  if (!storage) return null;
  const key = storageKey(operation);
  const raw = storage.getItem(key);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (validRecovery(value)) return value;
  } catch {
    // Invalid or truncated browser state is discarded below.
  }
  storage.removeItem(key);
  return null;
}

export function writeCampaignTemplateDiscoveryCreateRecovery(
  operation: CampaignTemplateDiscoveryCreateOperation,
  input: Pick<CampaignTemplateDiscoveryCreateRecovery, "fingerprint" | "key">,
): CampaignTemplateDiscoveryCreateRecovery | null {
  const value: CampaignTemplateDiscoveryCreateRecovery = {
    version: 1,
    fingerprint: input.fingerprint,
    key: input.key,
    updatedAt: Date.now(),
  };
  if (!validRecovery(value)) return null;
  const storage = storageOrNull();
  if (!storage) return value;
  try {
    storage.setItem(storageKey(operation), JSON.stringify(value));
  } catch {
    // Recovery is helpful, but privacy settings/quota must not block a create.
  }
  return value;
}

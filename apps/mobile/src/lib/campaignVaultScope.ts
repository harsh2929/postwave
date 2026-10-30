/**
 * lib/campaignVaultScope.ts — the encrypted-vault identity scope the campaign
 * snapshots are written under.
 *
 * Split out of the hook file, which was over its size budget. Scoping on
 * baseUrl + tenant + user + ROLE is what stops a snapshot written by one
 * identity being served to another on a shared device — the offline
 * identity-hygiene property mobile already holds for subscribers and audit,
 * and which the campaigns screens opted out of by having no snapshot at all.
 */
import { vaultScopeForClient } from "@/lib/secureVault";

export interface CampaignVaultIdentity {
  baseUrl: string | null;
  tenantId: string | null;
  userId: string | null;
  effectiveRole: string | null;
}

/** The scope string, or null when any component of the identity is missing. */
export function campaignVaultScope(
  gate: CampaignVaultIdentity,
): string | null {
  if (!gate.baseUrl || !gate.tenantId || !gate.userId || !gate.effectiveRole) {
    return null;
  }
  return vaultScopeForClient({
    baseUrl: gate.baseUrl,
    tenantId: gate.tenantId,
    userId: gate.userId,
    role: gate.effectiveRole,
  });
}

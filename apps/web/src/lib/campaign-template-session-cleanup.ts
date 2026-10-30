// SPDX-License-Identifier: AGPL-3.0-only

import { TEMPLATE_EDITOR_RECOVERY_PREFIX } from "@/lib/template-editor-recovery";

export const CAMPAIGN_TEMPLATE_DESIGN_SESSION_PREFIX =
  "postwave:campaign-template-design:v2";
export const CAMPAIGN_TEMPLATE_DISCOVERY_SESSION_PREFIX =
  "postwave:campaign-template-discovery-create:v1";

function storageOrNull(kind: "local" | "session"): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function clearAllCampaignTemplateDesignSessions(): void {
  const storage = storageOrNull("local");
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(`${CAMPAIGN_TEMPLATE_DESIGN_SESSION_PREFIX}:`)) {
        keys.push(key);
      }
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // Scope-keyed reads still prevent adoption after an identity switch.
  }
}

export type CampaignTemplateDiscoveryCreateOperation =
  | "collection"
  | "saved-search";

export function clearCampaignTemplateDiscoveryCreateRecovery(
  operation?: CampaignTemplateDiscoveryCreateOperation,
): void {
  const storage = storageOrNull("session");
  if (!storage) return;
  const key = (value: CampaignTemplateDiscoveryCreateOperation) =>
    `${CAMPAIGN_TEMPLATE_DISCOVERY_SESSION_PREFIX}:${value}`;
  if (operation) {
    storage.removeItem(key(operation));
    return;
  }
  storage.removeItem(key("collection"));
  storage.removeItem(key("saved-search"));
}

export function clearAllTemplateEditorRecovery(): void {
  const storage = storageOrNull("session");
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(`${TEMPLATE_EDITOR_RECOVERY_PREFIX}:`))
        keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // Draft keys also include the actor and workspace, so a new login never
    // offers another user's recovery even if storage access is denied.
  }
}

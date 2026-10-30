// SPDX-License-Identifier: AGPL-3.0-only

export interface RecoverableTemplateDraft {
  name: string;
  subject: string;
  previewText: string;
  description: string;
  category: string;
  goal: string;
  tagsInput: string;
  bodyHtml: string;
  bodyMjml: string;
  variables: string;
  linkedBlocks?: string;
}

// A single authored body can be up to 1 MiB at the API boundary. Leave room
// for metadata/variables while still refusing unbounded browser storage.
const MAX_DRAFT_BYTES = 1_600_000;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const TEMPLATE_EDITOR_RECOVERY_PREFIX = "moosewave:template-draft:v1";

export function browserTemplateRecoveryStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function templateRecoveryKey(input: {
  tenantId: string;
  userId: string;
  templateId: string;
  etag?: string;
}): string {
  // Never mix a different actor, workspace, template, or server revision.
  return `${TEMPLATE_EDITOR_RECOVERY_PREFIX}:${encodeURIComponent(input.tenantId)}:${encodeURIComponent(input.userId)}:${encodeURIComponent(input.templateId)}:${encodeURIComponent(input.etag ?? "new")}`;
}

export function readTemplateRecovery(
  storage: Storage,
  key: string,
): RecoverableTemplateDraft | null {
  try {
    const raw = storage.getItem(key);
    if (!raw || raw.length > MAX_DRAFT_BYTES) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.savedAt !== "number" ||
      !Number.isFinite(record.savedAt) ||
      record.savedAt > Date.now() ||
      Date.now() - record.savedAt > MAX_AGE_MS
    )
      return null;
    const fields = [
      "name",
      "subject",
      "previewText",
      "description",
      "category",
      "goal",
      "tagsInput",
      "bodyHtml",
      "bodyMjml",
      "variables",
    ] as const;
    if (fields.some((field) => typeof record[field] !== "string")) return null;
    const recovered = Object.fromEntries(
      fields.map((field) => [field, record[field]]),
    ) as unknown as RecoverableTemplateDraft;
    if (typeof record.linkedBlocks === "string" && record.linkedBlocks.length <= 200_000) {
      recovered.linkedBlocks = record.linkedBlocks;
    }
    return recovered;
  } catch {
    return null;
  }
}

export function writeTemplateRecovery(
  storage: Storage,
  key: string,
  draft: RecoverableTemplateDraft,
): boolean {
  try {
    const value = JSON.stringify({ ...draft, savedAt: Date.now() });
    if (value.length > MAX_DRAFT_BYTES) return false;
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function clearTemplateRecovery(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Storage can be unavailable in private browsing or hardened contexts.
  }
}

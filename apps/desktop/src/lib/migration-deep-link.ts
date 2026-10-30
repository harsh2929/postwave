import type { MigrationSourceId } from "./migration-sources";

export interface PendingMigrationApiKeyReturn {
  source: MigrationSourceId;
  state?: string;
}

const MIGRATION_SOURCE_IDS: ReadonlySet<string> = new Set([
  "mailchimp",
  "klaviyo",
  "customerio",
  "constant-contact",
  "aweber",
  "drip",
  "campaign-monitor",
  "omnisend",
  "loops",
  "flodesk",
  "bento",
  "activecampaign",
  "substack",
  "beehiiv",
  "convertkit",
  "mailerlite",
  "brevo",
  "hubspot",
  "sendy",
  "csv",
  "other",
]);

let pendingMigrationApiKeyReturn: PendingMigrationApiKeyReturn | null = null;

export function setPendingMigrationApiKeyReturn(
  pending: PendingMigrationApiKeyReturn,
): void {
  pendingMigrationApiKeyReturn = pending;
}

export function consumePendingMigrationApiKeyReturn(): PendingMigrationApiKeyReturn | null {
  const pending = pendingMigrationApiKeyReturn;
  pendingMigrationApiKeyReturn = null;
  return pending;
}

export function parseMigrationApiKeyReturn(
  path: string | null,
): PendingMigrationApiKeyReturn | null {
  if (!path) return null;
  try {
    const parsed = new URL(path, "https://postwave.local");
    if (parsed.pathname !== "/app/migrations/api-key") return null;
    const source = parsed.searchParams.get("source");
    if (!isMigrationSourceId(source)) return null;
    const state = parsed.searchParams.get("state")?.trim() || undefined;
    return state ? { source, state } : { source };
  } catch {
    return null;
  }
}

export function isMigrationSourceId(
  value: string | null | undefined,
): value is MigrationSourceId {
  return typeof value === "string" && MIGRATION_SOURCE_IDS.has(value);
}

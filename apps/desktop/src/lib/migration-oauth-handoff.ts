import type { MigrationSource } from "./api-client";

/**
 * Build the hosted, actor-authenticated migration task URL used for OAuth.
 *
 * The desktop deliberately delegates the complete OAuth migration task. It
 * does not infer ownership by scanning tenant-wide jobs: without an
 * actor-bound, one-time handoff receipt, even a single newly observed job may
 * belong to another administrator in the same workspace.
 */
export function migrationOAuthDelegationURL(
  dashboardBaseURL: string,
  source: MigrationSource,
): string {
  const target = new URL(
    `/app/migrations/new/${encodeURIComponent(source)}`,
    `${dashboardBaseURL.replace(/\/$/u, "")}/`,
  );
  target.searchParams.set("desktop_mode", "delegated");
  return target.toString();
}

/**
 * lib/migrationListItems.ts — which of the five states each section of the
 * Migrations screen is in, as data rather than as JSX.
 *
 * Lifted out of the route file for a measurable reason rather than a stylistic
 * one: adding the offline rung (GOVERNANCE#33) pushed `Migrations` past the
 * repo's 300-line function ceiling, and the honest fix for a screen that has
 * genuinely gained a state is to name the states, never to raise the ceiling.
 *
 * The ladder is the same one `components/QueryStates` enforces for the rest of
 * the app, in the same order, and the order is the whole point:
 *
 *   1. LOADING first, and only on a first load.
 *   2. ERROR before empty — a failed fetch is never "nothing here".
 *   3. OFFLINE-with-nothing-cached before empty, and distinct from error:
 *      nothing is broken, the device just has not asked.
 *   4. EMPTY only when a fetch genuinely succeeded and returned nothing.
 *   5. A NARROWED empty ("no jobs in this state") is its own item, because it
 *      is about the FILTER and the reader has learned something true.
 *
 * The screen keeps a SectionList rather than QueryStates because it renders two
 * independent sections whose states differ; this module is the shared decision
 * those sections were missing.
 *
 * Import-free of react-native/expo, so the ladder is unit-tested under node.
 */
// Imported from the DECLARATION site, not the `@/api/client` barrel: that
// barrel is eager (it evaluates the SSE transport and the AI streaming client
// on import) and `src/lib` is on the startup path, which
// `startupImportBudget.test.ts` guards by text — a type-only import through it
// would still trip the guard, and rightly so, because the next edit that needs
// a VALUE from the same line would silently put the barrel on the boot path.
import type { MobileMigrationJob, MobileMigrationSource } from "@/api/ops";
import type { MobileMailchimpParitySnapshot } from "@/api/mobileParity";

export type MigrationListItem =
  | { kind: "job"; key: string; job: MobileMigrationJob }
  | { kind: "source"; key: string; source: MobileMigrationSource }
  | {
      kind: "parity";
      key: string;
      snapshot: MobileMailchimpParitySnapshot;
    }
  | {
      kind: "empty";
      key: string;
      title: string;
      description: string;
      cta?: { label: string; onPress: () => void };
    }
  | { kind: "error"; key: string; error: unknown; onRetry: () => void }
  | { kind: "loading"; key: string };

export interface MigrationCopy {
  title: string;
  description: string;
}

export interface MigrationJobItemsInput {
  /** Rows actually held, cached ones included. */
  rows: readonly MobileMigrationJob[];
  /** `rows` narrowed by the active status chip. */
  filteredRows: readonly MobileMigrationJob[];
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  /** Offline copy, or null when the gate is open. */
  offline: MigrationCopy | null;
  onRetry: () => void;
  onShowAll: () => void;
}

export function buildMigrationJobItems(
  input: MigrationJobItemsInput,
): MigrationListItem[] {
  if (input.isLoading) return [{ kind: "loading", key: "jobs-loading" }];
  // Only blank the list to a full ErrorState when there is nothing cached to
  // keep on screen. When a background poll fails but we still hold the last
  // successful rows (useMobileMigrations polls every 5s while a job runs), keep
  // the job cards and surface the failure via a slim StaleDataBanner in the
  // list header instead — matching inbound-webhooks.tsx.
  if (input.isError && input.rows.length === 0) {
    return [
      {
        kind: "error",
        key: "jobs-error",
        error: input.error,
        onRetry: input.onRetry,
      },
    ];
  }
  if (input.offline && input.rows.length === 0) {
    return [{ kind: "empty", key: "jobs-offline", ...input.offline }];
  }
  if (input.rows.length === 0) {
    return [
      {
        kind: "empty",
        key: "jobs-empty",
        title: "No migration jobs",
        description:
          "Start migrations from desktop; their progress will appear here.",
      },
    ];
  }
  if (input.filteredRows.length === 0) {
    return [
      {
        kind: "empty",
        key: "jobs-filter-empty",
        title: "No matching jobs",
        description: "No jobs in this state. Try a different filter.",
        cta: { label: "Show all", onPress: input.onShowAll },
      },
    ];
  }
  return input.filteredRows.map((job) => ({
    kind: "job",
    key: `job-${job.id}`,
    job,
  }));
}

export interface MigrationSourceItemsInput {
  rows: readonly MobileMigrationSource[];
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  offline: MigrationCopy | null;
  onRetry: () => void;
}

export function buildMigrationSourceItems(
  input: MigrationSourceItemsInput,
): MigrationListItem[] {
  if (input.isLoading) return [{ kind: "loading", key: "sources-loading" }];
  if (input.isError) {
    return [
      {
        kind: "error",
        key: "sources-error",
        error: input.error,
        onRetry: input.onRetry,
      },
    ];
  }
  if (input.offline && input.rows.length === 0) {
    return [{ kind: "empty", key: "sources-offline", ...input.offline }];
  }
  if (input.rows.length === 0) {
    return [
      {
        kind: "empty",
        key: "sources-empty",
        title: "No source matrix",
        description: "Migration adapter capabilities are unavailable.",
      },
    ];
  }
  return input.rows.map((source) => ({
    kind: "source",
    key: `source-${source.source}`,
    source,
  }));
}

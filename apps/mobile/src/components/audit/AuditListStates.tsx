/**
 * AuditListStates — the audit list's header stack and its empty branch.
 *
 * Lifted out of the route file for a measurable reason rather than a
 * stylistic one: the screen's five nested "is this offline / errored /
 * narrowed / first-load" ternaries pushed `Audit` past the repo's cyclomatic
 * ceiling once the tail banner and the saved-view bar landed. Each branch here
 * is a genuine state of a compliance surface, so the fix is to name them, not
 * to raise the ceiling.
 */
import { View } from "react-native";

import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { SkeletonList } from "@/components/Skeleton";
import { StaleDataBanner } from "@/components/StaleDataBanner";
import { AuditActivityCard } from "@/components/audit/AuditActivityCard";
import { AuditCheckpointBanner } from "@/components/audit/AuditCheckpointBanner";
import { AuditTailBanner } from "@/components/audit/AuditTailBanner";
import { governanceEmptyCopy } from "@/lib/governanceEmptyStates";
import type { AuditTailState } from "@/lib/auditTail";
import type { AuditActivitySummary } from "@/lib/auditStats";
import type { AuditCheckpoint } from "@/hooks/useAudit";

export interface AuditListHeaderProps {
  firstLoad: boolean;
  online: boolean;
  loadedCount: number;
  listErrored: boolean;
  onRetry: () => void;
  tail: AuditTailState;
  onLoadNew: () => void;
  activity: AuditActivitySummary;
  activityLoading: boolean;
  checkpoint: AuditCheckpoint | null;
  checkpointLoading: boolean;
}

export function AuditListHeader({
  firstLoad,
  online,
  loadedCount,
  listErrored,
  onRetry,
  tail,
  onLoadNew,
  activity,
  activityLoading,
  checkpoint,
  checkpointLoading,
}: AuditListHeaderProps) {
  if (firstLoad) return <SkeletonList rows={6} />;
  return (
    <View style={{ gap: 8, marginBottom: 8 }}>
      <AuditTailBanner tail={tail} onLoad={onLoadNew} />
      {!online && loadedCount > 0 ? (
        <StaleDataBanner message="Offline — showing the last saved audit snapshot." />
      ) : null}
      {/* A refetch that failed over rows we already have is a NOTICE, not a
          takeover: replacing a loaded log with an error page during an
          incident loses the evidence the reader was mid-way through. */}
      {listErrored && loadedCount > 0 ? (
        <ErrorState
          compact
          message="Couldn't refresh — showing the last results."
          onRetry={onRetry}
        />
      ) : null}
      <AuditActivityCard summary={activity} loading={activityLoading} />
      <AuditCheckpointBanner
        checkpoint={checkpoint}
        loading={checkpointLoading}
      />
    </View>
  );
}

export interface AuditListEmptyProps {
  firstLoad: boolean;
  errored: boolean;
  error: unknown;
  onRetry: () => void;
  narrowed: boolean;
}

/** Error wins over empty — a failed fetch is never "nothing happened". */
export function AuditListEmpty({
  firstLoad,
  errored,
  error,
  onRetry,
  narrowed,
}: AuditListEmptyProps) {
  if (firstLoad) return null;
  if (errored) return <ErrorState error={error} onRetry={onRetry} />;
  // NARROWED stays local: that state is about the filter the user just set,
  // and it is a genuinely different message from "this surface has nothing".
  // The first-run case reads the SHARED governance copy so Audit, Approvals,
  // SCIM, Sinks and Agency stop each explaining themselves differently
  // (GOVERNANCE#30).
  if (narrowed) {
    return (
      <EmptyState
        title="Nothing matches"
        description="Try widening the filters, or load older events."
      />
    );
  }
  return <EmptyState {...governanceEmptyCopy("audit")} />;
}

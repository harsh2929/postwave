/**
 * AuditScreenOverlays — the audit tab's modal stack, extracted whole.
 *
 * app/(tabs)/audit.tsx crossed the 450-line/complexity-25 source budget when
 * the screen gained the advanced-filter sheet, the request-chain sheet and the
 * per-event forensics; the house rule is to split rather than to breach. This
 * component owns NO state and makes NO decisions the screen did not already
 * make — it is the render tail of `Audit()`, moved, so every open/close
 * decision stays readable in one place there.
 *
 * Only one sheet in this stack is ever visible at a time by construction
 * (each `visible` prop derives from a distinct piece of screen state), which
 * is exactly the iOS pageSheet constraint the screen documents.
 */
import { RejectReasonModal } from "@/components/approvals/RejectReasonModal";
import type { AuditRow } from "@/hooks/useAudit";
import type { useAuditExportController } from "@/hooks/useAuditExport";
import type { useAuditInvestigations } from "@/hooks/useAuditInvestigations";
import type { useAuditNlqController } from "@/hooks/useAuditNlq";
import type { useAuditViewLibrary } from "@/hooks/useAuditViewLibrary";
import type { useInvestigationReview } from "@/hooks/useInvestigationReview";
import type { AuditAdvancedFilters } from "@/lib/auditAdvancedFilters";
import type { AuditInvestigation } from "@/lib/auditInvestigations";
import type { AuditAnomaly } from "@/hooks/useAudit";

import { AuditAdvancedFiltersSheet } from "./AuditAdvancedFiltersSheet";
import { AuditChainSheet } from "./AuditChainSheet";
import { AuditExportSheet } from "./AuditExportSheet";
import { AuditInvestigationsSheet } from "./AuditInvestigationsSheet";
import { AuditNlqSheet } from "./AuditNlqSheet";
import {
  AuditRowDetail,
  type AuditRowInvestigationContext,
} from "./AuditRowDetail";
import { AuditSaveViewSheet } from "./AuditSaveViewSheet";

export interface AuditScreenOverlaysProps {
  library: ReturnType<typeof useAuditViewLibrary>;
  exports: ReturnType<typeof useAuditExportController>;
  exportOpen: boolean;
  onCloseExport: () => void;
  investigationsOpen: boolean;
  onCloseInvestigations: () => void;
  investigations: ReturnType<typeof useAuditInvestigations>;
  investigationRows: AuditInvestigation[] | null;
  canDecideInvestigations: boolean;
  review: ReturnType<typeof useInvestigationReview>;
  nlq: ReturnType<typeof useAuditNlqController<AuditRow>>;
  online: boolean;
  canReadPii: boolean;
  advancedOpen: boolean;
  advanced: AuditAdvancedFilters;
  onApplyAdvanced: (next: AuditAdvancedFilters) => void;
  onCloseAdvanced: () => void;
  chain: { seed: string | null } | null;
  onCloseChain: () => void;
  openRow: AuditRow | null;
  openRowAnomaly: AuditAnomaly | undefined;
  investigationContext: AuditRowInvestigationContext;
  onCloseRow: () => void;
}

export function AuditScreenOverlays(props: AuditScreenOverlaysProps) {
  const { library, exports, review, nlq } = props;
  return (
    <>
      <AuditSaveViewSheet
        visible={library.sheetOpen}
        name={library.name}
        onChangeName={library.setName}
        summary={library.summary}
        error={library.error}
        busy={library.busy}
        onCancel={library.closeSave}
        onSubmit={library.submitSave}
      />
      <AuditExportSheet
        visible={props.exportOpen}
        onClose={props.onCloseExport}
        scope={exports.scope}
        jobs={exports.jobs}
        loading={exports.loading}
        isPending={exports.isPending}
        isPaused={exports.isPaused}
        isError={exports.isError}
        error={exports.error}
        refetch={exports.refetch}
        canStart={exports.canStart}
        starting={exports.starting}
        onStart={exports.start}
        schedules={exports.schedules}
      />
      <AuditInvestigationsSheet
        visible={props.investigationsOpen}
        onClose={props.onCloseInvestigations}
        investigations={props.investigationRows ?? undefined}
        loading={props.investigations.isLoading}
        isPending={props.investigations.isPending}
        isPaused={props.investigations.isPaused}
        isError={props.investigations.isError}
        error={props.investigations.error}
        refetch={props.investigations.refetch}
        refreshing={
          props.investigations.isFetching && !props.investigations.isLoading
        }
        canDecide={props.canDecideInvestigations}
        decidingId={review.decidingId}
        onApprove={review.approve}
        onReject={review.openReject}
      />
      <RejectReasonModal
        visible={Boolean(review.rejectDraft)}
        label={review.rejectDraft?.label ?? ""}
        reason={review.rejectDraft?.reason ?? ""}
        busy={review.isDeciding}
        error={review.rejectError}
        subtitle="Say why the plan was declined. This is recorded on the investigation and cannot be undone from here."
        submitAccessibilityLabel="Reject investigation"
        onChangeReason={(reason) => {
          review.setRejectError(null);
          review.setRejectDraft((cur) => (cur ? { ...cur, reason } : cur));
        }}
        onCancel={() => {
          review.setRejectDraft(null);
          review.setRejectError(null);
        }}
        onSubmit={review.submitReject}
      />
      {nlq.access.allowed ? (
        <AuditNlqSheet nlq={nlq} online={props.online} canReadPii={props.canReadPii} />
      ) : null}
      <AuditAdvancedFiltersSheet
        visible={props.advancedOpen}
        value={props.advanced}
        onApply={props.onApplyAdvanced}
        onClose={props.onCloseAdvanced}
      />
      <AuditChainSheet
        visible={props.chain !== null}
        initialRequestId={props.chain?.seed ?? null}
        online={props.online}
        onClose={props.onCloseChain}
      />
      <AuditRowDetail
        row={props.openRow}
        {...(props.openRowAnomaly !== undefined
          ? { anomaly: props.openRowAnomaly }
          : {})}
        canReadPii={props.canReadPii}
        investigation={props.investigationContext}
        onClose={props.onCloseRow}
      />
    </>
  );
}

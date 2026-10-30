// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ClipboardCheck,
  ExternalLink,
  RefreshCw,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  OperationsFailure,
  OperationsHeader,
  OperationsLoading,
  OperationsSection,
  OperationsShell,
} from "@/components/operations/operations-surface";
import { AgentOriginEvidencePanel } from "@/components/approvals/agent-origin-evidence-panel";
import { RelativeTime } from "@/components/relative-time";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { purgeStaleApprovalQueries } from "@/lib/approval-cache";
import { isApprovalAuthorityFailure } from "@/lib/approval-rejection";
import {
  getApproval,
  isActionable,
  requesterLabel,
  resourceHref,
  resourceTypeLabel,
  statusVariant,
  type Approval,
} from "@/lib/approvals-api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { qk, STALE } from "@/lib/query-keys";
import { asRoute } from "@/lib/typed-routes";
import {
  ApprovalDecisionDialog,
  type ApprovalActionLock,
  type ApprovalDecisionKind,
} from "../approval-decision-dialog";

export function ApprovalDetailClient({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const decisionReturnFocusRef = useRef<HTMLElement | null>(null);
  const decisionFallbackFocusRef = useRef<HTMLAnchorElement | null>(null);
  const actionLockRef: ApprovalActionLock = useRef<symbol | null>(null);
  const previousScopeRef = useRef<{
    authorityKey: string;
    queryKey: readonly unknown[];
  } | null>(null);
  const [decision, setDecision] = useState<{
    approval: Approval;
    authorityKey: string;
    kind: ApprovalDecisionKind;
  } | null>(null);
  const [deniedAuthorityKey, setDeniedAuthorityKey] = useState<string | null>(
    null,
  );
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const identity = meQuery.isSuccess ? meQuery.data : null;
  const tenantId = identity?.tenant_id ?? "anonymous";
  const userId = identity?.user_id ?? "anonymous";
  const role = identity ? effectiveAuthRole(identity) : null;
  const viewerState = identity?.viewer_mode ? "viewer-mode" : "member-mode";
  const canReview = Boolean(
    identity && !identity.viewer_mode && (role === "owner" || role === "admin"),
  );
  const authorityKey = identity
    ? [tenantId, userId, role, viewerState].join("\u001f")
    : "unverified";
  const approvalsKey = useMemo(
    () =>
      [
        ...qk.settings(tenantId, role, "approvals"),
        userId,
        viewerState,
      ] as const,
    [role, tenantId, userId, viewerState],
  );
  // Realtime approval events and list mutations invalidate `approvalsKey`.
  // Nest details below that prefix so an externally recorded decision cannot
  // leave this screen serving a stale actionable record until manual refresh.
  const detailKey = [...approvalsKey, "detail", id] as const;

  useEffect(() => {
    if (meQuery.isPending) return;
    const previous = previousScopeRef.current;
    const current = canReview ? { authorityKey, queryKey: approvalsKey } : null;
    if (previous && (!current || previous.authorityKey !== authorityKey)) {
      setDecision(null);
      setDeniedAuthorityKey(null);
    }
    purgeStaleApprovalQueries(queryClient, current?.queryKey);
    previousScopeRef.current = current;
  }, [approvalsKey, authorityKey, canReview, meQuery.isPending, queryClient]);

  const approvalQuery = useQuery({
    queryKey: detailKey,
    queryFn: ({ signal }) =>
      getApproval(id, { expectedTenantId: tenantId, signal }),
    enabled:
      meQuery.isSuccess && canReview && deniedAuthorityKey !== authorityKey,
    staleTime: STALE.detail,
    retry: (count, error) =>
      !isApprovalAuthorityFailure(error) &&
      !(error instanceof ApiError && error.status === 404) &&
      count < 2,
  });
  const approvalAccessDenied = deniedAuthorityKey === authorityKey;

  const reverifyDeniedAccess = async (): Promise<void> => {
    const refreshed = await meQuery.refetch();
    if (refreshed.isSuccess) setDeniedAuthorityKey(null);
  };

  useEffect(() => {
    if (!isApprovalAuthorityFailure(approvalQuery.error)) {
      return;
    }
    setDeniedAuthorityKey(authorityKey);
    setDecision(null);
    purgeStaleApprovalQueries(queryClient);
    void queryClient.invalidateQueries({
      queryKey: qk.authMe(),
      exact: true,
    });
  }, [approvalQuery.error, authorityKey, queryClient]);
  const approval = approvalQuery.data;

  if (meQuery.isPending) {
    return <DetailBoundary mode="loading" />;
  }
  if (meQuery.isError) {
    return (
      <DetailBoundary
        mode="auth-error"
        onRetry={() => void meQuery.refetch()}
        retrying={meQuery.isFetching}
      />
    );
  }
  if (!canReview || !identity) {
    return <DetailBoundary mode="forbidden" />;
  }
  if (approvalAccessDenied) {
    return (
      <DetailBoundary
        mode="denied"
        onRetry={() => void reverifyDeniedAccess()}
        retrying={meQuery.isFetching}
      />
    );
  }

  const resourceLink = approval
    ? resourceHref(approval.resourceType, approval.resourceId)
    : null;
  const status =
    approvalQuery.error instanceof ApiError ? approvalQuery.error.status : null;

  return (
    <OperationsShell className="max-w-5xl">
      <Button variant="ghost" className="w-fit" asChild>
        <Link ref={decisionFallbackFocusRef} href={asRoute("/app/approvals")}>
          <ArrowLeft aria-hidden />
          Back to approvals
        </Link>
      </Button>
      <OperationsHeader
        icon={ClipboardCheck}
        eyebrow="Governance"
        title="Approval review"
        description="Inspect the exact request and its audit trail before recording a rejection decision."
        actions={
          <Button
            type="button"
            variant="outline"
            onClick={() => void approvalQuery.refetch()}
            loading={approvalQuery.isFetching}
          >
            <RefreshCw aria-hidden />
            Refresh
          </Button>
        }
      />

      <Alert>
        <AlertTitle>Approval execution is on release hold</AlertTitle>
        <AlertDescription>
          Approve remains unavailable until the exact resource revision and
          downstream execution are proven as one safe contract. A rejection
          confirms only the stored decision—not requester notification or a
          downstream effect.
        </AlertDescription>
      </Alert>

      {approvalQuery.isPending ? (
        <OperationsLoading label="Loading approval details" rows={6} />
      ) : approvalQuery.isError || !approval ? (
        status === 404 ? (
          <Alert>
            <AlertTitle>Approval not found</AlertTitle>
            <AlertDescription className="break-all">
              No approval is available for {id}. It may have been removed, or
              the link may be incomplete.
            </AlertDescription>
          </Alert>
        ) : (
          <OperationsFailure
            title={
              status === 403
                ? "Approval access was denied"
                : "Approval details could not be loaded"
            }
            description="This is a failed request, not evidence that the approval is absent. No decision was recorded."
            onRetry={() => void approvalQuery.refetch()}
            retrying={approvalQuery.isFetching}
          />
        )
      ) : (
        <>
          <OperationsSection
            id="approval-request"
            title={resourceTypeLabel(approval.resourceType)}
            description="The protected resource and requester context supplied by the approval record."
            aside={
              <Badge variant={statusVariant(approval.status)}>
                {approval.status}
              </Badge>
            }
          >
            <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
              <DetailTerm label="Approval ID" value={approval.id} mono />
              <DetailTerm
                label="Resource ID"
                value={approval.resourceId || "Not supplied"}
                mono
              />
              <DetailTerm
                label="Requested by"
                value={requesterLabel(approval)}
              />
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Requested
                </dt>
                <dd className="mt-1 text-sm">
                  <RelativeTime iso={approval.requestedAt} />
                </dd>
              </div>
              {approval.decidedAt ? (
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Decided
                  </dt>
                  <dd className="mt-1 text-sm">
                    <RelativeTime iso={approval.decidedAt} />
                  </dd>
                </div>
              ) : null}
              {approval.decidedByUserId ? (
                <DetailTerm
                  label="Decided by"
                  value={approval.decidedByUserId}
                  mono
                />
              ) : null}
            </dl>
            {resourceLink ? (
              <Button variant="outline" className="mt-5" asChild>
                <Link
                  href={asRoute(resourceLink)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Inspect resource
                  <ExternalLink aria-hidden />
                </Link>
              </Button>
            ) : (
              <p className="mt-5 text-sm text-muted-foreground">
                This resource type has no supported inspection destination.
              </p>
            )}
          </OperationsSection>

          <OperationsSection
            id="approval-audit-note"
            title="Decision note"
            description="Notes are part of the approval audit record."
          >
            <p className="whitespace-pre-wrap break-words text-sm leading-6">
              {approval.notes?.trim() || "No decision note has been recorded."}
            </p>
          </OperationsSection>

          <AgentOriginEvidencePanel
            approval={approval}
            scopeKey={detailKey}
            enabled={canReview}
          />

          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            {isActionable(approval) ? (
              <Button
                type="button"
                variant="destructive"
                onClick={(event) => {
                  decisionReturnFocusRef.current = event.currentTarget;
                  setDecision({
                    approval,
                    authorityKey,
                    kind: "reject",
                  });
                }}
              >
                Reject
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">
                {approval.status === "pending"
                  ? "This pending approval has expired or cannot be safely interpreted, so no decision is available."
                  : `This approval is ${approval.status} and cannot receive another decision.`}
              </p>
            )}
          </div>
        </>
      )}

      {decision?.authorityKey === authorityKey ? (
        <ApprovalDecisionDialog
          approval={decision.approval}
          kind={decision.kind}
          identity={identity}
          authorityKey={authorityKey}
          protectedQueryKey={approvalsKey}
          actionLock={actionLockRef}
          onAuthorityDenied={() => setDeniedAuthorityKey(authorityKey)}
          returnFocusRef={decisionReturnFocusRef}
          fallbackFocusRef={decisionFallbackFocusRef}
          onClose={() => setDecision(null)}
          onReconciled={(latest) => {
            queryClient.setQueryData(detailKey, latest);
            setDecision(null);
            void queryClient.invalidateQueries({
              queryKey: approvalsKey,
              exact: false,
              refetchType: "none",
            });
          }}
          onRecorded={(recorded) => {
            queryClient.setQueryData(detailKey, recorded);
            setDecision(null);
            void queryClient.invalidateQueries({
              queryKey: approvalsKey,
              exact: false,
            });
          }}
        />
      ) : null}
    </OperationsShell>
  );
}

function DetailBoundary({
  mode,
  onRetry,
  retrying = false,
}: {
  mode: "loading" | "auth-error" | "forbidden" | "denied";
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <OperationsShell className="max-w-5xl">
      <OperationsHeader
        icon={ClipboardCheck}
        eyebrow="Governance"
        title="Approval review"
        description="Inspect a protected request before recording a rejection."
      />
      {mode === "loading" ? (
        <OperationsLoading label="Verifying approval access" rows={5} />
      ) : mode === "auth-error" ? (
        <OperationsFailure
          title="Approval access could not be verified"
          description="No approval detail was requested. Check the connection and try again."
          onRetry={onRetry}
          retrying={retrying}
        />
      ) : mode === "denied" ? (
        <OperationsFailure
          title="Approval access was denied"
          description="Cached approval data was cleared and no decision control remains active. Verify your current workspace identity and role, then try again."
          onRetry={onRetry}
          retrying={retrying}
        />
      ) : (
        <Alert>
          <AlertTitle>Owner or admin access is required</AlertTitle>
          <AlertDescription>
            No approval detail was requested for the current effective role.
          </AlertDescription>
        </Alert>
      )}
    </OperationsShell>
  );
}

function DetailTerm({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd
        className={`mt-1 break-all text-sm ${mono ? "font-mono text-xs" : ""}`}
      >
        {value}
      </dd>
    </div>
  );
}

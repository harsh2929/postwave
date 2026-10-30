// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// "Origin evidence" for an approval review (desktop parity:
// components/ApprovalDetailSlideover.tsx EvidencePanel + AgentTrustPanel).
// The linked agent run is fetched ONLY when the approval record names an
// agent as requester, and the payload must name this exact approval — see
// approval-agent-evidence-api.ts. Model output (reasoning, prompt, draft
// bodies) renders as plain text; bodies have tags stripped and are never
// interpreted as markup.

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, RefreshCw } from "lucide-react";

import { OperationsSection } from "@/components/operations/operations-surface";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/api";
import {
  getAgentOriginEvidence,
  htmlToReadableText,
  type AgentEvidenceDraftPreview,
  type AgentOriginEvidence,
} from "@/lib/approval-agent-evidence-api";
import type { Approval } from "@/lib/approvals-api";
import { STALE } from "@/lib/query-keys";

export function isAgentRequested(
  approval: Pick<Approval, "requestedByActorType">,
): boolean {
  return approval.requestedByActorType === "agent";
}

export function AgentOriginEvidencePanel({
  approval,
  scopeKey,
  enabled = true,
}: {
  approval: Pick<Approval, "id" | "requestedByActorType">;
  /** The caller's qk-derived approvals scope (tenant, role, user, viewer). */
  scopeKey: readonly unknown[];
  /** False while the caller's review authority is unverified. */
  enabled?: boolean;
}) {
  const agentRequested = isAgentRequested(approval);
  const evidenceQuery = useQuery({
    queryKey: [...scopeKey, "agent-evidence", approval.id],
    queryFn: ({ signal }) => getAgentOriginEvidence(approval.id, { signal }),
    enabled: enabled && agentRequested,
    retry: false,
    staleTime: STALE.detail,
  });

  return (
    <OperationsSection
      id="approval-origin-evidence"
      title="Origin evidence"
      description="The agent run that produced this request, when the record names an agent as its requester."
      aside={
        agentRequested && evidenceQuery.isSuccess && evidenceQuery.data ? (
          <Badge variant="info">
            <Bot className="mr-1 size-3" aria-hidden />
            Agent run verified
          </Badge>
        ) : null
      }
    >
      {!agentRequested ? (
        <p className="text-sm text-muted-foreground">
          This record does not identify an agent-authored request, so no
          agent-run lookup was made.
        </p>
      ) : !enabled ? (
        <p className="text-sm text-muted-foreground">
          Agent evidence waits for verified review access.
        </p>
      ) : evidenceQuery.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Checking for a linked agent run…
        </p>
      ) : evidenceQuery.isError ? (
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-sm text-destructive">
            Agent provenance could not be verified:{" "}
            {apiErrorMessage(
              evidenceQuery.error,
              "the evidence request failed.",
            )}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            loading={evidenceQuery.isFetching}
            onClick={() => void evidenceQuery.refetch()}
          >
            <RefreshCw aria-hidden />
            Retry evidence
          </Button>
        </div>
      ) : evidenceQuery.data === null ? (
        <p className="text-sm text-muted-foreground">
          No linked agent run was returned. This does not prove who authored
          the request.
        </p>
      ) : (
        <AgentRunEvidence run={evidenceQuery.data} />
      )}
    </OperationsSection>
  );
}

function hasTrustRecord(run: AgentOriginEvidence): boolean {
  return Boolean(
    run.reasoning || run.promptUsed || run.contextUsed || run.draftPreview,
  );
}

function AgentRunEvidence({ run }: { run: AgentOriginEvidence }) {
  return (
    <div className="space-y-4" data-testid="agent-origin-evidence">
      <p className="text-sm">
        A linked agent run was verified for this approval.
      </p>
      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <div className="min-w-0">
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Run
          </dt>
          <dd className="mt-1 break-all font-mono text-xs">{run.runId}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Status
          </dt>
          <dd className="mt-1">{run.status}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Started
          </dt>
          <dd className="mt-1">
            <RelativeTime iso={run.startedAt} />
          </dd>
        </div>
      </dl>
      {!hasTrustRecord(run) ? (
        <p className="text-sm text-muted-foreground">
          No reasoning or draft snapshot was recorded for this run.
        </p>
      ) : (
        <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
          <EvidenceBlock title="Why the agent drafted this">
            {run.reasoning ? (
              <PlainText text={run.reasoning} testId="agent-reasoning" />
            ) : (
              <p className="text-sm italic text-muted-foreground">
                No rationale recorded — the model returned a draft without one.
              </p>
            )}
          </EvidenceBlock>
          {run.promptUsed || run.contextUsed ? (
            <EvidenceBlock title="What it was told">
              {run.promptUsed ? (
                <PlainText text={run.promptUsed} testId="agent-prompt" />
              ) : null}
              {run.contextUsed ? (
                <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                  {run.contextUsed}
                </p>
              ) : null}
            </EvidenceBlock>
          ) : null}
          {run.draftPreview ? (
            <EvidenceBlock title="What it produced">
              <DraftPreview preview={run.draftPreview} />
              <p className="mt-2 text-xs text-muted-foreground">
                Snapshot from run time · bodies shown as plain text. Open the
                resource to see the full rendered version.
              </p>
            </EvidenceBlock>
          ) : null}
        </div>
      )}
    </div>
  );
}

function EvidenceBlock({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </div>
  );
}

function PlainText({ text, testId }: { text: string; testId?: string }) {
  return (
    <p
      data-testid={testId}
      className="whitespace-pre-wrap break-words text-sm leading-6"
    >
      {text}
    </p>
  );
}

function DraftPreview({ preview }: { preview: AgentEvidenceDraftPreview }) {
  if (preview.kind === "sequence") {
    return (
      <div className="space-y-3" data-testid="agent-draft-preview">
        {preview.name ? (
          <p className="text-sm font-semibold">{preview.name}</p>
        ) : null}
        {preview.steps.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No steps in the snapshot.
          </p>
        ) : (
          <ol className="space-y-3">
            {preview.steps.map((step) => (
              <li key={step.position} className="border-l-2 pl-3">
                <p className="text-xs text-muted-foreground">
                  Email {step.position}
                  {step.delayHours === 0
                    ? " · sends immediately"
                    : ` · +${step.delayHours}h`}
                </p>
                {step.subject ? (
                  <p className="text-sm font-semibold">{step.subject}</p>
                ) : null}
                {step.body ? (
                  <PlainText text={htmlToReadableText(step.body)} />
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-2" data-testid="agent-draft-preview">
      {preview.subject ? (
        <p className="text-sm">
          <span className="text-xs text-muted-foreground">Subject </span>
          <span className="font-semibold">{preview.subject}</span>
        </p>
      ) : null}
      {preview.previewText ? (
        <p className="text-sm">
          <span className="text-xs text-muted-foreground">Preview </span>
          {preview.previewText}
        </p>
      ) : null}
      {preview.body ? (
        <PlainText text={htmlToReadableText(preview.body)} />
      ) : null}
    </div>
  );
}

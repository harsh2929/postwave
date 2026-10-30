// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  CircleSlash2,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api";
import { loadNextQueryPage } from "@/lib/infinite-query-action";
import {
  applyCampaignAssuranceFinding,
  CampaignAssuranceApplyProvenanceError,
  CAMPAIGN_ASSURANCE_SOURCE_LABELS,
  type CampaignAssuranceEvidence,
  type CampaignAssuranceFinding,
  type CampaignAssuranceLatest,
  type CampaignAssuranceSourceClass,
  campaignAssuranceErrorMessage,
  factContractSummary,
  getCampaignAssuranceEvidence,
  getCampaignContentRevision,
  getLatestCampaignAssurance,
  isCampaignAssuranceNotEnabled,
  overrideCampaignAssuranceFinding,
  remediationSummary,
  startCurrentCampaignAssurance,
} from "@/lib/campaign-assurance-api";
import { qk, type RoleKey } from "@/lib/query-keys";
import type { MeResponse } from "@/lib/auth-api";
import {
  canAdminCampaigns,
  canWriteCampaigns,
  confirmFreshCampaignAdminAuthority,
  confirmFreshCampaignWriteAuthority,
} from "@/lib/campaign-write-authority";

const TERMINAL_STATES = new Set([
  "complete",
  "incomplete",
  "failed",
  "cancelled",
  "stale",
]);

interface AssuranceIdentity {
  campaignId: string;
  tenantId: string;
  role: RoleKey;
}

export function useCampaignAssuranceLatest(identity: AssuranceIdentity) {
  const queryKey = [
    ...qk.campaign(identity.tenantId, identity.role, identity.campaignId),
    "campaign-assurance",
    "latest",
  ] as const;
  return useQuery({
    queryKey,
    queryFn: () => getLatestCampaignAssurance(identity.campaignId),
    refetchInterval: (query) => {
      const state = query.state.data?.data.detail.run.state;
      return state && !TERMINAL_STATES.has(state) ? 2_000 : false;
    },
    // "Not enabled here" is a fact about the environment; asking again
    // cannot change it. Anything else keeps the client-wide two retries.
    retry: (failureCount, error) =>
      !isCampaignAssuranceNotEnabled(error) && failureCount < 2,
    staleTime: 5_000,
  });
}

/**
 * The panel's state when the environment runs without Campaign Assurance.
 * Informational, not an error: there is nothing to retry and nothing to run.
 */
function CampaignAssuranceNotEnabledCard() {
  return (
    <Card id="campaign-assurance">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck
            className="h-5 w-5 text-muted-foreground"
            aria-hidden="true"
          />
          Predicted Agent Comprehension
        </CardTitle>
        <CardDescription>
          Campaign Assurance isn&apos;t turned on in this environment, so there
          are no assurance checks for this campaign.
        </CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        <p>
          Sending isn&apos;t affected: without Campaign Assurance, no send waits
          on an assurance receipt.
        </p>
      </CardContent>
    </Card>
  );
}

export function CampaignAssurancePanel({
  campaignId,
  tenantId,
  role,
  canOverride: requestedOverride,
  canEdit: requestedEdit,
  canApply: requestedApply,
  campaignETag,
  identity,
}: AssuranceIdentity & {
  canOverride: boolean;
  /** True only for editor-or-higher roles; controls whether the action exists. */
  canEdit: boolean;
  /** False while local edits make the captured server ETag inapplicable. */
  canApply: boolean;
  campaignETag: string | null;
  identity: MeResponse | null | undefined;
}) {
  const canEdit = requestedEdit && canWriteCampaigns(identity);
  const canApply = requestedApply && canEdit;
  const canOverride = requestedOverride && canAdminCampaigns(identity);
  const queryClient = useQueryClient();
  const assuranceIdentity = { campaignId, tenantId, role };
  const latestQuery = useCampaignAssuranceLatest(assuranceIdentity);
  const latest = latestQuery.data?.data;
  const run = latest?.detail.run;
  const [starting, setStarting] = useState(false);

  const startCurrentRun = async () => {
    if (starting || !canEdit || !canApply) return;
    setStarting(true);
    try {
      await confirmFreshCampaignWriteAuthority(identity);
      const accepted = await startCurrentCampaignAssurance(campaignId);
      toast.success(
        `Campaign Assurance run accepted for ${accepted.data.required_scenario_count} frozen scenario${accepted.data.required_scenario_count === 1 ? "" : "s"}.`,
      );
      await queryClient.invalidateQueries({
        queryKey: qk.campaign(tenantId, role, campaignId),
      });
      await latestQuery.refetch();
    } catch (error) {
      toast.error(
        campaignAssuranceErrorMessage(
          error,
          "Could not start Campaign Assurance.",
        ),
      );
    } finally {
      setStarting(false);
    }
  };

  const evidenceQuery = useInfiniteQuery({
    queryKey: [
      ...qk.campaign(tenantId, role, campaignId),
      "campaign-assurance",
      run?.id ?? "none",
      "evidence",
    ],
    queryFn: ({ pageParam }) =>
      getCampaignAssuranceEvidence(campaignId, run!.id, pageParam),
    initialPageParam: 0,
    enabled: Boolean(run?.id),
    getNextPageParam: (last) => nextEvidenceOffset(last.data),
  });
  const evidence = useMemo(
    () =>
      mergeEvidencePages(evidenceQuery.data?.pages?.map((page) => page.data)),
    [evidenceQuery.data?.pages],
  );

  const revisionQuery = useQuery({
    queryKey: [
      ...qk.campaign(tenantId, role, campaignId),
      "content-revision",
      run?.content_revision_id ?? "none",
    ],
    queryFn: () =>
      getCampaignContentRevision(campaignId, run!.content_revision_id),
    enabled: Boolean(run?.content_revision_id),
    staleTime: Infinity,
  });

  if (latestQuery.isPending) {
    return (
      <Card id="campaign-assurance" aria-busy="true">
        <CardHeader>
          <Skeleton className="h-5 w-64" />
          <Skeleton className="h-4 w-full" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-28 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (latestQuery.isError && isCampaignAssuranceNotEnabled(latestQuery.error)) {
    return <CampaignAssuranceNotEnabledCard />;
  }

  if (latestQuery.isError) {
    const missing =
      latestQuery.error instanceof ApiError && latestQuery.error.status === 404;
    return (
      <Card id="campaign-assurance">
        <CardHeader>
          <CardTitle>Predicted Agent Comprehension</CardTitle>
          <CardDescription>
            {missing
              ? "No Campaign Assurance receipt exists for this campaign yet."
              : "Campaign Assurance evidence is currently unavailable."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {!missing ? (
            <p className="text-destructive" role="alert">
              {campaignAssuranceErrorMessage(
                latestQuery.error,
                "Could not load assurance evidence.",
              )}
            </p>
          ) : null}
          <p className="text-muted-foreground">
            Starting assurance freezes the current draft and asks the server to
            compile every required semantic scenario into one immutable plan.
          </p>
          <div className="flex flex-wrap gap-2">
            {missing && canEdit ? (
              <Button
                type="button"
                disabled={starting || !canApply}
                onClick={() => void startCurrentRun()}
              >
                {starting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ShieldCheck className="h-4 w-4" />
                )}
                {starting
                  ? "Preparing exact plan…"
                  : canApply
                    ? "Run full assurance"
                    : "Save or discard local edits first"}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              onClick={() => void latestQuery.refetch()}
            >
              <RefreshCw className="h-4 w-4" /> Retry
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!latest || !run) return null;
  const contract = factContractSummary(revisionQuery.data?.fact_contract);
  const verdict = assuranceVerdict(latest);
  const findings = Array.isArray(evidence?.findings.items)
    ? evidence?.findings.items
    : [];
  const extractions = Array.isArray(evidence?.extractions.items)
    ? evidence?.extractions.items
    : [];
  const overrides = Array.isArray(evidence?.overrides.items)
    ? evidence?.overrides.items
    : [];
  const missingSources = latestQuery.data.measurement.source_classes.filter(
    (source) => !source.present,
  );
  const unavailableExtractions = extractions.filter(
    (item) => item.status !== "complete",
  );

  return (
    <Card id="campaign-assurance">
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5" />
              Predicted Agent Comprehension
            </CardTitle>
            <CardDescription>
              {latestQuery.data.measurement.interpretation}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canEdit && TERMINAL_STATES.has(run.state) ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={starting || !canApply}
                onClick={() => void startCurrentRun()}
              >
                {starting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                {starting
                  ? "Preparing…"
                  : canApply
                    ? "Rerun full assurance"
                    : "Save local edits before rerun"}
              </Button>
            ) : null}
            <Badge variant={verdict.variant}>{verdict.label}</Badge>
          </div>
        </div>
        <SourceDisclosureRow
          sources={latestQuery.data.measurement.source_classes}
          unavailable={
            missingSources.length > 0 || unavailableExtractions.length > 0
          }
        />
      </CardHeader>

      <CardContent className="space-y-5">
        <div
          className={`rounded-md border p-3 text-sm ${verdict.alert ? "border-destructive/40 bg-destructive/5" : "bg-muted/20"}`}
          role={verdict.alert ? "alert" : "status"}
        >
          <div className="flex items-start gap-2">
            <verdict.icon className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">{verdict.detail}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {latest.applicability.basis} The queue endpoint revalidates the
                exact receipt and hashes; this card is not a second send
                authority.
              </p>
            </div>
          </div>
        </div>

        <ReceiptSummary latest={latest} />

        <section aria-labelledby="message-contract-title" className="space-y-2">
          <h3 id="message-contract-title" className="text-sm font-semibold">
            Message Contract
          </h3>
          {revisionQuery.isPending ? (
            <Skeleton className="h-20 w-full" />
          ) : revisionQuery.isError ? (
            <p className="rounded-md border p-3 text-sm text-muted-foreground">
              The frozen Fact Contract could not be loaded. The receipt remains
              visible, but contract wording is unavailable.
            </p>
          ) : !contract.available ? (
            <p className="rounded-md border p-3 text-sm text-warning-emphasis">
              This frozen revision has no valid Fact Contract, so a trustworthy
              overall comprehension score cannot be inferred.
            </p>
          ) : (
            <div className="grid gap-3 rounded-md border p-3 text-sm md:grid-cols-2">
              <ContractField label="Primary intent" value={contract.intent} />
              <ContractField label="Core claim" value={contract.claim} />
              <ContractField label="Primary action" value={contract.action} />
              <ContractField
                label="Required facts"
                value={
                  contract.facts.length
                    ? contract.facts
                        .map(
                          (fact) =>
                            `${fact.value || fact.id} (${fact.criticality})`,
                        )
                        .join("; ")
                    : "None declared"
                }
              />
            </div>
          )}
        </section>

        <section aria-labelledby="findings-title" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="findings-title" className="text-sm font-semibold">
              Findings and remediation
            </h3>
            {evidenceQuery.isFetching ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Refreshing
                evidence…
              </span>
            ) : null}
          </div>
          {evidenceQuery.isError ? (
            <div className="space-y-2 rounded-md border border-destructive/30 p-3">
              <p className="text-sm text-destructive" role="alert">
                Could not load the immutable finding receipts.
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={evidenceQuery.isFetching}
                onClick={() => void evidenceQuery.refetch()}
              >
                <RefreshCw className="h-4 w-4" /> Retry evidence
              </Button>
            </div>
          ) : findings.length === 0 ? (
            <p className="rounded-md border p-3 text-sm text-muted-foreground">
              {evidenceQuery.isPending
                ? "Loading findings…"
                : "No findings were recorded."}
            </p>
          ) : (
            <div className="space-y-4">
              {SOURCE_ORDER.map((source) => {
                const sourceFindings = findings.filter(
                  (finding) => finding.source_class === source,
                );
                if (!sourceFindings.length) return null;
                return (
                  <div key={source} className="space-y-2">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {CAMPAIGN_ASSURANCE_SOURCE_LABELS[source]}
                    </h4>
                    {sourceFindings.map((finding) => (
                      <FindingRow
                        key={finding.id}
                        campaignId={campaignId}
                        runId={run.id}
                        finding={finding}
                        override={latestOverrideFor(overrides, finding.id)}
                        canOverride={canOverride}
                        canEdit={canEdit}
                        canApply={canApply}
                        campaignETag={campaignETag}
                        identity={identity}
                        onChanged={() => {
                          void latestQuery.refetch();
                          void evidenceQuery.refetch();
                          void queryClient.invalidateQueries({
                            queryKey: qk.campaign(tenantId, role, campaignId),
                          });
                        }}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          )}
          {evidenceQuery.hasNextPage ? (
            <Button
              type="button"
              variant="outline"
              disabled={evidenceQuery.isFetchingNextPage}
              onClick={() =>
                void loadNextQueryPage(evidenceQuery, evidenceQuery.isEnabled)
              }
            >
              {evidenceQuery.isFetchingNextPage ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              Load more immutable evidence
            </Button>
          ) : null}
        </section>

        <UnavailableEvidence
          missingSources={missingSources}
          extractions={unavailableExtractions}
        />

        <details className="rounded-md border p-3 text-sm">
          <summary className="flex cursor-pointer list-none items-center gap-2 font-medium">
            <ChevronDown className="h-4 w-4" /> Analyzer and artifact provenance
          </summary>
          <div className="mt-3 space-y-3">
            <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
              <ContractField label="Renderer" value={run.renderer_version} />
              <ContractField label="Compiler" value={run.compiler_version} />
              <ContractField
                label="Analyzer suite"
                value={run.analyzer_suite_version}
              />
              <ContractField
                label="Model suite"
                value={run.model_suite_version}
              />
              <ContractField
                label="Prompt suite"
                value={run.prompt_suite_version}
              />
              <ContractField label="Scoring" value={run.scoring_version} />
              <ContractField
                label="Gate policy"
                value={run.gate_policy_version}
              />
              <ContractField
                label="Methodology"
                value={run.methodology_version}
              />
              <ContractField
                label="Modeled cost (µ-units)"
                value={
                  run.cost_microunits == null
                    ? "Unavailable for this run"
                    : run.cost_microunits.toLocaleString()
                }
              />
              <ContractField
                label="Frozen cost ceiling (µ-units)"
                value={
                  run.max_modeled_cost_microunits == null
                    ? "Unavailable for this run"
                    : run.max_modeled_cost_microunits.toLocaleString()
                }
              />
            </dl>
            <p className="text-xs text-muted-foreground">
              {latest.detail.manifest.artifacts.length} frozen artifact(s),{" "}
              {latest.detail.manifest.configurations.length} analyzer
              configuration(s), and {latest.detail.manifest.targets.length}{" "}
              exact target(s).
            </p>
            {extractions.map((extraction) => (
              <div key={extraction.id} className="rounded border p-2 text-xs">
                <span className="font-medium">
                  {CAMPAIGN_ASSURANCE_SOURCE_LABELS[extraction.source_class]}
                </span>
                {extraction.source_class === "modeled" ? (
                  <span className="text-muted-foreground">
                    {` · ${extraction.model_provider || "provider unavailable"} / ${extraction.model_id || "model unavailable"} / ${extraction.model_version || "version unavailable"} · ${extraction.execution_kind === "cache_reuse" ? "exact-cache reuse" : extraction.execution_kind === "invoked" ? "provider invocation" : "execution lineage unavailable"}`}
                  </span>
                ) : null}
                <HashValue label="Receipt" value={extraction.receipt_hash} />
                {extraction.execution_kind === "cache_reuse" &&
                extraction.reused_from_receipt_hash ? (
                  <HashValue
                    label="Invoked-origin receipt"
                    value={extraction.reused_from_receipt_hash}
                  />
                ) : null}
              </div>
            ))}
          </div>
        </details>
      </CardContent>
    </Card>
  );
}

export function CampaignAssuranceSendStatus(identity: AssuranceIdentity) {
  const query = useCampaignAssuranceLatest(identity);
  if (query.isPending) {
    return (
      <div
        className="rounded-md border p-3 text-xs text-muted-foreground"
        role="status"
      >
        <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />
        Checking the exact Campaign Assurance receipt…
      </div>
    );
  }
  if (query.isError && isCampaignAssuranceNotEnabled(query.error)) {
    return (
      <div
        className="rounded-md border p-3 text-xs text-muted-foreground"
        role="status"
      >
        Campaign Assurance isn&apos;t turned on in this environment, so this
        send doesn&apos;t wait on an assurance receipt.
      </div>
    );
  }
  if (query.isError) {
    const missing =
      query.error instanceof ApiError && query.error.status === 404;
    return (
      <div
        className="rounded-md border border-warning/40 bg-warning-subtle/30 p-3 text-xs text-warning-emphasis"
        role="status"
      >
        {missing
          ? "No Campaign Assurance receipt is available."
          : "Campaign Assurance could not be loaded."}{" "}
        The server queue gate remains authoritative and will recheck before any
        recipient is queued.
      </div>
    );
  }
  const latest = query.data.data;
  const verdict = assuranceVerdict(latest);
  return (
    <div
      className="rounded-md border p-3 text-xs"
      role={verdict.alert ? "alert" : "status"}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Predicted Agent Comprehension</span>
        <Badge variant={verdict.variant}>{verdict.label}</Badge>
      </div>
      <p className="mt-1 text-muted-foreground">{verdict.detail}</p>
      <div className="mt-2 grid gap-1 font-mono text-[10px] text-muted-foreground sm:grid-cols-2">
        <span title={latest.detail.run.source_hash}>
          Source {shortHash(latest.detail.run.source_hash)}
        </span>
        <span title={latest.detail.run.plan_hash}>
          Plan {shortHash(latest.detail.run.plan_hash)}
        </span>
        <span title={latest.detail.run.artifact_set_hash}>
          Artifacts {shortHash(latest.detail.run.artifact_set_hash)}
        </span>
        <span>Freshness {latest.applicability.freshness}</span>
      </div>
      <p className="mt-2 text-muted-foreground">
        The queue endpoint validates these exact identities again; this preview
        never bypasses that gate.
      </p>
    </div>
  );
}

const SOURCE_ORDER: CampaignAssuranceSourceClass[] = [
  "deterministic",
  "modeled",
  "controlled_observation",
];

function SourceDisclosureRow({
  sources,
  unavailable,
}: {
  sources: Array<{
    class: CampaignAssuranceSourceClass;
    present: boolean;
    meaning: string;
  }>;
  unavailable: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-2" aria-label="Evidence source classes">
      {SOURCE_ORDER.map((sourceClass) => {
        const source = sources.find((item) => item.class === sourceClass);
        return (
          <Badge
            key={sourceClass}
            variant={source?.present ? "outline" : "warning"}
            title={source?.meaning}
          >
            {CAMPAIGN_ASSURANCE_SOURCE_LABELS[sourceClass]} ·{" "}
            {source?.present ? "present" : "unavailable"}
          </Badge>
        );
      })}
      <Badge variant={unavailable ? "warning" : "outline"}>
        {CAMPAIGN_ASSURANCE_SOURCE_LABELS.unavailable} ·{" "}
        {unavailable ? "present" : "none"}
      </Badge>
    </div>
  );
}

function ReceiptSummary({ latest }: { latest: CampaignAssuranceLatest }) {
  const run = latest.detail.run;
  return (
    <section aria-labelledby="assurance-receipt-title" className="space-y-2">
      <h3 id="assurance-receipt-title" className="text-sm font-semibold">
        Immutable receipt
      </h3>
      <dl className="grid gap-x-4 gap-y-2 rounded-md border p-3 text-xs sm:grid-cols-2">
        <ContractField label="Run" value={`#${run.run_no} · ${run.id}`} mono />
        <ContractField
          label="Frozen revision"
          value={run.content_revision_id}
          mono
        />
        <ContractField label="Send plan" value={run.send_plan_id} mono />
        <ContractField label="Profile" value={run.profile} />
        <HashValue label="Source hash" value={run.source_hash} />
        <HashValue label="Plan hash" value={run.plan_hash} />
        <HashValue label="Artifact-set hash" value={run.artifact_set_hash} />
        <HashValue
          label="Coverage manifest hash"
          value={run.coverage_manifest_hash}
        />
        <HashValue
          label="Configuration manifest hash"
          value={run.configuration_manifest_hash}
        />
        <HashValue
          label="Target manifest hash"
          value={run.target_manifest_hash}
        />
        <ContractField
          label="Freshness"
          value={latest.applicability.freshness}
        />
        <ContractField
          label="Extraction coverage"
          value={`${run.successful_extraction_count}/${run.required_extraction_count} successful; ${run.extraction_error_count} error(s)`}
        />
        <ContractField
          label="Predicted score"
          value={
            run.overall_score == null
              ? "Unavailable"
              : `${run.overall_score.toFixed(1)} (${run.score_min ?? "—"}–${run.score_max ?? "—"})`
          }
        />
      </dl>
    </section>
  );
}

function ContractField({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={`${mono ? "font-mono text-[11px]" : ""} break-words`}
        title={value}
      >
        {value || "—"}
      </dd>
    </div>
  );
}

function HashValue({ label, value }: { label: string; value: string }) {
  return <ContractField label={label} value={value} mono />;
}

function FindingRow({
  campaignId,
  runId,
  finding,
  override,
  canOverride,
  canEdit,
  canApply,
  campaignETag,
  identity,
  onChanged,
}: {
  campaignId: string;
  runId: string;
  finding: CampaignAssuranceFinding;
  override?: { decision: string; reason: string; expires_at?: string };
  canOverride: boolean;
  canEdit: boolean;
  canApply: boolean;
  campaignETag: string | null;
  identity: MeResponse | null | undefined;
  onChanged: () => void;
}) {
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const [appliedRevision, setAppliedRevision] = useState<string | null>(null);
  const hasDeterministicPatch =
    finding.source_class === "deterministic" &&
    finding.typed_patch !== undefined;
  return (
    <div
      className={`rounded-md border p-3 text-sm ${finding.blocking ? "border-destructive/40" : ""}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium">{finding.code}</p>
          <p className="text-xs text-muted-foreground">
            {finding.dimension} · {finding.severity}
          </p>
        </div>
        <div className="flex gap-1">
          {finding.blocking ? (
            <Badge variant="destructive">Blocks</Badge>
          ) : (
            <Badge variant="outline">Advisory</Badge>
          )}
          {override ? (
            <Badge
              variant={overrideIsActive(override) ? "warning" : "destructive"}
            >
              {override.decision !== "allow_send"
                ? "Rejected"
                : overrideIsActive(override)
                  ? "Waived"
                  : "Waiver expired"}
            </Badge>
          ) : null}
        </div>
      </div>
      <p className="mt-2">{finding.explanation}</p>
      <p className="mt-2 text-xs text-muted-foreground">
        Remediation: {remediationSummary(finding.remediation)} Any content
        change creates a new revision and requires a fresh assurance run.
      </p>
      {hasDeterministicPatch ? (
        <p className="mt-1 text-xs text-muted-foreground">
          A deterministic typed repair is recorded. The server will apply only a
          validated heading-level TypedPatchV1 and will create a different
          immutable revision; it never edits this receipt in place.
        </p>
      ) : finding.typed_patch !== undefined ? (
        <p className="mt-1 text-xs text-muted-foreground">
          A typed proposal is recorded, but automatic application is limited to
          deterministic heading-level repairs. No change was applied.
        </p>
      ) : null}
      <HashValue label="Finding receipt" value={finding.receipt_hash} />
      {override ? (
        <p className="mt-2 rounded border bg-muted/20 p-2 text-xs">
          Governed decision: {override.reason}
          {override.expires_at
            ? `${
                overrideIsActive(override) ? " · expires " : " · expired "
              }${new Date(override.expires_at).toLocaleString()}`
            : ""}
          {override.decision === "allow_send" && !overrideIsActive(override)
            ? " — this waiver no longer authorises a send; the finding is blocking again."
            : ""}
        </p>
      ) : finding.overridable && canOverride ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="mt-2"
          onClick={() => setOverrideOpen(true)}
        >
          Record governed decision
        </Button>
      ) : finding.overridable ? (
        <p className="mt-2 text-xs text-muted-foreground">
          An owner or admin may record a governed decision.
        </p>
      ) : null}
      {appliedRevision ? (
        <p className="mt-2 rounded border border-warning/40 bg-warning-subtle/20 p-2 text-xs">
          Applied into revision{" "}
          <span className="font-mono">{appliedRevision}</span>. The originating
          run and plan are stale; freeze the next plan and rerun Campaign
          Assurance before sending.
        </p>
      ) : hasDeterministicPatch && canEdit ? (
        <div className="mt-2 space-y-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!canApply || !campaignETag}
            onClick={() => setApplyOpen(true)}
          >
            Apply deterministic repair
          </Button>
          {!canApply ? (
            <p className="text-xs text-muted-foreground">
              Finish or discard local edits before applying this repair.
            </p>
          ) : !campaignETag ? (
            <p className="text-xs text-muted-foreground">
              Reload the campaign to capture its authoritative ETag before
              applying.
            </p>
          ) : null}
        </div>
      ) : hasDeterministicPatch ? (
        <p className="mt-2 text-xs text-muted-foreground">
          An editor, admin, or owner may apply this stored deterministic repair.
        </p>
      ) : null}
      <OverrideDialog
        open={overrideOpen}
        onOpenChange={setOverrideOpen}
        campaignId={campaignId}
        runId={runId}
        finding={finding}
        identity={identity}
        onChanged={onChanged}
      />
      {hasDeterministicPatch && canEdit && campaignETag ? (
        <ApplyPatchDialog
          open={applyOpen}
          onOpenChange={setApplyOpen}
          campaignId={campaignId}
          runId={runId}
          finding={finding}
          campaignETag={campaignETag}
          identity={identity}
          onApplied={(revisionId) => {
            setAppliedRevision(revisionId);
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}

export function ApplyPatchDialog({
  open,
  onOpenChange,
  campaignId,
  runId,
  finding,
  campaignETag,
  identity,
  onApplied,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  campaignId: string;
  runId: string;
  finding: CampaignAssuranceFinding;
  campaignETag: string;
  identity: MeResponse | null | undefined;
  onApplied: (revisionId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const canWrite = canWriteCampaigns(identity);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const submit = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setError(null);
    setBusy(true);
    try {
      await confirmFreshCampaignWriteAuthority(identity);
      const result = await applyCampaignAssuranceFinding(
        campaignId,
        runId,
        finding.id,
        campaignETag,
      );
      const applied = result.receipt.data;
      if (
        applied.originating_run_state !== "stale" ||
        applied.rerun_required !== true ||
        !applied.revision?.id
      ) {
        throw new Error(
          "The repair response did not include a stale-run rerun receipt.",
        );
      }
      toast.success(
        "Repair applied to a new revision. A new plan and assurance run are required.",
      );
      onOpenChange(false);
      onApplied(applied.revision.id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 412) {
        onApplied("");
        onOpenChange(false);
        toast.error(
          "The campaign changed. It was refreshed; review the finding before trying again.",
        );
      } else if (error instanceof CampaignAssuranceApplyProvenanceError) {
        onApplied("");
        onOpenChange(false);
        toast.error(
          "The repair acknowledgement was incomplete. The campaign was refreshed before another repair can be attempted.",
        );
      } else if (
        error instanceof ApiError &&
        (error.status === 0 || error.status >= 500 || error.kind !== "http")
      ) {
        onApplied("");
        onOpenChange(false);
        toast.error(
          "The repair result could not be confirmed. The campaign was refreshed before another repair can be attempted.",
        );
      } else {
        const message = campaignAssuranceErrorMessage(
          error,
          "Could not apply the deterministic repair.",
        );
        setError(message);
        toast.error(message);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busyRef.current) return;
        onOpenChange(next);
        if (next) setError(null);
      }}
    >
      <DialogContent
        aria-busy={busy}
        onEscapeKeyDown={(event) => {
          if (busyRef.current) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (busyRef.current) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Apply deterministic repair?</DialogTitle>
          <DialogDescription>
            This submits finding {finding.code} against the exact campaign ETag.
            The server accepts only a deterministic heading-level TypedPatchV1,
            creates or reuses a different immutable revision, and makes the old
            run and plan stale. It does not rerun assurance automatically.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <div
            ref={errorRef}
            tabIndex={-1}
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis"
          >
            {error}
          </div>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy || !canWrite}
            onClick={() => void submit()}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Create repaired revision
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function OverrideDialog({
  open,
  onOpenChange,
  campaignId,
  runId,
  finding,
  identity,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  campaignId: string;
  runId: string;
  finding: CampaignAssuranceFinding;
  identity: MeResponse | null | undefined;
  onChanged: () => void;
}) {
  const [decision, setDecision] = useState<"allow_send" | "reject">(
    "allow_send",
  );
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const canAdmin = canAdminCampaigns(identity);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const submit = async () => {
    if (busyRef.current) return;
    const rationale = reason.trim();
    if (rationale.length < 10) {
      toast.error("Give a specific rationale of at least 10 characters.");
      return;
    }
    busyRef.current = true;
    setError(null);
    setBusy(true);
    try {
      await confirmFreshCampaignAdminAuthority(identity);
      await overrideCampaignAssuranceFinding(campaignId, runId, finding.id, {
        decision,
        reason: rationale,
      });
      toast.success(
        "Governed decision recorded against the immutable finding.",
      );
      setReason("");
      onOpenChange(false);
      onChanged();
    } catch (error) {
      const message = campaignAssuranceErrorMessage(
        error,
        "Could not record the governed decision.",
      );
      setError(message);
      toast.error(message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busyRef.current) return;
        onOpenChange(next);
        if (next) setError(null);
      }}
    >
      <DialogContent
        aria-busy={busy}
        onEscapeKeyDown={(event) => {
          if (busyRef.current) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (busyRef.current) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Govern finding {finding.code}</DialogTitle>
          <DialogDescription>
            This writes an immutable, finding-scoped decision. It does not edit
            the email or erase the finding.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor={`decision-${finding.id}`}>Decision</Label>
            <Select
              id={`decision-${finding.id}`}
              value={decision}
              disabled={busy}
              onChange={(event) =>
                setDecision(event.target.value as "allow_send" | "reject")
              }
            >
              <option value="allow_send">Allow this exact frozen send</option>
              <option value="reject">Reject this finding appeal</option>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`reason-${finding.id}`}>Rationale</Label>
            <Textarea
              id={`reason-${finding.id}`}
              value={reason}
              disabled={busy}
              maxLength={2000}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Explain why this exact finding is acceptable or must remain blocked."
            />
            <p className="text-xs text-muted-foreground">
              {reason.trim().length}/2000 · minimum 10
            </p>
          </div>
          {error ? (
            <div
              ref={errorRef}
              tabIndex={-1}
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis"
            >
              {error}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy || !canAdmin || reason.trim().length < 10}
            onClick={() => void submit()}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Record
            decision
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UnavailableEvidence({
  missingSources,
  extractions,
}: {
  missingSources: Array<{
    class: CampaignAssuranceSourceClass;
    meaning: string;
  }>;
  extractions: Array<{
    id: string;
    source_class: CampaignAssuranceSourceClass;
    error_code?: string;
    error_message?: string;
  }>;
}) {
  if (!missingSources.length && !extractions.length) return null;
  return (
    <section
      aria-labelledby="unavailable-evidence-title"
      className="rounded-md border border-warning/40 bg-warning-subtle/20 p-3 text-sm"
    >
      <h3
        id="unavailable-evidence-title"
        className="flex items-center gap-2 font-semibold"
      >
        <CircleSlash2 className="h-4 w-4" /> Unavailable evidence
      </h3>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
        {missingSources.map((source) => (
          <li key={source.class}>
            {CAMPAIGN_ASSURANCE_SOURCE_LABELS[source.class]}: {source.meaning}
          </li>
        ))}
        {extractions.map((extraction) => (
          <li key={extraction.id}>
            {CAMPAIGN_ASSURANCE_SOURCE_LABELS[extraction.source_class]}{" "}
            extraction:{" "}
            {extraction.error_message || extraction.error_code || "unavailable"}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs">
        Unavailable modeled evidence never becomes a green result.
      </p>
    </section>
  );
}

function assuranceVerdict(latest: CampaignAssuranceLatest): {
  label: string;
  detail: string;
  variant: "success" | "warning" | "destructive" | "outline";
  icon: typeof CheckCircle2;
  alert: boolean;
} {
  const { run } = latest.detail;
  if (
    !latest.applicability.applicable_to_frozen_snapshot ||
    latest.applicability.freshness !== "frozen_snapshot_current" ||
    run.state === "stale" ||
    run.state === "cancelled"
  ) {
    return {
      label: "Stale",
      detail:
        "This receipt is not applicable to the current frozen snapshot. Create a new revision/plan as needed and rerun.",
      variant: "warning",
      icon: AlertTriangle,
      alert: true,
    };
  }
  if (
    run.state === "queued" ||
    run.state === "running" ||
    run.gate_decision === "pending"
  ) {
    return {
      label: "Running",
      detail: `${run.terminal_extraction_count}/${run.required_extraction_count} required extractions are terminal.`,
      variant: "outline",
      icon: Loader2,
      alert: false,
    };
  }
  if (run.state !== "complete" || run.gate_decision === "unavailable") {
    return {
      label: "Incomplete",
      detail:
        "Required evidence is incomplete or unavailable; this is not a passing receipt.",
      variant: "warning",
      icon: CircleSlash2,
      alert: true,
    };
  }
  if (run.gate_decision === "block") {
    return {
      label: "Blocked",
      detail: `${run.blocking_finding_count} blocking finding(s) remain on this exact artifact set.`,
      variant: "destructive",
      icon: AlertTriangle,
      alert: true,
    };
  }
  if (run.gate_decision === "warn") {
    return {
      label: "Warnings",
      detail:
        "The receipt is current and complete, with advisory findings for review.",
      variant: "warning",
      icon: AlertTriangle,
      alert: false,
    };
  }
  if (run.gate_decision === "pass") {
    return {
      label: "Current receipt",
      detail:
        "The receipt is complete and current for this exact frozen revision, plan, and artifact set.",
      variant: "success",
      icon: CheckCircle2,
      alert: false,
    };
  }
  return {
    label: "Unavailable",
    detail:
      "The receipt has an unrecognized decision and cannot be treated as passing.",
    variant: "warning",
    icon: CircleSlash2,
    alert: true,
  };
}

function nextEvidenceOffset(
  evidence: CampaignAssuranceEvidence,
): number | undefined {
  return [
    evidence.extractions.next_offset,
    evidence.findings.next_offset,
    evidence.overrides.next_offset,
  ]
    .filter((value): value is number => typeof value === "number")
    .sort((a, b) => a - b)[0];
}

function mergeEvidencePages(
  pages: CampaignAssuranceEvidence[] | undefined,
): CampaignAssuranceEvidence | null {
  if (!pages?.length) return null;
  const first = pages[0];
  return {
    ...first,
    extractions: {
      ...first.extractions,
      items: pages.flatMap((page) => page.extractions.items),
    },
    findings: {
      ...first.findings,
      items: pages.flatMap((page) => page.findings.items),
    },
    overrides: {
      ...first.overrides,
      items: pages.flatMap((page) => page.overrides.items),
    },
  };
}

/**
 * The override the gate would consider for a finding, mirroring
 * campaignassurancegate.authorizeOverrides.
 *
 * Selection order is load-bearing and matches the gate exactly: take the
 * LATEST override for the finding, then judge it. The gate does not fall back
 * to an older still-valid override, so a fresh `reject` supersedes an earlier
 * `allow_send`, and an expired latest override blocks even when a live one
 * sits beneath it. Selecting-then-validating in the other order would make
 * this panel disagree with the gate in precisely the cases that matter.
 */
function latestOverrideFor(
  overrides: CampaignAssuranceEvidence["overrides"]["items"],
  findingId: string,
) {
  return overrides
    .filter((override) => override.finding_id === findingId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
}

/**
 * Whether an override actually waives the send right now.
 *
 * `expires_at` was rendered as text and never compared to anything, so an
 * expired waiver kept its "Waived" badge. The gate disqualifies it
 * (`override.ExpiresAt != nil && !override.ExpiresAt.After(now)`), leaves the
 * finding blocking and refuses the queue — so the panel was asserting a state
 * the server contradicts, and the operator only learned otherwise by clicking
 * Send.
 */
export function overrideIsActive(
  override: { decision: string; expires_at?: string } | undefined,
  now: number = Date.now(),
): boolean {
  if (!override || override.decision !== "allow_send") return false;
  if (!override.expires_at) return true;
  const expiry = new Date(override.expires_at).getTime();
  // An unparseable timestamp cannot be shown to be in the future; the gate
  // would reject it, so neither does this claim it waives anything.
  if (Number.isNaN(expiry)) return false;
  return expiry > now;
}

function shortHash(value: string): string {
  return value.length > 14 ? `${value.slice(0, 7)}…${value.slice(-7)}` : value;
}

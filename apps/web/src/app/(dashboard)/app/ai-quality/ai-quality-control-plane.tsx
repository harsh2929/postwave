// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, FlaskConical, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import {
  GovernanceEmpty,
  GovernanceError,
  GovernanceLoading,
  GovernancePageHeader,
  GovernanceSection,
} from "@/components/governance/governance-ui";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import {
  AI_REGRESSION_SURFACES,
  aiRegressionSettingsError,
  archiveGoldenExample,
  captureGoldenExample,
  currentGateCorpusEligibility,
  getAiRegressionRun,
  getAiRegressionSettings,
  goldenCaptureDraftError,
  listAiRegressionRunResults,
  listAiRegressionRuns,
  listGoldenExamples,
  newGoldenCaptureRequestId,
  sameAiRegressionSettings,
  sameGoldenExampleRevision,
  triggerAiRegressionRun,
  updateAiRegressionSettings,
  type AiRegressionRun,
  type AiRegressionSettings,
  type AiRegressionSurface,
  type CaptureGoldenExampleInput,
  type GoldenExample,
} from "@/lib/ai-regression-api";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { STALE } from "@/lib/query-keys";
import { roleCanWrite } from "@/lib/use-admin-gate";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";

import { gateVariant, surfaceLabel } from "./_ai-quality-helpers";

const ARCHIVE_TOKEN = "ARCHIVE REFERENCE";

// Run evidence (detail read, per-result rows, frozen forensic texts) only
// renders for the one expanded run, so it loads on demand instead of in the
// route's eager chunk (bundle budget). The fallback matches the panel's own
// loading state so the run list does not jump when it mounts.
const RunEvidence = dynamic(
  () => import("./_run-evidence").then((mod) => mod.RunEvidence),
  {
    loading: () => <GovernanceLoading label="Loading run evidence…" rows={3} />,
  },
);

function runStatusVariant(
  status: AiRegressionRun["status"],
): "success" | "warning" | "destructive" {
  if (status === "completed") return "success";
  if (status === "failed") return "destructive";
  return "warning";
}

function sameRunRevision(
  left: AiRegressionRun,
  right: AiRegressionRun,
): boolean {
  return (
    left.id === right.id &&
    left.status === right.status &&
    left.updatedAt === right.updatedAt &&
    left.attemptCount === right.attemptCount &&
    left.totalExamples === right.totalExamples &&
    left.scoredExamples === right.scoredExamples &&
    left.errorExamples === right.errorExamples &&
    left.gateResult === right.gateResult
  );
}

export function AiQualityControlPlane({ identity }: { identity: MeResponse }) {
  const role = effectiveAuthRole(identity);
  const canAdmin = roleCanWrite(role) && !identity.viewer_mode;
  const queryClient = useQueryClient();
  const baseKey = ["ai-regression", identity.tenant_id, role] as const;
  const goldenKey = [...baseKey, "golden", "all"] as const;
  const runsKey = [...baseKey, "runs"] as const;
  const settingsKey = [...baseKey, "settings"] as const;

  const golden = useQuery({
    queryKey: goldenKey,
    queryFn: ({ signal }) => listGoldenExamples({ signal, limit: 500 }),
    staleTime: STALE.list,
    retry: false,
  });
  const runs = useQuery({
    queryKey: runsKey,
    queryFn: ({ signal }) => listAiRegressionRuns({ signal, limit: 200 }),
    staleTime: STALE.list,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.some((run) =>
        ["pending", "running"].includes(run.status),
      )
        ? 5_000
        : false,
  });
  const settings = useQuery({
    queryKey: settingsKey,
    queryFn: ({ signal }) => getAiRegressionSettings({ signal }),
    enabled: canAdmin,
    staleTime: STALE.detail,
    retry: false,
  });

  const [settingsDraft, setSettingsDraft] =
    useState<AiRegressionSettings | null>(null);
  const [settingsBaseline, setSettingsBaseline] =
    useState<AiRegressionSettings | null>(null);
  const [surfaceFilter, setSurfaceFilter] = useState<
    "all" | AiRegressionSurface
  >("all");
  const [captureSurface, setCaptureSurface] =
    useState<AiRegressionSurface>("campaign_draft");
  const [captureBrief, setCaptureBrief] = useState("");
  const [captureOutput, setCaptureOutput] = useState("");
  const [captureAcknowledged, setCaptureAcknowledged] = useState(false);
  // The draft's validation message waits for the reader: it appears once
  // they leave the brief or output field, tick the confirmation, or submit.
  // An untouched form is not a mistake, and "Brief is required." on arrival
  // reads as one.
  const [captureTouched, setCaptureTouched] = useState(false);
  const captureAttemptRef = useRef<{
    fingerprint: string;
    requestId: string;
  } | null>(null);
  const [runLabel, setRunLabel] = useState("");
  const [runAcknowledged, setRunAcknowledged] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<GoldenExample | null>(
    null,
  );
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const operationRef = useRef(false);

  const settingsDirty = Boolean(
    settingsDraft &&
    settingsBaseline &&
    !sameAiRegressionSettings(settingsDraft, settingsBaseline),
  );
  const captureDirty = Boolean(
    captureBrief || captureOutput || captureAcknowledged,
  );
  useUnsavedChangesGuard((settingsDirty || captureDirty) && !saving);

  useEffect(() => {
    if (!settings.data || settingsDirty || saving) return;
    if (
      settingsBaseline &&
      sameAiRegressionSettings(settings.data, settingsBaseline)
    ) {
      return;
    }
    setSettingsBaseline(settings.data);
    setSettingsDraft(settings.data);
  }, [settings.data, settingsBaseline, settingsDirty, saving]);

  const filteredGolden = useMemo(
    () =>
      (Array.isArray(golden.data) ? golden.data : []).filter(
        (example) =>
          surfaceFilter === "all" || example.surfaceKind === surfaceFilter,
      ),
    [golden.data, surfaceFilter],
  );
  const gateEligibility =
    settingsDraft && golden.isSuccess
      ? currentGateCorpusEligibility(settingsDraft, golden.data.length)
      : null;
  const settingsValidation = settingsDraft
    ? aiRegressionSettingsError(settingsDraft)
    : null;
  const captureFingerprint = JSON.stringify([
    captureSurface,
    captureBrief.trim(),
    captureOutput.trim(),
  ]);
  const captureValidation = goldenCaptureDraftError({
    requestId:
      captureAttemptRef.current?.fingerprint === captureFingerprint
        ? captureAttemptRef.current.requestId
        : "00000000-0000-4000-8000-000000000000",
    surfaceKind: captureSurface,
    brief: captureBrief,
    approvedOutput: captureOutput,
  });
  const captureErrorShown = captureTouched ? captureValidation : null;

  const selectedSummary = (Array.isArray(runs.data) ? runs.data : []).find(
    (run) => run.id === selectedRunId,
  );
  const runDetail = useQuery({
    queryKey: [...baseKey, "run", selectedRunId],
    queryFn: ({ signal }) =>
      getAiRegressionRun(selectedRunId ?? "", { signal }),
    enabled: selectedRunId !== null,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchInterval: (query) =>
      query.state.data &&
      ["pending", "running"].includes(query.state.data.status)
        ? 5_000
        : false,
  });
  const runResults = useQuery({
    queryKey: [...baseKey, "run", selectedRunId, "results"],
    queryFn: ({ signal }) =>
      listAiRegressionRunResults(selectedRunId ?? "", { signal }),
    enabled: selectedRunId !== null,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchInterval:
      runDetail.data && ["pending", "running"].includes(runDetail.data.status)
        ? 5_000
        : false,
  });

  async function saveSettings(): Promise<void> {
    if (
      !canAdmin ||
      !settingsDraft ||
      !settingsBaseline ||
      settingsValidation ||
      !settingsDirty ||
      operationRef.current
    ) {
      return;
    }
    operationRef.current = true;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await verifyFreshAdminAuthority(identity);
      const current = await getAiRegressionSettings({ fresh: true });
      if (!sameAiRegressionSettings(settingsBaseline, current)) {
        queryClient.setQueryData(settingsKey, current);
        setSettingsBaseline(current);
        setSettingsDraft(current);
        throw new Error(
          "The evaluation policy changed after this form opened. Nothing was written; review the fresh server values.",
        );
      }
      const receipt = await updateAiRegressionSettings(settingsDraft);
      const confirmed = await getAiRegressionSettings({ fresh: true });
      if (
        !sameAiRegressionSettings(receipt, confirmed) ||
        !sameAiRegressionSettings(settingsDraft, confirmed)
      ) {
        throw new Error(
          "The policy write returned, but a fresh read did not confirm the complete replacement.",
        );
      }
      queryClient.setQueryData(settingsKey, confirmed);
      setSettingsBaseline(confirmed);
      setSettingsDraft(confirmed);
      setSuccess(
        "Future-run evaluation policy was replaced and confirmed. Historical receipts were not reinterpreted.",
      );
      toast.success("AI evaluation policy saved.");
    } catch (caught) {
      setError(
        apiErrorMessage(caught, "Could not save the evaluation policy."),
      );
      void settings.refetch();
    } finally {
      operationRef.current = false;
      setSaving(false);
    }
  }

  async function captureReference(): Promise<void> {
    if (
      !canAdmin ||
      captureValidation ||
      !captureAcknowledged ||
      operationRef.current
    ) {
      return;
    }
    let attempt = captureAttemptRef.current;
    if (!attempt || attempt.fingerprint !== captureFingerprint) {
      try {
        attempt = {
          fingerprint: captureFingerprint,
          requestId: newGoldenCaptureRequestId(),
        };
      } catch {
        setError(
          "Secure request-ID generation is unavailable. The reference form was retained and nothing was submitted.",
        );
        return;
      }
      captureAttemptRef.current = attempt;
    }
    operationRef.current = true;
    setSaving(true);
    setError(null);
    setSuccess(null);
    const input: CaptureGoldenExampleInput = {
      requestId: attempt.requestId,
      surfaceKind: captureSurface,
      brief: captureBrief,
      approvedOutput: captureOutput,
    };
    try {
      await verifyFreshAdminAuthority(identity);
      const before = await listGoldenExamples({ fresh: true, limit: 500 });
      const existing = before.find(
        (example) => example.requestId === attempt.requestId,
      );
      const receipt = existing ?? (await captureGoldenExample(input));
      const after = await listGoldenExamples({ fresh: true, limit: 500 });
      const confirmed = after.find((example) => example.id === receipt.id);
      if (
        !confirmed ||
        confirmed.requestId !== attempt.requestId ||
        !sameGoldenExampleRevision(receipt, confirmed)
      ) {
        throw new Error(
          "The capture returned, but a fresh corpus read did not confirm the idempotent reference receipt.",
        );
      }
      queryClient.setQueryData(goldenKey, after);
      captureAttemptRef.current = null;
      setCaptureBrief("");
      setCaptureOutput("");
      setCaptureAcknowledged(false);
      setCaptureTouched(false);
      setSuccess(
        "Golden reference captured and confirmed. Its approved output is write-only in the corpus list and will appear only inside an immutable run snapshot.",
      );
      toast.success("Golden reference captured.");
    } catch (caught) {
      setError(
        apiErrorMessage(caught, "Could not capture the golden reference."),
      );
      void golden.refetch();
    } finally {
      operationRef.current = false;
      setSaving(false);
    }
  }

  async function archiveReference(example: GoldenExample): Promise<void> {
    if (!canAdmin || operationRef.current) return;
    operationRef.current = true;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await verifyFreshAdminAuthority(identity);
      const before = await listGoldenExamples({ fresh: true, limit: 500 });
      const current = before.find((candidate) => candidate.id === example.id);
      if (!current || !sameGoldenExampleRevision(example, current)) {
        queryClient.setQueryData(goldenKey, before);
        throw new Error(
          "This reference changed or was archived after confirmation opened. Review the fresh corpus state.",
        );
      }
      await archiveGoldenExample(current.id);
      const after = await listGoldenExamples({ fresh: true, limit: 500 });
      if (after.some((candidate) => candidate.id === current.id)) {
        throw new Error("A fresh corpus read did not confirm archival.");
      }
      queryClient.setQueryData(goldenKey, after);
      setArchiveTarget(null);
      setSuccess(
        "Golden reference archived for future runs. Existing immutable run snapshots and results were not changed.",
      );
      toast.success("Golden reference archived.");
    } catch (caught) {
      setError(apiErrorMessage(caught, "Could not archive the reference."));
      void golden.refetch();
      throw caught;
    } finally {
      operationRef.current = false;
      setSaving(false);
    }
  }

  async function triggerRun(): Promise<void> {
    const label = runLabel.trim();
    if (
      !canAdmin ||
      !label ||
      Array.from(label).length > 160 ||
      !runAcknowledged ||
      operationRef.current
    ) {
      return;
    }
    operationRef.current = true;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await verifyFreshAdminAuthority(identity);
      const before = await listAiRegressionRuns({ fresh: true, limit: 200 });
      if (before.some((run) => ["pending", "running"].includes(run.status))) {
        queryClient.setQueryData(runsKey, before);
        throw new Error(
          "A regression run is already pending or running. Wait for its durable receipt to settle.",
        );
      }
      const receipt = await triggerAiRegressionRun(label);
      const detail = await getAiRegressionRun(receipt.runId, { fresh: true });
      if (
        detail.modelVersionTag !== label ||
        detail.runtimeProvider !== receipt.runtime.provider ||
        detail.modelId !== receipt.runtime.modelId ||
        detail.promptVersionTag !== receipt.runtime.promptPolicyVersion
      ) {
        throw new Error(
          "The durable run receipt did not match the server-attested runtime returned by the trigger.",
        );
      }
      const after = await listAiRegressionRuns({ fresh: true, limit: 200 });
      const inList = after.find((run) => run.id === detail.id);
      if (!inList || !sameRunRevision(detail, inList)) {
        throw new Error(
          "The run detail was created, but the fresh run collection did not confirm the same lifecycle revision.",
        );
      }
      queryClient.setQueryData(runsKey, after);
      queryClient.setQueryData([...baseKey, "run", detail.id], detail);
      setSelectedRunId(detail.id);
      setRunLabel("");
      setRunAcknowledged(false);
      setSuccess(
        `Regression run receipt ${detail.id} was confirmed with current status ${detail.status}. Runtime identity and current policy were frozen by the server.`,
      );
      toast.success("Regression replay queued.");
    } catch (caught) {
      setError(
        apiErrorMessage(caught, "Could not queue the regression replay."),
      );
      void runs.refetch();
    } finally {
      operationRef.current = false;
      setSaving(false);
    }
  }

  return (
    <>
      <GovernancePageHeader
        icon={FlaskConical}
        eyebrow="AI evidence"
        title="AI quality gate"
        description="Manage a human-approved reference corpus and inspect durable replay evidence. Recorded outcomes do not deploy or block a model release."
        refreshLabel="Refresh AI evidence"
        refreshing={golden.isFetching || runs.isFetching || settings.isFetching}
        onRefresh={() => {
          void golden.refetch();
          void runs.refetch();
          if (canAdmin) void settings.refetch();
        }}
      />

      <Alert role="note">
        <ShieldCheck className="size-4" aria-hidden />
        <AlertTitle>Evidence boundary</AlertTitle>
        <AlertDescription>
          “Pass”, “fail”, and “advisory” are recorded classifications over a
          frozen corpus, runtime identity, and policy snapshot. This control
          plane has no deployment, campaign-send, or model-routing authority.
        </AlertDescription>
      </Alert>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>AI evidence operation not confirmed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {success ? (
        <p role="status" className="text-sm text-success-emphasis">
          {success}
        </p>
      ) : null}

      <GovernanceSection
        icon={ShieldCheck}
        title="Future-run evaluation policy"
        description="Admin-only replacement policy. Each queued run freezes its own copy, so changes never rewrite history."
      >
        {!canAdmin ? (
          <Alert>
            <AlertTitle>Current policy is admin-only</AlertTitle>
            <AlertDescription>
              Historical runs expose their frozen thresholds to viewers. The
              current future-run policy is not requested for this effective
              role.
            </AlertDescription>
          </Alert>
        ) : settings.isPending || !settingsDraft || !settingsBaseline ? (
          settings.isError ? (
            <GovernanceError
              message={apiErrorMessage(
                settings.error,
                "Current AI evaluation policy could not be verified.",
              )}
              retrying={settings.isFetching}
              onRetry={() => void settings.refetch()}
            />
          ) : (
            <GovernanceLoading label="Loading AI evaluation policy…" rows={3} />
          )
        ) : (
          <form
            className="space-y-4"
            aria-busy={saving}
            onSubmit={(event) => {
              event.preventDefault();
              void saveSettings();
            }}
          >
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="ai-warning-threshold">Warning below</Label>
                <Input
                  id="ai-warning-threshold"
                  type="number"
                  min={0}
                  max={100}
                  step="0.1"
                  value={settingsDraft.warnThreshold}
                  disabled={saving}
                  onChange={(event) =>
                    setSettingsDraft({
                      ...settingsDraft,
                      warnThreshold: event.currentTarget.valueAsNumber,
                    })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ai-threshold-outcome">
                  Threshold outcome below
                </Label>
                <Input
                  id="ai-threshold-outcome"
                  type="number"
                  min={0}
                  max={100}
                  step="0.1"
                  value={settingsDraft.hardGateThreshold}
                  disabled={saving || !settingsDraft.hardGateEnabled}
                  onChange={(event) =>
                    setSettingsDraft({
                      ...settingsDraft,
                      hardGateThreshold: event.currentTarget.valueAsNumber,
                    })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ai-minimum-examples">
                  Minimum scored examples
                </Label>
                <Input
                  id="ai-minimum-examples"
                  type="number"
                  min={1}
                  max={2_147_483_647}
                  step={1}
                  value={settingsDraft.minExamplesForGate}
                  disabled={saving}
                  onChange={(event) =>
                    setSettingsDraft({
                      ...settingsDraft,
                      minExamplesForGate: event.currentTarget.valueAsNumber,
                    })
                  }
                />
              </div>
            </div>
            <label className="flex items-start gap-3 rounded-lg border p-3 text-sm">
              <Checkbox
                checked={settingsDraft.hardGateEnabled}
                disabled={saving}
                onChange={(event) =>
                  setSettingsDraft({
                    ...settingsDraft,
                    hardGateEnabled: event.target.checked,
                  })
                }
              />
              <span>
                Record a threshold pass or concern when enough examples score.
                This remains an evidence classification, not a deployment gate.
              </span>
            </label>
            <GateEligibilityNote
              policyInvalid={Boolean(settingsValidation)}
              eligibility={gateEligibility}
              count={golden.data?.length ?? 0}
              threshold={settingsDraft.minExamplesForGate}
              corpusLoading={golden.isPending}
              corpusError={golden.isError}
            />
            {settingsValidation ? (
              <p role="alert" className="text-sm text-destructive">
                {settingsValidation}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                disabled={
                  !settingsDirty || Boolean(settingsValidation) || saving
                }
                loading={saving}
              >
                Save future-run policy
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={!settingsDirty || saving}
                onClick={() => setSettingsDraft(settingsBaseline)}
              >
                Discard policy edits
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              This API has no ETag. Save uses a fresh exact preflight and
              post-write readback; the server remains authoritative during the
              unavoidable final race window.
            </p>
          </form>
        )}
      </GovernanceSection>

      <GovernanceSection
        icon={ShieldCheck}
        title="Golden reference set"
        description="Live metadata used by future snapshots. Approved output is intentionally absent from this list."
      >
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-56 space-y-2">
            <Label htmlFor="golden-surface-filter">Filter surface</Label>
            <Select
              id="golden-surface-filter"
              value={surfaceFilter}
              onChange={(event) =>
                setSurfaceFilter(
                  event.target.value as "all" | AiRegressionSurface,
                )
              }
            >
              <option value="all">All surfaces</option>
              {AI_REGRESSION_SURFACES.map((surface) => (
                <option key={surface} value={surface}>
                  {surfaceLabel(surface)}
                </option>
              ))}
            </Select>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={golden.isFetching || saving}
            onClick={() => void golden.refetch()}
          >
            {golden.isFetching ? "Refreshing…" : "Refresh references"}
          </Button>
        </div>
        {golden.isPending ? (
          <GovernanceLoading label="Loading golden references…" rows={4} />
        ) : golden.isError ? (
          <GovernanceError
            message={apiErrorMessage(
              golden.error,
              "Golden-reference metadata could not be verified.",
            )}
            retrying={golden.isFetching}
            onRetry={() => void golden.refetch()}
          />
        ) : filteredGolden.length === 0 ? (
          <GovernanceEmpty>
            {surfaceFilter === "all"
              ? "No golden references are active."
              : "No active reference matches this surface filter."}
          </GovernanceEmpty>
        ) : (
          <>
            <ul className="space-y-2">
              {filteredGolden.map((example, index) => (
                <li
                  key={example.id}
                  className="flex flex-wrap items-start justify-between gap-3 rounded-lg border p-3 text-sm"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">
                        {surfaceLabel(example.surfaceKind)}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        Reference {index + 1}
                      </span>
                    </div>
                    <p className="break-words" dir="auto">
                      {example.brief}
                    </p>
                    <p className="break-all text-xs text-muted-foreground">
                      {example.modelId} · {example.id} ·{" "}
                      {formatWireTimestamp(
                        example.createdAt,
                        "Date unavailable",
                      )}
                    </p>
                  </div>
                  {canAdmin ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      disabled={saving}
                      onClick={() => setArchiveTarget(example)}
                    >
                      Archive
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
            {golden.data?.length === 500 ? (
              <p className="mt-3 text-xs text-muted-foreground">
                The API returned its 500-row maximum. The corpus may contain
                more active references; this view does not claim an exact total.
              </p>
            ) : null}
          </>
        )}

        {canAdmin ? (
          <form
            className="mt-6 space-y-4 border-t pt-5"
            aria-busy={saving}
            onSubmit={(event) => {
              event.preventDefault();
              setCaptureTouched(true);
              void captureReference();
            }}
          >
            <div>
              <h3 className="font-medium">Capture a manual reference</h3>
              <p className="text-sm text-muted-foreground">
                Public capture is provenance-neutral: the server records
                manual_reference and rejects client-asserted model, approval,
                run, or voice-profile lineage.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="golden-capture-surface">Surface</Label>
              <Select
                id="golden-capture-surface"
                value={captureSurface}
                disabled={saving}
                onChange={(event) => {
                  captureAttemptRef.current = null;
                  setCaptureSurface(event.target.value as AiRegressionSurface);
                }}
              >
                {AI_REGRESSION_SURFACES.map((surface) => (
                  <option key={surface} value={surface}>
                    {surfaceLabel(surface)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="golden-capture-brief">Original brief</Label>
              <Textarea
                id="golden-capture-brief"
                rows={5}
                maxLength={8_000}
                value={captureBrief}
                dir="auto"
                disabled={saving}
                aria-invalid={captureErrorShown ? true : undefined}
                aria-describedby={
                  captureErrorShown ? "golden-capture-error" : undefined
                }
                onBlur={() => setCaptureTouched(true)}
                onChange={(event) => {
                  if (
                    captureAttemptRef.current?.fingerprint !==
                    captureFingerprint
                  )
                    captureAttemptRef.current = null;
                  setCaptureBrief(event.target.value);
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="golden-capture-output">
                Human-approved output
              </Label>
              <Textarea
                id="golden-capture-output"
                rows={8}
                maxLength={32_000}
                value={captureOutput}
                dir="auto"
                disabled={saving}
                aria-invalid={captureErrorShown ? true : undefined}
                aria-describedby={
                  captureErrorShown ? "golden-capture-error" : undefined
                }
                onBlur={() => setCaptureTouched(true)}
                onChange={(event) => {
                  if (
                    captureAttemptRef.current?.fingerprint !==
                    captureFingerprint
                  )
                    captureAttemptRef.current = null;
                  setCaptureOutput(event.target.value);
                }}
              />
              <p className="text-xs text-muted-foreground">
                This text is sent over the authenticated no-store route and is
                never returned in the corpus collection view.
              </p>
            </div>
            <label className="flex items-start gap-3 rounded-lg border p-3 text-sm">
              <Checkbox
                checked={captureAcknowledged}
                disabled={saving}
                onChange={(event) => {
                  // Confirming is the reader saying "ready": show what is
                  // still missing rather than a silently disabled button.
                  setCaptureTouched(true);
                  setCaptureAcknowledged(event.target.checked);
                }}
              />
              <span>
                I confirm this output was human-approved and is appropriate as
                known-good future replay evidence.
              </span>
            </label>
            {captureErrorShown ? (
              <p
                id="golden-capture-error"
                role="alert"
                className="text-sm text-destructive"
              >
                {captureErrorShown}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                disabled={
                  Boolean(captureValidation) || !captureAcknowledged || saving
                }
                loading={saving}
              >
                Capture golden reference
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={!captureDirty || saving}
                onClick={() => {
                  captureAttemptRef.current = null;
                  setCaptureBrief("");
                  setCaptureOutput("");
                  setCaptureAcknowledged(false);
                  setCaptureTouched(false);
                }}
              >
                Discard capture draft
              </Button>
            </div>
          </form>
        ) : null}
      </GovernanceSection>

      <GovernanceSection
        icon={Activity}
        title="Regression runs"
        description="Durable lifecycle, frozen runtime/policy identity, aggregate outcomes, and immutable per-reference evidence."
      >
        {canAdmin ? (
          <form
            className="mb-5 space-y-3 rounded-lg border bg-muted/20 p-4"
            aria-busy={saving}
            onSubmit={(event) => {
              event.preventDefault();
              void triggerRun();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="regression-run-label">
                Release correlation label
              </Label>
              <Input
                id="regression-run-label"
                value={runLabel}
                maxLength={160}
                disabled={saving}
                placeholder="voice-candidate-2026-08-30"
                onChange={(event) => setRunLabel(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                This is an operator label, not a model selector. The server
                attests and freezes the actual provider, model, and replay
                policy.
              </p>
            </div>
            <label className="flex items-start gap-3 rounded-lg border p-3 text-sm">
              <Checkbox
                checked={runAcknowledged}
                disabled={saving}
                onChange={(event) => setRunAcknowledged(event.target.checked)}
              />
              <span>
                I understand this queues one AI replay over the complete live
                reference snapshot, spends runtime quota, and cannot be safely
                auto-retried or queued offline.
              </span>
            </label>
            <Button
              type="submit"
              disabled={!runLabel.trim() || !runAcknowledged || saving}
              loading={saving}
            >
              Queue regression replay
            </Button>
          </form>
        ) : null}

        {runs.isPending ? (
          <GovernanceLoading
            label="Loading regression run receipts…"
            rows={5}
          />
        ) : runs.isError ? (
          <GovernanceError
            message={apiErrorMessage(
              runs.error,
              "Regression run receipts could not be verified.",
            )}
            retrying={runs.isFetching}
            onRetry={() => void runs.refetch()}
          />
        ) : !runs.data?.length ? (
          <GovernanceEmpty>
            No regression runs have been queued.
          </GovernanceEmpty>
        ) : (
          <ul className="space-y-3">
            {runs.data.map((run) => (
              <li key={run.id} className="rounded-lg border p-4 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={runStatusVariant(run.status)}>
                        {run.status}
                      </Badge>
                      <Badge variant={gateVariant(run.gateResult)}>
                        {run.gateResult ?? "No evaluation yet"}
                      </Badge>
                    </div>
                    <p className="break-words font-medium" dir="auto">
                      {run.modelVersionTag}
                    </p>
                    <p className="break-all font-mono text-xs text-muted-foreground">
                      {run.id}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-expanded={selectedRunId === run.id}
                    onClick={() =>
                      setSelectedRunId((current) =>
                        current === run.id ? null : run.id,
                      )
                    }
                  >
                    {selectedRunId === run.id
                      ? "Hide evidence"
                      : "Review evidence"}
                  </Button>
                </div>
                <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      Mean score
                    </dt>
                    <dd className="tabular-nums">
                      {run.fidelityScoreMean === null
                        ? "Not scored"
                        : `${run.fidelityScoreMean.toFixed(1)} / 100`}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Coverage</dt>
                    <dd className="tabular-nums">
                      {run.scoredExamples} scored · {run.errorExamples} errors ·{" "}
                      {run.totalExamples} frozen
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Runtime</dt>
                    <dd className="break-all">
                      {run.runtimeProvider} / {run.modelId}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Updated</dt>
                    <dd>
                      {formatWireTimestamp(run.updatedAt, "Date unavailable")}
                    </dd>
                  </div>
                </dl>
                {run.errorMessage ? (
                  <p className="mt-3 break-words text-destructive" dir="auto">
                    {run.errorCode ? `${run.errorCode}: ` : ""}
                    {run.errorMessage}
                  </p>
                ) : null}
                {selectedRunId === run.id ? (
                  <RunEvidence
                    summary={selectedSummary ?? run}
                    detail={runDetail.data}
                    detailLoading={runDetail.isPending}
                    detailError={runDetail.error}
                    results={runResults.data}
                    resultsLoading={runResults.isPending}
                    resultsError={runResults.error}
                    refreshing={runDetail.isFetching || runResults.isFetching}
                    onRefresh={() => {
                      void runDetail.refetch();
                      void runResults.refetch();
                    }}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </GovernanceSection>

      <ConfirmDialog
        open={archiveTarget !== null}
        onOpenChange={(open) => {
          if (!open && !saving) setArchiveTarget(null);
        }}
        title="Archive this golden reference?"
        description={
          <span>
            Exclude this reference from future run snapshots. Existing frozen
            snapshots and historical results remain unchanged. Type{" "}
            {ARCHIVE_TOKEN}
            to confirm.
          </span>
        }
        confirmationToken={ARCHIVE_TOKEN}
        confirmLabel="Archive reference"
        onConfirm={() =>
          archiveTarget ? archiveReference(archiveTarget) : undefined
        }
      />
    </>
  );
}

function GateEligibilityNote({
  policyInvalid,
  eligibility,
  count,
  threshold,
  corpusLoading,
  corpusError,
}: {
  policyInvalid: boolean;
  eligibility: "eligible" | "inert" | null;
  count: number;
  threshold: number;
  corpusLoading: boolean;
  corpusError: boolean;
}) {
  let text = "";
  if (corpusLoading) {
    text =
      "The reference corpus is still loading, so eligibility cannot be assessed.";
  } else if (corpusError) {
    text =
      "The reference corpus failed to load, so gate status cannot be determined.";
  } else if (policyInvalid) {
    text =
      "Enter a valid evaluation policy before assessing corpus eligibility.";
  } else if (eligibility === "eligible") {
    text = `${count.toLocaleString()} loaded references reach the configured ${threshold.toLocaleString()}-example floor. Actual eligibility still requires that many scored results.`;
  } else if (eligibility === "inert") {
    text = `The future threshold classification is inert: ${count.toLocaleString()} references are loaded and ${threshold.toLocaleString()} are required.`;
  } else {
    text = `The API returned its 500-row maximum below the configured ${threshold.toLocaleString()}-example floor, so this view cannot honestly determine corpus eligibility.`;
  }
  return (
    <Alert
      variant={policyInvalid || eligibility === "inert" ? "warning" : "default"}
    >
      <AlertTitle>Current corpus eligibility</AlertTitle>
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  );
}

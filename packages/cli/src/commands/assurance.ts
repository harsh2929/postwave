// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import type {
  CampaignAssuranceEnvelope,
  CampaignAssuranceFinding,
  CampaignAssuranceLatest,
  CampaignAssuranceProfile,
  CampaignAssuranceRun,
  CampaignAssuranceRunDetail,
  CampaignAssuranceStartRun,
} from "@postwave/sdk";

import { createClient } from "../lib/client.js";
import { formatOutput, type OutputFormat } from "../lib/output.js";

const PROFILES = new Set<CampaignAssuranceProfile>([
  "fast",
  "full",
  "calibration",
]);
const DECISIONS = new Set(["allow_send", "reject"] as const);

export interface AssuranceOpts {
  apiKey?: string;
  baseUrl?: string;
  tenantId?: string;
  output?: OutputFormat;
  format?: OutputFormat;
  campaignId?: string;
  campaign?: string;
  runId?: string;
  run?: string;
  findingId?: string;
  finding?: string;
  contentRevisionId?: string;
  sendPlanId?: string;
  profile?: string;
  requestId?: string;
  idempotencyKey?: string;
  decision?: string;
  reason?: string;
  expiresAt?: string;
  ifMatch?: string;
  limit?: string | number;
  offset?: string | number;
  seed?: boolean;
  observedSurfaces?: string;
  yes?: boolean;
}

export async function assuranceRun(opts: AssuranceOpts = {}): Promise<void> {
  const campaignId = required(
    opts.campaignId ?? opts.campaign,
    "--campaign or --campaign-id",
  );
  const contentRevisionId = opts.contentRevisionId?.trim() || undefined;
  const sendPlanId = opts.sendPlanId?.trim() || undefined;
  const profile = parseProfile(opts.profile);
  if (sendPlanId && !contentRevisionId) {
    fail("--send-plan-id requires --content-revision-id");
    return;
  }
  const observedSurfaces = parseObservedSurfaces(opts.observedSurfaces);
  if (observedSurfaces === null || !campaignId || !profile) return;
  if (observedSurfaces !== undefined && !opts.seed) {
    fail("--observed-surfaces requires --seed");
    return;
  }

  const response = await createClient(opts).campaignAssurance.createRun(
    campaignId,
    {
      profile,
      request_id: opts.requestId ?? randomUUID(),
      ...(contentRevisionId ? { content_revision_id: contentRevisionId } : {}),
      ...(sendPlanId ? { send_plan_id: sendPlanId } : {}),
      ...(opts.seed ? { include_seed_test: true } : {}),
      ...(observedSurfaces !== undefined
        ? { observed_surfaces: observedSurfaces }
        : {}),
    },
    { idempotencyKey: opts.idempotencyKey },
  );
  printEnvelope(response, outputFormat(opts), startRunRow(response));
}

export async function assuranceGet(opts: AssuranceOpts = {}): Promise<void> {
  const campaignId = required(opts.campaignId ?? opts.campaign, "--campaign");
  if (!campaignId) return;
  const resource = createClient(opts).campaignAssurance;
  const runId = opts.runId ?? opts.run;
  if (runId) {
    const response = await resource.getRun(campaignId, runId);
    printEnvelope(response, outputFormat(opts), runDetailRow(response));
    return;
  }
  const response = await resource.getLatest(campaignId);
  printEnvelope(response, outputFormat(opts), latestRow(response));
}

export async function assuranceFindings(
  opts: AssuranceOpts = {},
): Promise<void> {
  const campaignId = required(opts.campaignId ?? opts.campaign, "--campaign");
  const runId = required(opts.runId ?? opts.run, "--run");
  const limit = parseBoundedInteger(opts.limit, "--limit", 1, 200, 100);
  const offset = parseBoundedInteger(opts.offset, "--offset", 0, 100_000, 0);
  if (!campaignId || !runId || limit === undefined || offset === undefined) {
    return;
  }
  const response = await createClient(opts).campaignAssurance.getEvidence(
    campaignId,
    runId,
    { limit, offset },
  );
  const rows = response.data.findings.items.map(findingRow);
  printEnvelope(response, outputFormat(opts), rows);
}

export async function assuranceOverride(
  opts: AssuranceOpts = {},
): Promise<void> {
  const campaignId = required(opts.campaignId ?? opts.campaign, "--campaign");
  const runId = required(opts.runId ?? opts.run, "--run");
  const findingId = required(opts.findingId ?? opts.finding, "--finding");
  const reason = required(opts.reason, "--reason");
  const decision = parseDecision(opts.decision);
  if (!campaignId || !runId || !findingId || !reason || !decision) return;
  if (reason.length < 10 || reason.length > 2000) {
    fail("--reason must contain 10 to 2000 characters");
    return;
  }

  const response = await createClient(opts).campaignAssurance.overrideFinding(
    campaignId,
    runId,
    findingId,
    {
      request_id: opts.requestId ?? randomUUID(),
      decision,
      reason,
      ...(opts.expiresAt ? { expires_at: opts.expiresAt } : {}),
    },
    { idempotencyKey: opts.idempotencyKey },
  );
  printEnvelope(response, outputFormat(opts), [
    {
      measurement: response.measurement.name,
      source: "governed_override",
      override_id: response.data.id,
      run_id: response.data.run_id,
      finding_id: response.data.finding_id,
      decision: response.data.decision,
      actor_role: response.data.actor_role,
      expires_at: response.data.expires_at ?? "",
    },
  ]);
}

export async function assuranceCancel(opts: AssuranceOpts = {}): Promise<void> {
  const campaignId = required(opts.campaignId ?? opts.campaign, "--campaign");
  const runId = required(opts.runId ?? opts.run, "--run");
  if (!campaignId || !runId) return;
  if (!opts.yes) {
    fail("Pass --yes to cancel a queued or running assurance run");
    return;
  }
  const response = await createClient(opts).campaignAssurance.cancelRun(
    campaignId,
    runId,
    { idempotencyKey: opts.idempotencyKey },
  );
  printEnvelope(
    response,
    outputFormat(opts),
    runRow(response.measurement.name, response.data),
  );
}

export async function assuranceApply(opts: AssuranceOpts = {}): Promise<void> {
  const campaignId = required(opts.campaignId ?? opts.campaign, "--campaign");
  const runId = required(opts.runId ?? opts.run, "--run");
  const findingId = required(opts.findingId ?? opts.finding, "--finding");
  const ifMatch = required(opts.ifMatch, "--if-match");
  if (!campaignId || !runId || !findingId || !ifMatch) return;
  if (!opts.yes) {
    fail(
      "Pass --yes to create a new content revision, advance the draft, and mark the originating run stale",
    );
    return;
  }

  const response = await createClient(opts).campaignAssurance.applyFinding(
    campaignId,
    runId,
    findingId,
    { request_id: opts.requestId ?? randomUUID() },
    { ifMatch, idempotencyKey: opts.idempotencyKey },
  );
  printEnvelope(response, outputFormat(opts), [
    {
      measurement: response.measurement.name,
      source: "deterministic_stored_patch",
      application_id: response.data.application.id,
      finding_id: response.data.application.finding_id,
      base_revision_id: response.data.application.base_content_revision_id,
      created_revision_id:
        response.data.application.created_content_revision_id,
      revision_no: response.data.revision.revision_no,
      campaign_etag: response.data.campaign_etag,
      originating_run_state: response.data.originating_run_state,
      rerun_required: response.data.rerun_required,
    },
  ]);
}

function outputFormat(opts: AssuranceOpts): OutputFormat | undefined {
  return opts.format ?? opts.output;
}

function parseObservedSurfaces(
  raw: string | undefined,
): string[] | undefined | null {
  if (raw === undefined) return undefined;
  const values = raw.split(",").map((value) => value.trim());
  if (
    values.length > 32 ||
    values.some(
      (value) =>
        value.length === 0 ||
        new TextEncoder().encode(value).byteLength > 128 ||
        !/^[A-Za-z0-9._:-]+$/u.test(value),
    ) ||
    new Set(values).size !== values.length
  ) {
    fail(
      "--observed-surfaces must be a comma-separated list of at most 32 unique 1-128 byte stable identifiers",
    );
    return null;
  }
  return values;
}

function required(value: string | undefined, flag: string): string | undefined {
  if (value?.trim()) return value.trim();
  fail(`Pass ${flag} <id>`);
  return undefined;
}

function parseProfile(
  raw: string | undefined,
): CampaignAssuranceProfile | undefined {
  const value = raw ?? "full";
  if (PROFILES.has(value as CampaignAssuranceProfile)) {
    return value as CampaignAssuranceProfile;
  }
  fail("--profile must be fast, full, or calibration");
  return undefined;
}

function parseDecision(
  raw: string | undefined,
): "allow_send" | "reject" | undefined {
  const value = raw ?? "allow_send";
  if (DECISIONS.has(value as "allow_send" | "reject")) {
    return value as "allow_send" | "reject";
  }
  fail("--decision must be allow_send or reject");
  return undefined;
}

function parseBoundedInteger(
  raw: string | number | undefined,
  flag: string,
  min: number,
  max: number,
  defaultValue: number,
): number | undefined {
  if (raw === undefined) return defaultValue;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${flag} must be an integer from ${min} to ${max}`);
    return undefined;
  }
  return value;
}

function fail(message: string): void {
  console.error(message);
  process.exitCode = 1;
}

function printEnvelope<T>(
  response: CampaignAssuranceEnvelope<T>,
  output: OutputFormat | undefined,
  humanRows: Record<string, unknown>[],
): void {
  const format = output ?? "table";
  console.log(
    format === "table"
      ? formatOutput(humanRows, "table")
      : formatOutput(response, format),
  );
}

function startRunRow(
  response: CampaignAssuranceEnvelope<CampaignAssuranceStartRun>,
): Record<string, unknown>[] {
  return [
    {
      measurement: response.measurement.name,
      evidence: sourceSummary(response),
      run_id: response.data.run_id,
      state: response.data.state,
      profile: response.data.profile,
      scenarios: response.data.required_scenario_count,
      extractions: response.data.required_extraction_count,
    },
  ];
}

function latestRow(
  response: CampaignAssuranceEnvelope<CampaignAssuranceLatest>,
): Record<string, unknown>[] {
  return [
    {
      ...runRow(response.measurement.name, response.data.detail.run)[0],
      evidence: sourceSummary(response),
      freshness: response.data.applicability.freshness,
      applicable: response.data.applicability.applicable_to_frozen_snapshot,
    },
  ];
}

function runDetailRow(
  response: CampaignAssuranceEnvelope<CampaignAssuranceRunDetail>,
): Record<string, unknown>[] {
  return [
    {
      ...runRow(response.measurement.name, response.data.run)[0],
      evidence: sourceSummary(response),
    },
  ];
}

function runRow(
  measurement: string,
  run: CampaignAssuranceRun,
): Record<string, unknown>[] {
  return [
    {
      measurement,
      run_id: run.id,
      state: run.state,
      gate: run.gate_decision,
      predicted_score: run.overall_score ?? "unavailable",
      score_range:
        run.score_min === null || run.score_max === null
          ? "unavailable"
          : `${run.score_min}..${run.score_max}`,
      deterministic_blockers: run.blocking_finding_count,
      findings: run.finding_count,
    },
  ];
}

function findingRow(
  finding: CampaignAssuranceFinding,
): Record<string, unknown> {
  return {
    finding_id: finding.id,
    source: finding.source_class,
    code: finding.code,
    severity: finding.severity,
    blocking: finding.blocking,
    overridable: finding.overridable,
    dimension: finding.dimension,
    explanation: finding.explanation,
  };
}

function sourceSummary<T>(response: CampaignAssuranceEnvelope<T>): string {
  return (
    response.measurement.source_classes
      .filter((source) => source.present)
      .map((source) => source.class)
      .join(",") || "unavailable"
  );
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import YAML from "yaml";

const packageRoot = new URL("../", import.meta.url);
const spec = YAML.parse(
  readFileSync(new URL("openapi.yaml", packageRoot), "utf8"),
);
const routeManifest = JSON.parse(
  readFileSync(
    new URL("../../apps/api/internal/routeauth/manifest.json", packageRoot),
    "utf8",
  ),
);

const reads = [
  "/api/v1/campaigns/{id}/assurance",
  "/api/v1/campaigns/{id}/assurance-runs/{runID}",
  "/api/v1/campaigns/{id}/assurance-runs/{runID}/manifest",
  "/api/v1/campaigns/{id}/assurance-runs/{runID}/evidence",
  "/api/v1/campaigns/{id}/assurance-runs/{runID}/events",
];

const writes = [
  {
    path: "/api/v1/campaigns/{id}/assurance-runs",
    role: "editor",
    scopes: ["write:campaigns"],
    mode: undefined,
    success: "202",
  },
  {
    path: "/api/v1/campaigns/{id}/assurance-runs/{runID}/cancel",
    role: "editor",
    scopes: ["write:campaigns"],
    mode: undefined,
    success: "200",
  },
  {
    path:
      "/api/v1/campaigns/{id}/assurance-runs/{runID}/findings/{findingID}/apply",
    role: "editor",
    scopes: ["write:campaigns"],
    mode: undefined,
    success: "201",
  },
  {
    path:
      "/api/v1/campaigns/{id}/assurance-runs/{runID}/findings/{findingID}/appeals",
    role: "admin",
    scopes: ["write:campaigns", "send:transactional"],
    mode: "all",
    success: "200",
  },
  {
    path:
      "/api/v1/campaigns/{id}/assurance-runs/{runID}/findings/{findingID}/overrides",
    role: "admin",
    scopes: ["write:campaigns", "send:transactional"],
    mode: "all",
    success: "200",
  },
];

test("Campaign Assurance operations match mounted auth and idempotency boundaries", () => {
  for (const path of reads) {
    const operation = spec.paths[path]?.get;
    assert.ok(operation, `GET ${path}`);
    assert.deepEqual(operation["x-required-scopes"], ["read:campaigns"]);
    assert.equal(operation["x-required-role"], "viewer");
    assert.deepEqual(operation.security, [
      { bearerAuth: [] },
      { sessionCookie: [] },
    ]);
    assert.ok(operation.responses["200"]);
    assert.ok(operation.responses["401"]);
    assert.ok(operation.responses["403"]);
    assert.ok(operation.responses["404"]);
  }

  for (const expected of writes) {
    const operation = spec.paths[expected.path]?.post;
    assert.ok(operation, `POST ${expected.path}`);
    assert.deepEqual(operation["x-required-scopes"], expected.scopes);
    assert.equal(operation["x-required-role"], expected.role);
    assert.equal(operation["x-required-scope-mode"], expected.mode);
    assert.ok(operation.responses[expected.success]);
    const idempotency = operation.parameters.find(
      (parameter) =>
        parameter.$ref ===
        "#/components/parameters/CampaignAssuranceIdempotencyKey",
    );
    assert.ok(idempotency, `${expected.path} requires Idempotency-Key`);
  }
  assert.equal(
    spec.components.parameters.CampaignAssuranceIdempotencyKey.required,
    true,
  );
});

test("generated gateway authorization matches the public operation contract", () => {
  const policies = new Map(
    routeManifest.routes
      .filter((route) => route.path.includes("/assurance"))
      .map((route) => [`${route.method} ${route.path}`, route]),
  );
  assert.equal(policies.size, reads.length + writes.length);
  for (const path of reads) {
    const policy = policies.get(`GET ${path}`);
    assert.ok(policy, `GET ${path}`);
    assert.equal(policy.session_minimum_role, "viewer");
    assert.deepEqual(policy.api_key_scopes, ["read:campaigns"]);
    assert.equal(policy.api_key_scope_mode, "any");
  }
  for (const expected of writes) {
    const policy = policies.get(`POST ${expected.path}`);
    assert.ok(policy, `POST ${expected.path}`);
    assert.equal(policy.session_minimum_role, expected.role);
    assert.deepEqual(policy.api_key_scopes, expected.scopes);
    assert.equal(policy.api_key_scope_mode, expected.mode ?? "any");
    assert.match(policy.policy_source, /^openapi\./u);
  }
});

test("public write bodies are closed and cannot inject server methodology or actor authority", () => {
  const create = spec.components.schemas.CreateCampaignAssuranceRunInput;
  assert.equal(create.additionalProperties, false);
  assert.deepEqual(Object.keys(create.properties).sort(), [
    "content_revision_id",
    "profile",
    "request_id",
    "send_plan_id",
  ]);
  assert.deepEqual(create.required, ["profile", "request_id"]);
  assert.deepEqual(create.dependentRequired, {
    send_plan_id: ["content_revision_id"],
  });
  for (const forbidden of [
    "model_id",
    "prompt_suite_version",
    "configurations",
    "targets",
    "artifact_url",
    "recipient",
    "actor_id",
  ]) {
    assert.equal(forbidden in create.properties, false);
  }

  const appeal = spec.components.schemas.CampaignAssuranceAppealInput;
  assert.equal(appeal.additionalProperties, false);
  assert.deepEqual(Object.keys(appeal.properties).sort(), [
    "decision",
    "expires_at",
    "reason",
    "request_id",
  ]);
  assert.equal("finding_id" in appeal.properties, false);
  assert.equal("actor_id" in appeal.properties, false);
  assert.equal("actor_role" in appeal.properties, false);

  const apply = spec.components.schemas.CampaignAssuranceApplyFindingInput;
  assert.equal(apply.additionalProperties, false);
  assert.deepEqual(Object.keys(apply.properties), ["request_id"]);
  for (const forbidden of [
    "typed_patch",
    "typed_patch_schema_version",
    "operation",
    "path",
    "value",
    "actor_id",
  ]) {
    assert.equal(forbidden in apply.properties, false);
  }
});

test("finding application is a conditional new-revision mutation with a replay-stable receipt", () => {
  const path =
    "/api/v1/campaigns/{id}/assurance-runs/{runID}/findings/{findingID}/apply";
  const operation = spec.paths[path].post;
  const ifMatch = operation.parameters.find(
    (parameter) => parameter.name === "If-Match",
  );
  assert.ok(ifMatch);
  assert.equal(ifMatch.in, "header");
  assert.equal(ifMatch.required, true);
  assert.ok(operation.responses["412"]);
  assert.ok(operation.responses["428"]);
  assert.ok(operation.responses["201"].headers.ETag);
  assert.ok(operation.responses["201"].headers.Location);

  const result = spec.components.schemas.CampaignAssuranceApplyFindingResult;
  assert.deepEqual(result.properties.originating_run_state, {
    type: "string",
    const: "stale",
  });
  assert.deepEqual(result.properties.rerun_required, {
    type: "boolean",
    const: true,
  });
  const application =
    spec.components.schemas.CampaignAssurancePatchApplication;
  assert.ok(application.required.includes("campaign_updated_at"));
  assert.equal(
    application.properties.typed_patch_schema_version.const,
    1,
  );
});

test("measurement and events contracts do not overclaim provider observation or history", () => {
  const sources = spec.components.schemas.CampaignAssuranceSourceClass.enum;
  assert.deepEqual(sources, [
    "deterministic",
    "modeled",
    "controlled_observation",
  ]);
  const sourceDescription =
    spec.components.schemas.CampaignAssuranceSourceClass.description;
  assert.match(sourceDescription, /not an inbox provider observation/u);

  const progress =
    spec.components.schemas.CampaignAssuranceProgressSnapshot.properties;
  assert.deepEqual(progress.event_history_available, {
    type: "boolean",
    const: false,
  });
  const events =
    spec.paths[
      "/api/v1/campaigns/{id}/assurance-runs/{runID}/events"
    ].get;
  assert.match(events.description, /neither SSE nor[\s\S]*event history/u);
  assert.equal(events.operationId, "getCampaignAssuranceProgressSnapshot");
});

test("pre-send verdict accepts only exact Campaign Assurance identity", () => {
  const input = spec.components.schemas.PreSendVerdictInput;
  assert.equal(input.additionalProperties, false);
  assert.deepEqual(input.dependentRequired, {
    content_revision_id: ["campaign_id", "source_hash"],
    source_hash: ["campaign_id", "content_revision_id"],
  });
  for (const field of ["campaign_id", "content_revision_id", "source_hash"]) {
    assert.ok(input.properties[field], `pre-send input exposes ${field}`);
  }

  const response = spec.components.schemas.PreSendVerdictResponse;
  assert.equal(response.properties.components.minItems, 3);
  assert.equal(response.properties.components.maxItems, 4);
  assert.equal(
    response.properties.components.prefixItems[3].allOf[1].properties.name.const,
    "campaign_assurance",
  );
  assert.deepEqual(response.properties.components.items, { not: {} });
  assert.equal(
    response.properties.campaign_assurance.$ref,
    "#/components/schemas/PreSendCampaignAssuranceEvaluation",
  );

  const evaluation =
    spec.components.schemas.PreSendCampaignAssuranceEvaluation;
  for (const field of [
    "campaign_id",
    "content_revision_id",
    "source_hash",
    "status",
    "reason_code",
    "authorized",
    "source_coverage",
  ]) {
    assert.ok(evaluation.required.includes(field), `evaluation requires ${field}`);
  }
  assert.ok(evaluation.properties.reason_code.enum.includes("not_assured"));
  assert.ok(evaluation.properties.reason_code.enum.includes("integrity_mismatch"));
});

test("queue contract distinguishes warning advisory from block binding", () => {
  const queue =
    spec.paths["/api/v1/campaigns/{id}/queue"].post.responses["202"].content[
      "application/json"
    ].schema.properties;
  assert.deepEqual(queue.assurance_rollout_mode.enum, ["warn", "block"]);
  assert.match(queue.assurance_rollout_mode.description, /unbound advisory/u);
  assert.deepEqual(queue.assurance_decision.enum, ["pass", "warn", "overridden"]);
  for (const field of [
    "content_revision_id",
    "assurance_run_id",
    "send_plan_id",
    "assurance_status",
    "assurance_reason_code",
  ]) {
    assert.ok(queue[field], `queue response exposes ${field}`);
  }
});

test("evidence, manifest, and run schemas retain immutable identity and nullable scores", () => {
  const run = spec.components.schemas.CampaignAssuranceRun;
  for (const field of [
    "content_revision_id",
    "send_plan_id",
    "artifact_set_hash",
    "coverage_manifest_hash",
    "configuration_manifest_hash",
    "target_manifest_hash",
    "prompt_suite_hash",
    "scoring_version",
    "gate_policy_version",
    "max_modeled_cost_microunits",
  ]) {
    assert.ok(run.required.includes(field), `run requires ${field}`);
  }
  for (const score of [
    "overall_score",
    "score_min",
    "score_max",
    "score_spread",
    "agreement",
  ]) {
    assert.equal(
      run.properties[score].oneOf.some((branch) => branch.type === "null"),
      true,
      `${score} remains honestly nullable`,
    );
  }
  assert.deepEqual(
    spec.components.schemas.CampaignAssuranceManifest.required,
    ["run", "artifacts", "configurations", "targets"],
  );
  assert.deepEqual(
    spec.components.schemas.CampaignAssuranceEvidence.required,
    ["run", "source_classes", "extractions", "findings", "overrides"],
  );

  const extraction = spec.components.schemas.CampaignAssuranceExtraction;
  assert.deepEqual(extraction.properties.execution_kind.enum, [
    "invoked",
    "cache_reuse",
  ]);
  for (const field of [
    "model_cache_key",
    "model_input_manifest_hash",
    "model_invocation_id",
    "reused_from_extraction_id",
    "reused_from_receipt_hash",
    "reused_original_cost_microunits",
  ]) {
    assert.ok(extraction.properties[field], `extraction exposes ${field}`);
  }
});

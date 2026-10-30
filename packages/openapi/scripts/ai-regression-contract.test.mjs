import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import YAML from "yaml";

const packageRoot = new URL("../", import.meta.url);
const spec = YAML.parse(
  readFileSync(new URL("openapi.yaml", packageRoot), "utf8"),
);
const routeContracts = JSON.parse(
  readFileSync(new URL("route-contracts.json", packageRoot), "utf8"),
);

const operationContract = [
  {
    method: "get",
    path: "/api/v1/ai-regression/golden-examples",
    role: "viewer",
    scope: "read:reports",
    success: "200",
  },
  {
    method: "post",
    path: "/api/v1/ai-regression/golden-examples",
    role: "admin",
    scope: "admin",
    success: "201",
  },
  {
    method: "delete",
    path: "/api/v1/ai-regression/golden-examples/{id}",
    role: "admin",
    scope: "admin",
    success: "204",
  },
  {
    method: "get",
    path: "/api/v1/ai-regression/runs",
    role: "viewer",
    scope: "read:reports",
    success: "200",
  },
  {
    method: "post",
    path: "/api/v1/ai-regression/runs",
    role: "admin",
    scope: "admin",
    success: "202",
  },
  {
    method: "get",
    path: "/api/v1/ai-regression/runs/latest",
    role: "viewer",
    scope: "read:reports",
    success: "200",
  },
  {
    method: "get",
    path: "/api/v1/ai-regression/runs/{id}",
    role: "viewer",
    scope: "read:reports",
    success: "200",
  },
  {
    method: "get",
    path: "/api/v1/ai-regression/runs/{id}/results",
    role: "viewer",
    scope: "read:reports",
    success: "200",
  },
  {
    method: "get",
    path: "/api/v1/ai-regression/settings",
    role: "admin",
    scope: "admin",
    success: "200",
  },
  {
    method: "put",
    path: "/api/v1/ai-regression/settings",
    role: "admin",
    scope: "admin",
    success: "200",
  },
];

test("AI regression operations pin live statuses and least privilege", () => {
  for (const expected of operationContract) {
    const operation = spec.paths[expected.path]?.[expected.method];
    assert.ok(operation, `${expected.method.toUpperCase()} ${expected.path}`);
    assert.deepEqual(operation["x-required-scopes"], [expected.scope]);
    assert.equal(operation["x-required-role"], expected.role);
    assert.ok(operation.responses[expected.success]);
    assert.ok(operation.responses["401"]);
    assert.ok(operation.responses["403"]);
  }

  assert.ok(spec.paths["/api/v1/ai-regression/runs"].post.responses["409"]);
  assert.ok(spec.paths["/api/v1/ai-regression/runs"].post.responses["422"]);
  assert.ok(spec.paths["/api/v1/ai-regression/runs"].post.responses["503"]);
  for (const path of [
    "/api/v1/ai-regression/golden-examples/{id}",
    "/api/v1/ai-regression/runs/{id}",
    "/api/v1/ai-regression/runs/{id}/results",
  ]) {
    const operation =
      spec.paths[path].get ?? spec.paths[path].delete ?? undefined;
    assert.ok(
      operation.responses["404"],
      `${path} must disclose no more than 404`,
    );
  }
});

test("AI regression caller-writable bodies are closed and server authority stays server-side", () => {
  const capture = spec.components.schemas.AIRegressionGoldenCaptureRequest;
  assert.equal(capture.additionalProperties, false);
  assert.deepEqual(Object.keys(capture.properties).sort(), [
    "approved_output",
    "brief",
    "request_id",
    "surface_kind",
  ]);
  assert.deepEqual([...capture.required].sort(), [
    "approved_output",
    "brief",
    "request_id",
    "surface_kind",
  ]);

  const trigger = spec.components.schemas.AIRegressionTriggerRequest;
  assert.equal(trigger.additionalProperties, false);
  assert.deepEqual(Object.keys(trigger.properties), ["model_version_tag"]);
  assert.equal(trigger.properties.model_version_tag.maxLength, 160);

  const settings = spec.components.schemas.AIRegressionSettings;
  assert.equal(settings.additionalProperties, false);
  assert.deepEqual(Object.keys(settings.properties).sort(), [
    "hard_gate_enabled",
    "hard_gate_threshold",
    "min_examples_for_gate",
    "warn_threshold",
  ]);

  const goldenMetadata =
    spec.components.schemas.AIRegressionGoldenExampleMetadata;
  assert.equal("approved_output" in goldenMetadata.properties, false);
  assert.ok(goldenMetadata.properties.request_id.oneOf);
});

test("AI regression evidence schemas remain complete, closed, and nullable where evidence can be absent", () => {
  const run = spec.components.schemas.AIRegressionRun;
  assert.equal(run.additionalProperties, false);
  for (const field of [
    "runtime_provider",
    "model_id",
    "model_version_tag",
    "prompt_version_tag",
    "total_examples",
    "scored_examples",
    "error_examples",
    "passed_examples",
    "fidelity_score_mean",
    "fidelity_score_p25",
    "gate_result",
    "warn_threshold",
    "hard_gate_enabled",
    "hard_gate_threshold",
    "min_examples_for_gate",
    "attempt_count",
    "max_attempts",
    "created_at",
    "started_at",
    "completed_at",
    "snapshot_frozen_at",
    "heartbeat_at",
    "lease_expires_at",
    "retry_not_before",
    "stale_at",
    "updated_at",
    "by_surface",
  ]) {
    assert.ok(run.properties[field], `run.${field}`);
  }

  const surface = spec.components.schemas.AIRegressionSurfaceAggregate;
  assert.equal(surface.additionalProperties, false);
  assert.deepEqual(surface.required, [
    "total",
    "scored",
    "errors",
    "passed",
    "mean_score",
    "gate_result",
  ]);
  assert.deepEqual(surface.properties.gate_result, {
    $ref: "#/components/schemas/AIRegressionGateResult",
  });
  assert.equal(
    surface.properties.mean_score.oneOf.some(
      (branch) => branch.type === "null",
    ),
    true,
  );

  const result = spec.components.schemas.AIRegressionResult;
  assert.equal(result.additionalProperties, false);
  for (const field of [
    "brief",
    "approved_output",
    "source_model_id",
    "voice_profile_version",
    "approval_id",
    "agent_run_id",
    "source_created_at",
    "snapshotted_at",
    "snapshot_ordinal",
    "replayed_output",
    "fidelity_score",
    "breakdown",
    "error_code",
    "error_message",
    "attempt_count",
  ]) {
    assert.ok(result.properties[field], `result.${field}`);
  }
  assert.equal(result.properties.snapshot_ordinal.oneOf[0].minimum, 1);

  const breakdown = spec.components.schemas.AIRegressionFidelityBreakdown;
  assert.equal(breakdown.additionalProperties, false);
  assert.deepEqual(Object.keys(breakdown.properties).sort(), [
    "combined",
    "embedding_similarity",
    "structural_match",
    "stylistic_distance",
    "vocabulary_overlap",
  ]);
  assert.deepEqual([...breakdown.required].sort(), [
    "combined",
    "embedding_similarity",
    "structural_match",
    "stylistic_distance",
    "vocabulary_overlap",
  ]);
});

test("AI regression is promoted from gateway-only classification into OpenAPI", () => {
  for (const rule of routeContracts.rules) {
    if (rule.route) {
      assert.equal(rule.route.includes("/api/v1/ai-regression"), false);
    }
    if (rule.pattern) {
      const expression = new RegExp(rule.pattern, "u");
      for (const operation of operationContract) {
        assert.equal(
          expression.test(
            `${operation.method.toUpperCase()} ${operation.path}`,
          ),
          false,
        );
      }
    }
  }
});

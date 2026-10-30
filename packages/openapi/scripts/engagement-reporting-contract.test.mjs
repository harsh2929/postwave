import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import YAML from "yaml";

const packageRoot = new URL("../", import.meta.url);
const spec = YAML.parse(
  readFileSync(new URL("openapi.yaml", packageRoot), "utf8"),
);
const routeAuthManifest = JSON.parse(
  readFileSync(
    new URL("../../apps/api/internal/routeauth/manifest.json", packageRoot),
    "utf8",
  ),
);

const summaryPath =
  "/api/v1/analytics/engagement-classification/summary";
const reachPath = "/api/v1/analytics/human-engaged-reach";
const exportPath = "/api/v1/analytics/human-engaged-reach/export";

test("engagement reporting operations are authenticated read:reports routes", () => {
  for (const path of [summaryPath, reachPath, exportPath]) {
    const operation = spec.paths[path]?.get;
    assert.ok(operation, `GET ${path}`);
    assert.deepEqual(operation["x-required-scopes"], ["read:reports"]);
    assert.equal(operation["x-required-role"], "viewer");
    assert.deepEqual(operation.security, [
      { bearerAuth: [] },
      { sessionCookie: [] },
    ]);
    assert.ok(operation.responses["200"]);
    assert.ok(operation.responses["400"]);
    assert.ok(operation.responses["401"]);
    assert.ok(operation.responses["403"]);
    assert.ok(operation.responses["500"]);
    assert.deepEqual(operation.parameters.map((parameter) => parameter.name), [
      "campaign_id",
      "since",
      "until",
    ]);
    assert.match(operation.parameters[0].description, /authentication/u);
  }
});

test("evidence export fixes campaign/window scope and exposes exact-byte integrity headers", () => {
  const operation = spec.paths[exportPath].get;
  assert.ok(operation.parameters.every((parameter) => parameter.required === true));
  assert.match(operation.description, /not a Moosewave signature/u);
  assert.match(operation.description, /supersession lineage/u);
  const headers = operation.responses["200"].headers;
  for (const name of [
    "Cache-Control",
    "Content-Disposition",
    "Content-Digest",
    "ETag",
    "X-Postwave-Artifact-SHA256",
  ]) {
    assert.ok(headers[name], `missing response header ${name}`);
  }
  assert.match(
    headers["Content-Digest"].description,
    /exact identity-encoded response-body bytes/u,
  );
  assert.match(headers["X-Postwave-Artifact-SHA256"].description, /evidence_payload/u);
  assert.match(
    operation.description,
    /no\s+`Content-Encoding` field is emitted/u,
  );
  assert.equal(
    operation.responses["200"].content[
      "application/vnd.postwave.human-engaged-reach-evidence+json"
    ].schema.$ref,
    "#/components/schemas/HumanEngagedReachEvidenceArtifact",
  );
  assert.ok(operation.responses["404"]);
  assert.match(operation.responses["404"].description, /foreign and unknown/u);
});

test("campaign-scoped reach reads document indistinguishable not-found behavior", () => {
  for (const path of [reachPath, exportPath]) {
    const notFound = spec.paths[path].get.responses["404"];
    assert.ok(notFound, `GET ${path} omits 404`);
    assert.match(notFound.description, /authenticated tenant/u);
  }
});

test("evidence export has a reviewed routeauth policy", () => {
  const exportPolicy = routeAuthManifest.routes.find(
    (route) => route.method === "GET" && route.path === exportPath,
  );
  assert.deepEqual(exportPolicy, {
    method: "GET",
    path: exportPath,
    exposure: "authenticated",
    auth_methods: ["session", "api_key"],
    session_minimum_role: "viewer",
    api_key_scopes: ["read:reports"],
    api_key_scope_mode: "any",
    policy_source: "openapi.x-required-scopes",
    review_status: "reviewed",
  });
});

test("reach schema keeps the floor, unknown-only band, and upper bound together", () => {
  const schema = spec.components.schemas.HumanEngagedReachResponse;
  assert.equal(schema.additionalProperties, false);
  for (const field of [
    "provider_accepted_recipients",
    "human_engaged_reach_floor",
    "unknown_band",
    "human_engaged_reach_upper_bound",
    "machine_only_recipients",
    "no_interaction_recipients",
    "methodology",
    "classifier_version_coverage",
    "mixed_classifier_versions",
  ]) {
    assert.ok(schema.required.includes(field), `missing required ${field}`);
  }
  assert.match(schema.properties.unknown_band.description, /no human interaction/u);
  assert.match(
    schema.properties.human_engaged_reach_upper_bound.description,
    /floor plus the mutually-exclusive unknown band/u,
  );
  assert.match(
    schema.properties.no_interaction_recipients.description,
    /excluded from the floor and upper bound/u,
  );
  assert.match(schema.properties.window_start.description, /analysis bound/u);
  assert.match(schema.properties.window_start.description, /not an assertion/u);
  assert.match(schema.properties.window_end.description, /sending completed/u);
  assert.doesNotMatch(JSON.stringify(schema), /verified[_ -]human/iu);
});

test("both schemas expose exact mixed and unclassified provenance", () => {
  const coverage = spec.components.schemas.EngagementClassifierVersionCoverage;
  assert.equal(coverage.additionalProperties, false);
  assert.deepEqual(coverage.required, [
    "shadow_mode",
    "event_count",
    "unclassified",
  ]);
  assert.match(coverage.description, /no stored classifier decision/u);
  for (const name of [
    "EngagementClassificationSummaryResponse",
    "HumanEngagedReachResponse",
  ]) {
    const schema = spec.components.schemas[name];
    for (const field of [
      "classifier_version",
      "methodology_version",
      "registry_version",
      "configuration_hash",
      "classifier_version_coverage",
      "mixed_classifier_versions",
      "shadow_mode",
    ]) {
      assert.ok(schema.required.includes(field), `${name} omits ${field}`);
    }
    assert.equal(
      schema.properties.classifier_version_coverage.items.$ref,
      "#/components/schemas/EngagementClassifierVersionCoverage",
    );
  }
});

test("evidence artifact distinguishes observed signals from classifier inference", () => {
  const artifact = spec.components.schemas.HumanEngagedReachEvidenceArtifact;
  const integrity = spec.components.schemas.HumanEngagedReachEvidenceIntegrity;
  const semantics = spec.components.schemas.HumanEngagedReachEvidenceSemantics;
  const report = spec.components.schemas.HumanEngagedReachEvidenceReport;

  assert.equal(artifact.additionalProperties, false);
  assert.ok(artifact.required.includes("generated_at"));
  assert.match(
    artifact.properties.generated_at.description,
    /outside evidence_payload and its digest/u,
  );
  assert.equal(integrity.properties.algorithm.const, "sha-256");
  assert.equal(integrity.properties.scope.const, "evidence_payload");
  assert.equal(integrity.properties.authenticity.const, "not_signed");
  assert.match(integrity.properties.digest_sha256.pattern, /64/u);
  for (const field of [
    "observed_evidence",
    "inferred_evidence",
    "not_observed",
    "human_reach_claim",
    "unknown_treatment",
    "acceptance_boundary",
  ]) {
    assert.ok(semantics.required.includes(field), `missing semantic boundary ${field}`);
  }
  assert.ok(!Object.hasOwn(report.properties, "generated_at"));
  assert.ok(report.required.includes("campaign_id"));
  assert.match(report.properties.window_start.description, /analysis bound/u);
  assert.match(report.properties.window_end.description, /sending completed/u);
  assert.equal(report.properties.machine_by_subtype.type, "array");
  assert.match(
    report.properties.human_engaged_reach_floor.description,
    /classifier-derived lower bound, not directly observed reading/u,
  );
  assert.doesNotMatch(JSON.stringify(artifact), /verified[_ -]human/iu);
});

test("F12 emits incremental lift only as immutable powered F02 evidence", () => {
  const lift = spec.components.schemas.PoweredIncrementalLift;
  const pointer = spec.components.schemas.IncrementalLiftEvidencePointer;
  const reach = spec.components.schemas.HumanEngagedReachResponse;
  const report = spec.components.schemas.HumanEngagedReachEvidenceReport;

  assert.equal(lift.additionalProperties, false);
  assert.equal(lift.properties.powered.const, true);
  assert.ok(lift.required.includes("evidence_pointer"));
  assert.ok(lift.required.includes("generated_at"));
  assert.ok(lift.required.includes("methodology_statement"));
  assert.ok(!lift.required.includes("relative_lift"));
  assert.match(lift.properties.relative_lift.description, /Percentage lift/u);
  assert.match(lift.properties.relative_lift.description, /10% to 15% is 50/u);
  assert.match(
    lift.properties.methodology_statement.description,
    /Self-contained explanation/u,
  );
  assert.equal(pointer.properties.result_id.format, "uuid");
  assert.match(pointer.properties.evidence_sha256.pattern, /64/u);
  for (const schema of [reach, report]) {
    assert.equal(
      schema.properties.incremental_lift.$ref,
      "#/components/schemas/PoweredIncrementalLift",
    );
    assert.ok(!schema.required.includes("incremental_lift"));
  }
});

test("full-tier SDK resources expose both report reads and the evidence export", () => {
  const sources = {
    typescript: readFileSync(
      new URL("../sdk-ts/src/resources/analytics.ts", packageRoot),
      "utf8",
    ),
    python: readFileSync(
      new URL("../sdk-py/postwave/resources/analytics.py", packageRoot),
      "utf8",
    ),
    php: readFileSync(
      new URL("../sdk-php/src/Resources/AnalyticsResource.php", packageRoot),
      "utf8",
    ),
  };
  for (const [language, source] of Object.entries(sources)) {
    assert.match(source, /\/api\/v1\/analytics\/engagement-classification\/summary/u, `${language} summary route`);
    assert.match(source, /\/api\/v1\/analytics\/human-engaged-reach/u, `${language} reach route`);
    assert.match(source, /\/api\/v1\/analytics\/human-engaged-reach\/export/u, `${language} evidence export route`);
    assert.match(
      source,
      /application\/vnd\.postwave\.human-engaged-reach-evidence\+json/u,
      `${language} evidence media type`,
    );
    assert.doesNotMatch(source, /verified[_ -]human/iu, `${language} overclaims`);
  }
});

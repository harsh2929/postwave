// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const documents = [
  resolve(repoRoot, "packages/openapi/openapi.json"),
  resolve(repoRoot, "apps/api/internal/apidocs/openapi.json"),
].map((path) => JSON.parse(readFileSync(path, "utf8")));
const routeManifest = JSON.parse(
  readFileSync(
    resolve(repoRoot, "apps/api/internal/routeauth/manifest.json"),
    "utf8",
  ),
);

const JOB_PATH = "/api/v1/verification/jobs";
const EXPECTED_RESPONSES = [
  "202",
  "400",
  "401",
  "403",
  "409",
  "413",
  "415",
  "422",
  "500",
  "503",
];
const REQUIRED_JOB_FIELDS = [
  "id",
  "status",
  "source",
  "execution_mode",
  "total",
  "processed",
  "cache_hits",
  "local_filtered",
  "vendor_verified",
  "credits_spent",
  "duplicates",
  "ambiguous",
  "attempts",
  "created_at",
];
const SAFE_SINGLE_LINE_PATTERN =
  "^[^\\u0000-\\u001F\\u007F-\\u009F\\u00AD\\u0600-\\u0605\\u061C\\u06DD\\u070F\\u0890-\\u0891\\u08E2\\u180E\\u200B-\\u200F\\u2028-\\u202E\\u2060-\\u206F\\uD800-\\uF8FF\\uFEFF\\uFFF9-\\uFFFB]*$";

test("bulk verification job creation publishes its real guarded contract", () => {
  for (const document of documents) {
    const operation = document.paths[JOB_PATH]?.post;
    assert.ok(operation, `POST ${JOB_PATH} missing`);
    assert.deepEqual(operation["x-required-scopes"], ["write:subscribers"]);
    assert.equal(operation["x-required-role"], "editor");
    assert.deepEqual(operation.security, [
      { bearerAuth: [] },
      { sessionCookie: [] },
    ]);
    assert.equal(operation["x-postwave-max-body-bytes"], 8 * 1024 * 1024);
    assert.deepEqual(operation.parameters, [
      { $ref: "#/components/parameters/VerificationIdempotencyKey" },
    ]);
    assert.equal(operation.requestBody.required, true);
    assert.equal(
      operation.requestBody.content["application/json"].schema.$ref,
      "#/components/schemas/VerificationJobCreateRequest",
    );
    assert.deepEqual(
      Object.keys(operation.responses).sort(),
      EXPECTED_RESPONSES,
    );
    assert.equal(
      operation.responses["202"].content["application/json"].schema.$ref,
      "#/components/schemas/VerificationJob",
    );
    assert.equal(
      operation.responses["409"].$ref,
      "#/components/responses/VerificationJobIdempotencyInProgress",
    );
    assert.equal(
      operation.responses["422"].$ref,
      "#/components/responses/VerificationIdempotencyMismatch",
    );
    assert.equal(
      operation.responses["503"].$ref,
      "#/components/responses/VerificationJobRuntimeUnavailable",
    );
    assert.match(
      operation.description,
      /does not call a\s+verification provider/u,
    );
    assert.match(operation.description, /before resolving a source/u);

    const request = document.components.schemas.VerificationJobCreateRequest;
    assert.equal(request.additionalProperties, false);
    assert.equal(request.properties.emails.maxItems, 250_000);
    assert.equal(request.properties.emails.items.maxLength, 320);
    assert.equal(
      request.properties.emails.items["x-postwave-max-utf8-bytes"],
      320,
    );
    assert.equal(request.properties.source_ref.maxLength, 512);
    assert.equal(
      request.properties.source_ref.pattern,
      SAFE_SINGLE_LINE_PATTERN,
    );
    assert.equal(
      request.properties.emails.items.pattern,
      SAFE_SINGLE_LINE_PATTERN,
    );
    assert.deepEqual(
      request.oneOf.map((branch) => branch.properties.source.const),
      ["inline", "upload", "tag", "all_subscribers"],
    );
    assert.deepEqual(request.oneOf[0].required, ["emails"]);
    assert.deepEqual(request.oneOf[1].required, ["source", "emails"]);
    assert.deepEqual(request.oneOf[2].required, ["source", "source_ref"]);
    assert.equal(request.oneOf[2].properties.emails.maxItems, 0);
    assert.equal(request.oneOf[3].properties.emails.maxItems, 0);

    const job = document.components.schemas.VerificationJob;
    assert.equal(job.additionalProperties, false);
    assert.deepEqual(job.required, REQUIRED_JOB_FIELDS);
    assert.deepEqual(document.components.schemas.VerificationJobStatus.enum, [
      "pending",
      "running",
      "completed",
      "failed",
      "canceled",
    ]);
    assert.deepEqual(document.components.schemas.VerificationJobSource.enum, [
      "inline",
      "upload",
      "tag",
      "all_subscribers",
    ]);
    assert.deepEqual(
      document.components.schemas.VerificationJobExecutionMode.enum,
      ["local", "full"],
    );
    assert.equal(job.properties.total.maximum, 250_000);
    assert.equal(job.properties.created_by.format, "uuid");
    assert.equal(job.properties.source_ref.pattern, SAFE_SINGLE_LINE_PATTERN);
    assert.equal(job.properties.error.pattern, SAFE_SINGLE_LINE_PATTERN);
    assert.equal(
      document.components.schemas.VerificationJobItem.properties.email.pattern,
      SAFE_SINGLE_LINE_PATTERN,
    );

    const unavailable =
      document.components.responses.VerificationJobRuntimeUnavailable;
    assert.equal(
      unavailable.content["application/json"].schema.$ref,
      "#/components/schemas/RuntimeCapabilityError",
    );
    assert.equal(
      unavailable.content["application/json"].example.error.code,
      "verification_bulk_unavailable",
    );
    assert.equal(
      unavailable.content["application/json"].example.error.capability,
      "verification_bulk_jobs",
    );

    const key = document.components.parameters.VerificationIdempotencyKey;
    assert.equal(key.required, true);
    assert.match(key.description, /exact request\s+identity/u);
    assert.match(key.description, /used exactly as supplied/u);
    assert.match(
      key.description,
      /leading or trailing\s+whitespace is invalid/iu,
    );
    assert.doesNotMatch(key.description, /normalized|trimming/iu);
    assert.equal(
      key.schema.pattern,
      "^[^\\s\\u0000-\\u001F\\u007F-\\u009F](?:[^\\u0000-\\u001F\\u007F-\\u009F]*[^\\s\\u0000-\\u001F\\u007F-\\u009F])?$",
    );

    const gradeDescription =
      document.components.schemas.EmailHealthGrade.description;
    const bClause = gradeDescription.match(/`B`[\s\S]*?`C`/u)?.[0];
    assert.ok(bClause, "EmailHealthGrade B clause missing");
    assert.match(bClause, /first-party positive activity/u);
    assert.doesNotMatch(bClause, /vendor activity|proprietary/iu);

    const health = document.components.schemas.EmailHealthResult;
    const gradeA = health.allOf.find(
      (branch) => branch.if?.properties?.grade?.const === "A",
    );
    assert.deepEqual(gradeA.then.required, [
      "status",
      "provider",
      "checked_at",
    ]);
    assert.deepEqual(gradeA.then.properties.provider.enum, [
      "zerobounce",
      "kickbox",
    ]);
    assert.match(
      document.components.schemas.EmailHealthEvidenceKind.description,
      /cannot earn B or retire negative chronology/u,
    );
  }
});

test("route authority agrees that bulk job creation is editor/write guarded", () => {
  const route = routeManifest.routes.find(
    (candidate) => candidate.method === "POST" && candidate.path === JOB_PATH,
  );
  assert.ok(route, `POST ${JOB_PATH} missing from route authority`);
  assert.equal(route.exposure, "authenticated");
  assert.deepEqual(route.auth_methods, ["session", "api_key"]);
  assert.equal(route.session_minimum_role, "editor");
  assert.deepEqual(route.api_key_scopes, ["write:subscribers"]);
  assert.equal(route.api_key_scope_mode, "any");
});

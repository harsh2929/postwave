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
const manifest = JSON.parse(
  readFileSync(
    resolve(repoRoot, "apps/api/internal/routeauth/manifest.json"),
    "utf8",
  ),
);

const LIST_PATH = "/api/v1/intelligent-retry/events";
const MARK_READY_PATH = "/api/v1/intelligent-retry/events/{id}/mark-ready";
const DISMISS_PATH = "/api/v1/intelligent-retry/events/{id}/dismiss";
const PRIVATE_RESPONSE = {
  appliesTo:
    "all outcomes, including pre-handler authentication and authorization refusals",
  cacheControl: "private, no-store",
  pragma: "no-cache",
  expires: "0",
  contentTypeOptions: "nosniff",
};
const PRIVATE_HEADERS = {
  "Cache-Control": {
    $ref: "#/components/headers/IntelligentRetryPrivateNoStore",
  },
  Pragma: { $ref: "#/components/headers/IntelligentRetryPragmaNoCache" },
  Expires: { $ref: "#/components/headers/IntelligentRetryExpires" },
  "X-Content-Type-Options": {
    $ref: "#/components/headers/IntelligentRetryNoSniff",
  },
};
const OPERATIONS = [
  ["GET", LIST_PATH, ["200", "400", "401", "403", "500"]],
  [
    "POST",
    MARK_READY_PATH,
    [
      "200",
      "400",
      "401",
      "403",
      "404",
      "409",
      "413",
      "415",
      "422",
      "428",
      "500",
    ],
  ],
  [
    "POST",
    DISMISS_PATH,
    [
      "200",
      "400",
      "401",
      "403",
      "404",
      "409",
      "413",
      "415",
      "422",
      "428",
      "500",
    ],
  ],
];

function dereference(document, value) {
  if (!value?.$ref) return value;
  assert.match(value.$ref, /^#\//u);
  return value.$ref
    .slice(2)
    .split("/")
    .reduce((node, part) => node?.[part.replaceAll("~1", "/").replaceAll("~0", "~")], document);
}

test("intelligent-retry mirrors publish exact admin, privacy, and response contracts", () => {
  for (const document of documents) {
    for (const [method, path, responseCodes] of OPERATIONS) {
      const operation = document.paths[path]?.[method.toLowerCase()];
      assert.ok(operation, `${method} ${path} missing`);
      assert.deepEqual(operation["x-required-scopes"], ["admin"]);
      assert.equal(operation["x-required-role"], "admin");
      assert.deepEqual(operation.security, [
        { bearerAuth: [] },
        { sessionCookie: [] },
      ]);
      assert.deepEqual(operation["x-postwave-private-response"], PRIVATE_RESPONSE);
      assert.deepEqual(Object.keys(operation.responses).sort(), responseCodes);
      for (const [code, responseRef] of Object.entries(operation.responses)) {
        const response = dereference(document, responseRef);
        for (const [header, contract] of Object.entries(PRIVATE_HEADERS)) {
          assert.deepEqual(
            response.headers?.[header],
            contract,
            `${method} ${path} ${code} must preserve ${header}`,
          );
        }
      }
    }

    const list = document.paths[LIST_PATH].get;
    const status = list.parameters.find((parameter) => parameter.name === "status");
    const limit = list.parameters.find((parameter) => parameter.name === "limit");
    assert.deepEqual(status.schema, {
      $ref: "#/components/schemas/IntelligentRetryStatus",
    });
    assert.deepEqual(limit.schema, {
      type: "integer",
      minimum: 1,
      maximum: 500,
      default: 100,
    });
    assert.equal(
      dereference(document, list.responses["200"]).content["application/json"].schema.$ref,
      "#/components/schemas/IntelligentRetryEventListResponse",
    );

    for (const path of [MARK_READY_PATH, DISMISS_PATH]) {
      const operation = document.paths[path].post;
      const pathID = document.paths[path].parameters[0].schema;
      assert.equal(pathID.type, "string");
      assert.equal("format" in pathID, false);
      assert.equal(operation["x-postwave-max-body-bytes"], 1024);
      assert.deepEqual(operation.parameters, [
        { $ref: "#/components/parameters/IdempotencyKey" },
      ]);
      assert.equal(operation.requestBody.required, true);
      assert.equal(
        operation.requestBody.content["application/json"].schema.$ref,
        "#/components/schemas/IntelligentRetryMutationInput",
      );
      assert.equal(
        dereference(document, operation.responses["200"]).content["application/json"].schema.$ref,
        "#/components/schemas/IntelligentRetryEvent",
      );
      assert.equal(
        dereference(document, operation.responses["200"]).headers[
          "Idempotent-Replayed"
        ].schema.const,
        "true",
      );
      assert.equal(
        dereference(document, operation.responses["409"]).headers[
          "Retry-After"
        ].schema.const,
        "5",
      );
      assert.equal(
        dereference(document, operation.responses["422"]).content[
          "application/json"
        ].schema.$ref,
        "#/components/schemas/IntelligentRetryIdempotencyMismatchError",
      );
    }

    const event = document.components.schemas.IntelligentRetryEvent;
    assert.equal(event.additionalProperties, false);
    assert.deepEqual(event.required, [
      "id",
      "tenant_id",
      "campaign_id",
      "subscriber_email",
      "reason",
      "status",
      "retry_after",
      "attempts",
      "created_at",
      "updated_at",
    ]);
    for (const id of ["id", "tenant_id", "campaign_id"]) {
      assert.equal(event.properties[id].format, "uuid");
    }
    assert.equal(event.properties.attempts.minimum, 0);
    assert.deepEqual(document.components.schemas.IntelligentRetryStatus.enum, [
      "pending",
      "ready",
      "retrying",
      "retried",
      "failed",
      "dismissed",
    ]);
    assert.equal(document.components.schemas.IntelligentRetryReason.const, "frequency_cap");
    assert.equal(document.components.schemas.IntelligentRetryBreakdown.additionalProperties, false);
    assert.equal(document.components.schemas.IntelligentRetryBreakdown.properties.skipped.minimum, 0);

    const mutation = document.components.schemas.IntelligentRetryMutationInput;
    assert.equal(mutation.additionalProperties, false);
    assert.deepEqual(mutation.required, ["expected_updated_at"]);
    assert.equal(mutation.properties.expected_updated_at.format, "date-time");
    assert.equal(mutation.properties.expected_updated_at.minLength, 1);
    assert.equal(mutation.properties.expected_updated_at.maxLength, 64);

    assert.deepEqual(
      document.components.schemas.IntelligentRetryListBadRequestError.properties.error.properties.code.enum,
      ["invalid_status", "invalid_limit"],
    );
    assert.deepEqual(
      document.components.schemas.IntelligentRetryMutationBadRequestError.properties.error.properties.code.enum,
      [
        "bad_json",
        "unknown_field",
        "multiple_json_values",
        "invalid_expected_updated_at",
        "invalid_idempotency_key",
        "idempotency_key_too_long",
        "body_read_failed",
      ],
    );
    assert.deepEqual(
      document.components.schemas.IntelligentRetryConflictError.properties.error.properties.code.enum,
      [
        "retry_revision_conflict",
        "retry_transition_conflict",
        "idempotency_key_in_progress",
      ],
    );
    assert.equal(
      document.components.schemas.IntelligentRetryIdempotencyMismatchError
        .properties.error.properties.code.const,
      "idempotency_key_request_mismatch",
    );
    assert.deepEqual(
      document.components.schemas.IntelligentRetryInternalError.properties.error
        .properties.code.enum,
      [
        "internal_error",
        "idempotency_lookup_failed",
        "idempotency_claim_failed",
        "idempotency_complete_failed",
        "idempotency_revalidation_failed",
      ],
    );
    assert.equal(
      document.components.schemas.IntelligentRetryPreconditionRequiredError.properties.error.properties.code.const,
      "precondition_required",
    );
  }
});

test("intelligent-retry authorization manifest is reviewed exact-admin", () => {
  for (const [method, path] of OPERATIONS) {
    const policy = manifest.routes.find(
      (route) => route.method === method && route.path === path,
    );
    assert.ok(policy, `${method} ${path} policy missing`);
    assert.equal(policy.exposure, "authenticated");
    assert.deepEqual(policy.auth_methods, ["session", "api_key"]);
    assert.equal(policy.session_minimum_role, "admin");
    assert.deepEqual(policy.api_key_scopes, ["admin"]);
    assert.equal(policy.api_key_scope_mode, "any");
    assert.equal(policy.policy_source, "openapi.x-required-scopes");
    assert.equal(policy.review_status, "reviewed");
  }
});

test("campaign queue errors disclose all-capped and retry-ledger refusal boundaries", () => {
  for (const document of documents) {
    const validation = document.components.responses.CampaignQueueValidation;
    assert.equal(
      validation.content["application/json"].examples.frequencyCapAllDeferred.value.error.code,
      "frequency_cap_all_deferred",
    );
    const unavailable = document.components.responses.CampaignQueueUnavailable;
    assert.equal(
      unavailable.content["application/json"].examples.intelligentRetryUnavailable.value.error.code,
      "intelligent_retry_unavailable",
    );
  }
});

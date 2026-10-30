// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const documents = [
  resolve(repoRoot, "packages/openapi/openapi.json"),
  resolve(repoRoot, "apps/api/internal/apidocs/openapi.json"),
].map((path) => JSON.parse(readFileSync(path, "utf8")));
const yamlDocument = YAML.parse(
  readFileSync(resolve(repoRoot, "packages/openapi/openapi.yaml"), "utf8"),
);
const manifest = JSON.parse(
  readFileSync(
    resolve(repoRoot, "apps/api/internal/routeauth/manifest.json"),
    "utf8",
  ),
);

const SETTINGS_PATH = "/api/v1/settings/sending";
const STATUS_PATH = "/api/v1/settings/sending/status";
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
    $ref: "#/components/headers/SendingSettingsPrivateNoStore",
  },
  Pragma: { $ref: "#/components/headers/SendingSettingsPragmaNoCache" },
  Expires: { $ref: "#/components/headers/SendingSettingsExpires" },
  "X-Content-Type-Options": {
    $ref: "#/components/headers/SendingSettingsNoSniff",
  },
};
const OUTCOME_HEADER = "X-Postwave-Sending-Cap-Outcome";
const COMMITTED_OUTCOME = {
  $ref: "#/components/headers/SendingCapOutcomeCommitted",
};
const NOT_COMMITTED_OUTCOME = {
  $ref: "#/components/headers/SendingCapOutcomeNotCommitted",
};
const OUTCOME_UNPROVEN_CODES = new Set(["401", "403", "413"]);
const AMBIGUOUS_FAILURE_OUTCOMES = [
  "not-committed",
  "committed",
  "committed-conservatively-fenced",
  "commit-outcome-unknown-conservatively-fenced",
];
const OPERATIONS = [
  ["GET", SETTINGS_PATH, ["200", "401", "403", "500"]],
  [
    "PUT",
    SETTINGS_PATH,
    ["200", "400", "401", "403", "409", "413", "415", "500", "503"],
  ],
  ["GET", STATUS_PATH, ["200", "401", "403", "500"]],
];

function dereference(document, value) {
  if (!value?.$ref) return value;
  return value.$ref
    .slice(2)
    .split("/")
    .reduce((node, part) => node?.[part], document);
}

test("canonical sending-settings OpenAPI mirrors publish exact admin, CAS, and private-response contracts", () => {
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
      assert.deepEqual(
        operation["x-postwave-private-response"],
        PRIVATE_RESPONSE,
      );
      assert.deepEqual(Object.keys(operation.responses).sort(), responseCodes);
      for (const [code, responseRef] of Object.entries(operation.responses)) {
        const response = dereference(document, responseRef);
        if (method !== "PUT") {
          assert.deepEqual(response.headers, PRIVATE_HEADERS);
          continue;
        }
        if (code === "200") {
          assert.deepEqual(response.headers, {
            ...PRIVATE_HEADERS,
            [OUTCOME_HEADER]: COMMITTED_OUTCOME,
          });
          continue;
        }
        assert.deepEqual(
          Object.fromEntries(
            Object.entries(response.headers).filter(
              ([name]) => name !== OUTCOME_HEADER && name !== "Retry-After",
            ),
          ),
          PRIVATE_HEADERS,
        );
        if (OUTCOME_UNPROVEN_CODES.has(code)) {
          assert.equal(response.headers[OUTCOME_HEADER], undefined);
          continue;
        }
        assert.ok(response.headers[OUTCOME_HEADER]);
      }
    }

    const settings = document.paths[SETTINGS_PATH];
    assert.equal(
      dereference(document, settings.get.responses["200"]).content[
        "application/json"
      ].schema.$ref,
      "#/components/schemas/SendingSettings",
    );
    assert.equal(settings.put["x-postwave-max-body-bytes"], 65_536);
    assert.equal(settings.put.requestBody.required, true);
    assert.equal(
      settings.put.requestBody.content["application/json"].schema.$ref,
      "#/components/schemas/SendingSettingsInput",
    );
    assert.equal(
      dereference(document, settings.put.responses["200"]).content[
        "application/json"
      ].schema.$ref,
      "#/components/schemas/SendingSettings",
    );
    const conflictResponse = dereference(
      document,
      settings.put.responses["409"],
    );
    assert.deepEqual(conflictResponse.headers, {
      ...PRIVATE_HEADERS,
      [OUTCOME_HEADER]: NOT_COMMITTED_OUTCOME,
      "Retry-After": conflictResponse.headers["Retry-After"],
    });
    assert.equal(
      conflictResponse.content["application/json"].schema.$ref,
      "#/components/schemas/SendingSettingsConflictError",
    );
    assert.deepEqual(
      document.components.schemas.SendingSettingsConflictError.oneOf.map(
        (variant) => variant.$ref,
      ),
      [
        "#/components/schemas/SendingSettingsRevisionConflictError",
        "#/components/schemas/SendingSettingsCapChangeInProgressError",
        "#/components/schemas/SendingSettingsDeliverabilityThrottleActiveError",
      ],
    );
    assert.equal(
      document.components.schemas
        .SendingSettingsDeliverabilityThrottleActiveError.properties.error
        .properties.code.const,
      "deliverability_throttle_active",
    );
    for (const code of ["400", "415"]) {
      assert.deepEqual(
        dereference(document, settings.put.responses[code]).headers[
          OUTCOME_HEADER
        ],
        NOT_COMMITTED_OUTCOME,
      );
    }
    for (const code of OUTCOME_UNPROVEN_CODES) {
      const response = dereference(document, settings.put.responses[code]);
      assert.deepEqual(response.headers, PRIVATE_HEADERS);
      assert.match(response.description, /refused|could not be completed/);
    }
    const failed = dereference(document, settings.put.responses["500"]);
    assert.deepEqual(
      failed.headers[OUTCOME_HEADER].schema.enum,
      AMBIGUOUS_FAILURE_OUTCOMES,
    );
    assert.match(failed.description, /optional mutation\s+outcome header/i);
    assert.match(failed.description, /header is absent, the\s+outcome is ambiguous/i);
    assert.match(settings.put.description, /A 401, 403, or 413 can be produced before/);
    assert.match(settings.put.description, /Only an explicitly received `not-committed` value proves/);
    const unavailable = dereference(document, settings.put.responses["503"]);
    assert.deepEqual(unavailable.headers[OUTCOME_HEADER].schema.enum, [
      "not-committed",
      "committed-conservatively-fenced",
      "commit-outcome-unknown-conservatively-fenced",
    ]);
    assert.equal(
      unavailable.content["application/json"].schema.$ref,
      "#/components/schemas/SendingSettingsCoordinationError",
    );

    const status = document.paths[STATUS_PATH].get;
    assert.equal(
      dereference(document, status.responses["200"]).content["application/json"]
        .schema.$ref,
      "#/components/schemas/SendingSettingsStatus",
    );

    const row = document.components.schemas.SendingSettings;
    assert.equal(row.additionalProperties, false);
    assert.deepEqual(row.required, [
      "tenant_id",
      "quiet_hours_per_recipient",
      "updated_at",
    ]);
    assert.equal(row.properties.tenant_id.format, "uuid");
    assert.equal(row.properties.updated_at.format, "date-time");

    const input = document.components.schemas.SendingSettingsInput;
    assert.equal(input.additionalProperties, false);
    assert.ok(!input.required?.includes("expected_updated_at"));
    assert.equal(input.properties.quiet_hours_start.type, "string");
    assert.equal(input.properties.quiet_hours_end.type, "string");
    assert.equal(input.properties.quiet_hours_tz.type, "string");
    assert.equal(input.properties.quiet_hours_per_recipient.type, "boolean");
    assert.equal(input.properties.expected_updated_at.oneOf[0].const, "");
    assert.equal(
      input.properties.expected_updated_at.oneOf[1].format,
      "date-time",
    );
    assert.ok(
      input.properties.expected_updated_at.oneOf.every(
        (variant) => variant.type === "string",
      ),
    );
    assert.match(
      input.description,
      /Duplicate object member names\s+are rejected/,
    );
    assert.match(input.description, /every other present field\s+must have its declared non-null type/);

    const statusSchema = document.components.schemas.SendingSettingsStatus;
    assert.equal(statusSchema.additionalProperties, false);
    assert.equal(statusSchema.properties.counter_authoritative.const, false);
    assert.equal(statusSchema.properties.counter_source.const, "unavailable");
    assert.equal(statusSchema.properties.counter_scope.const, "unavailable");
    assert.equal(statusSchema.properties.tenant_id.format, "uuid");
    assert.deepEqual(statusSchema.properties.cap_coordination_state.enum, [
      "ready",
      "conservatively_fenced",
      "unavailable",
    ]);
    assert.ok(statusSchema.required.includes("tenant_id"));
    assert.ok(statusSchema.required.includes("cap_coordination_state"));
    assert.ok(statusSchema.required.includes("cap_coordination_ready"));
    assert.ok(
      statusSchema.required.includes("cap_coordination_matches_settings"),
    );

    assert.equal(
      document.components.headers.SendingCapOutcomeCommitted.schema.const,
      "committed",
    );
    assert.equal(
      document.components.headers.SendingCapOutcomeNotCommitted.schema.const,
      "not-committed",
    );
    assert.equal(
      document.components.headers.SendingCapOutcomeConservativelyFenced.schema
        .const,
      "committed-conservatively-fenced",
    );
    assert.equal(
      document.components.headers.SendingCapOutcomeUnknownConservativelyFenced
        .schema.const,
      "commit-outcome-unknown-conservatively-fenced",
    );

    const conflict =
      document.components.schemas.SendingSettingsRevisionConflictError;
    assert.equal(
      conflict.properties.error.properties.code.const,
      "settings_revision_conflict",
    );
  }
});

test("canonical sending-settings authorization manifest is reviewed exact-admin", () => {
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

test("sending-settings YAML publishes the non-replayable keyed-request boundary", () => {
  const put = yamlDocument.paths[SETTINGS_PATH].put;
  assert.equal(put["x-postwave-idempotency"], "forbidden");
  assert.equal(put["x-postwave-retry-policy"], "one-attempt");
  assert.match(put.description, /`Idempotency-Key` MUST NOT be sent/);
  assert.match(put.description, /commit outcome is still unknown/);

  const badRequest = dereference(yamlDocument, put.responses["400"]);
  assert.deepEqual(badRequest.headers, {
    ...PRIVATE_HEADERS,
    [OUTCOME_HEADER]: NOT_COMMITTED_OUTCOME,
  });
  assert.equal(
    badRequest.content["application/json"].schema.$ref,
    "#/components/schemas/SendingSettingsBadRequestError",
  );
  const codes = yamlDocument.components.schemas.SendingSettingsBadRequestError
    .properties.error.properties.code.enum;
  assert.ok(codes.includes("idempotency_forbidden"));
  assert.equal(
    yamlDocument.components.schemas.SendingSettingsBadRequestError
      .additionalProperties,
    false,
  );
});

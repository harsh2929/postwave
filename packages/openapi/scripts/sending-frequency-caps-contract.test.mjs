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

const COLLECTION_PATH = "/api/v1/sending/frequency-caps";
const MEMBER_PATH = "/api/v1/sending/frequency-caps/{id}";
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
    $ref: "#/components/headers/FrequencyCapPrivateNoStore",
  },
  Pragma: { $ref: "#/components/headers/FrequencyCapPragmaNoCache" },
  Expires: { $ref: "#/components/headers/FrequencyCapExpires" },
  "X-Content-Type-Options": {
    $ref: "#/components/headers/FrequencyCapNoSniff",
  },
};
const OPERATIONS = [
  ["GET", COLLECTION_PATH, ["200", "401", "403", "500"]],
  [
    "POST",
    COLLECTION_PATH,
    ["201", "400", "401", "403", "409", "413", "415", "422", "500"],
  ],
  [
    "PATCH",
    MEMBER_PATH,
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
    "DELETE",
    MEMBER_PATH,
    [
      "204",
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
  return value.$ref
    .slice(2)
    .split("/")
    .reduce((node, part) => node?.[part], document);
}

test("canonical sending frequency-cap OpenAPI mirrors publish the exact-admin CAS contract", () => {
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
        assert.ok(response, `${method} ${path} ${code} response missing`);
        for (const [header, contract] of Object.entries(PRIVATE_HEADERS)) {
          assert.deepEqual(
            response.headers?.[header],
            contract,
            `${method} ${path} ${code} must preserve ${header}`,
          );
        }
      }
    }

    const collection = document.paths[COLLECTION_PATH];
    const listSuccess = dereference(document, collection.get.responses["200"]);
    assert.equal(
      listSuccess.content["application/json"].schema.$ref,
      "#/components/schemas/FrequencyCapRuleListResponse",
    );
    assert.equal(collection.post["x-postwave-max-body-bytes"], 1_048_576);
    assert.deepEqual(collection.post.parameters, [
      { $ref: "#/components/parameters/IdempotencyKey" },
    ]);
    assert.match(collection.post.description, /same tenant transaction/);
    assert.equal(collection.post.requestBody.required, true);
    assert.equal(
      collection.post.requestBody.content["application/json"].schema.$ref,
      "#/components/schemas/FrequencyCapRuleCreateInput",
    );
    const createSuccess = dereference(
      document,
      collection.post.responses["201"],
    );
    assert.equal(
      createSuccess.content["application/json"].schema.$ref,
      "#/components/schemas/FrequencyCapRuleResponse",
    );
    assert.equal(
      createSuccess.headers["Idempotent-Replayed"].schema.const,
      "true",
    );
    const createInProgress = dereference(
      document,
      collection.post.responses["409"],
    );
    assert.equal(createInProgress.headers["Retry-After"].schema.const, "5");
    assert.equal(
      createInProgress.content["application/json"].schema.$ref,
      "#/components/schemas/FrequencyCapIdempotencyInProgressError",
    );
    assert.equal(
      dereference(document, collection.post.responses["422"]).content[
        "application/json"
      ].schema.$ref,
      "#/components/schemas/FrequencyCapIdempotencyMismatchError",
    );

    const member = document.paths[MEMBER_PATH];
    assert.equal(member.parameters[0].schema.format, "uuid");
    for (const method of ["patch", "delete"]) {
      const operation = member[method];
      assert.deepEqual(operation.parameters, [
        { $ref: "#/components/parameters/IdempotencyKey" },
      ]);
      assert.equal(operation.requestBody.required, true);
      assert.equal(
        operation.requestBody.content["application/json"].schema.$ref,
        method === "patch"
          ? "#/components/schemas/FrequencyCapRulePatchInput"
          : "#/components/schemas/FrequencyCapRuleDeleteInput",
      );
      assert.equal(
        dereference(document, operation.responses["428"]).content[
          "application/json"
        ].schema.$ref,
        "#/components/schemas/FrequencyCapPreconditionRequiredError",
      );
      assert.equal(
        dereference(document, operation.responses["409"]).content[
          "application/json"
        ].schema.$ref,
        "#/components/schemas/FrequencyCapMutationConflictError",
      );
      assert.equal(
        dereference(document, operation.responses["422"]).content[
          "application/json"
        ].schema.$ref,
        "#/components/schemas/FrequencyCapIdempotencyMismatchError",
      );
    }
    assert.equal(member.patch["x-postwave-max-body-bytes"], 1_048_576);
    assert.equal(member.delete["x-postwave-max-body-bytes"], 4096);
    assert.equal(
      dereference(document, member.delete.responses["204"]).headers[
        "Idempotent-Replayed"
      ].schema.const,
      "true",
    );

    const rule = document.components.schemas.FrequencyCapRule;
    assert.equal(rule.additionalProperties, false);
    assert.ok(rule.required.includes("updated_at"));
    assert.equal(rule.properties.updated_at.format, "date-time");
    assert.equal(rule.properties.label["x-postwave-max-utf16-units"], 160);

    for (const schemaName of [
      "FrequencyCapRulePatchInput",
      "FrequencyCapRuleDeleteInput",
    ]) {
      const input = document.components.schemas[schemaName];
      assert.equal(input.additionalProperties, false);
      assert.deepEqual(input.required, ["expected_updated_at"]);
      assert.equal(input.properties.expected_updated_at.format, "date-time");
    }
    assert.equal(
      document.components.schemas.FrequencyCapPreconditionRequiredError
        .properties.error.properties.code.const,
      "precondition_required",
    );
    assert.equal(
      document.components.schemas.FrequencyCapRevisionConflictError.properties
        .error.properties.code.const,
      "frequency_cap_revision_conflict",
    );
    assert.equal(
      document.components.schemas.FrequencyCapIdempotencyInProgressError
        .properties.error.properties.code.const,
      "idempotency_key_in_progress",
    );
    assert.equal(
      document.components.schemas.FrequencyCapIdempotencyMismatchError
        .properties.error.properties.code.const,
      "idempotency_key_request_mismatch",
    );
    assert.deepEqual(
      document.components.schemas.FrequencyCapMutationConflictError.oneOf,
      [
        { $ref: "#/components/schemas/FrequencyCapRevisionConflictError" },
        {
          $ref: "#/components/schemas/FrequencyCapIdempotencyInProgressError",
        },
      ],
    );
    assert.equal(
      document.components.headers.FrequencyCapExpires.schema.const,
      "0",
    );
  }
});

test("canonical sending frequency-cap authorization manifest is reviewed exact-admin", () => {
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

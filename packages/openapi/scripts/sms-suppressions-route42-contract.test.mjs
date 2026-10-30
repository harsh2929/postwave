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

const ADMIN_OPERATIONS = [
  ["GET", "/api/v1/sms/quiet-hours"],
  ["POST", "/api/v1/sms/quiet-hours"],
  ["PATCH", "/api/v1/sms/quiet-hours/{id}"],
  ["DELETE", "/api/v1/sms/quiet-hours/{id}"],
  ["GET", "/api/v1/sms/keyword-responses"],
  ["POST", "/api/v1/sms/keyword-responses"],
  ["PATCH", "/api/v1/sms/keyword-responses/{id}"],
  ["DELETE", "/api/v1/sms/keyword-responses/{id}"],
  ["GET", "/api/v1/sms/suppressions"],
  ["POST", "/api/v1/sms/suppressions"],
  ["POST", "/api/v1/sms/suppressions/query"],
  ["DELETE", "/api/v1/sms/suppressions/{id}"],
];
const UUID_V4_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const CANONICAL_OPT_OUT_RESPONSE =
  "You are unsubscribed from SMS marketing messages from this sender.";
const JSON_BODY_OPERATIONS = new Set([
  "POST /api/v1/sms/quiet-hours",
  "PATCH /api/v1/sms/quiet-hours/{id}",
  "DELETE /api/v1/sms/quiet-hours/{id}",
  "POST /api/v1/sms/keyword-responses",
  "PATCH /api/v1/sms/keyword-responses/{id}",
  "DELETE /api/v1/sms/keyword-responses/{id}",
  "POST /api/v1/sms/suppressions",
  "POST /api/v1/sms/suppressions/query",
]);
const JSON_BODY_LIMITS = new Map(
  [...JSON_BODY_OPERATIONS].map((operation) => [
    operation,
    operation.includes("/suppressions") ? 8192 : 32768,
  ]),
);
const PRIVATE_SUCCESS_HEADERS = {
  "Cache-Control": { $ref: "#/components/headers/SmsPrivateNoStore" },
  Pragma: { $ref: "#/components/headers/SmsPragmaNoCache" },
  "X-Content-Type-Options": { $ref: "#/components/headers/SmsNoSniff" },
};

test("Route42 OpenAPI mirrors publish the strict body-query suppression contract", () => {
  for (const document of documents) {
    for (const [method, path] of ADMIN_OPERATIONS) {
      const operation = document.paths[path]?.[method.toLowerCase()];
      assert.ok(operation, `${method} ${path} missing`);
      assert.deepEqual(
        operation["x-required-scopes"],
        ["admin"],
        `${method} ${path} scopes`,
      );
      assert.deepEqual(
        operation.security,
        [{ bearerAuth: [] }, { sessionCookie: [] }],
        `${method} ${path} authentication alternatives`,
      );
      assert.deepEqual(
        operation["x-postwave-private-response"],
        {
          appliesTo:
            "all outcomes, including pre-handler authentication and authorization refusals",
          cacheControl: "private, no-store",
          pragma: "no-cache",
          contentTypeOptions: "nosniff",
        },
        `${method} ${path} private response boundary`,
      );
      assert.ok(operation.responses["503"], `${method} ${path} 503 missing`);
      const success = operation.responses["201"] ?? operation.responses["200"];
      assert.deepEqual(
        success.headers,
        PRIVATE_SUCCESS_HEADERS,
        `${method} ${path} success security headers`,
      );
      if (JSON_BODY_OPERATIONS.has(`${method} ${path}`)) {
        assert.ok(operation.responses["413"], `${method} ${path} 413 missing`);
        assert.ok(operation.responses["415"], `${method} ${path} 415 missing`);
        assert.equal(
          operation["x-postwave-max-body-bytes"],
          JSON_BODY_LIMITS.get(`${method} ${path}`),
          `${method} ${path} body limit`,
        );
      }
    }

    assert.equal(
      document.components.headers.SmsPrivateNoStore.schema.const,
      "private, no-store",
    );
    assert.equal(
      document.components.headers.SmsPragmaNoCache.schema.const,
      "no-cache",
    );
    assert.equal(document.components.headers.SmsNoSniff.schema.const, "nosniff");

    const list = document.paths["/api/v1/sms/suppressions"].get;
    assert.equal(
      list.parameters.some((parameter) => parameter.name === "phone"),
      false,
      "recipient phone must not enter GET URL parameters",
    );
    const query = document.paths["/api/v1/sms/suppressions/query"].post;
    assert.match(query.description, /canonical request URL/u);
    assert.match(query.description, /deployment privacy control/u);
    assert.match(
      query.description,
      /`Idempotency-Key` is\s+ignored before generic mutation replay header validation,\s+idempotency-ledger tenant-key resolution, body capture, or ledger\s+access/u,
    );
    assert.match(query.description, /fresh\s+mandatory\s+read audit/u);
    const keywordCreate = document.paths["/api/v1/sms/keyword-responses"].post;
    assert.match(keywordCreate.description, /create-only/i);
    assert.match(keywordCreate.description, /keyword_response_exists/);
    assert.match(keywordCreate.description, /reserved_keyword/);
    assert.equal(
      keywordCreate.requestBody.content["application/json"].schema.$ref,
      "#/components/schemas/SmsKeywordResponseCreateInput",
    );
    const keywordCreateInput =
      document.components.schemas.SmsKeywordResponseCreateInput;
    assert.deepEqual(keywordCreateInput.required, ["keyword", "action"]);
    assert.equal(keywordCreateInput.oneOf.length, 2);
    assert.equal(
      keywordCreateInput.properties.keyword.pattern,
      "^[A-Za-z0-9_.:-]+$",
    );
    assert.equal(
      document.components.schemas.SmsKeywordResponse.properties.keyword.pattern,
      "^[A-Z0-9_.:-]+$",
    );
    assert.equal(
      document.components.schemas.SmsKeywordResponsePatchInput.properties
        .keyword.pattern,
      keywordCreateInput.properties.keyword.pattern,
    );
    assert.deepEqual(keywordCreateInput.properties.action.enum, ["opt_out"]);
    assert.equal(
      keywordCreateInput.properties.response_body.const,
      CANONICAL_OPT_OUT_RESPONSE,
    );
    assert.equal(
      keywordCreateInput.properties.response_text.const,
      CANONICAL_OPT_OUT_RESPONSE,
    );
    const keywordPatchInput =
      document.components.schemas.SmsKeywordResponsePatchInput;
    assert.deepEqual(keywordPatchInput.properties.action.enum, ["opt_out"]);
    assert.equal(
      keywordPatchInput.properties.response_body.const,
      CANONICAL_OPT_OUT_RESPONSE,
    );
    assert.equal(
      keywordPatchInput.properties.response_text.const,
      CANONICAL_OPT_OUT_RESPONSE,
    );
    assert.match(
      document.paths["/api/v1/sms/keyword-responses/{id}"].patch.description,
      /historical readable `reply_only` row/u,
    );
    assert.match(
      document.paths["/api/v1/sms/keyword-responses/{id}"].patch.description,
      /reserved_keyword/u,
    );
    assert.match(
      document.paths["/api/v1/sms/keyword-responses/{id}"].delete.description,
      /^Deletes the resource/u,
    );
    assert.doesNotMatch(
      document.paths["/api/v1/sms/keyword-responses/{id}"].delete.description,
      /deactivates/u,
    );
    assert.equal(
      document.components.schemas.SmsKeywordResponse.properties.opt_in_count
        .maximum,
      2_147_483_647,
    );
    for (const schemaName of ["SmsQuietHoursList", "SmsKeywordResponseList"]) {
      assert.deepEqual(document.components.schemas[schemaName].required, [
        "tenantId",
        "items",
      ]);
    }
    assert.equal(
      document.components.schemas.SmsQuietHoursInput.properties.country_code
        .const,
      "",
    );
    assert.deepEqual(
      document.components.schemas.SmsQuietHoursRule.properties.country_code
        .enum,
      ["", "US", "CA"],
    );
    assert.match(
      document.components.schemas.SmsQuietHoursRule.properties.country_code
        .description,
      /historical reconciliation/i,
    );
    assert.match(
      document.paths["/api/v1/sms/quiet-hours/{id}"].patch.description,
      /explicitly sets both\s+`enabled: false` and\s+`country_code: ""`/u,
    );
    assert.match(
      document.paths["/api/v1/sms/quiet-hours/{id}"].patch.description,
      /whether enabled or disabled/u,
    );
    assert.match(
      document.components.schemas.SmsQuietHoursPatchInput.properties.country_code
        .description,
      /country-only\s+clear/u,
    );
    for (const [path, schemaName] of [
      ["/api/v1/sms/quiet-hours/{id}", "SmsQuietHoursPatchInput"],
      ["/api/v1/sms/keyword-responses/{id}", "SmsKeywordResponsePatchInput"],
    ]) {
      const patchSchema =
        document.paths[path].patch.requestBody.content["application/json"]
          .schema.$ref;
      assert.equal(patchSchema, `#/components/schemas/${schemaName}`);
      assert.deepEqual(document.components.schemas[schemaName].required, [
        "expected_updated_at",
      ]);
      assert.equal(
        document.paths[path].delete.requestBody.content["application/json"]
          .schema.$ref,
        "#/components/schemas/SmsPolicyDeleteInput",
      );
    }
    assert.equal(
      query.requestBody.content["application/json"].schema.$ref,
      "#/components/schemas/SmsSuppressionQueryInput",
    );
    assert.deepEqual(
      document.components.schemas.SmsSuppressionQueryInput.required,
      ["phone"],
    );
    assert.deepEqual(
      Object.keys(
        document.components.schemas.SmsSuppressionQueryInput.properties,
      ).sort(),
      ["phone", "reason"],
    );
    for (const schemaName of [
      "SmsSuppressionQueryInput",
      "SmsSuppressionAddInput",
    ]) {
      const phone = document.components.schemas[schemaName].properties.phone;
      const pattern = new RegExp(phone.pattern, "u");
      assert.equal(pattern.test("(415) 555-1212"), true, `${schemaName} formatted phone`);
      assert.equal(pattern.test(" +1 415.555.1212 "), true, `${schemaName} country phone`);
      assert.equal(pattern.test("+1\t4155551212"), false, `${schemaName} tab`);
      assert.equal(pattern.test("＋14155551212"), false, `${schemaName} Unicode plus`);
      assert.match(phone.description, /Reviewed ASCII US\/Canada input/u);
      assert.match(phone.description, /canonical\s+`\+1XXXXXXXXXX`/u);
    }
    assert.equal(
      query.responses["200"].content["application/json"].schema.$ref,
      "#/components/schemas/SmsSuppressionExactPage",
    );
    const exactPage =
      document.components.schemas.SmsSuppressionExactPage.allOf[1];
    assert.deepEqual(exactPage.not, { required: ["nextCursor"] });
    assert.equal(exactPage.properties.items.maxItems, 1);
    assert.equal(exactPage.properties.total.maximum, 1);
    assert.equal(
      document.paths["/api/v1/sms/suppressions"].post.responses["201"].content[
        "application/json"
      ].schema.$ref,
      "#/components/schemas/SmsSuppressionRow",
    );

    const cursor =
      document.components.parameters.SmsSuppressionCursorQuery.schema;
    assert.equal(cursor.pattern, "^v1\\.[A-Za-z0-9_-]+$");
    assert.equal(
      document.components.schemas.SmsSuppressionsPage.properties.nextCursor
        .pattern,
      cursor.pattern,
    );
    assert.equal(
      document.components.schemas.SmsSuppressionsPage.properties.snapshotAt
        .pattern,
      "^20[0-9]{2}-",
    );

    const receipt = document.components.schemas.SmsSuppressionDeleteReceipt;
    assert.equal(receipt.additionalProperties, false);
    assert.deepEqual(receipt.required, ["ok", "tenantId", "id"]);
    assert.equal(receipt.properties.ok.const, true);
    assert.equal(receipt.properties.id.pattern, UUID_V4_PATTERN);
    for (const path of [
      "/api/v1/sms/suppressions/{id}",
      "/api/v1/sms/quiet-hours/{id}",
      "/api/v1/sms/keyword-responses/{id}",
    ]) {
      assert.equal(
        document.paths[path].parameters[0].schema.pattern,
        UUID_V4_PATTERN,
      );
      assert.equal(
        document.paths[path].delete.responses["200"].content["application/json"]
          .schema.$ref,
        "#/components/schemas/SmsSuppressionDeleteReceipt",
      );
    }

    assert.deepEqual(document.components.schemas.SmsSuppressionReason.enum, [
      "manual",
      "stop_keyword",
      "help_keyword",
      "carrier_block",
      "complaint",
      "quiet_hours",
      "expired",
    ]);
    assert.deepEqual(
      document.components.schemas.SmsKeywordResponse.properties.action.enum,
      ["reply_only", "opt_out"],
    );
    assert.equal(
      document.components.schemas.SmsKeywordResponse.properties
        .autoReplyDispatchAvailable.const,
      false,
    );
    assert.match(
      document.paths["/api/v1/sms/quiet-hours"].get.description,
      /internal eligibility gate/u,
    );
    assert.match(
      document.paths["/api/v1/sms/quiet-hours"].get.description,
      /no live-delivery claim/u,
    );
  }
});

test("Route42 generated gateway policies are reviewed exact-admin", () => {
  const policies = new Map(
    manifest.routes.map((route) => [`${route.method} ${route.path}`, route]),
  );
  for (const [method, path] of ADMIN_OPERATIONS) {
    const key = `${method} ${path}`;
    const policy = policies.get(key);
    assert.ok(policy, `${key} missing from routeauth manifest`);
    assert.equal(policy.exposure, "authenticated", `${key} exposure`);
    assert.deepEqual(
      policy.auth_methods,
      ["session", "api_key"],
      `${key} auth`,
    );
    assert.equal(policy.session_minimum_role, "admin", `${key} role`);
    assert.deepEqual(policy.api_key_scopes, ["admin"], `${key} scopes`);
    assert.equal(
      policy.policy_source,
      "openapi.x-required-scopes",
      `${key} source`,
    );
    assert.equal(policy.review_status, "reviewed", `${key} review`);
  }
});

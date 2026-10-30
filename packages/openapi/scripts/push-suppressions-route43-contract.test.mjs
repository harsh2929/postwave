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

const OPERATIONS = [
  ["GET", "/api/v1/push/suppressions"],
  ["POST", "/api/v1/push/suppressions"],
  ["POST", "/api/v1/push/suppressions/bulk-import"],
  ["POST", "/api/v1/push/suppressions/bulk-remove"],
  ["DELETE", "/api/v1/push/suppressions/{id}"],
];
const BODY_LIMITS = new Map([
  ["POST /api/v1/push/suppressions", 16_384],
  ["POST /api/v1/push/suppressions/bulk-import", 524_288],
  ["POST /api/v1/push/suppressions/bulk-remove", 524_288],
  ["DELETE /api/v1/push/suppressions/{id}", 16_384],
]);
const PRIVATE_HEADERS = {
  "Cache-Control": { $ref: "#/components/headers/PushPrivateNoStore" },
  Pragma: { $ref: "#/components/headers/PushPragmaNoCache" },
  "X-Content-Type-Options": { $ref: "#/components/headers/PushNoSniff" },
};
const UUID_V4 =
  "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

test("Route43 OpenAPI mirrors publish one finite private authority contract", () => {
  for (const document of documents) {
    for (const [method, path] of OPERATIONS) {
      const operation = document.paths[path]?.[method.toLowerCase()];
      assert.ok(operation, `${method} ${path} missing`);
      assert.deepEqual(operation["x-required-scopes"], ["admin"]);
      assert.equal(operation["x-required-role"], "admin");
      assert.deepEqual(operation.security, [
        { bearerAuth: [] },
        { sessionCookie: [] },
      ]);
      assert.deepEqual(operation["x-postwave-private-response"], {
        appliesTo:
          "all outcomes, including exact-admin authentication and authorization refusals",
        cacheControl: "private, no-store, max-age=0",
        pragma: "no-cache",
        contentTypeOptions: "nosniff",
      });
      assert.ok(operation.responses["503"], `${method} ${path} 503`);
      const success = operation.responses["201"] ?? operation.responses["200"];
      assert.deepEqual(success.headers, PRIVATE_HEADERS);
      if (BODY_LIMITS.has(`${method} ${path}`)) {
        assert.equal(
          operation["x-postwave-max-body-bytes"],
          BODY_LIMITS.get(`${method} ${path}`),
        );
        assert.ok(operation.requestBody?.required);
        assert.ok(operation.responses["413"]);
        assert.ok(operation.responses["415"]);
        assert.ok(operation.responses["422"]);
      }
    }

    assert.equal(
      document.components.headers.PushPrivateNoStore.schema.const,
      "private, no-store, max-age=0",
    );
    assert.equal(
      document.components.headers.PushPragmaNoCache.schema.const,
      "no-cache",
    );
    assert.equal(document.components.headers.PushNoSniff.schema.const, "nosniff");

    const list = document.paths["/api/v1/push/suppressions"].get;
    assert.deepEqual(
      list.parameters.map((parameter) => parameter.name),
      ["platform", "reason", "hash_prefix", "cursor", "limit"],
    );
    const byName = Object.fromEntries(
      list.parameters.map((parameter) => [parameter.name, parameter]),
    );
    assert.equal(byName.hash_prefix.schema.pattern, "^[0-9a-f]{8,16}$");
    assert.deepEqual(byName.limit.schema, {
      type: "integer",
      minimum: 1,
      maximum: 100,
      default: 50,
    });
    assert.equal(byName.cursor.schema.pattern, "^[A-Za-z0-9_-]+$");
    assert.equal(byName.cursor.schema.maxLength, 2048);
    assert.match(list.description, /16-character display fingerprint/u);
    assert.match(list.description, /runtime qualification/u);
    assert.match(list.description, /release-held/u);
    assert.match(list.description, /monotonic visibility revision/u);
    assert.match(list.description, /clock rollback/u);
    assert.doesNotMatch(list.description, /database response cutoff/iu);
    assert.doesNotMatch(list.description, /currently excluded|currently prevented/iu);

    const schemas = document.components.schemas;
    assert.deepEqual(schemas.PushSuppressionPlatform.enum, ["apns", "fcm", "web"]);
    assert.deepEqual(schemas.PushSuppressionReason.enum, [
      "manual",
      "unregistered",
      "expired",
      "complaint",
      "user_opt_out",
    ]);
    assert.deepEqual(schemas.PushSuppressionSource.enum, [
      "dashboard",
      "provider",
      "user",
      "complaint",
      "legacy",
    ]);
    assert.deepEqual(schemas.PushSuppressionLockedReason.enum, [
      "provider_authority",
      "user_opt_out_authority",
      "complaint_authority",
      "legacy_authority_requires_review",
    ]);

    const row = schemas.PushSuppressionRow;
    assert.equal(row.additionalProperties, false);
    assert.deepEqual(row.required, [
      "id",
      "tenant_id",
      "device_token_hash",
      "platform",
      "reason",
      "source",
      "created_at",
      "updated_at",
      "version",
      "reversible",
    ]);
    assert.equal(row.properties.id.pattern, UUID_V4);
    assert.equal(row.properties.device_token_hash.pattern, "^[0-9a-f]{16}$");
    assert.equal("source_event_id" in row.properties, false);
    assert.equal(row.oneOf.length, 5);
    assert.deepEqual(row.oneOf[0].not, { required: ["locked_reason"] });

    const page = schemas.PushSuppressionsPage;
    assert.equal(page.additionalProperties, false);
    assert.equal(page.properties.items.maxItems, 100);
    assert.equal(page.properties.nextCursor.pattern, "^[A-Za-z0-9_-]+$");
    assert.equal(page.properties.nextCursor.maxLength, 2048);
    assert.match(page.properties.total.description, /monotonic visibility revision/u);
    assert.match(page.properties.snapshotAt.description, /observation metadata/u);
    assert.match(page.properties.snapshotAt.description, /clock rollback/u);

    const variants = row.oneOf.map((variant) => variant.properties);
    assert.deepEqual(variants[0], {
      reason: { const: "manual" },
      source: { const: "dashboard" },
      reversible: { const: true },
    });
    assert.deepEqual(variants[1], {
      reason: { enum: ["unregistered", "expired"] },
      source: { const: "provider" },
      reversible: { const: false },
      locked_reason: { const: "provider_authority" },
    });
    assert.equal(variants[2].locked_reason.const, "user_opt_out_authority");
    assert.equal(variants[3].locked_reason.const, "complaint_authority");
    assert.equal(
      variants[4].locked_reason.const,
      "legacy_authority_requires_review",
    );

    const add = schemas.PushSuppressionAddInput;
    assert.deepEqual(add.required, ["device_token", "platform"]);
    assert.equal(add.properties.reason.const, "manual");
    assert.match(add.properties.device_token.description, /Exact 20–4096 UTF-8 bytes/u);
    assert.match(add.properties.device_token.description, /without trimming/u);

    const removal = schemas.PushSuppressionDeleteInput;
    assert.deepEqual(removal.required, ["expected_version"]);
    const receipt = schemas.PushSuppressionDeleteReceipt;
    assert.deepEqual(receipt.required, [
      "ok",
      "tenantId",
      "id",
      "version",
      "stillSuppressed",
    ]);
    assert.equal(receipt.properties.id.pattern, UUID_V4);
    assert.match(receipt.properties.version.description, /expected_version \+ 1/u);

    for (const schemaName of [
      "PushSuppressionBulkImportInput",
      "PushSuppressionBulkRemoveInput",
    ]) {
      const items = schemas[schemaName].properties.items;
      assert.equal(items.minItems, 1);
      assert.equal(items.maxItems, 100);
      assert.equal(items.uniqueItems, true);
    }
    assert.deepEqual(schemas.PushSuppressionBulkRemoveItem.required, [
      "id",
      "expected_version",
    ]);
    assert.equal(schemas.PushSuppressionBulkRemoveItem.additionalProperties, false);
    assert.deepEqual(schemas.PushSuppressionBulkImportReceipt.required, [
      "ok",
      "tenantId",
      "created",
      "existing",
      "items",
    ]);
    assert.deepEqual(schemas.PushSuppressionBulkRemoveReceipt.required, [
      "ok",
      "tenantId",
      "removed",
      "stillSuppressed",
      "items",
    ]);

    const basePost = document.paths["/api/v1/push/suppressions"].post;
    assert.equal(
      basePost.responses["200"].content["application/json"].schema.$ref,
      "#/components/schemas/PushSuppressionRow",
    );
    assert.equal(
      basePost.responses["201"].content["application/json"].schema.$ref,
      "#/components/schemas/PushSuppressionRow",
    );
    assert.equal(
      document.paths["/api/v1/push/suppressions/{id}"].parameters[0].schema.pattern,
      UUID_V4,
    );
  }
});

test("Route43 route authority is generated as exact admin for every operation", () => {
  for (const [method, path] of OPERATIONS) {
    const route = manifest.routes.find(
      (candidate) => candidate.method === method && candidate.path === path,
    );
    assert.ok(route, `${method} ${path} missing from routeauth manifest`);
    assert.equal(route.exposure, "authenticated");
    assert.deepEqual(route.auth_methods, ["session", "api_key"]);
    assert.equal(route.session_minimum_role, "admin");
    assert.deepEqual(route.api_key_scopes, ["admin"]);
    assert.equal(route.policy_source, "openapi.x-required-scopes");
    assert.equal(route.review_status, "reviewed");
  }
});

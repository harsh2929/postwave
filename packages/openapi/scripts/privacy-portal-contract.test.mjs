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

const adminOperations = [
  ["get", "/api/v1/privacy/portal", "200", "PrivacyPortalSummary"],
  ["get", "/api/v1/privacy/portal/regions", "200", "PrivacyPortalRegionList"],
  ["post", "/api/v1/privacy/portal/regions", "201", "PrivacyPortalRegion"],
  ["delete", "/api/v1/privacy/portal/regions/{id}", "200", "PrivacyPortalMutationReceipt"],
  ["get", "/api/v1/privacy/portal/double-optin/pending", "200", "PrivacyPortalDoubleOptInPage"],
  ["post", "/api/v1/privacy/portal/double-optin/{id}/resend", "200", "PrivacyPortalMutationReceipt"],
  ["post", "/api/v1/privacy/portal/double-optin/{id}/cancel", "200", "PrivacyPortalMutationReceipt"],
  ["get", "/api/v1/privacy/portal/preference-center", "200", "PrivacyPortalPreferenceCustomization"],
  ["patch", "/api/v1/privacy/portal/preference-center", "200", "PrivacyPortalPreferenceCustomization"],
  ["put", "/api/v1/privacy/portal/preference-center", "200", "PrivacyPortalPreferenceCustomization"],
];

function responseSchema(operation, status) {
  return operation.responses[status]?.content?.["application/json"]?.schema;
}

test("privacy portal publishes exact admin-only response contracts", () => {
  for (const document of documents) {
    for (const [method, path, status, schema] of adminOperations) {
      const operation = document.paths[path]?.[method];
      assert.ok(operation, `${method.toUpperCase()} ${path}`);
      assert.deepEqual(operation["x-required-scopes"], ["admin"]);
      assert.equal(operation["x-required-role"], "admin");
      assert.deepEqual(operation.security, [
        { bearerAuth: [] },
        { sessionCookie: [] },
      ]);
      assert.equal(
        responseSchema(operation, status)?.$ref,
        `#/components/schemas/${schema}`,
        `${method.toUpperCase()} ${path} response`,
      );
      assert.ok(operation.responses["401"]);
      assert.ok(operation.responses["403"]);
    }

    const branding =
      document.paths["/api/v1/privacy/portal/preference-center"];
    for (const method of ["patch", "put"]) {
      assert.equal(
        branding[method].requestBody.content["application/json"].schema.$ref,
        "#/components/schemas/PrivacyPortalPreferenceCustomizationInput",
      );
    }
    assert.match(
      document.paths["/api/v1/privacy/portal/double-optin/{id}/resend"].post
        .description,
      /does not send an email/u,
    );
  }
});

test("public preference contract is token-only, strict, and metadata-minimized", () => {
  for (const document of documents) {
    const path = document.paths["/api/public/preferences/{token}"];
    assert.deepEqual(path.get.security, []);
    assert.deepEqual(path.post.security, []);
    assert.equal(
      responseSchema(path.get, "200").$ref,
      "#/components/schemas/PublicPreferenceLookup",
    );
    assert.equal(
      path.post.requestBody.content["application/json"].schema.$ref,
      "#/components/schemas/PublicPreferenceUpdateInput",
    );

    const lookup = document.components.schemas.PublicPreferenceLookup;
    assert.equal(lookup.additionalProperties, false);
    assert.ok(lookup.required.includes("customization"));
    assert.ok(lookup.required.includes("gpc"));
    assert.equal(lookup.properties.topics.maxItems, 1000);

    const topic = document.components.schemas.PublicPreferenceTopic;
    assert.equal(topic.additionalProperties, false);
    for (const forbidden of [
      "tenantId",
      "createdAt",
      "updatedAt",
      "optedInCount",
      "optedOutCount",
    ]) {
      assert.equal(topic.properties[forbidden], undefined, forbidden);
    }

    const update = document.components.schemas.PublicPreferenceUpdateInput;
    assert.equal(update.additionalProperties, false);
    assert.equal(update.properties.topics.maxItems, 1000);
    assert.equal(update.properties.topics.uniqueItems, true);
  }
});

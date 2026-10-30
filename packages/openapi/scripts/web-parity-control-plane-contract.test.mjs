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

const browserSecurity = [{ bearerAuth: [] }, { sessionCookie: [] }];

function operation(document, method, path) {
  const candidate = document.paths[path]?.[method];
  assert.ok(candidate, `${method.toUpperCase()} ${path} missing`);
  return candidate;
}

function assertPolicy(candidate, scopes, role) {
  assert.deepEqual(candidate["x-required-scopes"], scopes);
  assert.equal(candidate["x-required-role"], role);
  assert.deepEqual(candidate.security, browserSecurity);
}

function manifestRoute(method, path) {
  const candidate = routeManifest.routes.find(
    (route) => route.method === method && route.path === path,
  );
  assert.ok(candidate, `${method} ${path} missing from route authority`);
  return candidate;
}

test("custom-object reads, versioned writes, and body-only record search stay exact", () => {
  for (const document of documents) {
    const search = operation(
      document,
      "post",
      "/api/v1/custom-objects/types/{id}/records/search",
    );
    assertPolicy(search, ["read:reports"], "viewer");
    assert.equal(search["x-postwave-max-body-bytes"], 16 * 1024);
    assert.equal(
      search.requestBody.content["application/json"].schema.$ref,
      "#/components/schemas/CustomObjectRecordSearchInput",
    );
    assert.equal(search.parameters, undefined);
    assert.deepEqual(Object.keys(search.responses).sort(), [
      "200",
      "400",
      "401",
      "403",
      "404",
      "413",
      "415",
      "500",
    ]);

    const searchInput = document.components.schemas.CustomObjectRecordSearchInput;
    assert.equal(searchInput.additionalProperties, false);
    assert.deepEqual(searchInput.required, ["property", "value"]);
    assert.equal(searchInput.properties.limit.maximum, 500);

    const recordDelete = operation(
      document,
      "delete",
      "/api/v1/custom-objects/records/{id}",
    );
    assertPolicy(recordDelete, ["admin"], "admin");
    assert.ok(recordDelete.responses["428"]);
    const recordCAS = document.components.schemas.CustomObjectRecordDeleteInput;
    assert.deepEqual(recordCAS.required, [
      "expectedVersion",
      "confirmationExternalId",
    ]);
    assert.equal(recordCAS.additionalProperties, false);

    const typeDelete = operation(
      document,
      "delete",
      "/api/v1/custom-objects/types/{id}",
    );
    assertPolicy(typeDelete, ["admin"], "admin");
    assert.ok(typeDelete.responses["428"]);
    assert.deepEqual(
      document.components.schemas.CustomObjectTypeDeleteInput.required,
      ["expectedVersion", "confirmationKey"],
    );
  }
});

test("audience resources publish strong ETags and optional strict CAS", () => {
  for (const document of documents) {
    const ifMatch = document.components.parameters.AudienceOptionalIfMatch;
    assert.equal(ifMatch.required, false);
    assert.match(ifMatch.description, /omission remains supported/iu);
    assert.match(ifMatch.schema.pattern, /^\^"/u);

    for (const [method, path] of [
      ["patch", "/api/v1/audience-destinations/{id}"],
      ["delete", "/api/v1/audience-destinations/{id}"],
      ["post", "/api/v1/audience-destinations/{id}/sync"],
      ["patch", "/api/v1/audience-syncs/{id}"],
      ["delete", "/api/v1/audience-syncs/{id}"],
      ["post", "/api/v1/audience-syncs/{id}/run"],
    ]) {
      const candidate = operation(document, method, path);
      assertPolicy(candidate, ["write:subscribers"], "editor");
      assert.ok(
        candidate.parameters.some(
          (parameter) =>
            parameter.$ref ===
            "#/components/parameters/AudienceOptionalIfMatch",
        ),
        `${method.toUpperCase()} ${path} lacks optional If-Match`,
      );
      assert.ok(candidate.responses["412"]);
      assert.equal(candidate.responses["428"], undefined);
    }

    for (const [method, path, status] of [
      ["post", "/api/v1/audience-destinations", "201"],
      ["get", "/api/v1/audience-destinations/{id}", "200"],
      ["patch", "/api/v1/audience-destinations/{id}", "200"],
      ["post", "/api/v1/audience-syncs", "201"],
      ["get", "/api/v1/audience-syncs/{id}", "200"],
      ["patch", "/api/v1/audience-syncs/{id}", "200"],
    ]) {
      const response = operation(document, method, path).responses[status];
      assert.equal(
        response.headers.ETag.$ref,
        "#/components/headers/AudienceStrongETag",
      );
    }
  }
});

test("SMS lifecycle, global totals, body-tag CAS, and retired aliases are explicit", () => {
  for (const document of documents) {
    const list = operation(document, "get", "/api/v1/sms/conversations");
    assertPolicy(list, ["admin"], "admin");
    assert.equal(
      list.responses["200"].content["application/json"].schema.$ref,
      "#/components/schemas/SmsConversationsResponse",
    );
    const totals = document.components.schemas.SmsConversationsResponse;
    for (const field of [
      "unreadTotal",
      "unknownTotal",
      "totalConversations",
      "activeTotal",
      "snoozedTotal",
      "archivedTotal",
    ]) {
      assert.ok(totals.required.includes(field), `${field} must be global`);
    }

    const expected =
      document.components.schemas.SmsConversationExpectedUpdatedAt;
    assert.deepEqual(expected.oneOf.map((branch) => branch.type), [
      "string",
      "null",
    ]);
    assert.equal(
      Object.hasOwn(
        document.components.schemas.SmsConversationLifecycleCASInput
          .properties,
        "expectedStateUpdatedAt",
      ),
      false,
    );
    assert.ok(
      Object.hasOwn(
        document.components.schemas.SmsConversationLifecycleCASInput
          .properties,
        "expectedUpdatedAt",
      ),
    );
    assert.ok(
      document.components.schemas.SmsConversationStateMutationReceipt.required.includes(
        "stateUpdatedAt",
      ),
    );

    const bulk = operation(
      document,
      "post",
      "/api/v1/sms/conversations/bulk",
    );
    assertPolicy(bulk, ["admin"], "admin");
    assert.equal(bulk["x-postwave-max-body-bytes"], 64 * 1024);
    assert.deepEqual(
      document.components.schemas.SmsConversationBulkMutationInput.properties
        .conversations,
      {
        type: "array",
        minItems: 1,
        maxItems: 200,
        uniqueItems: true,
        items: { $ref: "#/components/schemas/SmsConversationBulkTarget" },
      },
    );

    const tagsPath = "/api/v1/sms/conversations/{phone}/tags";
    const addTag = operation(document, "post", tagsPath);
    const removeTag = operation(document, "delete", tagsPath);
    assertPolicy(addTag, ["admin"], "admin");
    assertPolicy(removeTag, ["admin"], "admin");
    assert.equal(
      addTag.requestBody.content["application/json"].schema.$ref,
      "#/components/schemas/SmsConversationTagAddInput",
    );
    assert.equal(
      removeTag.requestBody.content["application/json"].schema.$ref,
      "#/components/schemas/SmsConversationTagRemoveInput",
    );
    assert.equal(
      document.components.schemas.SmsConversationTagAddInput.properties
        .expectedAbsent.const,
      true,
    );

    const retiredTag = operation(
      document,
      "delete",
      "/api/v1/sms/conversations/{phone}/tags/{tag}",
    );
    assert.deepEqual(Object.keys(retiredTag.responses), ["401", "403", "410"]);
    const retiredSearch = operation(
      document,
      "get",
      "/api/v1/sms/conversations/search",
    );
    assert.deepEqual(Object.keys(retiredSearch.responses), ["401", "403", "410"]);
    const search = operation(
      document,
      "post",
      "/api/v1/sms/conversations/search",
    );
    assert.equal(search["x-postwave-max-body-bytes"], 8 * 1024);
  }
});

test("audit export, alert, and sink contracts preserve diagnostics boundaries and authority", () => {
  for (const document of documents) {
    const exportCreate = operation(
      document,
      "post",
      "/api/v1/audit/export-async",
    );
    assertPolicy(
      exportCreate,
      ["audit:read", "audit:read_pii", "audit:execute_actions"],
      "admin",
    );
    assert.equal(exportCreate["x-required-scope-mode"], "all");
    assert.ok(exportCreate.responses["202"]);
    assert.equal(exportCreate.responses["200"], undefined);
    assert.equal(exportCreate["x-postwave-max-body-bytes"], 8 * 1024);

    const download = operation(
      document,
      "get",
      "/api/v1/audit/export-jobs/{id}/download",
    );
    assertPolicy(download, ["audit:read", "audit:read_pii"], "viewer");
    assert.equal(download["x-required-scope-mode"], "all");
    assert.ok(download.responses["409"]);
    assert.ok(download.responses["410"]);
    assert.ok(
      download.responses["200"].headers["X-Postwave-Audit-Export-Rows"],
    );

    const alertList = operation(document, "get", "/api/v1/audit-alerts");
    assertPolicy(alertList, ["audit:read"], "viewer");
    assert.equal(
      document.components.schemas.AuditAlertRedactedChannelConfig.maxProperties,
      0,
    );
    assert.equal(
      document.components.schemas.AuditAlertChannelConfigInput.properties
        .routing_key.writeOnly,
      true,
    );

    const alertCreate = operation(document, "post", "/api/v1/audit-alerts");
    assertPolicy(alertCreate, ["audit:configure_sinks"], "admin");
    assert.ok(alertCreate.responses["201"]);

    const inbound = operation(
      document,
      "post",
      "/api/v1/audit-alerts/inbound-webhook",
    );
    assert.deepEqual(inbound.security, [{ auditAlertInboundBearer: [] }]);
    assert.equal(inbound["x-required-scopes"], undefined);

    const sinkList = operation(document, "get", "/api/v1/audit-sinks");
    assertPolicy(sinkList, ["audit:configure_sinks"], "admin");
    assert.equal(
      Object.hasOwn(document.components.schemas.AuditSink.properties, "credentials"),
      false,
    );
    assert.equal(
      document.components.schemas.AuditSinkCredentials.writeOnly,
      true,
    );

    for (const path of [
      "/api/v1/audit-sinks/test",
      "/api/v1/audit-sinks/{id}/test",
    ]) {
      const probe = operation(document, "post", path);
      assertPolicy(probe, ["audit:configure_sinks"], "admin");
      assert.equal(
        probe.responses["200"].content["application/json"].schema.$ref,
        "#/components/schemas/AuditSinkTestReceipt",
      );
      assert.ok(probe.responses["502"]);
    }
  }
});

test("subscriber identity reads and writes preserve parent/address revisions and category-correct paging", () => {
  for (const document of documents) {
    const consents = operation(
      document,
      "get",
      "/api/v1/subscribers/{id}/channel-consents",
    );
    assertPolicy(consents, ["read:subscribers"], "viewer");
    assert.equal(
      consents.responses["200"].headers.ETag.$ref,
      "#/components/headers/SubscriberParentStrongETag",
    );
    assert.equal(
      consents.responses["200"].content["application/json"].schema.$ref,
      "#/components/schemas/SubscriberChannelConsentListResponse",
    );
    assert.deepEqual(
      document.components.schemas.SubscriberChannelConsentListResponse.required,
      ["items", "subscriber_version"],
    );
    assert.match(
      document.components.headers.SubscriberParentStrongETag.description,
      /byte-for-byte equal.*subscriber_version/iu,
    );

    const addEmail = operation(
      document,
      "post",
      "/api/v1/subscribers/{id}/emails",
    );
    assertPolicy(addEmail, ["write:subscribers"], "editor");
    assert.equal(addEmail["x-postwave-max-body-bytes"], 512 * 1024);
    assert.ok(
      addEmail.parameters.some(
        (parameter) =>
          parameter.$ref ===
          "#/components/parameters/SubscriberParentIfMatch",
      ),
    );
    assert.equal(
      document.components.parameters.SubscriberParentIfMatch.required,
      true,
    );
    assert.match(
      document.components.parameters.SubscriberParentIfMatch.schema.$ref,
      /SubscriberParentVersion$/u,
    );
    assert.ok(addEmail.responses["412"]);
    assert.ok(addEmail.responses["428"]);
    assert.equal(
      addEmail.responses["201"].headers.ETag.$ref,
      "#/components/headers/SubscriberEmailStrongETag",
    );
    assert.equal(
      addEmail.requestBody.content["application/json"].schema.$ref,
      "#/components/schemas/SubscriberEmailAddInput",
    );
    const addEmailInput =
      document.components.schemas.SubscriberEmailAddInput;
    assert.equal(Object.hasOwn(addEmailInput.properties, "link_version"), false);
    assert.equal(addEmailInput.oneOf.length, 2);
    assert.ok(
      addEmailInput.oneOf[0].required.includes("policy_version"),
    );
    assert.ok(
      document.components.schemas.SubscriberEmail.required.includes("version"),
    );

    const timeline = operation(
      document,
      "get",
      "/api/v1/subscribers/{id}/timeline",
    );
    assertPolicy(timeline, ["read:subscribers"], "viewer");
    const category = timeline.parameters.find(
      (parameter) => parameter.name === "category",
    );
    assert.deepEqual(category.schema.enum, [
      "all",
      "engagement",
      "delivery",
      "consent",
      "profile",
    ]);
    assert.match(
      timeline.description,
      /filtering happens before cursor evaluation,\s*limit/iu,
    );
    assert.equal(
      timeline.responses["200"].content["application/json"].schema.$ref,
      "#/components/schemas/SubscriberTimeline",
    );
    assert.equal(
      document.components.schemas.SubscriberTimelineStats.properties
        .engagement_daily_30d.minItems,
      30,
    );

    const suppress = operation(
      document,
      "post",
      "/api/v1/subscribers/{id}/suppress",
    );
    assertPolicy(suppress, ["write:subscribers"], "editor");
    assert.ok(
      suppress.parameters.some(
        (parameter) =>
          parameter.$ref ===
          "#/components/parameters/SubscriberParentIfMatch",
      ),
    );
    assert.ok(suppress.responses["412"]);
    assert.ok(suppress.responses["428"]);
    assert.equal(
      suppress.responses["204"].headers.ETag.$ref,
      "#/components/headers/SubscriberParentStrongETag",
    );

    const unsuppress = operation(
      document,
      "delete",
      "/api/v1/deliverability/suppressions/{email}",
    );
    assertPolicy(unsuppress, ["admin"], "admin");
    assert.equal(
      unsuppress.responses["200"].content["application/json"].schema.$ref,
      "#/components/schemas/DeliverabilitySuppressionRemoveResult",
    );
    assert.equal(
      document.components.schemas.DeliverabilitySuppressionRemoveResult
        .properties.subscriber_status_changed.const,
      false,
    );

    const account = operation(
      document,
      "patch",
      "/api/v1/subscribers/{id}/account",
    );
    assertPolicy(account, ["write:subscribers"], "editor");
    assert.equal(account["x-postwave-max-body-bytes"], 512 * 1024);
    assert.ok(
      account.parameters.some(
        (parameter) =>
          parameter.$ref ===
          "#/components/parameters/SubscriberParentIfMatch",
      ),
    );
    assert.ok(account.responses["412"]);
    assert.ok(account.responses["428"]);

    const federationList = operation(
      document,
      "get",
      "/api/v1/subscribers/{id}/federated-links",
    );
    assertPolicy(federationList, ["read:subscribers"], "viewer");
    assert.equal(
      federationList.responses["200"].headers.ETag.$ref,
      "#/components/headers/SubscriberParentStrongETag",
    );
    assert.deepEqual(
      document.components.schemas.FederationLinksPage.required,
      ["items", "subscriber_version"],
    );

    const federationCreate = operation(
      document,
      "post",
      "/api/v1/subscribers/{id}/federated-links",
    );
    assertPolicy(federationCreate, ["write:subscribers"], "editor");
    assert.ok(
      federationCreate.parameters.some(
        (parameter) =>
          parameter.$ref ===
          "#/components/parameters/FederationChildIfMatch",
      ),
    );
    assert.ok(federationCreate.responses["412"]);
    assert.ok(federationCreate.responses["422"]);
    assert.ok(federationCreate.responses["428"]);
    assert.equal(
      federationCreate.responses["201"].headers.ETag.$ref,
      "#/components/headers/SubscriberParentStrongETag",
    );
    assert.equal(
      federationCreate.responses["201"].content["application/json"].schema
        .$ref,
      "#/components/schemas/FederationLinkMutationResult",
    );

    const federationDelete = operation(
      document,
      "delete",
      "/api/v1/subscribers/{id}/federated-links/{parent_subscriber_id}",
    );
    assertPolicy(federationDelete, ["write:subscribers"], "editor");
    assert.ok(federationDelete.responses["412"]);
    assert.ok(federationDelete.responses["428"]);
    assert.deepEqual(
      document.components.schemas.FederationDeleteResult.required,
      ["deleted", "subscriber_version"],
    );

    for (const [method, path, scopes, role] of [
      ["patch", "/api/v1/subscribers/{id}", ["write:subscribers"], "editor"],
      ["delete", "/api/v1/subscribers/{id}", ["write:subscribers"], "editor"],
      ["post", "/api/v1/subscribers/{id}/aliases", ["write:subscribers"], "editor"],
      ["delete", "/api/v1/subscribers/{id}/aliases/{alias_id}", ["write:subscribers"], "editor"],
      ["patch", "/api/v1/subscribers/{id}/emails/{email_id}", ["write:subscribers"], "editor"],
      ["delete", "/api/v1/subscribers/{id}/emails/{email_id}", ["write:subscribers"], "editor"],
      ["patch", "/api/v1/subscribers/{id}/channel-consents/{channel}", ["write:subscribers"], "editor"],
      ["put", "/api/v1/subscribers/{id}/lifecycle", ["write:subscribers"], "editor"],
      ["post", "/api/v1/accounts", ["write:subscribers"], "editor"],
      ["post", "/api/v1/merge/apply", ["write:subscribers"], "editor"],
    ]) {
      const candidate = operation(document, method, path);
      assertPolicy(candidate, scopes, role);
      assert.match(candidate.description, /step-up/iu);
      assert.ok(candidate.responses["401"]);
    }

    for (const method of ["patch", "delete"]) {
      const addressWrite = operation(
        document,
        method,
        "/api/v1/subscribers/{id}/emails/{email_id}",
      );
      assert.ok(
        addressWrite.parameters.some(
          (parameter) =>
            parameter.$ref ===
            "#/components/parameters/SubscriberEmailIfMatch",
        ),
      );
      assert.ok(addressWrite.responses["412"]);
      assert.ok(addressWrite.responses["428"]);
    }
  }
});

test("warehouse, reverse-ETL, and streaming contracts expose safe version-bound projections", () => {
  const reads = [
    ["get", "/api/v1/warehouse/providers"],
    ["get", "/api/v1/warehouse/connections"],
    ["get", "/api/v1/warehouse/connections/{id}"],
    ["get", "/api/v1/warehouse/connections/{id}/health"],
    ["get", "/api/v1/warehouse/connections/{id}/runs"],
    ["get", "/api/v1/warehouse/connections/{id}/streaming/runs"],
    ["get", "/api/v1/warehouse/connections/{id}/reverse-etl-mappings"],
    ["get", "/api/v1/warehouse/catalog"],
    ["get", "/api/v1/warehouse/connections/{id}/mappings"],
    ["get", "/api/v1/warehouse/runs"],
    ["get", "/api/v1/warehouse/runs/{id}"],
  ];
  const writes = [
    ["post", "/api/v1/warehouse/connections"],
    ["delete", "/api/v1/warehouse/connections/{id}"],
    ["post", "/api/v1/warehouse/connections/{id}/provider-cleanup/acknowledge"],
    ["post", "/api/v1/warehouse/connections/{id}/runs"],
    ["post", "/api/v1/warehouse/connections/{id}/pause"],
    ["post", "/api/v1/warehouse/streaming/validate"],
    ["post", "/api/v1/warehouse/connections/{id}/streaming/ship"],
    ["post", "/api/v1/warehouse/connections/{id}/reverse-etl-mappings"],
    ["delete", "/api/v1/warehouse/connections/{id}/reverse-etl-mappings/{mapping_id}"],
    ["post", "/api/v1/warehouse/connections/{id}/reverse-etl-sync"],
    ["put", "/api/v1/warehouse/connections/{id}/mappings/{source_object}"],
    ["post", "/api/v1/warehouse/runs/due"],
    ["get", "/api/v1/warehouse/runs/{id}/errors"],
    ["post", "/api/v1/warehouse/validate"],
  ];

  for (const document of documents) {
    for (const [method, path] of reads) {
      assertPolicy(operation(document, method, path), ["read:reports"], "viewer");
    }
    for (const [method, path] of writes) {
      assertPolicy(operation(document, method, path), ["admin"], "admin");
    }

    const connection = document.components.schemas.WarehouseNativeConnection;
    for (const field of [
      "version",
      "credential_ref_present",
      "issue_present",
    ]) {
      assert.ok(connection.required.includes(field));
    }
    for (const leaked of ["credentials_ref", "last_cursor", "error"]) {
      assert.equal(Object.hasOwn(connection.properties, leaked), false);
    }
    assert.equal(
      document.components.schemas.WarehouseStreamingConfig.additionalProperties,
      false,
    );
    assert.deepEqual(
      Object.keys(
        document.components.schemas.WarehouseStreamingConfig.properties,
      ).sort(),
      ["batch_size", "compression", "field_filters", "format", "prefix"],
    );

    const pause = operation(
      document,
      "post",
      "/api/v1/warehouse/connections/{id}/pause",
    );
    assert.equal(
      pause.requestBody.content["application/json"].schema.$ref,
      "#/components/schemas/WarehouseConnectionMutationInput",
    );
    assert.ok(pause.responses["412"]);

    const remove = operation(
      document,
      "delete",
      "/api/v1/warehouse/connections/{id}",
    );
    assert.ok(remove.responses["200"]);
    assert.equal(remove.responses["204"], undefined);
    assert.deepEqual(
      document.components.schemas.WarehouseConnectionDeleteInput.required,
      ["expected_version", "confirmation_name"],
    );

    const nativeRun = document.components.schemas.WarehouseNativeRun;
    assert.ok(nativeRun.required.includes("issue_present"));
    for (const leaked of [
      "input_uri",
      "output_uri",
      "cursor_from",
      "cursor_to",
      "metrics",
      "error",
    ]) {
      assert.equal(Object.hasOwn(nativeRun.properties, leaked), false);
    }
    const rowError = document.components.schemas.WarehouseRowErrorEvidence;
    assert.ok(rowError.required.includes("message_present"));
    assert.equal(Object.hasOwn(rowError.properties, "error_message"), false);
    assert.equal(Object.hasOwn(rowError.properties, "raw_row"), false);

    const ship = operation(
      document,
      "post",
      "/api/v1/warehouse/connections/{id}/streaming/ship",
    );
    assert.ok(ship.responses["200"]);
    assert.equal(ship.responses["202"], undefined);
    assert.ok(ship.responses["412"]);
    assert.deepEqual(
      document.components.schemas.WarehouseStreamingRun.required.filter(
        (field) => ["cursor_from", "cursor_to", "has_more", "issue_present"].includes(field),
      ),
      ["cursor_from", "cursor_to", "has_more", "issue_present"],
    );
    assert.equal(
      Object.hasOwn(
        document.components.schemas.WarehouseStreamingRun.properties,
        "object_uri",
      ),
      false,
    );
  }
});

test("asset, saved-block, and reference-collection mutations are closed and version-bound", () => {
  for (const document of documents) {
    const asset = document.components.schemas.Asset;
    for (const field of ["tenantId", "updatedAt", "version"]) {
      assert.ok(asset.required.includes(field));
    }
    assert.equal(asset.properties.version.minimum, 1);

    const upload = operation(document, "post", "/api/v1/assets");
    assertPolicy(upload, ["write:campaigns"], "editor");
    assert.ok(upload.responses["428"]);
    assert.equal(
      upload.requestBody.content["application/json"].schema.$ref,
      "#/components/schemas/AssetJSONUploadInput",
    );
    assert.equal(
      document.components.schemas.AssetJSONUploadInput.properties.expected_version.const,
      0,
    );
    assert.ok(
      upload.requestBody.content["multipart/form-data"].schema.required.includes(
        "expected_version",
      ),
    );

    const assetPatch = operation(document, "patch", "/api/v1/assets/{id}");
    assertPolicy(assetPatch, ["write:campaigns"], "editor");
    assert.deepEqual(
      assetPatch.requestBody.content["application/json"].schema.required,
      ["alt_text", "expected_version"],
    );
    assert.equal(
      assetPatch.requestBody.content["application/json"].schema.additionalProperties,
      false,
    );
    assert.ok(assetPatch.responses["412"]);

    const assetDelete = operation(document, "delete", "/api/v1/assets/{id}");
    assert.equal(assetDelete.parameters, undefined);
    assert.equal(
      assetDelete.requestBody.content["application/json"].schema.$ref,
      "#/components/schemas/AssetDeleteInput",
    );
    assert.ok(assetDelete.responses["409"]);
    assert.ok(assetDelete.responses["412"]);
    assert.equal(
      document.components.schemas.AssetReferenceConflict.properties.error.required.includes(
        "version",
      ),
      true,
    );

    const bulk = document.components.schemas.AssetBulkDeleteInput;
    assert.deepEqual(bulk.required, ["items"]);
    assert.equal(bulk.properties.items.maxItems, 1000);
    assert.deepEqual(
      bulk.properties.items.items.required,
      ["id", "expected_version"],
    );
    assert.ok(
      document.components.schemas.AssetBulkDeleteFailure.properties.reason.enum.includes(
        "stale_version",
      ),
    );
    assert.ok(
      document.components.schemas.AssetBulkDeleteResponse.required.includes(
        "receipts",
      ),
    );

    const tagList = operation(document, "get", "/api/v1/assets/{id}/tags");
    assertPolicy(tagList, ["read:campaigns"], "viewer");
    assert.deepEqual(
      document.components.schemas.AssetTagListResponse.required,
      ["tags", "version"],
    );
    assert.equal(
      document.components.schemas.AssetFolderMoveInput.properties.folder_id.oneOf.some(
        (branch) => branch.const === "",
      ),
      false,
    );

    const savedList = operation(document, "get", "/api/v1/blocks/saved");
    assertPolicy(savedList, ["read:campaigns"], "viewer");
    assert.equal(
      savedList.responses["200"].content["application/json"].schema.$ref,
      "#/components/schemas/SavedBlockPage",
    );
    const savedGet = operation(document, "get", "/api/v1/blocks/saved/{id}");
    assertPolicy(savedGet, ["write:campaigns"], "editor");
    const savedDelete = operation(
      document,
      "delete",
      "/api/v1/blocks/saved/{id}",
    );
    assert.ok(savedDelete.responses["412"]);
    assert.ok(savedDelete.responses["428"]);
    assert.ok(document.components.schemas.SavedBlock.required.includes("version"));

    const collectionList = operation(document, "get", "/api/v1/collections");
    assertPolicy(collectionList, ["read:subscribers"], "viewer");
    const collectionGet = operation(
      document,
      "get",
      "/api/v1/collections/{id}",
    );
    assertPolicy(collectionGet, ["write:subscribers"], "editor");
    assert.ok(
      document.components.schemas.ReferenceCollection.required.includes(
        "version",
      ),
    );
    assert.ok(
      document.components.schemas.ReferenceCollectionSummary.required.includes(
        "version",
      ),
    );
    assert.equal(
      Object.hasOwn(
        document.components.schemas.ReferenceCollectionSummary.properties,
        "item_count",
      ),
      false,
    );
    const collectionDelete = operation(
      document,
      "delete",
      "/api/v1/collections/{id}",
    );
    assert.ok(collectionDelete.responses["412"]);
    assert.ok(collectionDelete.responses["428"]);
  }
});

test("route authority agrees with the newly explicit control-plane policies", () => {
  const cases = [
    [
      "POST",
      "/api/v1/custom-objects/types/{id}/records/search",
      "viewer",
      ["read:reports"],
      "any",
    ],
    [
      "POST",
      "/api/v1/audience-destinations/{id}/sync",
      "editor",
      ["write:subscribers"],
      "any",
    ],
    ["POST", "/api/v1/sms/conversations/bulk", "admin", ["admin"], "any"],
    ["GET", "/api/v1/audit-alerts", "viewer", ["audit:read"], "any"],
    [
      "GET",
      "/api/v1/audit-sinks",
      "admin",
      ["audit:configure_sinks"],
      "any",
    ],
    [
      "POST",
      "/api/v1/audit/export-async",
      "admin",
      ["audit:read", "audit:read_pii", "audit:execute_actions"],
      "all",
    ],
    [
      "GET",
      "/api/v1/subscribers/{id}/channel-consents",
      "viewer",
      ["read:subscribers"],
      "any",
    ],
    [
      "POST",
      "/api/v1/subscribers/{id}/emails",
      "editor",
      ["write:subscribers"],
      "any",
    ],
    [
      "GET",
      "/api/v1/subscribers/{id}/timeline",
      "viewer",
      ["read:subscribers"],
      "any",
    ],
    [
      "POST",
      "/api/v1/subscribers/{id}/suppress",
      "editor",
      ["write:subscribers"],
      "any",
    ],
    [
      "PATCH",
      "/api/v1/subscribers/{id}/account",
      "editor",
      ["write:subscribers"],
      "any",
    ],
    [
      "GET",
      "/api/v1/subscribers/{id}/federated-links",
      "viewer",
      ["read:subscribers"],
      "any",
    ],
    [
      "POST",
      "/api/v1/subscribers/{id}/federated-links",
      "editor",
      ["write:subscribers"],
      "any",
    ],
    [
      "DELETE",
      "/api/v1/subscribers/{id}/federated-links/{parent_subscriber_id}",
      "editor",
      ["write:subscribers"],
      "any",
    ],
    [
      "PATCH",
      "/api/v1/subscribers/{id}/emails/{email_id}",
      "editor",
      ["write:subscribers"],
      "any",
    ],
    [
      "PATCH",
      "/api/v1/subscribers/{id}/channel-consents/{channel}",
      "editor",
      ["write:subscribers"],
      "any",
    ],
    [
      "PUT",
      "/api/v1/subscribers/{id}/lifecycle",
      "editor",
      ["write:subscribers"],
      "any",
    ],
    [
      "POST",
      "/api/v1/merge/apply",
      "editor",
      ["write:subscribers"],
      "any",
    ],
    [
      "POST",
      "/api/v1/warehouse/connections/{id}/pause",
      "admin",
      ["admin"],
      "any",
    ],
    [
      "POST",
      "/api/v1/warehouse/connections/{id}/streaming/ship",
      "admin",
      ["admin"],
      "any",
    ],
    [
      "DELETE",
      "/api/v1/assets/{id}",
      "editor",
      ["write:campaigns"],
      "any",
    ],
    [
      "GET",
      "/api/v1/blocks/saved/{id}",
      "editor",
      ["write:campaigns"],
      "any",
    ],
    [
      "DELETE",
      "/api/v1/collections/{id}",
      "editor",
      ["write:subscribers"],
      "any",
    ],
  ];
  for (const [method, path, role, scopes, scopeMode] of cases) {
    const route = manifestRoute(method, path);
    assert.equal(route.exposure, "authenticated");
    assert.deepEqual(route.auth_methods, ["session", "api_key"]);
    assert.equal(route.session_minimum_role, role);
    assert.deepEqual(route.api_key_scopes, scopes);
    assert.equal(route.api_key_scope_mode, scopeMode);
    assert.equal(route.review_status, "reviewed");
  }

  const inbound = manifestRoute(
    "POST",
    "/api/v1/audit-alerts/inbound-webhook",
  );
  assert.equal(inbound.exposure, "credentialed");
  assert.deepEqual(inbound.auth_methods, [
    "openapi_security:auditAlertInboundBearer",
  ]);
  assert.equal(inbound.session_minimum_role, "not_applicable");
});

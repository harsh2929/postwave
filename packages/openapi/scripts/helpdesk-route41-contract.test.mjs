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

const heldHelpdeskPosts = new Map([
  ["/api/v1/service-suite/agent/draft-reply", "customer_agent_draft_write_held"],
  ["/api/v1/service-suite/channels", "helpdesk_channel_create_held"],
  ["/api/v1/service-suite/conversations", "helpdesk_conversation_create_held"],
  ["/api/v1/service-suite/conversations/{id}/messages", "helpdesk_delivery_unavailable"],
  ["/api/v1/service-suite/macros", "helpdesk_macro_create_held"],
  ["/api/v1/service-suite/macros/{id}/use", "macro_usage_evidence_unavailable"],
  ["/api/v1/service-suite/spam-assessments", "spam_assessment_write_held"],
  ["/api/v1/service-suite/tickets", "helpdesk_ticket_create_held"],
  ["/api/v1/service-suite/views", "helpdesk_view_create_held"],
]);

const heldSupportEffects = [
  ["post", "/api/v1/support-integrations"],
  ["delete", "/api/v1/support-integrations/{id}"],
  ["post", "/api/v1/support-integrations/{id}/sync"],
  ["post", "/api/v1/support-integrations/{id}/backfill"],
  ["post", "/api/v1/support-integrations/{id}/ingest"],
  ["post", "/api/v1/support-integrations/{id}/pause"],
  ["get", "/api/v1/support-integrations/{id}/runs"],
  ["get", "/api/v1/support-integrations/webhook-ingest"],
  ["post", "/api/v1/support-integrations/webhook-ingest"],
  ["get", "/api/v1/support-integrations/webhook-ingest/providers"],
  ["post", "/api/v1/support-integrations/webhook-ingest/{id}/rotate"],
];

function assertExactAdmin(operation, label) {
  assert.deepEqual(operation["x-required-scopes"], ["admin"], `${label} scopes`);
  assert.equal(operation["x-required-role"], "admin", `${label} role`);
  assert.deepEqual(
    operation.security,
    [{ bearerAuth: [] }, { sessionCookie: [] }],
    `${label} auth methods`,
  );
}

test("Route41 Helpdesk and support contracts are exhaustive and truthfully held", () => {
  for (const document of documents) {
    const catalog = document.components.schemas.ServiceSuiteCatalog;
    const catalogKeys = [
      "agent_run_types",
      "capabilities",
      "channels",
      "conversation_statuses",
      "guardrail",
      "provenance",
      "schema_version",
    ];
    assert.deepEqual(Object.keys(catalog.properties).sort(), catalogKeys);
    assert.deepEqual([...catalog.required].sort(), catalogKeys);

    const serviceOperations = Object.entries(document.paths)
      .filter(([path]) => path.startsWith("/api/v1/service-suite/"))
      .flatMap(([path, item]) =>
        Object.entries(item)
          .filter(([method]) => ["get", "post", "put", "patch", "delete"].includes(method))
          .map(([method, operation]) => [method, path, operation]),
      );
    assert.equal(serviceOperations.length, 29, "full service-suite operation family must be published");
    for (const [method, path, operation] of serviceOperations) {
      if (method === "get" && path === "/api/v1/service-suite/catalog") {
        assert.deepEqual(operation["x-required-scopes"], ["read:reports"]);
        assert.equal(operation["x-required-role"], "viewer");
      } else {
        assertExactAdmin(operation, `${method.toUpperCase()} ${path}`);
      }
    }

    for (const [path, code] of heldHelpdeskPosts) {
      const operation = document.paths[path]?.post;
      assert.ok(operation, `${path} POST missing`);
      assert.equal(Object.hasOwn(operation, "requestBody"), false, `${path} must not invite a body`);
      assert.deepEqual(Object.keys(operation.responses), ["409"], `${path} success response leaked`);
      assert.match(operation.description, new RegExp(`\\b${code}\\b`, "u"));
    }

    const note = document.paths["/api/v1/service-suite/conversations/{id}/internal-notes"]?.post;
    assert.ok(note, "typed internal-note route missing");
    assertExactAdmin(note, "typed internal note");
    assert.deepEqual(Object.keys(note.requestBody.content["application/json"].schema), ["$ref"]);
    assert.equal(note.requestBody.content["application/json"].schema.$ref, "#/components/schemas/HelpdeskInternalNoteRequest");
    assert.deepEqual(Object.keys(document.components.schemas.HelpdeskInternalNoteRequest.properties), ["body_text"]);
    assert.match(note.description, /does\s+\*\*not\*\* certify complete Helpdesk SAR/u);
    assert.deepEqual(Object.keys(note.responses).sort(), ["200", "201", "400", "409", "410", "503"]);

    for (const [method, path] of heldSupportEffects) {
      const operation = document.paths[path]?.[method];
      assert.ok(operation, `${method.toUpperCase()} ${path} missing`);
      assertExactAdmin(operation, `${method.toUpperCase()} ${path}`);
      assert.equal(Object.hasOwn(operation, "requestBody"), false, `${path} must not read/invite a body`);
      assert.deepEqual(Object.keys(operation.responses), ["503"], `${path} must expose only runtime hold`);
      assert.match(operation.description, /support_integration_runtime_held/u);
    }

    const publicSupportOperations = Object.entries(document.paths)
      .filter(([path]) => path.startsWith("/api/public/support-integrations/"))
      .flatMap(([path, item]) =>
        Object.entries(item)
          .filter(([method]) => ["get", "post", "put", "patch", "delete"].includes(method))
          .map(([method, operation]) => [method, path, operation]),
      );
    assert.equal(publicSupportOperations.length, 35, "all historical support callback shapes must remain visibly held");
    for (const [method, path, operation] of publicSupportOperations) {
      assert.equal(method, "post", `${path} unexpected method`);
      assert.deepEqual(operation.security, [], `${path} is a pre-auth hold`);
      assert.equal(operation["x-postwave-release-hold"], "support_provider_ingress_held");
      assert.equal(Object.hasOwn(operation, "requestBody"), false, `${path} must not invite a body`);
      assert.deepEqual(Object.keys(operation.responses), ["503"]);
      assert.match(operation.description, /edge\/ALB path logging is proven scrubbed/u);
    }

    const supportProjection = document.components.schemas.SupportIntegrationProjection;
    for (const forbidden of ["credentials_ref", "settings", "sync_cursor", "last_sync_at", "error_message", "external_id", "runs"]) {
      assert.equal(Object.hasOwn(supportProjection.properties, forbidden), false, `support projection leaked ${forbidden}`);
    }
    assert.equal(supportProjection.properties.runtime_status.const, "held");
    assert.match(supportProjection.properties.provider.description, /long-tail slug absent from the current static provider/u);
    assert.equal(document.components.schemas.SupportProviderSpec.properties.runtime_status.const, "held");
    assert.match(document.components.schemas.SupportProviderListResponse.description, /does not claim to enumerate every/u);

    const report = document.components.schemas.HelpdeskSupportReport;
    assert.ok(report.properties.window_created_conversations_by_status);
    assert.ok(report.properties.tickets.properties.window_created_open);
    assert.ok(report.properties.tickets.properties.window_created_overdue_due_date);
    for (const stale of ["conversations_by_status", "open_backlog", "sla_breached", "resolved"]) {
      assert.equal(Object.hasOwn(report.properties, stale), false, `stale report claim ${stale}`);
      assert.equal(Object.hasOwn(report.properties.tickets.properties, stale), false, `stale ticket report claim ${stale}`);
    }
  }
});

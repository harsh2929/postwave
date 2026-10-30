// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

const CANONICAL_EVENTS = [
  "campaign.sent",
  "subscriber.added",
  "subscriber.removed",
  "subscriber.unsubscribed",
  "approval.requested",
  "approval.decided",
  "audit.created",
  "bounce.received",
  "list_health.degraded",
  "list.subscriber.added",
  "email.bounced",
  "email.complained",
  "email.delivered",
  "assurance.run.completed",
  "assurance.run.blocked",
];

function quotedValues(block) {
  return [...block.matchAll(/["']([^"']+)["']/gu)].map((match) => match[1]);
}

function expectPrivateResponses(operation) {
  for (const [status, response] of Object.entries(operation.responses)) {
    assert.equal(
      response.headers?.["Cache-Control"]?.$ref,
      "#/components/headers/OutboundWebhookPlaygroundPrivateNoStore",
      `${operation.operationId} ${status} must document the private no-store boundary`,
    );
  }
}

test("OpenAPI and embedded mirror publish one complete playground contract", () => {
  const published = JSON.parse(read("packages/openapi/openapi.json"));
  const embedded = JSON.parse(read("apps/api/internal/apidocs/openapi.json"));
  assert.deepEqual(embedded, published);
  assert.deepEqual(
    published.components.schemas.OutboundWebhookEventType.enum,
    CANONICAL_EVENTS,
  );

  const fire =
    published.paths["/api/v1/outbound-webhooks/{id}/playground/fire"].post;
  assert.deepEqual(fire["x-required-scopes"], ["admin"]);
  assert.equal(
    fire["x-postwave-client-boundary"],
    "admin-interactive-live-diagnostic",
  );
  assert.equal(
    fire.parameters[0].$ref,
    "#/components/parameters/OutboundWebhookPlaygroundIdempotencyKey",
  );
  assert.equal(
    fire.requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/OutboundWebhookPlaygroundFireInput",
  );
  assert.deepEqual(Object.keys(fire.responses).sort(), [
    "200",
    "400",
    "401",
    "403",
    "404",
    "409",
    "410",
    "413",
    "415",
    "422",
    "426",
    "429",
    "500",
    "503",
  ]);
  expectPrivateResponses(fire);
  assert.deepEqual(Object.keys(fire.responses["200"].headers).sort(), [
    "Cache-Control",
    "Idempotent-Replayed",
    "Pragma",
    "Vary",
    "X-Content-Type-Options",
  ]);
  assert.equal(
    fire.responses["200"].headers["Idempotent-Replayed"].$ref,
    "#/components/headers/OutboundWebhookPlaygroundIdempotencyReplayed",
  );

  const fireInput =
    published.components.schemas.OutboundWebhookPlaygroundFireInput;
  assert.deepEqual(fireInput.required, [
    "fire_id",
    "event_type",
    "expected_webhook_config_version",
  ]);
  assert.equal(fire["x-postwave-max-body-bytes"], 524288);
  assert.equal(fire["x-postwave-max-response-body-bytes"], 4096);
  assert.equal(fire["x-postwave-reject-duplicate-json-members"], "recursive");
  assert.equal(fire["x-postwave-preserve-json-numbers"], true);
  assert.equal(
    fire["x-postwave-data-classification"],
    "potentially-personal-arbitrary-content",
  );
  assert.equal(
    fire["x-postwave-retention-boundary"],
    "tenant-webhook-delivery-retention",
  );
  const normalizedFireDescription = fire.description.replace(/\s+/gu, " ");
  for (const disclosure of [
    "Use synthetic data only",
    "envelope-encrypted private",
    "newest 100 matches, includes no aliases, and has no continuation",
    "public erasure path remains disabled by the repository-wide coverage gate",
    "Names, phone numbers, or other identifiers without that email are not discoverable",
    "Retention cryptoshredding removes the receipt ciphertext, receipt digest, and email locators",
    "Access-bundle JSONB copies are outside this receipt lifecycle",
    "permanent payload-free control row retains",
    "no-redispatch fence",
  ]) {
    assert.ok(
      normalizedFireDescription.includes(disclosure),
      `playground privacy/retention description omits ${disclosure}`,
    );
  }
  assert.deepEqual(fire["x-postwave-response-limits"], {
    "inspectable-url-utf8-bytes": 2048,
    "inspectable-header-count": 128,
    "inspectable-header-name-utf8-bytes": 256,
    "inspectable-header-value-utf8-bytes": 4096,
    "inspectable-body-json-bytes": 524288,
    "signature-utf8-bytes": 4096,
    "receiver-response-utf8-bytes": 4096,
    "inspection-error-utf8-bytes": 4096,
    "error-envelope-code-utf8-bytes": 128,
    "error-envelope-message-utf8-bytes": 512,
  });
  assert.equal(
    fireInput.properties.expected_webhook_config_version.format,
    "int64",
  );
  assert.equal(fireInput.properties.expected_webhook_config_version.minimum, 1);
  assert.equal(
    fireInput.properties.expected_webhook_config_version.maximum,
    9007199254740991,
  );
  assert.equal(
    fireInput.properties.payload["x-postwave-max-canonical-json-bytes"],
    262144,
  );
  assert.equal(fireInput.properties.payload["x-postwave-max-depth"], 24);
  assert.ok(
    fireInput.properties.payload.description.includes(
      "Use synthetic data only",
    ),
  );
  const canonicalUuidPattern =
    "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
  assert.equal(fireInput.properties.fire_id.pattern, canonicalUuidPattern);
  assert.equal(
    published.paths["/api/v1/outbound-webhooks/{id}/playground/fire"]
      .parameters[0].schema.pattern,
    canonicalUuidPattern,
  );
  const fireResponse =
    published.components.schemas.OutboundWebhookPlaygroundFireResponse;
  for (const field of [
    "fire_id",
    "event_id",
    "delivery_id",
    "outcome",
    "ambiguous",
    "response_body_truncated",
  ]) {
    assert.ok(
      fireResponse.required.includes(field),
      `fire response requires ${field}`,
    );
  }
  assert.equal(fireResponse.properties.fire_id.pattern, canonicalUuidPattern);
  assert.equal(fireResponse.properties.event_id.pattern, canonicalUuidPattern);
  assert.equal(fireResponse.properties.url.maxLength, 2048);
  assert.equal(fireResponse.properties.headers.maxProperties, 128);
  assert.equal(fireResponse.properties.response_body.maxLength, 4096);
  assert.equal(fireResponse.properties.error.maxLength, 4096);

  const webhook = published.components.schemas.OutboundWebhook;
  assert.ok(webhook.required.includes("config_version"));
  assert.equal(webhook.properties.config_version.format, "int64");
  assert.equal(webhook.properties.config_version.minimum, 1);
  assert.equal(webhook.properties.config_version.maximum, 9007199254740991);

  const receipt =
    published.paths["/api/v1/outbound-webhooks/playground/fires/{fire_id}"].get;
  assert.deepEqual(receipt["x-required-scopes"], ["admin"]);
  assert.equal(
    receipt["x-postwave-client-boundary"],
    "admin-interactive-live-diagnostic",
  );
  assert.deepEqual(Object.keys(receipt.responses).sort(), [
    "200",
    "401",
    "403",
    "404",
    "500",
    "503",
  ]);
  assert.equal(
    published.paths["/api/v1/outbound-webhooks/playground/fires/{fire_id}"]
      .parameters[0].schema.pattern,
    canonicalUuidPattern,
  );
  expectPrivateResponses(receipt);
  assert.equal(
    receipt.responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/OutboundWebhookPlaygroundFireReceipt",
  );
  const receiptSchema =
    published.components.schemas.OutboundWebhookPlaygroundFireReceipt;
  assert.equal(receiptSchema.properties.fire_id.pattern, canonicalUuidPattern);
  assert.equal(
    receiptSchema.properties.webhook_id.pattern,
    canonicalUuidPattern,
  );

  const catalog =
    published.paths["/api/v1/outbound-webhooks/playground/events"].get;
  assert.deepEqual(catalog["x-required-scopes"], ["admin"]);
  expectPrivateResponses(catalog);
});

test("first-party SDK, MCP, mobile fallback, and docs share the canonical catalog", () => {
  const ts = read("packages/sdk-ts/src/types.ts");
  const tsBlock =
    /export const OUTBOUND_WEBHOOK_EVENT_TYPES = \[([\s\S]*?)\] as const;/u.exec(
      ts,
    );
  assert.ok(tsBlock, "TypeScript SDK runtime catalog missing");
  assert.deepEqual(quotedValues(tsBlock[1]), CANONICAL_EVENTS);

  const py = read("packages/sdk-py/postwave/types/webhooks.py");
  const pyBlock =
    /WebhookEventType = Literal\[([\s\S]*?)\]\nOUTBOUND_WEBHOOK_EVENT_TYPES/u.exec(
      py,
    );
  assert.ok(pyBlock, "Python SDK typed catalog missing");
  assert.deepEqual(quotedValues(pyBlock[1]), CANONICAL_EVENTS);

  const mobile = read("apps/mobile/src/lib/outboundWebhookForm.ts");
  const mobileBlock =
    /OUTBOUND_WEBHOOK_EVENT_FALLBACK[^=]*= \[([\s\S]*?)\];/u.exec(mobile);
  assert.ok(mobileBlock, "mobile fallback catalog missing");
  assert.deepEqual(quotedValues(mobileBlock[1]), CANONICAL_EVENTS);

  const mcp = read("packages/mcp-server/src/tools/admin.ts");
  const mcpBlock =
    /export const MCP_OUTBOUND_WEBHOOK_EVENT_TYPES = \[([\s\S]*?)\] as const;/u.exec(
      mcp,
    );
  assert.ok(mcpBlock, "MCP outbound validator catalog missing");
  assert.deepEqual(quotedValues(mcpBlock[1]), CANONICAL_EVENTS);
  assert.match(mcp, /z\.enum\(MCP_OUTBOUND_WEBHOOK_EVENT_TYPES\)/u);
  assert.doesNotMatch(mcp, /"subscriber\.created"/u);

  const docs = read("packages/openapi/README.md");
  const docsBlock =
    /The canonical outbound-webhook catalog is:\n\n```text\n([\s\S]*?)\n```/u.exec(
      docs,
    );
  assert.ok(docsBlock, "documented outbound catalog missing");
  assert.deepEqual(docsBlock[1].split("\n"), CANONICAL_EVENTS);
  assert.match(docs, /admin-only, live diagnostic/u);
  assert.match(docs, /do not wrap arbitrary custom-payload fire/u);
});

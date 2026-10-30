import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import YAML from "yaml";

const packageRoot = new URL("../", import.meta.url);
const spec = YAML.parse(
  readFileSync(new URL("openapi.yaml", packageRoot), "utf8"),
);
const routeAuthManifest = JSON.parse(
  readFileSync(
    new URL("../../apps/api/internal/routeauth/manifest.json", packageRoot),
    "utf8",
  ),
);

function resolveResponse(response) {
  if (!response?.$ref) return response;
  const prefix = "#/components/responses/";
  assert.ok(response.$ref.startsWith(prefix), response.$ref);
  return spec.components.responses[response.$ref.slice(prefix.length)];
}

const operations = [
  ["GET", "/api/v1/privacy/incidents", "200"],
  ["POST", "/api/v1/privacy/incidents", "201"],
  ["GET", "/api/v1/privacy/incidents/tabletops", "200"],
  ["POST", "/api/v1/privacy/incidents/tabletops", "201"],
  ["GET", "/api/v1/privacy/incidents/{incident_id}", "200"],
  ["GET", "/api/v1/privacy/incidents/{incident_id}/events", "200"],
  ["POST", "/api/v1/privacy/incidents/{incident_id}/notifications", "503"],
  ["GET", "/api/v1/privacy/incidents/{incident_id}/packet/{audience}", "503"],
  ["POST", "/api/v1/privacy/incidents/{incident_id}/signoff", "503"],
  ["POST", "/api/v1/privacy/incidents/{incident_id}/transition", "200"],
];

test("privacy incident operations are explicit admin-only contracts", () => {
  for (const [method, path, success] of operations) {
    const operation = spec.paths[path]?.[method.toLowerCase()];
    assert.ok(operation, `${method} ${path}`);
    assert.deepEqual(operation["x-required-scopes"], ["admin"]);
    assert.equal(operation["x-required-role"], "admin");
    assert.deepEqual(operation.security, [
      { bearerAuth: [] },
      { sessionCookie: [] },
    ]);
    assert.ok(operation.responses[success], `${method} ${path} ${success}`);
    assert.ok(operation.responses["401"], `${method} ${path} 401`);
    assert.ok(operation.responses["403"], `${method} ${path} 403`);
  }
});

test("release-held legal and delivery operations advertise no success response", () => {
  const held = [
    [
      "post",
      "/api/v1/privacy/incidents/{incident_id}/notifications",
      "incident_notification_release_hold",
      "notification evidence recording is unavailable until it is bound to a durable provider or regulator receipt; no change was committed",
    ],
    [
      "get",
      "/api/v1/privacy/incidents/{incident_id}/packet/{audience}",
      "incident_packet_release_hold",
      "authority packet generation is unavailable until every legal assertion is backed by verified incident evidence; no packet was generated",
    ],
    [
      "post",
      "/api/v1/privacy/incidents/{incident_id}/signoff",
      "counsel_signoff_release_hold",
      "counsel sign-off is unavailable until approval is bound to a distinct authenticated principal and durable verification receipt; no change was committed",
    ],
  ];
  for (const [method, path, code, message] of held) {
    const operation = spec.paths[path][method];
    assert.equal(operation.responses["200"], undefined);
    assert.equal(operation.responses["201"], undefined);
    assert.equal(operation.requestBody, undefined);
    assert.equal(
      operation.responses["503"].content["application/json"].example.error.code,
      code,
    );
    assert.equal(
      operation.responses["503"].content["application/json"].example.error
        .message,
      message,
    );
    assert.match(operation.description, /fails closed/iu);
  }

  const transition =
    spec.paths["/api/v1/privacy/incidents/{incident_id}/transition"].post;
  assert.ok(transition.responses["200"]);
  assert.equal(
    transition.responses["503"].content["application/json"].example.error.code,
    "incident_closure_release_hold",
  );
  assert.equal(
    transition.responses["503"].content["application/json"].example.error
      .message,
    "incident closure is unavailable until jurisdiction-specific notification decisions and authenticated delivery evidence are recorded; no change was committed",
  );
  assert.match(transition.description, /target is `closed`/u);
});

test("incident list and tabletop list expose bounded keyset pagination", () => {
  for (const path of [
    "/api/v1/privacy/incidents",
    "/api/v1/privacy/incidents/tabletops",
  ]) {
    const parameters = new Map(
      spec.paths[path].get.parameters.map((parameter) => [
        parameter.name,
        parameter,
      ]),
    );
    assert.equal(parameters.get("limit").schema.minimum, 1);
    assert.equal(parameters.get("limit").schema.maximum, 200);
    assert.equal(parameters.get("limit").schema.default, 200);
    assert.equal(
      parameters.get("cursor").description.includes("nextCursor"),
      true,
    );
    assert.ok(spec.paths[path].get.responses["400"]);
  }
  assert.equal(
    spec.components.schemas.PrivacyIncidentListResponse.properties.incidents
      .maxItems,
    200,
  );
  assert.equal(
    spec.components.schemas.PrivacyIncidentTabletopListResponse.properties
      .tabletops.maxItems,
    200,
  );
});

test("incident schemas preserve wire enums and provisional legal semantics", () => {
  assert.deepEqual(spec.components.schemas.PrivacyIncidentState.enum, [
    "open",
    "contained",
    "notifications_pending",
    "closed",
  ]);
  assert.deepEqual(spec.components.schemas.PrivacyIncidentSeverity.enum, [
    "investigating",
    "low",
    "medium",
    "high",
    "critical",
  ]);
  assert.deepEqual(spec.components.schemas.PrivacyIncidentAudience.enum, [
    "authority",
    "customer",
    "data_subject",
  ]);

  const reference =
    spec.components.schemas.PrivacyIncidentJurisdictionReference;
  assert.deepEqual(Object.keys(reference.properties), ["code", "name"]);
  assert.match(reference.description, /does not assert legal coverage/iu);

  const resolution =
    spec.components.schemas.PrivacyIncidentJurisdictionResolution;
  assert.equal(resolution.properties.status.const, "release_held");
  assert.equal(
    resolution.properties.release_hold_code.const,
    "jurisdiction_rules_release_hold",
  );
  for (const removed of [
    "matched",
    "deadline_seconds",
    "effective_deadline_at",
    "notify_authorities",
    "notify_consumer_reporting_agencies",
    "content_requirements",
  ]) {
    assert.equal(resolution.properties[removed], undefined, removed);
  }
  assert.equal(
    spec.components.schemas.PrivacyIncident.properties.affected_subject_count
      .minimum,
    0,
  );
  assert.equal(
    spec.components.schemas.PrivacyIncidentListItem.allOf[1].not.required[0],
    "jurisdiction_resolution",
  );
  assert.deepEqual(
    spec.components.schemas.PrivacyIncidentDetail.allOf[1].required,
    ["jurisdiction_resolution"],
  );
  assert.match(
    spec.components.schemas.PrivacyIncident.properties.notification_decisions
      .description,
    /not independently verified/iu,
  );
  const tokenPattern =
    "^[^\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u206f]*$";
  for (const schemaName of ["PrivacyIncident", "PrivacyIncidentCreateInput"]) {
    for (const field of [
      "affected_regions",
      "affected_data_categories",
      "jurisdictions",
    ]) {
      const schema = spec.components.schemas[schemaName].properties[field];
      assert.equal(schema.maxItems, 64, `${schemaName}.${field}`);
      assert.equal(schema.items.maxLength, 256, `${schemaName}.${field}`);
      assert.equal(
        schema.items.pattern,
        tokenPattern,
        `${schemaName}.${field}.items`,
      );
    }
  }
  for (const schemaName of [
    "PrivacyIncidentTabletopInput",
    "PrivacyIncidentTabletop",
  ]) {
    const tabletop = spec.components.schemas[schemaName];
    assert.equal(tabletop.properties.participants.items.pattern, tokenPattern);
    assert.equal(tabletop.properties.evidence_path.pattern, tokenPattern);
  }
  const tokenRegex = new RegExp(tokenPattern, "u");
  assert.equal(tokenRegex.test("incident-👩‍💻"), true, "ZWJ remains valid");
  assert.equal(tokenRegex.test("unsafe\u202etoken"), false);
  assert.equal(tokenRegex.test("unsafe\u0085token"), false);
  assert.equal(
    spec.components.schemas.PrivacyIncidentCreateInput.properties.summary
      .maxLength,
    4000,
  );
  const narrativePattern =
    "^[^\\u0000\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u206f]*$";
  for (const [schemaName, field] of [
    ["PrivacyIncident", "summary"],
    ["PrivacyIncidentCreateInput", "summary"],
    ["PrivacyIncidentTransitionInput", "reason"],
    ["PrivacyIncidentTransitionEvent", "reason"],
    ["PrivacyIncidentTabletopInput", "scenario"],
    ["PrivacyIncidentTabletopInput", "findings"],
    ["PrivacyIncidentTabletop", "scenario"],
    ["PrivacyIncidentTabletop", "findings"],
  ]) {
    assert.equal(
      spec.components.schemas[schemaName].properties[field].pattern,
      narrativePattern,
      `${schemaName}.${field}`,
    );
  }
  assert.deepEqual(
    spec.components.schemas.PrivacyIncidentCreateInput.properties.discovered_at
      .anyOf,
    [{ type: "string", format: "date-time" }, { type: "null" }],
  );
  assert.deepEqual(
    spec.components.schemas.PrivacyIncidentCreateInput.properties
      .affected_subject_count.anyOf,
    [{ type: "integer", minimum: 0, maximum: 2147483647 }, { type: "null" }],
  );
});

test("event response is a closed transition-or-notification union", () => {
  const event = spec.components.schemas.PrivacyIncidentEvent;
  assert.deepEqual(event.oneOf, [
    { $ref: "#/components/schemas/PrivacyIncidentTransitionEvent" },
    { $ref: "#/components/schemas/PrivacyIncidentNotificationEvent" },
  ]);
  assert.equal(
    spec.components.schemas.PrivacyIncidentTransitionEvent.additionalProperties,
    false,
  );
  for (const schemaName of [
    "PrivacyIncidentTransitionEvent",
    "PrivacyIncidentNotificationEvent",
  ]) {
    const schema = spec.components.schemas[schemaName];
    for (const required of ["event_id", "source", "schema_version"]) {
      assert.ok(
        schema.required.includes(required),
        `${schemaName}.${required}`,
      );
    }
    assert.equal(schema.properties.schema_version.const, 1);
  }
  assert.equal(
    spec.components.schemas.PrivacyIncidentNotificationEvent
      .additionalProperties,
    false,
  );
  assert.match(
    spec.components.schemas.PrivacyIncidentNotificationEvent.properties
      .body_sha256.description,
    /not a verified response digest or signature/iu,
  );
  const response = spec.components.schemas.PrivacyIncidentEventsResponse;
  assert.deepEqual(response.required, ["incident_id", "events"]);
  assert.equal(response.properties.incident_id.format, "uuid");
  assert.equal(
    spec.components.schemas.PrivacyIncidentTransitionEvent.properties.reason
      .maxLength,
    2000,
  );
  assert.equal(
    spec.components.schemas.PrivacyIncidentNotificationEvent.properties
      .body_sha256.pattern,
    "^[0-9a-fA-F]{64}$",
  );
  assert.match(
    spec.paths["/api/v1/privacy/incidents/{incident_id}/events"].get
      .description,
    /not a complete incident evidence record/iu,
  );
});

test("append and transition preconditions are explicit", () => {
  for (const path of [
    "/api/v1/privacy/incidents",
    "/api/v1/privacy/incidents/tabletops",
  ]) {
    const post = spec.paths[path].post;
    const key = post.parameters.find(
      (parameter) =>
        parameter.$ref ===
        "#/components/parameters/PrivacyIncidentIdempotencyKey",
    );
    assert.ok(key, `${path} Idempotency-Key`);
    assert.ok(post.responses["409"]);
    assert.ok(post.responses["422"]);
  }
  assert.equal(
    spec.components.parameters.PrivacyIncidentIdempotencyKey.required,
    true,
  );

  const transition =
    spec.paths["/api/v1/privacy/incidents/{incident_id}/transition"].post;
  assert.ok(
    spec.components.schemas.PrivacyIncidentTransitionInput.required.includes(
      "expected_from",
    ),
  );
  assert.equal(
    transition.responses["409"].content["application/json"].examples.staleState
      .value.error.code,
    "stale_incident_state",
  );
  assert.match(
    transition.description,
    /opaque resource revision is\s+not yet/iu,
  );
});

test("incident data and release holds are explicitly no-store", () => {
  assert.match(
    spec.components.headers.PrivacyIncidentCacheControl.description,
    /credential parsing[\s\S]*tenant\s+resolution[\s\S]*admin\s+authorization[\s\S]*idempotency refusals/iu,
  );
  assert.match(
    spec.components.headers.PrivacyIncidentCredentialVary.description,
    /pre-handler[\s\S]*authentication[\s\S]*authorization[\s\S]*idempotency refusals/iu,
  );
  for (const [method, path] of operations) {
    const responses = spec.paths[path][method.toLowerCase()].responses;
    for (const [status, unresolved] of Object.entries(responses)) {
      const response = resolveResponse(unresolved);
      assert.equal(
        response.headers["Cache-Control"].$ref,
        "#/components/headers/PrivacyIncidentCacheControl",
        `${method} ${path} ${status} Cache-Control`,
      );
      assert.equal(
        response.headers.Vary.$ref,
        "#/components/headers/PrivacyIncidentCredentialVary",
        `${method} ${path} ${status} Vary`,
      );
    }
  }
});

test("incident errors expose stable bounded-input and identity examples", () => {
  const badRequest = spec.components.responses.PrivacyIncidentBadRequest;
  assert.equal(
    badRequest.content["application/json"].examples.invalidIncidentId.value
      .error.code,
    "invalid_incident_id",
  );
  assert.equal(
    badRequest.content["application/json"].examples.invalidCursor.value.error
      .code,
    "invalid_cursor",
  );
  assert.equal(
    badRequest.content["application/json"].examples.idempotencyKeyRequired.value
      .error.code,
    "idempotency_key_required",
  );
});

test("generated route authorization preserves the admin boundary", () => {
  const policies = new Map(
    routeAuthManifest.routes
      .filter((route) => route.path.startsWith("/api/v1/privacy/incidents"))
      .map((route) => [`${route.method} ${route.path}`, route]),
  );
  assert.equal(policies.size, operations.length);
  for (const [method, path] of operations) {
    const policy = policies.get(`${method} ${path}`);
    assert.ok(policy, `${method} ${path}`);
    assert.equal(policy.exposure, "authenticated");
    assert.deepEqual(policy.auth_methods, ["session", "api_key"]);
    assert.equal(policy.session_minimum_role, "admin");
    assert.deepEqual(policy.api_key_scopes, ["admin"]);
    assert.equal(policy.api_key_scope_mode, "any");
    assert.equal(policy.policy_source, "openapi.x-required-scopes");
    assert.equal(policy.review_status, "reviewed");
  }
});

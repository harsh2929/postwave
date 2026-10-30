import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import YAML from "yaml";

const packageRoot = new URL("../", import.meta.url);
const spec = YAML.parse(
  readFileSync(new URL("openapi.yaml", packageRoot), "utf8"),
);
const reachability = JSON.parse(
  readFileSync(new URL("route-reachability.json", packageRoot), "utf8"),
);
const manifest = JSON.parse(
  readFileSync(
    new URL("../../apps/api/internal/routeauth/manifest.json", packageRoot),
    "utf8",
  ),
);
const main = readFileSync(
  new URL("../../apps/api/main.go", packageRoot),
  "utf8",
);

const collectionPath = "/api/v1/campaigns/{campaign}/vanity-paths";
const conversionPath = "/api/v1/vanity-visits/{reference}/conversion";
const evidencePath = "/api/v1/campaigns/{campaign}/direct-attribution-evidence";

test("mounted vanity routes have exact least-privilege OpenAPI contracts", () => {
  const list = spec.paths[collectionPath]?.get;
  const create = spec.paths[collectionPath]?.post;
  const conversion = spec.paths[conversionPath]?.post;
  assert.ok(list);
  assert.ok(create);
  assert.ok(conversion);

  assert.deepEqual(list.security, [{ bearerAuth: [] }, { sessionCookie: [] }]);
  assert.deepEqual(list["x-required-scopes"], ["read:campaigns"]);
  assert.equal(list["x-required-role"], "viewer");

  assert.deepEqual(create.security, [
    { bearerAuth: [] },
    { sessionCookie: [] },
  ]);
  assert.deepEqual(create["x-required-scopes"], ["write:campaigns"]);
  assert.equal(create["x-required-role"], "editor");

  assert.deepEqual(conversion.security, [{ bearerAuth: [] }]);
  assert.equal(conversion["x-required-auth-method"], "api_key");
  assert.deepEqual(conversion["x-required-scopes"], ["admin"]);
  assert.equal(conversion["x-required-role"], undefined);
  assert.match(
    conversion.description,
    /dashboard sessions, including owners, are rejected/u,
  );

  const evidence = spec.paths[evidencePath]?.get;
  assert.ok(evidence);
  assert.deepEqual(evidence.security, [
    { bearerAuth: [] },
    { sessionCookie: [] },
  ]);
  assert.deepEqual(evidence["x-required-scopes"], ["read:reports"]);
  assert.equal(evidence["x-required-role"], "viewer");
  assert.match(evidence.description, /readership_proven: false/u);
  assert.match(evidence.description, /does not add cents across/u);
  assert.match(
    evidence.responses["404"].description,
    /never returned as an empty register/u,
  );
});

test("vanity request and response schemas preserve campaign-only attribution", () => {
  for (const name of [
    "CampaignVanityPathCreateInput",
    "CampaignVanityPath",
    "CampaignVanityPathList",
    "CampaignVanityPathCreated",
    "VanityVisitConversionInput",
    "VanityVisitConversionReceipt",
  ]) {
    assert.equal(
      spec.components.schemas[name].additionalProperties,
      false,
      name,
    );
  }
  assert.equal(
    spec.components.schemas.CampaignVanityPathCreated.properties
      .attribution_scope.const,
    "campaign",
  );
  assert.equal(
    spec.components.schemas.VanityVisitConversionReceipt.properties
      .attributed_via.const,
    "campaign_vanity_path",
  );
  const email =
    spec.components.schemas.VanityVisitConversionInput.properties
      .customer_email;
  assert.equal(email.writeOnly, true);
  assert.match(email.description, /discarded without persistence/u);

  for (const name of [
    "CampaignDirectAttributionEvidenceSummary",
    "CampaignDirectAttributionEvidenceItem",
    "CampaignDirectAttributionEvidencePageInfo",
    "CampaignDirectAttributionEvidencePage",
  ]) {
    assert.equal(
      spec.components.schemas[name].additionalProperties,
      false,
      name,
    );
  }
  const evidenceItem =
    spec.components.schemas.CampaignDirectAttributionEvidenceItem;
  const evidenceSummary =
    spec.components.schemas.CampaignDirectAttributionEvidenceSummary;
  assert.equal(evidenceItem.properties.readership_proven.const, false);
  assert.deepEqual(evidenceItem.properties.attributed_via.enum, [
    "code_redemption",
    "campaign_vanity_path",
  ]);
  assert.deepEqual(evidenceItem.properties.attribution_scope.enum, [
    "campaign_assignment",
    "campaign",
  ]);
  assert.ok(
    evidenceItem.required.includes("linked_without_recorded_assignment_click"),
  );
  assert.deepEqual(Object.keys(evidenceSummary.properties).sort(), [
    "click_evidence_unavailable",
    "code_allocations",
    "code_linked_outcomes",
    "code_redemptions",
    "no_click_redemptions",
    "vanity_linked_outcomes",
    "vanity_visits",
    "with_click_redemptions",
  ]);
  assert.ok(!("code_revenue_cents" in evidenceSummary.properties));
  assert.ok(!("vanity_revenue_cents" in evidenceSummary.properties));
  assert.equal(evidenceItem.properties.currency.pattern, "^(?:|[A-Z]{3})$");
});

test("live vanity mount is neither excluded nor given an inferred legacy policy", () => {
  assert.match(main, /coderedemption\.MountVanityAdminRoutes\(r,/u);
  assert.match(main, /coderedemption\.MountRoutes\(r,/u);
  assert.ok(
    !reachability.forbidden_composition_calls.some(
      (entry) => entry.symbol === "coderedemption.MountVanityAdminRoutes",
    ),
  );
  const routeKeys = new Set([
    `GET ${collectionPath}`,
    `POST ${collectionPath}`,
    `POST ${conversionPath}`,
    `GET ${evidencePath}`,
  ]);
  for (const route of reachability.excluded_routes) {
    assert.ok(!routeKeys.has(`${route.method} ${route.path}`));
  }

  const expected = new Map([
    [
      `GET ${collectionPath}`,
      {
        auth_methods: ["session", "api_key"],
        role: "viewer",
        scope: "read:campaigns",
        source: "openapi.x-required-scopes",
      },
    ],
    [
      `POST ${collectionPath}`,
      {
        auth_methods: ["session", "api_key"],
        role: "editor",
        scope: "write:campaigns",
        source: "openapi.x-required-scopes",
      },
    ],
    [
      `POST ${conversionPath}`,
      {
        auth_methods: ["api_key"],
        role: "not_applicable",
        scope: "admin",
        source: "openapi.x-required-auth-method+openapi.x-required-scopes",
      },
    ],
    [
      `GET ${evidencePath}`,
      {
        auth_methods: ["session", "api_key"],
        role: "viewer",
        scope: "read:reports",
        source: "openapi.x-required-scopes",
      },
    ],
  ]);
  for (const route of manifest.routes) {
    const key = `${route.method} ${route.path}`;
    if (!expected.has(key)) continue;
    const want = expected.get(key);
    assert.deepEqual(route.auth_methods, want.auth_methods, key);
    assert.equal(route.session_minimum_role, want.role, key);
    assert.deepEqual(route.api_key_scopes, [want.scope], key);
    assert.equal(route.api_key_scope_mode, "any", key);
    assert.equal(route.policy_source, want.source, key);
    assert.equal(route.review_status, "reviewed", key);
    expected.delete(key);
  }
  assert.deepEqual(
    [...expected.keys()],
    [],
    "missing vanity routeauth policies",
  );
});

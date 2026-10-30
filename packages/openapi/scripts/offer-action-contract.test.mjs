import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import YAML from "yaml";

const packageRoot = new URL("../", import.meta.url);
const spec = YAML.parse(
  readFileSync(new URL("openapi.yaml", packageRoot), "utf8"),
);
const actionCatalog = readFileSync(
  new URL("../../apps/api/internal/notifications/actions.go", packageRoot),
  "utf8",
);
const actionGate = readFileSync(
  new URL("../../apps/api/internal/actionticket/actionticket.go", packageRoot),
  "utf8",
);
const sideEffectGate = readFileSync(
  new URL("../../apps/api/internal/notifications/side_effect.go", packageRoot),
  "utf8",
);
const main = readFileSync(
  new URL("../../apps/api/main.go", packageRoot),
  "utf8",
);
const offerHandlers = readFileSync(
  new URL("../../apps/api/internal/offers/handlers.go", packageRoot),
  "utf8",
);
const routeauthManifest = JSON.parse(
  readFileSync(
    new URL("../../apps/api/internal/routeauth/manifest.json", packageRoot),
    "utf8",
  ),
);

test("canonical public read is structurally documented but release-held", () => {
  const publicRead = spec.paths["/api/public/offers/{offer}"]?.get;
  const adminRead = spec.paths["/api/v1/offers/{offer}"]?.get;
  assert.ok(publicRead);
  assert.ok(adminRead);
  assert.deepEqual(publicRead.security, []);
  assert.deepEqual(Object.keys(publicRead.responses), ["503"]);
  assert.ok(spec.components.schemas.PublicOfferEnvelope);
  assert.equal(
    Object.hasOwn(spec.components.schemas.PublicOffer.properties, "metadata"),
    false,
  );
  assert.equal(
    Object.hasOwn(spec.components.schemas.PublicOffer.properties, "campaign_id"),
    false,
  );
  assert.deepEqual(adminRead.security, [
    { bearerAuth: [] },
    { sessionCookie: [] },
  ]);
  assert.deepEqual(adminRead["x-required-scopes"], ["read:campaigns"]);
  assert.equal(adminRead["x-required-role"], "viewer");
  assert.equal(
    publicRead["x-postwave-release-hold"],
    "assure_f15_public_offer_unwired",
  );
  assert.match(publicRead.description, /PublicResolutionAvailable=false/u);
  assert.doesNotMatch(main, /if offers\.PublicResolutionAvailable \{/u);
  assert.match(main, /offers\.MountPublicRoutes/u);
  assert.match(main, /offers\.MountAdminRoutes/u);
  assert.match(
    offerHandlers,
    /PublicResolutionReleaseHoldCode\s*=\s*"assure_f15_public_offer_unwired"/u,
  );
  assert.match(offerHandlers, /http\.StatusServiceUnavailable/u);
});

test("action-ticket GET previews and POST performs with a body secret", () => {
  const preview = spec.paths["/api/v1/actions/preview"]?.get;
  const redeem = spec.paths["/api/v1/actions/redeem"]?.post;
  assert.ok(preview);
  assert.ok(redeem);
  assert.deepEqual(preview.security, []);
  assert.deepEqual(redeem.security, []);
  assert.equal(preview.parameters.find((item) => item.name === "ticket").required, true);
  assert.ok(redeem.requestBody.content["application/json"]);
  assert.ok(redeem.requestBody.content["application/x-www-form-urlencoded"]);
  assert.match(redeem.description, /Offer actions are release-held/u);
  assert.match(redeem.description, /absent from the current\s+catalog/u);
  assert.equal(
    spec.components.schemas.ActionTicketRedeemInput.properties.ticket.writeOnly,
    true,
  );
});

test("release-held offer actions stay outside the advertised catalog", () => {
  assert.doesNotMatch(actionCatalog, /ID: "offer\.accept"/u);
  assert.doesNotMatch(actionCatalog, /ID: "offer\.decline"/u);
  assert.match(sideEffectGate, /SideEffectCompletesPurchase/u);
  assert.match(sideEffectGate, /SideEffectReservesInventory/u);
  assert.match(sideEffectGate, /func \(s SideEffect\) Ticketable\(\)/u);
  assert.match(actionGate, /candidate\.SideEffect\.Ticketable\(\)/u);
  assert.doesNotMatch(
    actionGate,
    /case\s+"offer\.accept"\s*:/u,
    "offer.accept must not gain a bespoke ticket bypass",
  );
});

test("retention evidence reads match the exact runtime admin boundary", () => {
  const expected = new Map([
    ["/api/v1/retention-offers", "#/components/schemas/RetentionOfferAdminList"],
    ["/api/v1/retention-offers/funnel", "#/components/schemas/RetentionOfferFunnelList"],
    ["/api/v1/retention-offers/winback-settings", "#/components/schemas/RetentionWinbackSettings"],
  ]);
  for (const [path, responseSchema] of expected) {
    const operation = spec.paths[path]?.get;
    assert.ok(operation, `${path} GET must be documented`);
    assert.deepEqual(operation.security, [
      { bearerAuth: [] },
      { sessionCookie: [] },
    ]);
    assert.deepEqual(operation["x-required-scopes"], ["admin"]);
    assert.equal(operation["x-required-role"], "admin");
    assert.equal(
      operation.responses["200"].content["application/json"].schema.$ref,
      responseSchema,
    );
    assert.ok(operation.responses["401"]);
    assert.ok(operation.responses["403"]);
    assert.ok(operation.responses["500"]);

    const manifestEntry = routeauthManifest.routes.find(
      (entry) => entry.method === "GET" && entry.path === path,
    );
    assert.ok(manifestEntry, `${path} must be present in routeauth`);
    assert.equal(manifestEntry.session_minimum_role, "admin");
    assert.deepEqual(manifestEntry.api_key_scopes, ["admin"]);
    assert.equal(manifestEntry.review_status, "reviewed");
  }
  assert.match(
    main,
    /retentionOfferDeps\.MountRoutes\(r\.With\(apikeys\.RequireExactTenantAdmin\)\)/u,
  );
});

test("retention and tier response schemas preserve all-platform bounds", () => {
  const offers = spec.components.schemas.RetentionOfferAdminList;
  const offer = spec.components.schemas.RetentionOfferAdminRecord;
  const funnel = spec.components.schemas.RetentionOfferFunnelList;
  const tile = spec.components.schemas.RetentionOfferFunnelTile;
  const tiers = spec.components.schemas.PaywallTierAdminList;
  const tier = spec.components.schemas.PaywallTierAdminRecord;

  assert.equal(offers.additionalProperties, false);
  assert.equal(offers.properties.offers.maxItems, 1000);
  assert.equal(offer.additionalProperties, false);
  assert.equal(offer.properties.headline["x-max-utf8-bytes"], 1000);
  assert.equal(offer.properties.body["x-max-utf8-bytes"], 10000);
  assert.equal(offer.properties.stripe_coupon_id["x-max-utf8-bytes"], 512);
  assert.equal(funnel.properties.tiles.maxItems, 1000);
  assert.equal(tile.additionalProperties, false);
  for (const field of ["shown", "accepted", "declined", "expired"]) {
    assert.equal(tile.properties[field].maximum, 2251799813685);
  }
  assert.equal(tiers.properties.tiers.maxItems, 1000);
  assert.equal(tier.properties.name["x-max-utf8-bytes"], 1000);
  assert.equal(tier.properties.description["x-max-utf8-bytes"], 10000);
  assert.equal(tier.properties.stripePriceId["x-max-utf8-bytes"], 512);

  const paywallRead = spec.paths["/api/v1/paywall/tiers"]?.get;
  assert.deepEqual(paywallRead["x-required-scopes"], ["admin"]);
  assert.equal(paywallRead["x-required-role"], "admin");
  assert.equal(
    paywallRead.responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/PaywallTierAdminList",
  );
});

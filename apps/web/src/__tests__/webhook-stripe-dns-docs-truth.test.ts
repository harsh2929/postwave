// SPDX-License-Identifier: AGPL-3.0-only
//
// These docs cover several similarly named but materially different surfaces:
// the dashboard-managed legacy outbound API, the richer canonical outbound
// API, inbound receive endpoints, the read-only Stripe connector, and the
// sending-identity DNS verifier. Pin the distinctions so a concise search
// summary cannot silently turn source composition into deployment evidence or
// reverse who signs an inbound request.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { STATIC_DOCS } from "@/lib/docs/search.server";

const REPO = resolve(process.cwd(), "../..");
const SRC = resolve(process.cwd(), "src");

function source(relativePath: string): string {
  return readFileSync(join(REPO, relativePath), "utf8");
}

function webSource(relativePath: string): string {
  return readFileSync(join(SRC, relativePath), "utf8");
}

function staticDoc(title: string): string {
  const doc = STATIC_DOCS.find((entry) => entry.title === title);
  if (!doc) throw new Error(`missing static doc: ${title}`);
  return doc.body;
}

describe("webhook, Stripe, and DNS docs describe the composed boundaries", () => {
  const main = source("apps/api/main.go");
  const developerPage = webSource("app/(marketing)/developers/page.tsx");
  const integrationPage = webSource(
    "app/(docs)/docs/integrations/[integration]/page.tsx",
  );
  const integrationIndex = webSource("app/(docs)/docs/integrations/page.tsx");

  it("separates the web-managed legacy webhook API from canonical source", () => {
    expect(main).toContain("MountEngagementPreferencesAndWebhooks(");
    expect(main).toContain("outboundWebhooksDeps.MountRoutes(");
    expect(main).toContain("StartOutboundWebhookWorkers(");

    expect(developerPage).toContain("legacy /api/v1/webhooks");
    expect(developerPage).toContain("canonical /api/v1/outbound-webhooks");
    expect(developerPage).toContain("not web-wired");
    expect(developerPage).toContain("not live-environment certification");
    expect(developerPage).not.toContain("Replay any past delivery");
  });

  it("keeps inbound signing direction and retry ownership explicit", () => {
    const auth = source("apps/api/internal/inbound_webhooks/authentication.go");
    const actions = source(
      "apps/api/internal/inbound_webhooks/action_worker.go",
    );
    expect(auth).toContain(
      'errSignatureFormat  = errors.New("X-Moosewave-Signature must be v2=<hex_hmac_sha256>")',
    );
    expect(actions).toContain("retry_exhausted");

    expect(integrationPage).toContain("The upstream sender signs each request");
    expect(integrationPage).toContain("Moosewave verifies the HMAC");
    expect(integrationPage).toContain("function signForPostwave(");
    expect(integrationPage).toContain(
      "Moosewave does not control whether or when the upstream sender retries",
    );
    expect(integrationPage).not.toContain("Verify signatures on your end");
    expect(integrationPage).not.toContain(
      "At-least-once delivery, retry with exponential backoff",
    );
  });

  it("indexes Stripe as read-only evidence rather than billing control", () => {
    const stripe = staticDoc("Stripe integration");
    expect(stripe).toContain("read-only");
    expect(stripe).toContain("signed webhook ingestion");
    expect(stripe).toContain("no charges");
    expect(stripe).toContain("subscription mutation");
    expect(stripe).toContain("customer portal");
    expect(integrationIndex).toContain("read-only Stripe evidence");
    expect(integrationPage).toContain(
      "It does not create charges, mutate paid or gift subscriptions, or provide a Stripe Customer Portal.",
    );
  });

  it("describes DNS verification as explicit evidence, not provisioning", () => {
    const identity = source(
      "apps/api/internal/sending_identity/sending_identity.go",
    );
    expect(identity).toContain(
      'Post("/api/v1/sending-identities/{id}/verify", d.Verify)',
    );

    const domains = staticDoc("Custom domains");
    expect(domains).toContain("explicit on-demand verification");
    expect(domains).toContain("live deployment remain unqualified");
    expect(domains).not.toContain("automated DNS verification");
    expect(domains).not.toContain("click-tracking subdomain");
    expect(integrationPage).toContain(
      "provider provisioning, certificates, routing, or a live production deployment",
    );
  });
});

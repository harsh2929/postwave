import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { OUTBOUND_EVENT_CATALOG } from "../../components/webhooks/EventCatalogDialog";
import {
  OUTBOUND_WEBHOOK_EVENTS,
  OUTBOUND_WEBHOOK_SIGNING_ALGORITHMS,
} from "../../lib/api-client";

const source = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("canonical outbound webhook desktop contract", () => {
  it("offers only producer-backed event types", () => {
    expect(OUTBOUND_WEBHOOK_EVENTS).toEqual([
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
      // Produced by appendFinalizationWebhookEvents in the same transaction
      // that finalizes the run. Listed here only because that producer exists —
      // this assertion is what stops the catalog offering a topic nothing fires.
      "assurance.run.completed",
      "assurance.run.blocked",
    ]);
  });

  it("keeps the user-visible catalog exhaustive with the backend event list", () => {
    expect(OUTBOUND_EVENT_CATALOG.map((entry) => entry.event)).toEqual([
      ...OUTBOUND_WEBHOOK_EVENTS,
    ]);
    expect(
      new Set(OUTBOUND_EVENT_CATALOG.map((entry) => entry.event)).size,
    ).toBe(OUTBOUND_WEBHOOK_EVENTS.length);
    for (const entry of OUTBOUND_EVENT_CATALOG) {
      expect(entry.description.trim()).not.toBe("");
      expect(entry.data).toEqual(expect.any(Object));
    }
  });

  it("documents the exact default envelope and delivery headers", () => {
    const catalog = source("components/webhooks/EventCatalogDialog.tsx");
    expect(catalog).toContain("event: {");
    expect(catalog).toContain('id: "4fd5c4c8-156f-4f0d-9346-02ab38e928d8"');
    expect(catalog).toContain("occurred_at:");
    expect(catalog).toContain(
      'webhook: { id: "2a1030cc-dce6-4228-9ed1-b50282b32ee9" }',
    );
    expect(catalog).toContain('id: "f18786aa-1445-46d0-a36d-a70a0640b81b"');
    expect(catalog).toContain("attempt: 1");
    for (const header of [
      "X-Postwave-Signature",
      "X-Postwave-Key-Id",
      "X-Postwave-Event",
      "X-Postwave-Event-Id",
      "X-Postwave-Delivery",
      "X-Postwave-Test: true",
    ]) {
      expect(catalog).toContain(header);
    }
    expect(catalog).toContain("signature does not authenticate auxiliary");
    expect(catalog).toContain("transform can remove");
    expect(catalog).toContain("production event deliveries omit");
    expect(catalog).toContain(
      "an API-configured transform can change the final signed body",
    );
  });

  it("ships raw-byte, timestamp-bounded verification for every signing algorithm", () => {
    expect(OUTBOUND_WEBHOOK_SIGNING_ALGORITHMS).toEqual([
      "hmac_sha256",
      "ecdsa_p256",
      "ed25519",
    ]);
    const snippets = source(
      "components/webhooks/VerificationSnippetDialog.tsx",
    );
    expect(snippets).toContain("exact request bytes");
    expect(snippets).toContain("timingSafeEqual");
    expect(snippets).toContain("hmac.compare_digest");
    expect(snippets).toContain("hmac.Equal");
    expect(snippets).toContain("v1=");
    expect(snippets).toContain("v2=");
    expect(snippets).toContain("v3=");
    expect(snippets).toContain("ecdsa.VerifyASN1");
    expect(snippets).toContain("ed25519.Verify");
    expect(snippets).toContain("toleranceSec = 300");
    expect(snippets).toContain("signatures.some");
    expect(snippets).toContain("outbound requests do not send a");
    expect(snippets).toContain("X-Postwave-Event-Id");
    expect(snippets).toContain("X-Postwave-Test: true");
    expect(snippets).toContain("not covered by that");
    expect(snippets).toContain(
      "Deduplicate only an identity present inside the verified",
    );
  });

  it("models filtered tests and pagination as explicit canonical data", () => {
    const contract = source("lib/api/webhook-event-operations.ts");
    const page = source("pages/OutboundWebhooks.tsx");
    const deliveries = source(
      "components/OutboundWebhookDeliveriesSlideover.tsx",
    );
    expect(contract).toContain("filtered: boolean");
    expect(contract).toContain(
      "response.filtered test results must be unsigned",
    );
    expect(contract).toContain("next_cursor: nextCursor");
    expect(page).toContain("Filtered before delivery");
    expect(page).toContain("No network request");
    expect(page).toContain("result.data.next_cursor");
    expect(deliveries).toContain("Load older deliveries");
    expect(deliveries).toContain("result.data.next_cursor");
  });

  it("keeps the main workspace on the canonical service without fake environments", () => {
    const client = source("lib/api-client.ts");
    const contract = source("lib/api/webhook-event-operations.ts");
    const page = source("pages/OutboundWebhooks.tsx");
    const deliveries = source(
      "components/OutboundWebhookDeliveriesSlideover.tsx",
    );
    expect(client).toContain("createOutboundOps({ request })");
    expect(contract).toContain('"/api/v1/outbound-webhooks"');
    expect(page).toContain("listOutboundWebhooks");
    expect(page).toContain("deleteOutboundWebhook");
    expect(deliveries).toContain("listOutboundWebhookDeliveries");
    expect(page).not.toContain("api.listWebhooks");
    expect(page).not.toContain("/api/v1/webhooks");
    expect(page).not.toMatch(/\benvironment\b/u);
  });

  it("keeps the home and inbound onboarding copy within supported semantics", () => {
    const home = source("pages/WebhooksHome.tsx");
    const inbound = source("pages/InboundWebhooks.tsx");
    const gallery = source("components/webhooks/WebhookOnboardingGallery.tsx");
    expect(home).not.toContain("ValuePropCard");
    expect(home).not.toContain("Every send, click");
    expect(home).toContain("complete producer-backed outbound catalog");
    expect(home).toContain('tab === "outbound"');
    expect(inbound).toContain("versioned timestamp-and-event HMAC contract");
    expect(inbound).toContain("Persist verified events");
    expect(inbound).toContain("v2=&lt;hex_hmac_sha256&gt;");
    expect(inbound).toContain(
      "v2:&lt;timestampByteLen&gt;:&lt;timestamp&gt;:&lt;eventIdByteLen&gt;:&lt;eventId&gt;:&lt;rawBody&gt;",
    );
    expect(inbound).not.toContain("ts + &quot;.&quot; + body");
    expect(gallery).toContain("Verify the provider signature");
    expect(gallery).toContain("re-sign and forward the JSON");
    expect(gallery).toContain("v2 length-framed timestamp");
    expect(gallery).not.toContain("Add this endpoint to Stripe Webhooks");
  });
});

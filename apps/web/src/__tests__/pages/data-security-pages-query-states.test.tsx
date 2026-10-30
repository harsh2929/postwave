// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { clickEveryControl, renderPage, unmount, WHOAMI } from "./_harness";

const DATA_SECURITY_WHOAMI = {
  ...WHOAMI,
  user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  tenant_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(DATA_SECURITY_WHOAMI),
}));

const LOADED: Record<string, unknown> = {
  "/api/v1/byok/keys": {
    keys: [
      {
        id: "key_identifier_that_must_not_overflow_a_mobile_viewport",
        alias: "Primary subscriber-data key",
        provider: "aws_kms",
        status: "active",
      },
    ],
  },
  "/api/v1/byok/providers": {
    providers: [{ name: "AWS KMS configured" }],
    supported: ["aws_kms", "gcp_kms"],
  },
  "/api/v1/inactive-keys": {
    count: 2,
    threshold_days: 90,
    keys: [{ id: "key_1" }, { id: "key_2" }],
  },
  "/api/v1/deliverability/hub/history": {
    count: 3,
    model_version: "deliverability-2026.08-long-version",
    snapshots: [{ score: 91 }],
  },
  "/api/v1/activation-exclusions": { items: [{ id: "excluded_1" }] },
  "/api/v1/deliverability/providers": {
    items: [{ id: "provider_1" }, { id: "provider_2" }],
  },
  "/api/v1/settings/identifier-transforms": {
    email_normalize_dots: true,
    email_normalize_plus: false,
    phone_e164_format: true,
    phone_default_region: "",
  },
  "/api/v1/settings/deduplication": {
    merge_confidence_threshold: 0.95,
  },
  "/api/v1/settings/pii-config": {
    built_in_fields: ["email", "phone"],
    fields: [{ key: "government_identifier" }],
  },
  "/api/v1/growth-source/quality": {
    window_days: 30,
    sources: [
      {
        consent_source: "hosted_form",
        total_subscribers: 12,
        engaged: 0,
        bounced: 0,
        complained: 0,
        engagement_rate: 0,
        bounce_rate: 0,
        complaint_rate: 0,
      },
      {
        consent_source: "partner_referral",
        total_subscribers: 20,
        engaged: 10,
        bounced: 2,
        complained: 1,
        engagement_rate: 50,
        bounce_rate: 10,
        complaint_rate: 5,
      },
    ],
  },
  "/api/v1/gift-subscriptions/stats": {
    total: 10,
    paid: 7,
    granted: 6,
    pending: 1,
    canceled: 1,
    expired: 1,
    refunded: 1,
    conversionRate: 60,
  },
  "/api/v1/paywall/tiers": { tiers: [{ id: "tier_1" }] },
  "/api/v1/commerce/catalogs": { items: [{ id: "catalog_1" }] },
  "/api/v1/growth-source/timeseries": {
    window_days: 3,
    points: [
      { date: "2026-08-01", consent_source: "", count: 0 },
      { date: "2026-08-02", consent_source: "hosted_form", count: 2 },
      { date: "2026-08-03", consent_source: "partner_referral", count: 1 },
    ],
  },
  "/api/v1/custom-objects/types": {
    items: [
      {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        tenantId: DATA_SECURITY_WHOAMI.tenant_id,
        key: "support_ticket_with_a_long_schema_key_for_mobile",
        label: "Support ticket",
        primaryKey: "external_id",
        schema: {
          type: "object",
          properties: { priority: { type: "string" } },
        },
        status: "active",
        version: 4,
        createdAt: "2026-08-01T08:00:00Z",
        updatedAt: "2026-08-29T08:00:00Z",
      },
    ],
  },
};

const EMPTY: Record<string, unknown> = {
  "/api/v1/byok/keys": { keys: [] },
  "/api/v1/byok/providers": { providers: [], supported: ["aws_kms"] },
  "/api/v1/inactive-keys": { count: 0, threshold_days: 90, keys: [] },
  "/api/v1/deliverability/hub/history": {
    count: 0,
    model_version: "",
    snapshots: [],
  },
  "/api/v1/activation-exclusions": { items: [] },
  "/api/v1/deliverability/providers": { items: [] },
  "/api/v1/settings/identifier-transforms": {
    email_normalize_dots: false,
    email_normalize_plus: false,
    phone_e164_format: false,
    phone_default_region: "",
  },
  "/api/v1/settings/deduplication": { merge_confidence_threshold: 0.95 },
  "/api/v1/settings/pii-config": { built_in_fields: [], fields: [] },
  "/api/v1/growth-source/quality": { window_days: 30, sources: [] },
  "/api/v1/gift-subscriptions/stats": {},
  "/api/v1/paywall/tiers": { tiers: [] },
  "/api/v1/commerce/catalogs": { items: [] },
  "/api/v1/growth-source/timeseries": { window_days: 30, points: [] },
  "/api/v1/custom-objects/types": { items: [] },
};

function stubDataSecurityTransport(mode: "loaded" | "empty" | "error") {
  const transport = vi.fn(async (input: RequestInfo | URL) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const path = new URL(raw, "http://postwave.test").pathname;
    if (mode === "error") {
      return new Response(
        JSON.stringify({ error: { code: "bad_request", message: "Failed" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify((mode === "loaded" ? LOADED : EMPTY)[path] ?? {}),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", transport);
  return transport;
}

const PAGES = [
  {
    name: "encryption keys",
    load: () => import("@/app/(dashboard)/app/encryption-keys/page"),
    loaded: ["Primary subscriber-data key", "AWS KMS configured", "active"],
    empty: "No customer-managed key is configured",
    alerts: 1,
  },
  {
    name: "credential hygiene",
    load: () => import("@/app/(dashboard)/app/key-hygiene/page"),
    loaded: ["2", "90 days", "deliverability-2026.08-long-version"],
    empty: "No score snapshots recorded yet",
    alerts: 4,
  },
  {
    name: "data hygiene",
    load: () => import("@/app/(dashboard)/app/data-hygiene/page"),
    loaded: ["95%", "E.164 formatting is on", "email, phone"],
    empty: "No additional fields declared",
    alerts: 3,
  },
  {
    name: "source quality",
    load: () => import("@/app/(dashboard)/app/source-quality/page"),
    loaded: ["hosted form", "unmeasured rather than zero", "60%"],
    empty: "No acquisition sources recorded",
    alerts: 5,
  },
  {
    name: "custom objects",
    load: async () => {
      // The route intentionally defers this protected workspace with
      // `next/dynamic({ ssr: false })`; happy-dom cannot reliably hydrate a
      // cold route boundary. Exercise the real client for query-state and
      // control coverage while production keeps the split.
      const { CustomObjectsClient } = await import(
        "@/app/(dashboard)/app/custom-objects/custom-objects-client"
      );
      return { default: CustomObjectsClient };
    },
    loaded: ["Support ticket", "support_ticket_with_a_long", "external_id"],
    empty: "No custom object types defined",
    alerts: 1,
  },
] as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("data-security query surfaces", () => {
  for (const page of PAGES) {
    it(`${page.name} renders seeded edge data and refreshes`, async () => {
      const transport = stubDataSecurityTransport("loaded");
      const Page = (await page.load()).default;
      const { container, root } = await renderPage(Page);
      try {
        for (const marker of page.loaded) {
          expect(container.textContent).toContain(marker);
        }
        const initialRequests = transport.mock.calls.length;
        const { failures } = await clickEveryControl(container);
        expect(failures).toEqual([]);
        expect(transport.mock.calls.length).toBeGreaterThan(initialRequests);
      } finally {
        unmount(root);
      }
    });

    it(`${page.name} has a truthful empty state`, async () => {
      stubDataSecurityTransport("empty");
      const Page = (await page.load()).default;
      const { container, root } = await renderPage(Page);
      try {
        expect(container.textContent).toContain(page.empty);
        expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
      } finally {
        unmount(root);
      }
    });

    it(`${page.name} exposes every failed read and its retry`, async () => {
      stubDataSecurityTransport("error");
      const Page = (await page.load()).default;
      const { container, root } = await renderPage(Page);
      try {
        expect(container.querySelectorAll('[role="alert"]')).toHaveLength(
          page.alerts,
        );
        expect(
          [...container.querySelectorAll("button")].filter((button) =>
            /^retry$/i.test(button.textContent?.trim() ?? ""),
          ),
        ).toHaveLength(page.alerts);
      } finally {
        unmount(root);
      }
    });
  }
});

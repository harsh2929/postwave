// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { clickEveryControl, renderPage, unmount, WHOAMI } from "./_harness";
import { importBeforeTests, waitFor } from "./_wait";

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
  whoami: vi.fn().mockResolvedValue({
    ...WHOAMI,
    tenant_id: "11111111-1111-4111-8111-111111111111",
  }),
}));

const LOADED: Record<string, unknown> = {
  "/api/v1/compliance/programs": {
    programs: [
      {
        framework: "hipaa",
        status: "unsupported",
        notes:
          "No Business Associate Agreement is offered and protected health information must not be used.",
      },
      { framework: "gdpr", status: "in_progress" },
      {
        framework: "soc2",
        status: "attested",
        signedByEmail: "owner@example.com",
        attestedAt: "2026-08-20T10:00:00Z",
        updatedAt: "2026-08-20T10:00:00Z",
      },
    ],
  },
  "/api/v1/audit/stats": { totalEvents: 1 },
  "/api/v1/audit/retention-activity": {
    events: [],
    total_purged_last_30d: 0,
  },
  "/api/v1/sar/requests": {
    requests: [
      {
        id: "55555555-5555-4555-8555-555555555555",
        kind: "access",
        subscriber_email: "reader@example-postwave.test",
        status: "ready",
        event_count: 12,
        consent_count: 2,
        bundle_bytes: 2048,
        requested_by: "admin:owner@example.test",
        requested_at: "2026-08-01T10:00:00Z",
        ready_at: "2026-08-01T10:00:01Z",
        region: "GDPR",
        error: "",
      },
    ],
    count: 1,
  },
  "/api/v1/scheduled-reports": {
    reports: [
      {
        id: "44444444-4444-4444-8444-444444444444",
        name: "Deletion deadline report",
        enabled: true,
        template: "engagement_summary",
        schedule: "weekly:mon@09:00",
        timezone: "UTC",
        recipients: ["owner@example.test"],
        last_run_at: null,
        latest_run_id: null,
        latest_run_status: null,
        latest_run_created_at: null,
        latest_run_accepted_count: 0,
        latest_run_failed_count: 0,
        latest_run_unknown_count: 0,
        latest_run_recipient_count: 0,
        next_due_at: "2026-09-07T09:00:00Z",
        created_at: "2026-08-20T10:00:00Z",
      },
    ],
  },
  "/api/v1/voice/brand-profile": { name: "Editorial voice" },
  "/api/v1/zero-copy-triggers": { items: [{ id: "trigger_1" }] },
  "/api/v1/consent/events": {
    count: 1,
    events: [
      {
        id: "event_1",
        subject_type: "subscriber",
        subject_id: "subscriber_1",
        subject_email:
          "a.very.long.subscriber.address.for.mobile@example-postwave.test",
        channel: "email",
        category: "newsletter",
        action: "granted",
        source: "hosted_form",
        policy_version: "privacy-2026-08-extremely-specific-version",
        proof_text: "Checked the explicit newsletter consent box.",
        created_at: "2026-08-01T10:00:00Z",
        recorded_at: "2026-08-21T10:00:00Z",
        preferences: {},
      },
    ],
    source_planes: ["consent_events", "consent_receipts"],
    snapshot_at: "2026-08-21T10:00:00Z",
    has_more: false,
    schema_version: 2,
  },
  "/api/v1/privacy/incidents": {
    incidents: [{ id: "incident_1" }],
    known_jurisdictions: [{ code: "IN", name: "India" }],
  },
  "/api/v1/push/suppressions": {
    tenantId: "11111111-1111-4111-8111-111111111111",
    items: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        tenant_id: "11111111-1111-4111-8111-111111111111",
        device_token_hash: "0123456789abcdef",
        platform: "apns",
        reason: "manual",
        source: "dashboard",
        created_at: "2026-08-21T09:00:00Z",
        updated_at: "2026-08-21T09:00:00Z",
        version: 1,
        reversible: true,
      },
    ],
    total: 1,
    snapshotAt: "2026-08-21T10:00:00Z",
  },
  "/api/v1/consent/receipts": {
    schema_version: 2,
    snapshot_at: "2026-08-21T10:00:00Z",
    source_planes: ["consent_receipts", "consent_records"],
    count: 1,
    has_more: false,
    receipts: [
      {
        id: "receipt_1",
        subscriber_email:
          "another.long.subscriber.address.for-mobile@example-postwave.test",
        new_state: "granted",
        source: "preference_centre",
        kind: "newsletter_consent",
        at: "2026-08-01T10:00:00Z",
        recorded_at: "2026-08-21T10:00:00Z",
      },
    ],
  },
  "/api/v1/pii-scan-config": {
    available: true,
    scan_enabled: true,
    scheduled_scans_available: false,
    status: "ready",
    execution_mode: "on_write",
    scanner_name: "postwave-pii-scanner",
    scanner_version: "2.1.0",
    detector_name: "structured-detector",
    detector_version: "4.2.0",
    policy_name: "workspace-default",
    policy_version: "2026-08",
  },
  "/api/v1/profile-transform-rules": { items: [{ id: "transform_1" }] },
  "/api/v1/subscriber-import-templates": { items: [{ id: "template_1" }] },
  "/api/v1/inbound-webhooks": { items: [{ id: "webhook_1" }] },
  "/api/v1/privacy/portal": {
    tenantId: "11111111-1111-4111-8111-111111111111",
    regions: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        tenantId: "11111111-1111-4111-8111-111111111111",
        region_code: "IN",
        framework: "other",
        requires_double_optin: true,
        requires_explicit_consent: true,
        do_not_sell_default: false,
        gpc_honored: true,
        created_at: "2026-08-01T10:00:00Z",
        updated_at: "2026-08-21T10:00:00Z",
      },
    ],
    dsar_requests: [
      {
        request_type: "erasure_request",
        open: 4,
        overdue: 1,
        closed: 8,
      },
    ],
    suppression_breakdown: [{ reason: "hard_bounce", count: 4 }],
    consent_proof_summary: [{ source: "hosted_form", count: 12 }],
    gpc_signaled_count: 7,
    do_not_sell_count: 5,
    double_optin_pending: 3,
    generated_at: "2026-08-21T10:00:00Z",
  },
  "/api/v1/privacy/portal/double-optin/pending": {
    tenantId: "11111111-1111-4111-8111-111111111111",
    count: 1,
    pending: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        email: "pending@example-postwave.test",
        sent_at: "2026-08-20T08:00:00Z",
        expires_at: "2026-10-19T08:00:00Z",
      },
    ],
  },
  "/api/v1/privacy/portal/preference-center": {
    tenantId: "11111111-1111-4111-8111-111111111111",
    logo_url: "https://example.test/brand.svg",
    primary_color: "#5b4cf0",
    footer_text:
      "A deliberately long subscriber-facing privacy footer that must remain readable on narrow screens.",
    show_postwave_badge: true,
  },
};

const EMPTY: Record<string, unknown> = {
  "/api/v1/compliance/programs": { programs: [] },
  "/api/v1/audit/stats": { totalEvents: 0 },
  "/api/v1/audit/retention-activity": {
    events: [],
    total_purged_last_30d: 0,
  },
  "/api/v1/sar/requests": { requests: [] },
  "/api/v1/scheduled-reports": { reports: [] },
  "/api/v1/zero-copy-triggers": { items: [] },
  "/api/v1/consent/events": {},
  "/api/v1/privacy/incidents": {},
  "/api/v1/push/suppressions": {
    tenantId: "11111111-1111-4111-8111-111111111111",
    items: [],
    total: 0,
    snapshotAt: "2026-08-21T10:00:00Z",
  },
  "/api/v1/consent/receipts": {},
  "/api/v1/pii-scan-config": {},
  "/api/v1/profile-transform-rules": { items: [] },
  "/api/v1/subscriber-import-templates": { items: [] },
  "/api/v1/inbound-webhooks": { items: [] },
  "/api/v1/privacy/portal": {
    tenantId: "11111111-1111-4111-8111-111111111111",
    regions: [],
    dsar_requests: [],
    suppression_breakdown: [],
    consent_proof_summary: [],
    gpc_signaled_count: 0,
    do_not_sell_count: 0,
    double_optin_pending: 0,
    generated_at: "2026-08-21T10:00:00Z",
  },
  "/api/v1/privacy/portal/double-optin/pending": {
    tenantId: "11111111-1111-4111-8111-111111111111",
    count: 0,
    pending: [],
  },
  "/api/v1/privacy/portal/preference-center": {
    tenantId: "11111111-1111-4111-8111-111111111111",
    logo_url: "",
    primary_color: "#5B6CFF",
    footer_text: "",
    show_postwave_badge: true,
  },
};

function stubGovernanceTransport(mode: "loaded" | "empty" | "error") {
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
    if (mode === "empty" && path === "/api/v1/voice/brand-profile") {
      return new Response(
        JSON.stringify({ error: { code: "not_found", message: "" } }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }

    const body = (mode === "loaded" ? LOADED : EMPTY)[path] ?? {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", transport);
  return transport;
}

async function waitForMarkers(
  container: HTMLElement,
  markers: readonly string[],
): Promise<void> {
  // A lazily loaded panel (next/dynamic) lands on wall-clock time, and a
  // slower CI host took longer than fifty 10 ms turns.
  await waitFor(() => {
    const missing = markers.filter(
      (marker) => !container.textContent?.includes(marker),
    );
    if (missing.length > 0) {
      throw new Error(
        `Timed out waiting for seeded evidence: ${missing.join(", ")}`,
      );
    }
  });
}

const PAGES = [
  {
    name: "compliance programmes",
    load: () => import("@/app/(dashboard)/app/compliance/page"),
    loaded: ["hipaa", "No Business Associate Agreement", "Attested"],
    empty: "No compliance programmes were reported",
    alerts: 3,
  },
  {
    name: "requests and reports",
    load: () => import("@/app/(dashboard)/app/compliance-requests/page"),
    loaded: [
      "Deletion deadline report",
      "Editorial voice",
      "Configured triggers",
    ],
    empty: "No subject-access or historical erasure receipts are recorded",
    alerts: 4,
  },
  {
    name: "consent evidence",
    load: () => import("@/app/(dashboard)/app/consent-evidence/page"),
    loaded: [
      "a.very.long.subscriber.address",
      "20 days later",
      "Checked the explicit",
    ],
    empty: "No consent events recorded",
    alerts: 3,
  },
  {
    name: "consent ledger",
    load: () => import("@/app/(dashboard)/app/consent-ledger/page"),
    loaded: [
      "another.long.subscriber.address",
      "preference centre",
      "Complete",
    ],
    empty: "No consent receipts recorded",
    alerts: 1,
  },
  {
    name: "data controls",
    load: () => import("@/app/(dashboard)/app/data-controls/page"),
    loaded: ["Scanning on", "structured-detector", "Active definitions"],
    empty: "Scanner unavailable",
    alerts: 4,
  },
  {
    name: "privacy portal",
    load: () => import("@/app/(dashboard)/app/privacy-portal/page"),
    loaded: ["hard bounce", "erasure request", "A deliberately long"],
    // Rendered by PortalDashboard (the parity commit replaced the admin's own
    // GovernanceEmpty with the dashboard's empty rows).
    empty: "No privacy requests on file",
    alerts: 4,
  },
] as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("governance pages", () => {
  // Each page's module graph is cold work for vitest's transform pipeline;
  // import them all before any test's 5 s clock starts.
  importBeforeTests(...PAGES.map((page) => page.load));

  for (const page of PAGES) {
    it(`${page.name} renders its seeded evidence and refreshes safely`, async () => {
      const transport = stubGovernanceTransport("loaded");
      const Page = (await page.load()).default;
      const { container, root } = await renderPage(Page);
      try {
        // Some governance panels are intentionally lazy. A stable fallback is
        // not the loaded page, so wait for every exact fixture marker before
        // exercising its controls.
        await waitForMarkers(container, page.loaded);
        for (const marker of page.loaded) {
          expect(container.textContent).toContain(marker);
        }
        const initialRequests = transport.mock.calls.length;
        const refresh = [...container.querySelectorAll("button")].find(
          (button) => /refresh/i.test(button.textContent ?? ""),
        );
        expect(refresh).toBeTruthy();
        const { failures } = await clickEveryControl(container);
        expect(failures).toEqual([]);
        expect(transport.mock.calls.length).toBeGreaterThan(initialRequests);
      } finally {
        unmount(root);
      }
    });

    it(`${page.name} distinguishes a real empty workspace`, async () => {
      stubGovernanceTransport("empty");
      const Page = (await page.load()).default;
      const { container, root } = await renderPage(Page);
      try {
        await waitForMarkers(container, [page.empty]);
        expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
      } finally {
        unmount(root);
      }
    });

    it(`${page.name} refuses clean claims when its reads fail`, async () => {
      stubGovernanceTransport("error");
      const Page = (await page.load()).default;
      const { container, root } = await renderPage(Page);
      try {
        expect(container.querySelectorAll('[role="alert"]')).toHaveLength(
          page.alerts,
        );
        expect(container.textContent).toMatch(
          /could not|returned no readable/i,
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

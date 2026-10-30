import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

import { loginAsDemo } from "../helpers/auth";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const APPROVAL_ID = "33333333-3333-4333-8333-333333333333";
const ROUTES = [
  { path: "/app/alerting-access", heading: "Alerting and access" },
  { path: "/app/approvals", heading: "Approvals" },
  { path: `/app/approvals/${APPROVAL_ID}`, heading: "Approval review" },
  { path: "/app/maintenance", heading: "Maintenance" },
  { path: "/app/notifications", heading: "Notifications" },
  { path: "/app/workspace-ops", heading: "Workspace operations" },
  { path: "/app/service-suite", heading: "Service suite availability" },
  { path: "/app/pilot", heading: "Pilot readiness" },
] as const;

const APPROVAL = {
  id: APPROVAL_ID,
  tenantId: TENANT_ID,
  resourceType: "campaign",
  resourceId: "campaign-ops-matrix",
  requestedByActorLabel: "Operations matrix",
  requestedByUserId: USER_ID,
  status: "pending",
  requestedAt: "2026-08-26T08:00:00Z",
};

const SERVICE_CATALOG = {
  schema_version: "postwave.service_suite.v2",
  provenance: { tenant_bound: false, source: "static_server_catalog" },
  agent_run_types: ["draft_reply", "triage", "handoff", "summary"],
  channels: [
    { key: "web_chat", label: "Web chat", runtime_status: "held" },
    { key: "email", label: "Email", runtime_status: "held" },
    { key: "sms", label: "SMS", runtime_status: "held" },
    { key: "instagram", label: "Instagram", runtime_status: "held" },
    { key: "whatsapp", label: "WhatsApp", runtime_status: "held" },
    { key: "facebook", label: "Facebook", runtime_status: "held" },
  ],
  conversation_statuses: [
    "open",
    "pending",
    "waiting",
    "resolved",
    "closed",
    "spam",
    "archived",
  ],
  capabilities: {
    outbound_reply_delivery: {
      status: "held",
      code: "helpdesk_delivery_unavailable",
    },
    inbound_email_bridge: { status: "held" },
    internal_notes: { status: "available" },
    privacy_lifecycle: { status: "held" },
    customer_hub_runtime: {
      status: "held",
      code: "customer_hub_runtime_unavailable",
    },
    channel_runtime: {
      status: "held",
      code: "helpdesk_channel_runtime_unavailable",
    },
    customer_agent: {
      status: "held",
      code: "customer_agent_draft_write_held",
      execution_mode: "deterministic_template_only",
    },
    macro_usage_evidence: {
      status: "held",
      code: "macro_usage_evidence_unavailable",
    },
    spam_assessment_write: {
      status: "held",
      code: "spam_assessment_write_held",
    },
    resource_creation: {
      status: "held",
      code: "helpdesk_create_replay_unavailable",
    },
  },
  guardrail: {
    draft_only: true,
    provider_executed: false,
    customer_mutations: false,
    requires_human_review: true,
  },
};

interface FixtureState {
  alertVerifications: number;
  maintenanceRuns: number;
  notificationReads: number;
  rotations: number;
  approvalRejections: number;
  tokenMints: number;
  viewerMode: boolean;
}

interface PilotFixtureState {
  failInventory: boolean;
  inventoryRequests: number;
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installOperationalFixtures(page: Page): Promise<FixtureState> {
  const state: FixtureState = {
    alertVerifications: 0,
    maintenanceRuns: 0,
    notificationReads: 0,
    rotations: 0,
    approvalRejections: 0,
    tokenMints: 0,
    viewerMode: false,
  };
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();

    if (path === "/api/v1/auth/me") {
      await json(route, {
        user_id: USER_ID,
        tenant_id: TENANT_ID,
        email: "owner@example.test",
        role: "owner",
        effective_role: state.viewerMode ? "viewer" : "owner",
        viewer_mode: state.viewerMode,
        can_use_viewer_mode: true,
        auth_provider: "local",
        email_verified: true,
        workspace_name: "Operations matrix",
        workspace_slug: "demo",
      });
      return;
    }
    if (path === "/api/v1/admin/archive/domain") {
      await json(route, {
        domain: "",
        cname_target: "",
        verification_token: "",
        status: "",
        last_checked_at: "",
        verified_at: "",
        last_error: "",
        ssl_status: "",
        ssl_last_error: "",
      });
      return;
    }
    if (
      /^\/api\/v1\/audit-alerts\/(pagerduty|jira|servicenow)\/auth$/u.test(path)
    ) {
      state.alertVerifications += 1;
      await json(route, { ok: true });
      return;
    }
    if (path === "/api/v1/streams/token") {
      state.tokenMints += 1;
      await json(route, {
        token: "stream_ops_matrix_full_value_123456789",
        expires_at: "2030-08-26T12:15:00Z",
        ttl_seconds: 900,
      });
      return;
    }
    if (path === "/api/v1/inbound-emails/endpoint/rotate") {
      state.rotations += 1;
      await json(route, {
        id: "endpoint-ops-matrix",
        tenantId: TENANT_ID,
        slug: "stable-inbound-address",
        secretConfigured: true,
        rotationRequired: false,
        secretRotatedAt: "2026-08-26T12:00:00Z",
        secret: "inbound_ops_matrix_full_secret_123456789",
        createdAt: "2026-08-01T00:00:00Z",
      });
      return;
    }

    if (path === "/api/v1/approvals" && method === "GET") {
      await json(route, { approvals: [APPROVAL] });
      return;
    }
    if (path === `/api/v1/approvals/${APPROVAL_ID}` && method === "GET") {
      await json(route, APPROVAL);
      return;
    }
    if (
      path === `/api/v1/approvals/${APPROVAL_ID}/reject` &&
      method === "POST"
    ) {
      state.approvalRejections += 1;
      await json(route, { ok: true });
      return;
    }
    if (
      path === `/api/v1/approvals/${APPROVAL_ID}/approve` &&
      method === "POST"
    ) {
      await json(route, { ok: true });
      return;
    }
    if (path === "/api/v1/approvals/delegations") {
      await json(route, { delegations: [] });
      return;
    }
    if (path === "/api/v1/approvals/escalation-policy") {
      await json(route, { escalateAfterHours: null, notifyOwners: false });
      return;
    }

    if (path === "/api/v1/notifications" && method === "GET") {
      await json(route, {
        items: [
          {
            id: "notification-ops-matrix",
            kind: "custom",
            title: "Operations matrix notification",
            body: "A deliberately long notification body remains readable at 320 pixels.",
            created_at: "2026-08-26T11:00:00Z",
          },
        ],
        unread_count: 1,
      });
      return;
    }
    if (path.includes("/api/v1/notifications/") && path.endsWith("/read")) {
      state.notificationReads += 1;
      await json(route, { ok: true });
      return;
    }
    if (path === "/api/v1/notifications/read-all") {
      state.notificationReads += 1;
      await json(route, { ok: true });
      return;
    }

    if (path === "/api/v1/feature-flags") {
      await json(route, { flags: [] });
      return;
    }
    if (path === "/api/v1/exports/retention-policy") {
      await json(route, {
        retention_days: 30,
        max_per_tenant: 20,
        current_storage_bytes: 4096,
        updated_at: "2026-08-26T10:00:00Z",
      });
      return;
    }
    if (path === "/api/v1/email-blocks/catalog") {
      await json(route, { blocks: [], brand: {} });
      return;
    }
    if (path === "/api/v1/dns-health/issues") {
      await json(route, { identities: [] });
      return;
    }
    if (path === "/api/v1/domain-warmup") {
      await json(route, { plans: [] });
      return;
    }
    if (path === "/api/v1/engagement-scores/distribution") {
      await json(route, { buckets: [] });
      return;
    }
    if (path === "/api/v1/deliverability/dmarc-reports") {
      await json(route, {
        items: [],
        meta: {
          returned: 0,
          totalReports: 0,
          hasMore: false,
          availableDomains: [],
          domainInventoryTruncated: false,
          generatedAt: "2026-08-26T10:00:00Z",
        },
      });
      return;
    }

    if (path === "/api/v1/service-suite/config") {
      await json(route, {
        tenantId: TENANT_ID,
        tenant_id: TENANT_ID,
        version: "absent",
        created_at: null,
        updated_at: null,
        status: "draft",
        order_history_enabled: true,
        favorites_enabled: true,
        coupons_enabled: true,
        recommendations_enabled: true,
        customer_agent_enabled: false,
        runtime_available: false,
        runtime_status: "held",
        runtime_reason_code: "customer_hub_runtime_unavailable",
        customer_agent_effective_enabled: false,
      });
      return;
    }
    if (path === "/api/v1/service-suite/catalog") {
      await json(route, SERVICE_CATALOG);
      return;
    }

    if (path === "/api/v1/migrations") {
      await json(route, [
        {
          id: "excluded-mailchimp-job",
          tenant_id: TENANT_ID,
          source: "mailchimp",
          status: "completed",
          progress: {},
          cursor: {},
          started_at: "2026-08-26T09:00:00Z",
          completed_at: "2026-08-26T10:00:00Z",
          rollback_until: null,
          verification_report: null,
          error: null,
        },
      ]);
      return;
    }
    if (path === "/api/v1/sending/readiness") {
      await json(route, {
        ready: true,
        items: [
          {
            key: "warmup-review",
            label: "Review warm-up plan",
            complete: false,
            severity: "warning",
          },
        ],
      });
      return;
    }
    if (path === "/api/v1/sms/pilot-readiness") {
      await json(route, { can_pilot: true, counts: {}, items: [] });
      return;
    }
    if (path === "/api/v1/sms/senders/pilot-certifications") {
      await json(route, { items: [] });
      return;
    }

    if (path === "/api/v1/spam-trap-guard/run-now") {
      state.maintenanceRuns += 1;
      await json(route, {
        completed_at: "2026-08-26T12:00:00Z",
        blocklisted: 2,
      });
      return;
    }

    if (path === "/api/v1/soft-bounce-recovery/run-now") {
      state.maintenanceRuns += 1;
      await json(route, {
        completed_at: "",
        recovered: 4,
        expired_suppressions: 2,
      });
      return;
    }
    if (path === "/api/v1/firewall/detect") {
      state.maintenanceRuns += 1;
      await json(route, { flipped: false });
      return;
    }
    if (path === "/api/v1/dns-health/run-now") {
      state.maintenanceRuns += 1;
      await json(route, { rechecked: 3 });
      return;
    }
    if (path === "/api/v1/predictive/recompute") {
      state.maintenanceRuns += 1;
      await json(route, {
        run: {
          id: "prediction-run-1",
          model_key: "engagement",
          model_version: "model-v2",
        },
      });
      return;
    }
    if (path === "/api/v1/contact-ratings/recompute") {
      state.maintenanceRuns += 1;
      await json(route, { updated: 0, scanned: 0, window_days: 30 });
      return;
    }
    if (path === "/api/v1/warehouse/runs/due") {
      state.maintenanceRuns += 1;
      await json(route, { items: [{ id: "due-1" }, { id: "due-2" }] });
      return;
    }
    if (path === "/api/v1/sunset/reengagement/preview") {
      state.maintenanceRuns += 1;
      await json(route, {
        subject: "We saved your place, {{ first_name }}",
        preheader: "A safe preview",
        bodyText: "Hello {{ first_name }}",
      });
      return;
    }
    if (path === "/api/v1/zero-copy-triggers/validate") {
      state.maintenanceRuns += 1;
      await json(route, {
        valid: true,
        errors: [],
        warnings: ["sample warehouse is not connected"],
      });
      return;
    }
    if (path === "/api/v1/onsite-growth/validate") {
      state.maintenanceRuns += 1;
      await json(route, {
        valid: false,
        errors: ["form is missing"],
        warnings: ["fallback audience is unset"],
      });
      return;
    }
    if (path === "/api/v1/cdp/transforms/preview") {
      state.maintenanceRuns += 1;
      await json(route, { results: [], success: 0, failed: 0 });
      return;
    }
    if (path === "/api/v1/social-capture/validate") {
      state.maintenanceRuns += 1;
      await json(route, {
        valid: true,
        errors: [],
        warnings: ["SMS consent handoff is not configured"],
      });
      return;
    }
    if (path === "/api/v1/events/publish") {
      state.maintenanceRuns += 1;
      await json(
        route,
        {
          error: {
            code: "topic_not_publishable",
            message: "This topic is server-published only.",
          },
        },
        422,
      );
      return;
    }
    if (path === "/api/v1/auth/me/viewer-mode" && method === "PATCH") {
      state.maintenanceRuns += 1;
      const body = (request.postDataJSON() ?? {}) as { enabled?: boolean };
      state.viewerMode = body.enabled === true;
      await json(route, {
        viewer_mode: state.viewerMode,
        role: "owner",
        effective_role: state.viewerMode ? "viewer" : "owner",
      });
      return;
    }

    await route.fallback();
  });
  return state;
}

async function installRichPilotFixtures(
  page: Page,
): Promise<PilotFixtureState> {
  const state: PilotFixtureState = {
    failInventory: false,
    inventoryRequests: 0,
  };
  const jobId = "pilot-activecampaign-job";
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET") {
      await route.fallback();
      return;
    }
    if (path === "/api/v1/migrations") {
      state.inventoryRequests += 1;
      if (state.failInventory && state.inventoryRequests > 1) {
        await json(
          route,
          {
            error: {
              code: "pilot_inventory_unavailable",
              message: "Pilot inventory is temporarily unavailable.",
            },
          },
          503,
        );
        return;
      }
      await json(route, [
        {
          id: jobId,
          tenant_id: TENANT_ID,
          source: "activecampaign",
          status: "completed",
          progress: {},
          cursor: {},
          started_at: "2026-08-25T08:00:00Z",
          completed_at: "2026-08-25T09:00:00Z",
          rollback_until: "2026-09-01T09:00:00Z",
          verification_report: {
            subscribers_imported: 120,
            suppression_list_size: 4,
            consent_known: 90,
            consent_unknown: 30,
            custom_fields_mapped: [],
            custom_fields_unmapped: [],
            segments_translated: 2,
            segments_with_warnings: [],
            automations_translated: 1,
            automations_unsupported: [],
            paid_subs_imported: 0,
            archive_imported: 6,
            data_loss_estimate_pct: 0,
          },
          error: null,
        },
        {
          id: "excluded-mailchimp-job",
          tenant_id: TENANT_ID,
          source: "mailchimp",
          status: "completed",
          progress: {},
          cursor: {},
          started_at: "2026-08-24T08:00:00Z",
          completed_at: "2026-08-24T09:00:00Z",
          rollback_until: null,
          verification_report: null,
          error: null,
        },
      ]);
      return;
    }
    if (path === `/api/v1/migrations/${jobId}/pilot-acceptance`) {
      await json(route, {
        job_id: jobId,
        source: "activecampaign",
        generated_at: "2026-08-26T08:00:00Z",
        status: "warning",
        blockers: 0,
        warnings: 1,
        items: [
          {
            key: "consent-review",
            label: "Consent review sign-off",
            status: "warning",
            detail:
              "Thirty imported contacts still require source evidence before activation.",
          },
        ],
      });
      return;
    }
    if (path === `/api/v1/migrations/${jobId}/rollback-rehearsal`) {
      await json(route, {
        job_id: jobId,
        status: "pass",
        rollbackable: true,
        generated_at: "2026-08-26T08:00:00Z",
        detail: "Rollback rehearsal completed without a blocking delta.",
        items: [],
      });
      return;
    }
    if (path === `/api/v1/migrations/${jobId}/shadow-monitor`) {
      await json(route, {
        monitor: {
          job_id: jobId,
          tenant_id: TENANT_ID,
          source: "activecampaign",
          enabled: true,
          interval_seconds: 3600,
          last_checked_at: "2026-08-26T08:00:00Z",
          last_recommended_action: "ready_for_cutover_review",
        },
        history: [],
      });
      return;
    }
    if (path === `/api/v1/migrations/${jobId}/automation-rebuilds`) {
      await json(route, {
        items: Array.from({ length: 11 }, (_, index) => ({
          rank: index + 1,
          source_id: `automation-${index + 1}`,
          name:
            index === 0
              ? "Abandoned-cart-recovery-with-an-intentionally-long-unbroken-name"
              : `Automation ${index + 1}`,
          status: index === 0 ? "blocked" : "test_passed",
          notes:
            index === 0
              ? "Owner review is required before this automation can be enabled."
              : "Test evidence recorded.",
        })),
      });
      return;
    }
    if (path === "/api/v1/sending/readiness") {
      await json(route, {
        ready: false,
        items: [
          {
            key: "warmup-review",
            label: "Review warm-up plan",
            complete: false,
            severity: "warning",
          },
          {
            key: "sender-domain",
            label: "Verify sender domain",
            complete: false,
            severity: "blocker",
          },
        ],
        controls: { tenant_id: TENANT_ID, paused: false, source: "fixture" },
        compliance: {
          exists: true,
          complete: false,
          verified_sender_domain: false,
          list_unsubscribe_enabled: true,
          one_click_unsubscribe_enabled: true,
          missing_physical_address: false,
          missing_compliance_email: false,
          missing_legal_sender_name: false,
        },
        settings: { exists: true, quiet_hours_enabled: false },
        warmup_started: true,
        sending_provisioned: true,
      });
      return;
    }
    if (path === "/api/v1/sms/pilot-readiness") {
      await json(route, {
        can_pilot: false,
        counts: { senders: 2 },
        items: [
          {
            key: "sender-registration",
            label: "Complete carrier registration",
            status: "blocker",
          },
          {
            key: "consent-sample",
            label: "Review consent sample",
            status: "warning",
          },
        ],
      });
      return;
    }
    if (path === "/api/v1/sms/senders/pilot-certifications") {
      const sender = (id: string, phoneNumber: string, canPilot: boolean) => ({
        sender: {
          id,
          provider: "twilio",
          country: "US",
          sender_type: "10dlc",
          phone_number: phoneNumber,
          registration_status: canPilot ? "approved" : "pending",
          created_at: "2026-08-20T08:00:00Z",
          updated_at: "2026-08-26T08:00:00Z",
        },
        can_pilot: canPilot,
        generated_at: "2026-08-26T08:00:00Z",
        items: [
          {
            key: `${id}-registration`,
            label: "Carrier registration",
            status: canPilot ? "pass" : "blocker",
          },
        ],
      });
      await json(route, {
        items: [
          sender("sender-certified", "+14155550101", true),
          sender("sender-pending", "+14155550102", false),
        ],
      });
      return;
    }
    await route.fallback();
  });
  return state;
}

async function openRoute(
  page: Page,
  path: string,
  heading: string,
): Promise<void> {
  const response = await page.goto(path, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  expect(response?.status() ?? 500, `${path}: document status`).toBeLessThan(
    400,
  );
  await expect(
    page.getByRole("heading", { level: 1, name: heading }),
  ).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    page.locator(
      '#main-content [data-slot="page-transition"] [role="status"][aria-label*="Loading"]',
    ),
  ).toHaveCount(0, { timeout: 60_000 });
}

async function certifyRoute(page: Page, path: string, mobile: boolean) {
  const root = page.locator('#main-content [data-slot="page-transition"]');
  const metrics = await root.evaluate((element, checkTouch) => {
    const visible = (node: HTMLElement) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden";
    };
    const targets = checkTouch
      ? Array.from(
          element.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], input:not([type="hidden"]):not(:disabled), textarea:not(:disabled), [role="tab"]',
          ),
        )
          .filter(visible)
          .map((target) => {
            const hit =
              target instanceof HTMLInputElement &&
              ["checkbox", "radio"].includes(target.type)
                ? (target.closest<HTMLElement>("label") ?? target)
                : target;
            const rect = hit.getBoundingClientRect();
            return {
              label:
                target.getAttribute("aria-label") ?? target.textContent?.trim(),
              width: rect.width,
              height: rect.height,
            };
          })
          .filter((target) => target.width < 43.5 || target.height < 43.5)
      : [];
    return {
      mainCount: document.querySelectorAll("main").length,
      h1Count: element.querySelectorAll("h1").length,
      overflow:
        Math.max(
          document.body.scrollWidth,
          document.documentElement.scrollWidth,
        ) - innerWidth,
      targets,
    };
  }, mobile);
  const axe = await new AxeBuilder({ page })
    .include('#main-content [data-slot="page-transition"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = axe.violations.filter((violation) =>
    ["critical", "serious"].includes(violation.impact ?? ""),
  );
  expect.soft(metrics.mainCount, `${path}: one main`).toBe(1);
  expect.soft(metrics.h1Count, `${path}: one h1`).toBe(1);
  expect
    .soft(metrics.overflow, `${path}: viewport overflow`)
    .toBeLessThanOrEqual(1);
  expect.soft(metrics.targets, `${path}: 44px touch targets`).toEqual([]);
  expect.soft(blocking, `${path}: serious/critical axe violations`).toEqual([]);
}

test.describe("operational and admin surface quality", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(() => {
      (
        window as typeof window & {
          __POSTWAVE_FORCE_REAL_API_FOR_E2E__?: boolean;
        }
      ).__POSTWAVE_FORCE_REAL_API_FOR_E2E__ = true;
    });
    await page.route("**/api/health", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "ok" }),
      }),
    );
    await loginAsDemo(page, { navigate: false });
    await installOperationalFixtures(page);
  });

  for (const viewport of [
    { label: "desktop", width: 1280, height: 900 },
    { label: "320px", width: 320, height: 800 },
  ]) {
    test(`${viewport.label}: all 8 route patterns are responsive and accessible`, async ({
      page,
    }) => {
      test.slow();
      await page.setViewportSize(viewport);
      for (const route of ROUTES) {
        await openRoute(page, route.path, route.heading);
        await certifyRoute(page, route.path, viewport.width === 320);
      }
    });
  }

  test("alert credentials are verified transiently and stream tokens are one-time", async ({
    page,
  }) => {
    const state = await installOperationalFixtures(page);
    await openRoute(page, "/app/alerting-access", "Alerting and access");
    await page.getByLabel("Routing key").fill("pagerduty-routing-key");
    await page.getByRole("button", { name: "Verify PagerDuty" }).click();
    await expect(
      page.getByText(/routing-key shape was accepted/u),
    ).toBeVisible();
    await expect(page.getByLabel("Routing key")).toHaveValue("");
    await page.getByRole("button", { name: "Mint token" }).click();
    await expect(
      page.getByText("stream_ops_matrix_full_value_123456789"),
    ).toBeVisible();
    const streamRegion = page.getByRole("region", { name: "Stream token" });
    await expect(
      streamRegion.getByRole("button", { name: "Mint token" }),
    ).toBeDisabled();
    await streamRegion.getByRole("button", { name: "Hide" }).click();
    await expect(
      page.getByText("stream_ops_matrix_full_value_123456789"),
    ).toHaveCount(0);
    await expect(
      streamRegion.getByRole("button", { name: "Mint token" }),
    ).toBeEnabled();
    expect(state.alertVerifications).toBe(1);
    expect(state.tokenMints).toBe(1);
  });

  test("signing-secret rotation keeps the address and reveals the full secret once", async ({
    page,
  }) => {
    const state = await installOperationalFixtures(page);
    await openRoute(page, "/app/alerting-access", "Alerting and access");
    await page.locator("#aa-confirm").fill("rotate");
    await page.getByRole("button", { name: "Rotate signing secret" }).click();
    await expect(
      page.getByText("inbound_ops_matrix_full_secret_123456789"),
    ).toBeVisible();
    await expect(
      page.getByText("stable-inbound-address", { exact: true }),
    ).toBeVisible();
    const rotationRegion = page.getByRole("region", {
      name: "Rotate inbound signing secret",
    });
    await rotationRegion.getByRole("button", { name: "Hide" }).click();
    await expect(
      page.getByText("inbound_ops_matrix_full_secret_123456789"),
    ).toHaveCount(0);
    expect(state.rotations).toBe(1);
  });

  test("approval rejection requires a reason and records one decision", async ({
    page,
  }) => {
    const state = await installOperationalFixtures(page);
    await openRoute(page, `/app/approvals/${APPROVAL_ID}`, "Approval review");
    await page.getByRole("button", { name: "Reject" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Reject" })
      .click();
    await expect(page.getByText(/rejection reason is required/u)).toBeVisible();
    await page
      .getByLabel("Reason (required)")
      .fill("Consent evidence is missing.");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Reject" })
      .click();
    expect(state.approvalRejections).toBe(1);
  });

  test("notifications can be filtered and a destination-less item can be read", async ({
    page,
  }) => {
    const state = await installOperationalFixtures(page);
    await openRoute(page, "/app/notifications", "Notifications");
    await page.getByRole("tab", { name: /unread/iu }).click();
    await page.getByRole("button", { name: "Mark read" }).click();
    await expect.poll(() => state.notificationReads).toBe(1);
  });

  test("all maintenance controls preserve empty, warning, policy, and viewer-mode truth", async ({
    page,
  }) => {
    const state = await installOperationalFixtures(page);
    await openRoute(page, "/app/maintenance", "Maintenance");
    const results = page.getByRole("region", { name: "Session results" });
    const actions = [
      ["Spam-trap sweep", /blocklisted 2/u],
      ["Soft-bounce recovery", /No completion time was returned/u],
      ["Firewall detection", /left attack mode unchanged/u],
      ["Recheck DNS", /3 sending identity\/identities rechecked/u],
      ["Recompute predictions", /model model-v2/u],
      ["Recompute ratings", /nothing was scanned/u],
      ["Due warehouse runs", /2 warehouse run\(s\) are due/u],
      ["Re-engagement preview", /We saved your place/u],
      ["Validate zero-copy trigger", /valid, but sample warehouse/u],
      ["Validate onsite growth", /not valid — form is missing/u],
      ["Preview transforms", /ran over no records/u],
      ["Validate social capture", /valid, but SMS consent handoff/u],
      ["Publish test event", /not on the client-publishable allow-list/u],
    ] as const;

    for (const [index, [label, confirmation]] of actions.entries()) {
      await page.getByRole("button", { name: label, exact: true }).click();
      const result = results
        .getByRole("listitem")
        .filter({ hasText: confirmation });
      await expect(result).toBeVisible();
      if (index === 0) {
        await result.evaluate((row) => {
          row.setAttribute("data-stable-result", "true");
        });
      } else if (index === 1) {
        await expect(
          results.getByRole("listitem").filter({ hasText: /blocklisted 2/u }),
        ).toHaveAttribute("data-stable-result", "true");
      }
    }
    await expect(
      results.getByText(/also warns — fallback audience/u),
    ).toBeVisible();

    await page
      .getByRole("button", { name: "Enter viewer mode", exact: true })
      .click();
    await expect(results.getByText(/Viewer mode on/u)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Spam-trap sweep", exact: true }),
    ).toBeDisabled();
    const leaveViewerMode = page.getByRole("button", {
      name: "Leave viewer mode",
      exact: true,
    });
    await expect(leaveViewerMode).toBeEnabled();
    await expect(leaveViewerMode).toBeFocused();
    await expect(
      results.getByRole("button", { name: "Clear", exact: true }),
    ).toBeEnabled();
    await leaveViewerMode.click();
    await expect(results.getByText(/Viewer mode off/u)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Spam-trap sweep", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Enter viewer mode", exact: true }),
    ).toBeFocused();

    await expect.poll(() => state.maintenanceRuns).toBe(15);
    await expect(results.getByRole("listitem")).toHaveCount(16);
    await expect(results.getByRole("listitem").first()).toContainText(
      "Viewer mode off",
    );
    await results.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(
      results.getByText("No maintenance action has run in this session."),
    ).toBeVisible();
    await expect(results.getByRole("listitem")).toHaveCount(0);
  });

  test("pilot tabs expose excluded-source truth and accessible status disclosure", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await openRoute(page, "/app/pilot", "Pilot readiness");
    await expect(page.getByText(/excluded from pilot evidence/u)).toBeVisible();
    const disclosure = page.getByRole("button", { name: /failing check/u });
    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await page.getByRole("tab", { name: "Automation rebuilds" }).click();
    await expect(page.getByText("No in-scope pilot migrations")).toBeVisible();
    await page.getByRole("tab", { name: "SMS senders" }).click();
    await expect(page.getByText("No SMS sender certifications")).toBeVisible();
    await page.getByRole("tab", { name: "Migration jobs" }).click();
    await expect(page.getByText("No in-scope pilot migrations")).toBeVisible();
    await certifyRoute(page, "/app/pilot", true);
  });

  test("pilot tabs retain dense evidence and the last good snapshot after refresh failure", async ({
    page,
  }) => {
    const state = await installRichPilotFixtures(page);
    await page.setViewportSize({ width: 320, height: 800 });
    await openRoute(page, "/app/pilot", "Pilot readiness");
    await expect(page.getByText(/1 migration excluded/u)).toBeVisible();
    await expect(
      page.getByRole("progressbar", { name: "Consent coverage: 75% known" }),
    ).toBeVisible();
    await expect(page.getByText("Consent review sign-off")).toBeVisible();

    const emailTile = page.getByRole("region", { name: "Email", exact: true });
    const smsTile = page.getByRole("region", { name: "SMS", exact: true });
    const emailDisclosure = emailTile.getByRole("button", {
      name: /2 failing checks/u,
    });
    await expect(emailDisclosure).toHaveCount(1);
    await expect(
      smsTile.getByRole("button", { name: /2 failing checks/u }),
    ).toHaveCount(1);
    await emailDisclosure.click();
    await expect(emailDisclosure).toHaveAttribute("aria-expanded", "true");
    await expect(emailTile.getByText("Verify sender domain")).toBeVisible();

    await page.getByRole("tab", { name: "Automation rebuilds" }).click();
    await expect(
      page.getByText(
        "#1 Abandoned-cart-recovery-with-an-intentionally-long-unbroken-name",
      ),
    ).toBeVisible();
    await expect(page.getByText("Showing 10 of 11 rebuilds.")).toBeVisible();
    await expect(page.getByText("#11 Automation 11")).toHaveCount(0);

    await page.getByRole("tab", { name: "SMS senders" }).click();
    await expect(page.getByText("+14155550101", { exact: true })).toBeVisible();
    await expect(page.getByText("+14155550102", { exact: true })).toBeVisible();
    await expect(page.getByText("certified", { exact: true })).toBeVisible();
    await expect(page.getByText("blocked", { exact: true })).toBeVisible();

    await page.getByRole("tab", { name: "Migration jobs" }).click();
    await expect(
      page.getByText("activecampaign", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Showing 1 of 1 in-scope job.")).toBeVisible();
    state.failInventory = true;
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(
      page.getByRole("alert").getByText("Refresh failed"),
    ).toBeVisible({
      timeout: 60_000,
    });
    await expect(
      page.getByText("activecampaign", { exact: true }),
    ).toBeVisible();
    expect(state.inventoryRequests).toBeGreaterThanOrEqual(2);
    await certifyRoute(page, "/app/pilot", true);
  });
});

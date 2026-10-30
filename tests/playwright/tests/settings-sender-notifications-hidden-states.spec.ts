import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

import { loginAsDemo } from "../helpers/auth";

const profile = {
  tenant_id: "00000000-0000-0000-0000-000000000001",
  legal_sender_name: "Moosewave Studio",
  physical_address_line1: "1 Market Street",
  physical_address_line2: "Suite 900",
  physical_address_city: "San Francisco",
  physical_address_region: "CA",
  physical_address_postal_code: "94105",
  physical_address_country: "US",
  compliance_contact_email: "compliance@example.test",
  default_footer_text: "You are receiving this because you subscribed.",
  list_unsubscribe_enabled: true,
  one_click_unsubscribe_enabled: true,
  verified_sender_domain: true,
};

const control = {
  tenant_id: profile.tenant_id,
  paused: false,
  source: "tenant",
};

const readiness = {
  ready: true,
  items: [
    {
      key: "sender_domain",
      label: "Sender domain verified",
      complete: true,
      severity: "blocker",
      detail: "SPF, DKIM, and DMARC are aligned for example.test.",
    },
  ],
  controls: control,
  compliance: {
    exists: true,
    complete: true,
    verified_sender_domain: true,
    list_unsubscribe_enabled: true,
    one_click_unsubscribe_enabled: true,
    legal_sender_name: profile.legal_sender_name,
    compliance_contact_email: profile.compliance_contact_email,
    missing_physical_address: false,
    missing_compliance_email: false,
    missing_legal_sender_name: false,
  },
  settings: {
    exists: true,
    max_sends_per_hour: 500,
    quiet_hours_start: "22:00",
    quiet_hours_end: "07:00",
    quiet_hours_tz: "America/Los_Angeles",
    quiet_hours_enabled: true,
    fallback_hour_utc: 9,
  },
  warmup_started: true,
  warmup_day: 4,
  todays_cap: 500,
  todays_sent: 120,
  sending_provisioned: true,
};

const sendingSettings = {
  tenant_id: profile.tenant_id,
  max_sends_per_hour: 500,
  quiet_hours_start: "22:00",
  quiet_hours_end: "07:00",
  quiet_hours_tz: "America/Los_Angeles",
  quiet_hours_per_recipient: true,
  fallback_hour_utc: 9,
  ip_pool: null,
  updated_at: "2026-08-30T08:00:00Z",
};

const notificationPrefs = {
  user_id: "00000000-0000-0000-0000-000000000002",
  tenant_id: profile.tenant_id,
  email_on_send_complete: true,
  email_on_approval_request: true,
  email_on_bounce_alert: true,
  email_on_deliverability_alert: true,
  email_on_usage_alert: true,
  inapp_on_send_complete: true,
  inapp_on_approval_request: true,
  inapp_on_bounce_alert: false,
  inapp_on_deliverability_alert: true,
  inapp_on_usage_alert: true,
  webhook_on_send_complete: false,
  webhook_on_approval_request: false,
  webhook_on_bounce_alert: false,
  webhook_on_deliverability_alert: false,
  webhook_on_usage_alert: false,
  notification_webhook_url: "",
  notification_webhook_kind: "slack",
  digest_frequency: "weekly",
  usage_alert_threshold_pct: 0,
};

async function respond(
  route: Route,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
) {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers,
    body: JSON.stringify(body),
  });
}

async function expectNoDocumentOverflow(page: Page) {
  const geometry = await page.evaluate(() => ({
    viewport: window.innerWidth,
    html: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(Math.max(geometry.html, geometry.body)).toBeLessThanOrEqual(
    geometry.viewport + 1,
  );
}

test.describe("sender + notification settings hidden states", () => {
  test.describe.configure({ mode: "serial" });

  test("sender protects failed baselines, retries, and wires the footer at 320px", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 780 });
    let failReads = true;
    let currentProfile = { ...profile };
    let savedPayload: Record<string, unknown> | null = null;

    // Keep this route self-contained when it runs against the source web app,
    // not only the full Docker stack. Sender settings waits for the resolved
    // tenant before loading its exact full-replace baselines.
    await page.route("**/api/v1/auth/me", (route) =>
      respond(route, 200, {
        user_id: "00000000-0000-0000-0000-000000000002",
        tenant_id: profile.tenant_id,
        email: "owner@example.test",
        role: "owner",
        effective_role: "owner",
        auth_provider: "password",
        email_verified: true,
        workspace_name: "Moosewave Studio",
        workspace_slug: "demo",
      }),
    );

    await page.route("**/api/v1/settings/email-compliance", async (route) => {
      if (route.request().method() === "PUT") {
        savedPayload = route.request().postDataJSON() as Record<
          string,
          unknown
        >;
        currentProfile = { ...currentProfile, ...savedPayload };
        await respond(route, 200, currentProfile);
        return;
      }
      await respond(
        route,
        failReads ? 503 : 200,
        failReads
          ? { error: { message: "sender baseline offline" } }
          : currentProfile,
      );
    });
    await page.route("**/api/v1/sending/controls", (route) =>
      respond(
        route,
        failReads ? 503 : 200,
        failReads ? { error: { message: "sender baseline offline" } } : control,
      ),
    );
    await page.route("**/api/v1/sending/readiness", (route) =>
      respond(
        route,
        failReads ? 503 : 200,
        failReads
          ? { error: { message: "sender baseline offline" } }
          : readiness,
      ),
    );
    await page.route("**/api/v1/settings/sending", (route) =>
      respond(
        route,
        failReads ? 503 : 200,
        failReads
          ? { error: { message: "sender baseline offline" } }
          : sendingSettings,
      ),
    );
    await page.route("**/api/v1/auth-checks", (route) =>
      respond(route, 200, [
        {
          domain: "an-extraordinarily-long-sending-domain.example.test",
          spf: { status: "ok", detail: "Includes the production provider" },
          dkim: { status: "ok", detail: "Selector is aligned" },
          dmarc: { status: "warn", detail: "Policy is still monitoring" },
          bimi: { status: "warn", detail: "Not configured" },
          ptr: { status: "ok", detail: "Aligned" },
        },
      ]),
    );

    await loginAsDemo(page, { navigate: false });
    await page.goto("/app/settings/sender");
    const retry = page.getByRole("button", { name: "Retry sender settings" });
    await expect(retry).toBeVisible();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Existing sender values remain protected" }),
    ).toBeFocused();
    await expect(page.locator("#legal-sender-name")).toHaveCount(0);
    await expect(page.locator("#cap")).toHaveCount(0);
    await expect(page.getByText(/cannot be overwritten/i)).toHaveCount(2);

    failReads = false;
    await retry.click();
    await expect(page.locator("#legal-sender-name")).toHaveValue(
      "Moosewave Studio",
    );
    await expect(page.locator("#cap")).toHaveValue("500");

    const footer = page.locator("#default-footer-text");
    await footer.fill("Updated footer for every supported commercial send.");
    const save = page.getByRole("button", {
      name: "Save compliance profile",
    });
    await expect(save).toBeEnabled();
    await save.click();
    await expect.poll(() => savedPayload).not.toBeNull();
    expect(savedPayload).toEqual(
      expect.objectContaining({
        default_footer_text:
          "Updated footer for every supported commercial send.",
      }),
    );
    expect(savedPayload).not.toHaveProperty("verified_sender_domain");

    await page.getByRole("button", { name: "Pause sends" }).click();
    const dialog = page.getByRole("dialog", { name: "Pause email sending" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(
      page.getByRole("button", { name: "Pause sends" }),
    ).toBeFocused();
    await expectNoDocumentOverflow(page);
  });

  test("sender retains the last verified baseline read-only after a refresh fails", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    let failReads = false;
    let currentProfile = { ...profile };
    let currentSendingSettings = { ...sendingSettings };

    await page.route("**/api/v1/auth/me", (route) =>
      respond(route, 200, {
        user_id: "00000000-0000-0000-0000-000000000002",
        tenant_id: profile.tenant_id,
        email: "owner@example.test",
        role: "owner",
        effective_role: "owner",
        auth_provider: "password",
        email_verified: true,
        workspace_name: "Moosewave Studio",
        workspace_slug: "demo",
      }),
    );
    await page.route("**/api/v1/settings/email-compliance", async (route) => {
      if (route.request().method() === "PUT") {
        currentProfile = {
          ...currentProfile,
          ...(route.request().postDataJSON() as Record<string, unknown>),
        } as typeof currentProfile;
        // The write succeeds, then its cache invalidation encounters a failed
        // refresh. This is the exact retained-data state that an initial 503
        // cannot exercise.
        failReads = true;
        await respond(route, 200, currentProfile);
        return;
      }
      await respond(
        route,
        failReads ? 503 : 200,
        failReads
          ? { error: { message: "current sender refresh unavailable" } }
          : currentProfile,
      );
    });
    await page.route("**/api/v1/sending/controls", (route) =>
      respond(
        route,
        failReads ? 503 : 200,
        failReads
          ? { error: { message: "current sender refresh unavailable" } }
          : control,
      ),
    );
    await page.route("**/api/v1/sending/readiness", (route) =>
      respond(
        route,
        failReads ? 503 : 200,
        failReads
          ? { error: { message: "current sender refresh unavailable" } }
          : readiness,
      ),
    );
    await page.route("**/api/v1/settings/sending", async (route) => {
      if (route.request().method() === "PUT") {
        currentSendingSettings = {
          ...currentSendingSettings,
          ...(route.request().postDataJSON() as Record<string, unknown>),
          updated_at: "2026-08-30T08:01:00Z",
        } as typeof currentSendingSettings;
        // The committed R2 response is canonical. Its aggregate invalidation
        // then fails, exercising the retained post-write baseline rather than
        // merely retaining the pre-write R1 read.
        failReads = true;
        await respond(route, 200, currentSendingSettings, {
          "x-postwave-sending-cap-outcome": "committed",
        });
        return;
      }
      await respond(
        route,
        failReads ? 503 : 200,
        failReads
          ? { error: { message: "current sender refresh unavailable" } }
          : currentSendingSettings,
      );
    });
    await page.route("**/api/v1/auth-checks", (route) =>
      respond(route, 200, []),
    );

    await loginAsDemo(page, { navigate: false });
    await page.goto("/app/settings/sender");
    await expect(page.locator("#cap")).toHaveValue("500");
    await expect(page.locator("#legal-sender-name")).toHaveValue(
      "Moosewave Studio",
    );

    await page.locator("#cap").fill("750");
    await page.getByRole("button", { name: "Save sending limits" }).click();

    const staleNotice = page.getByRole("status").filter({
      hasText: "Showing the last verified sender settings.",
    });
    await expect(staleNotice).toContainText(
      "Every sender and sending-policy control is read-only",
    );
    await expect(page.locator("#cap")).toHaveValue("750");
    await expect(page.locator("#cap")).toBeDisabled();
    await expect(page.locator("#legal-sender-name")).toHaveValue(
      "Moosewave Studio",
    );
    await expect(page.locator("#legal-sender-name")).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Pause sends" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Verify current settings" }),
    ).toBeVisible();
    await expectNoDocumentOverflow(page);
    const axe = await new AxeBuilder({ page })
      .include("main#main-content")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(
      axe.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
      JSON.stringify(axe.violations, null, 2),
    ).toEqual([]);

    const screenshotPath = testInfo.outputPath(
      "sender-stale-last-verified-390.png",
    );
    await page.locator("main#main-content").evaluate((main) => {
      main.scrollTop = 0;
    });
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach("sender-stale-last-verified-390", {
      path: screenshotPath,
      contentType: "image/png",
    });
  });

  test("notifications protects failed preferences and round-trips editable numeric state at 320px", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 780 });
    let failRead = true;
    let savedPayload: Record<string, unknown> | null = null;

    await page.route("**/api/v1/settings/notifications", async (route) => {
      if (route.request().method() === "PATCH") {
        savedPayload = route.request().postDataJSON() as Record<
          string,
          unknown
        >;
        await respond(route, 200, { ...notificationPrefs, ...savedPayload });
        return;
      }
      await respond(
        route,
        failRead ? 503 : 200,
        failRead
          ? { error: { message: "notification preferences offline" } }
          : notificationPrefs,
      );
    });
    await page.route(
      "**/api/v1/notifications/web-push/vapid-public-key",
      (route) => respond(route, 200, { enabled: false, public_key: "" }),
    );

    await loginAsDemo(page, { navigate: false });
    await page.goto("/app/settings/notifications");
    const retry = page.getByRole("button", { name: "Retry preferences" });
    await expect(retry).toBeVisible();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "notification preferences offline" }),
    ).toBeFocused();
    await expect(
      page.getByRole("region", { name: "Notification preferences" }),
    ).toHaveCount(0);

    failRead = false;
    await retry.click();
    const matrix = page.getByRole("region", {
      name: "Notification preferences",
    });
    await expect(matrix).toBeVisible();
    await expect(
      page.getByLabel("Bounce-rate alerts — In-app", { exact: true }),
    ).not.toBeChecked();

    const threshold = page.getByLabel("Usage alert threshold");
    await threshold.fill("");
    await expect(threshold).toHaveValue("");
    await threshold.fill("12.5");
    await expect(threshold).toHaveAttribute("aria-invalid", "true");
    await expect(
      page.getByRole("button", { name: "Save preferences" }),
    ).toBeDisabled();
    await threshold.fill("42");
    await page.getByRole("button", { name: "Save preferences" }).click();
    await expect.poll(() => savedPayload).not.toBeNull();
    expect(savedPayload).toEqual(
      expect.objectContaining({ usage_alert_threshold_pct: 42 }),
    );

    const matrixGeometry = await matrix.evaluate((node) => ({
      client: node.clientWidth,
      scroll: node.scrollWidth,
    }));
    expect(matrixGeometry.scroll).toBeGreaterThan(matrixGeometry.client);
    await expectNoDocumentOverflow(page);
  });
});

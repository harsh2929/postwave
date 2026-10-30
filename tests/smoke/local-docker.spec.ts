import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

const API_URL = process.env.POSTWAVE_API_URL || "http://localhost:8080";
const WEB_URL = process.env.POSTWAVE_WEB_URL || "http://localhost:3000";

const DASHBOARD_ROUTES = [
  "/app",
  "/app/subscribers",
  "/app/subscribers/segments",
  "/app/subscribers/segments/new",
  "/app/campaigns",
  "/app/compatibility",
  "/app/forms",
  "/app/forms/new",
  "/app/migrations",
  "/app/migrations/new/mailchimp",
  "/app/inbox-reality",
  "/app/inbox-reality/predict",
  "/app/sequences",
  "/app/sequences/new",
  "/app/sequences/voice-profile",
  "/app/templates",
  "/app/templates/new",
  "/app/billing",
  "/app/settings",
  "/app/settings/api",
  "/app/settings/domain",
  "/app/settings/sender",
  "/app/settings/topics",
  "/app/settings/webhooks",
  "/app/settings/notifications",
  "/app/settings/audit",
  "/app/settings/security",
  "/app/settings/privacy",
  "/app/settings/team",
  "/app/subscribers/paid-members",
  "/app/affiliates",
] as const;

const PUBLIC_ROUTES = [
  "/",
  "/features",
  "/pricing",
  "/docs",
  "/migrations",
  "/migrations/mailchimp",
  "/status",
] as const;

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext();
  try {
    await expectHealth(request, API_URL);
    await expectHealth(request, WEB_URL);
  } finally {
    await request.dispose();
  }
});

test.describe("web API proxy", () => {
  test("proxies API health", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  test("injects local tenant header for browser API calls", async ({
    request,
  }) => {
    const res = await request.get("/api/v1/subscribers?page=1&per_page=1");
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ page: 1, per_page: 1 });
  });

  test("keeps the unqualified affiliate admin tree unavailable", async ({
    request,
  }) => {
    const res = await request.get("/api/v1/admin/affiliates");
    expect(res.status()).toBe(404);
  });

  test("keeps local billing actions configured", async ({ request }) => {
    const portal = await request.post("/api/v1/billing/portal");
    expect(portal.status()).toBe(200);
    expect((await portal.json()).url).toContain("/app/billing?portal=local");

    const invoices = await request.get("/api/v1/billing/invoices");
    expect(invoices.status()).toBe(200);
    expect(Array.isArray(await invoices.json())).toBe(true);

    const usage = await request.get("/api/v1/billing/usage");
    expect(usage.status()).toBe(200);
    expect(Array.isArray(await usage.json())).toBe(true);

    for (const tier of ["studio_ltd", "studio_ltd_cloud", "studio_ltd_plus"]) {
      const checkout = await request.post("/api/v1/billing/checkout", {
        data: { tier },
      });
      expect(checkout.status(), tier).toBe(200);
      expect((await checkout.json()).url).toContain(
        `/app/billing/upgrade?checkout=${tier}`,
      );
    }
  });

  test("queues and downloads a local privacy export bundle", async ({
    request,
  }) => {
    const queued = await request.post("/api/v1/privacy/export-requests", {
      data: { region: "GDPR", notes: "local smoke export" },
    });
    expect(queued.status()).toBe(202);
    const body = await queued.json();
    expect(body).toMatchObject({
      request_id: expect.stringMatching(/^prv_data-export_/),
      status: "queued",
    });

    const bundle = await request.get(
      `/api/v1/privacy/export-requests/${encodeURIComponent(
        body.request_id,
      )}/download`,
    );
    expect(bundle.status()).toBe(200);
    expect(bundle.headers()["content-type"]).toContain("application/zip");
    expect(bundle.headers()["content-disposition"]).toContain(".zip");
    expect((await bundle.body()).length).toBeGreaterThan(100);
  });

  test("uses local migration demo handoffs instead of raw provider setup errors", async ({
    request,
  }) => {
    for (const source of ["mailchimp", "convertkit"]) {
      const res = await request.post(
        `/api/v1/migrations/${source}/oauth/start`,
      );
      expect(res.status(), source).toBe(200);
      const body = await res.json();
      expect(body.authorize_url).toContain("/app/migrations/oauth/callback");
      expect(body.authorize_url).toContain(`source=${source}`);
      expect(body.authorize_url).not.toMatch(/[?&]client_id=(&|$)/);
    }

    for (const source of ["beehiiv", "mailerlite", "csv", "substack"]) {
      const res = await request.post(
        `/api/v1/migrations/${source}/credentials`,
        {
          data: {
            api_key: "local-demo",
            account_id: "local-fixture",
            extra: { file_name: "subscribers.csv" },
          },
        },
      );
      expect(res.status(), source).toBe(200);
      expect(await res.json()).toHaveProperty("job_id");
    }
  });

  test("all migration sources expose parity metadata for transition gaps", async ({
    request,
  }) => {
    const sources = [
      "mailchimp",
      "convertkit",
      "beehiiv",
      "mailerlite",
      "csv",
      "substack",
    ] as const;

    const capabilities = await request.get("/api/v1/migrations/sources");
    expect(capabilities.status()).toBe(200);
    const capabilityRows = await capabilities.json();
    for (const source of sources) {
      const caps = capabilityRows.find((row: any) => row.source === source);
      expect(caps, source).toBeTruthy();
      expect(caps.supports, source).toHaveProperty("campaigns");
      expect(caps.supports, source).toHaveProperty("forms");
      expect(caps.supports, source).toHaveProperty("landing_pages");
      expect(caps.supports, source).toHaveProperty("ecommerce");
    }

    for (const source of sources) {
      let jobId = "";
      if (source === "mailchimp" || source === "convertkit") {
        const start = await request.post(
          `/api/v1/migrations/${source}/oauth/start`,
        );
        expect(start.status(), source).toBe(200);
        const body = await start.json();
        const callbackURL = new URL(body.authorize_url, WEB_URL);
        const callback = await request.get(
          `/api/v1/migrations/${source}/oauth/callback`,
          {
            params: {
              code: callbackURL.searchParams.get("code") ?? "",
              state: callbackURL.searchParams.get("state") ?? "",
            },
          },
        );
        expect(callback.status(), source).toBe(200);
        jobId = (await callback.json()).job_id;
      } else {
        const connected = await request.post(
          `/api/v1/migrations/${source}/credentials`,
          {
            data: {
              api_key: "local-demo",
              account_id: "local-fixture",
              extra: { file_name: "subscribers.csv" },
            },
          },
        );
        expect(connected.status(), source).toBe(200);
        jobId = (await connected.json()).job_id;
      }

      const discovery = await request.post(
        `/api/v1/migrations/${source}/discover`,
        { data: { job_id: jobId } },
      );
      expect(discovery.status(), source).toBe(200);
      const body = await discovery.json();
      expect(body.resource_metadata, source).toEqual(expect.any(Array));
      expect(body.resource_metadata.length, source).toBeGreaterThan(0);
      expect(
        body.resource_metadata.some(
          (row: any) => row.status === "not_supported",
        ),
        source,
      ).toBe(true);
    }
  });

  test("reports production readiness and manages suppressions", async ({
    request,
  }) => {
    const readiness = await request.get("/api/v1/readiness/production");
    expect(readiness.status()).toBe(200);
    expect(await readiness.json()).toMatchObject({
      environment: expect.any(String),
      groups: expect.any(Array),
      status: expect.stringMatching(/^(ok|warning|blocked)$/),
    });

    const email = `suppression-${Date.now()}@example.com`;
    const created = await request.post("/api/v1/suppressions", {
      data: {
        email,
        reason: "complaint",
        source: "local-smoke",
        provider_event_id: `evt_${Date.now()}`,
        metadata: { provider: "postmark" },
      },
    });
    expect(created.status()).toBe(201);
    const suppression = await created.json();
    expect(suppression).toMatchObject({
      email,
      reason: "complaint",
      source: "local-smoke",
    });

    const listed = await request.get(
      `/api/v1/suppressions?email=${encodeURIComponent(email)}`,
    );
    expect(listed.status()).toBe(200);
    expect((await listed.json()).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: suppression.id, email }),
      ]),
    );

    const deleted = await request.delete(
      `/api/v1/suppressions/${suppression.id}`,
    );
    expect(deleted.status()).toBe(204);
  });

  test("admin surfaces (audit, security, paywall, DLQ, drip funnel) respond", async ({
    request,
  }) => {
    // Audit log read — empty list is fine; we just want a 200.
    const audit = await request.get("/api/v1/audit?limit=10");
    expect(audit.status()).toBe(200);
    expect(await audit.json()).toMatchObject({ rows: expect.any(Array) });

    // Security settings: GET should return defaults for a fresh tenant.
    const sec = await request.get("/api/v1/security/settings");
    expect(sec.status()).toBe(200);
    const secBody = await sec.json();
    expect(secBody).toEqual(
      expect.objectContaining({
        require_2fa_for_admins: expect.any(Boolean),
        require_2fa_for_all: expect.any(Boolean),
      }),
    );
    // Toggle on, then off, to prove PUT round-trips.
    const updated = await request.put("/api/v1/security/settings", {
      data: { ...secBody, require_2fa_for_admins: true },
    });
    expect(updated.status()).toBe(200);
    expect((await updated.json()).require_2fa_for_admins).toBe(true);
    const reset = await request.put("/api/v1/security/settings", {
      data: { ...secBody, require_2fa_for_admins: false },
    });
    expect(reset.status()).toBe(200);

    // Paywall — list paid members + grant + revoke a synthetic one.
    const stamp = Date.now();
    const paidEmail = `paid-${stamp}@example.com`;
    const grant = await request.post("/api/v1/paid-members", {
      data: { subscriber_email: paidEmail, tier: "Smoke" },
    });
    expect(grant.status()).toBe(200);
    const list = await request.get("/api/v1/paid-members");
    expect(list.status()).toBe(200);
    const members: Array<{ subscriber_email: string }> = (await list.json())
      .members;
    expect(members.some((m) => m.subscriber_email === paidEmail)).toBe(true);
    const revoke = await request.delete(
      `/api/v1/paid-members/${encodeURIComponent(paidEmail)}`,
    );
    expect(revoke.status()).toBe(200);

    // DLQ inspection — empty is the expected steady state in smoke.
    const dlq = await request.get("/api/v1/dlq");
    expect(dlq.status()).toBe(200);
  });
});

test.describe("dashboard routes", () => {
  for (const route of DASHBOARD_ROUTES) {
    test(`${route} renders without visible runtime errors`, async ({
      page,
    }) => {
      const errors = collectRuntimeErrors(page);
      const apiFailures = collectAPIFailures(page);
      const response = await page.goto(route, { waitUntil: "networkidle" });

      expect(response?.status(), route).toBeLessThan(500);
      await expect(page.locator("body")).not.toContainText(
        /Application error|Internal Server Error/i,
      );
      await expect(page.locator("body")).not.toContainText(
        /Could not (load|save|fetch)/i,
      );
      if (route === "/app") {
        await expect(page.getByText("online")).toBeVisible();
      }
      expect(errors, `${route} page errors`).toEqual([]);
      expect(
        apiFailures.filter((failure) => !isAllowedAPIFailure(route, failure)),
      ).toEqual([]);
    });
  }
});

test.describe("public routes", () => {
  for (const route of PUBLIC_ROUTES) {
    test(`${route} renders`, async ({ page }) => {
      const errors = collectRuntimeErrors(page);
      const response = await page.goto(route, { waitUntil: "networkidle" });

      expect(response?.status(), route).toBeLessThan(500);
      await expect(page.locator("body")).not.toContainText(
        /Application error|Internal Server Error/i,
      );
      expect(errors, `${route} page errors`).toEqual([]);
    });
  }

  test("status subscription redirects back to status page", async ({
    page,
  }) => {
    await page.goto("/status");
    await page.getByLabel("Email").fill(`qa-status-${Date.now()}@example.com`);
    await page.getByRole("button", { name: "Subscribe" }).click();
    await expect(page).toHaveURL(/\/status\?subscribed=1$/);
    await expect(
      page.getByText("You're subscribed to status updates."),
    ).toBeVisible();
  });
});

test.describe("critical product flows", () => {
  test("hosted form can be created, published, rendered, and submitted", async ({
    page,
    request,
  }) => {
    const slug = `smoke-${Date.now()}`;
    const create = await request.post("/api/v1/forms", {
      data: {
        slug,
        name: "Smoke Form",
        optInMode: "single",
        successMessage: "Thanks",
      },
    });
    expect(create.status()).toBe(201);
    const form = await create.json();

    const publish = await request.patch(`/api/v1/forms/${form.id}`, {
      data: { status: "published" },
    });
    expect(publish.status()).toBe(200);

    await page.goto(`/forms/${slug}`, { waitUntil: "networkidle" });
    await expect(page.getByRole("button", { name: "Subscribe" })).toBeVisible();
    const email = `smoke-form-${Date.now()}@example.com`;
    await page.locator('input[name="email"]').fill(email);
    const consent = page.getByLabel(/agree/i);
    if (await consent.isVisible()) {
      await consent.check();
    }
    await page.getByRole("button", { name: "Subscribe" }).click();
    await expect(page).toHaveURL(/\/forms\/success\?/);

    const csv = await request.get(`/api/v1/forms/${form.id}/submissions.csv`);
    expect(csv.status()).toBe(200);
    expect(await csv.text()).toContain(email);

    await page.goto(`/app/forms/${form.id}/submissions`, {
      waitUntil: "networkidle",
    });
    const href = await page
      .getByRole("link", { name: /export csv/i })
      .getAttribute("href");
    expect(href).toBe(`/api/v1/forms/${form.id}/submissions.csv`);
  });

  test("mailchimp migration demo connects, discovers, and dry-runs locally", async ({
    page,
  }) => {
    await page.goto("/app/migrations/new/mailchimp", {
      waitUntil: "networkidle",
    });
    await page
      .getByRole("button", { name: /continue with mailchimp/i })
      .click();

    await expect(page).toHaveURL(
      /\/app\/migrations\/new\/mailchimp\?step=discover&job_id=/,
      {
        timeout: 10000,
      },
    );
    const main = page.locator("#main-content");
    await expect(main.getByText("What we found")).toBeVisible({
      timeout: 10000,
    });
    await expect(main.getByText("Subscribers", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: /run dry-run/i }).click();
    await expect(main.getByText("Dry-run report")).toBeVisible({
      timeout: 10000,
    });
    await expect(main.getByText("Goal-based welcome")).toBeVisible();
  });

  test("topic subscribe and unsubscribe routes match SDK/OpenAPI contract", async ({
    request,
  }) => {
    const slug = `smoke-topic-${Date.now()}`;
    const create = await request.post("/api/v1/topics", {
      data: {
        slug,
        name: "Smoke Topic",
        default_opt_in: true,
        display_order: 3,
      },
    });
    expect(create.status()).toBe(201);
    const topic = await create.json();
    expect(topic.defaultOptIn).toBe(true);
    expect(topic.displayOrder).toBe(3);

    const email = `smoke-topic-${Date.now()}@example.com`;
    await expectOK(
      request.post(`/api/v1/subscribers/${email}/topics/${topic.id}/subscribe`),
    );
    await expectOK(
      request.post(
        `/api/v1/subscribers/${email}/topics/${topic.id}/unsubscribe`,
      ),
    );
  });

  test("mailchimp compatibility center covers all six parity workstreams", async ({
    request,
    page,
  }) => {
    const stamp = Date.now();

    const group = await request.post("/api/v1/mailchimp-compat/groups", {
      data: {
        category: "Smoke interests",
        name: `Product ${stamp}`,
        type: "checkbox",
      },
    });
    expect(group.status()).toBe(201);

    const asset = await request.post("/api/v1/mailchimp-compat/assets", {
      data: {
        name: `Smoke asset ${stamp}`,
        asset_type: "image",
        url: "https://example.com/asset.png",
      },
    });
    expect(asset.status()).toBe(201);
    const assetBody = await asset.json();

    const section = await request.post("/api/v1/mailchimp-compat/sections", {
      data: {
        name: `Smoke section ${stamp}`,
        category: "newsletter",
        blocks: [{ type: "text", content: "Smoke" }],
      },
    });
    expect(section.status()).toBe(201);
    const sectionBody = await section.json();

    const campaign = await request.post("/api/v1/campaigns", {
      data: {
        name: `Smoke report ${stamp}`,
        subject: "Smoke report",
        campaign_type: "regular",
        editor_mode: "blocks",
        body_html: "<p>Smoke</p>",
        content_blocks: [
          {
            type: "image",
            asset_id: assetBody.id,
            url: assetBody.url,
            alt_text: assetBody.name,
          },
          {
            type: "section",
            section_id: sectionBody.id,
            name: sectionBody.name,
            content: "Smoke",
          },
        ],
        reusable_section_ids: [sectionBody.id],
        variants: [
          {
            id: "a",
            name: "Variant A",
            subject: "Smoke report A",
            weight: 50,
            body_html: "<p>A</p>",
          },
        ],
        tracking_settings: {
          open_tracking: true,
          click_tracking: true,
          utm_campaign: `smoke-${stamp}`,
        },
      },
    });
    expect(campaign.status()).toBe(201);
    const campaignBody = await campaign.json();
    await page.goto(`/app/campaigns/${campaignBody.id}`, {
      waitUntil: "networkidle",
    });
    await expect(
      page.getByRole("heading", { name: "Content blocks" }),
    ).toBeVisible();
    await expect(page.getByText(`Smoke asset ${stamp}`)).toBeVisible();
    await expect(page.getByText(`Smoke section ${stamp}`)).toBeVisible();
    await expect(page.getByLabel("Open tracking")).toBeChecked();
    await expect(page.getByLabel("UTM campaign")).toHaveValue(`smoke-${stamp}`);

    for (const event_type of ["sent", "delivered", "opened", "clicked"]) {
      const event = await request.post(
        `/api/v1/mailchimp-compat/campaigns/${campaignBody.id}/events`,
        {
          data: {
            subscriber_email: `smoke-${stamp}@example.com`,
            event_type,
            link_url:
              event_type === "clicked" ? "https://example.com" : undefined,
            device: "desktop",
            client: "gmail",
            country: "US",
          },
        },
      );
      expect(event.status(), event_type).toBe(201);
    }
    const report = await request.get(
      `/api/v1/mailchimp-compat/campaigns/${campaignBody.id}/report`,
    );
    expect(report.status()).toBe(200);
    expect(await report.json()).toMatchObject({ opened: 1, clicked: 1 });

    const v3Campaigns = await request.get("/api/mailchimp/3.0/campaigns");
    expect(v3Campaigns.status()).toBe(200);
    expect((await v3Campaigns.json()).campaigns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: campaignBody.id }),
      ]),
    );
    const v3Campaign = await request.get(
      `/api/mailchimp/3.0/campaigns/${campaignBody.id}`,
    );
    expect(v3Campaign.status()).toBe(200);
    expect(await v3Campaign.json()).toMatchObject({ id: campaignBody.id });
    const v3Content = await request.get(
      `/api/mailchimp/3.0/campaigns/${campaignBody.id}/content`,
    );
    expect(v3Content.status()).toBe(200);
    expect(await v3Content.json()).toMatchObject({
      html: expect.stringContaining("Smoke"),
    });
    const v3ClickDetails = await request.get(
      `/api/mailchimp/3.0/reports/${campaignBody.id}/click-details`,
    );
    expect(v3ClickDetails.status()).toBe(200);
    expect((await v3ClickDetails.json()).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          email_address: `smoke-${stamp}@example.com`,
        }),
      ]),
    );
    const v3OpenDetails = await request.get(
      `/api/mailchimp/3.0/reports/${campaignBody.id}/open-details`,
    );
    expect(v3OpenDetails.status()).toBe(200);
    expect((await v3OpenDetails.json()).total_items).toBeGreaterThanOrEqual(1);
    const v3Unsubscribed = await request.get(
      `/api/mailchimp/3.0/reports/${campaignBody.id}/unsubscribed`,
    );
    expect(v3Unsubscribed.status()).toBe(200);
    const v3Abuse = await request.get(
      `/api/mailchimp/3.0/reports/${campaignBody.id}/abuse-reports`,
    );
    expect(v3Abuse.status()).toBe(200);

    const journey = await request.post("/api/v1/mailchimp-compat/automations", {
      data: { name: `Smoke journey ${stamp}`, status: "draft" },
    });
    expect(journey.status()).toBe(201);
    const journeyBody = await journey.json();
    await expectOK(
      request.post(
        `/api/v1/mailchimp-compat/automations/${journeyBody.id}/resume`,
      ),
    );
    const v3Automations = await request.get("/api/mailchimp/3.0/automations");
    expect(v3Automations.status()).toBe(200);
    expect((await v3Automations.json()).automations).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: journeyBody.id })]),
    );
    const v3Automation = await request.get(
      `/api/mailchimp/3.0/automations/${journeyBody.id}`,
    );
    expect(v3Automation.status()).toBe(200);
    expect(await v3Automation.json()).toMatchObject({ id: journeyBody.id });

    const v3Templates = await request.get("/api/mailchimp/3.0/templates");
    expect(v3Templates.status()).toBe(200);
    expect((await v3Templates.json()).templates).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: sectionBody.id })]),
    );
    const v3Template = await request.get(
      `/api/mailchimp/3.0/templates/${sectionBody.id}`,
    );
    expect(v3Template.status()).toBe(200);
    expect(await v3Template.json()).toMatchObject({ id: sectionBody.id });

    const landing = await request.post(
      "/api/v1/mailchimp-compat/landing-pages",
      {
        data: {
          slug: `smoke-landing-${stamp}`,
          name: "Smoke landing",
          status: "published",
        },
      },
    );
    expect(landing.status()).toBe(201);
    const landingBody = await landing.json();
    const publicLanding = await request.get(
      `/api/public/landing-pages/${landingBody.slug}`,
    );
    expect(publicLanding.status()).toBe(200);
    await page.goto(`/landing/${landingBody.slug}`, {
      waitUntil: "networkidle",
    });
    await expect(page.getByRole("button", { name: "Subscribe" })).toBeVisible();

    const popup = await request.post("/api/v1/mailchimp-compat/popups", {
      data: {
        name: `Smoke popup ${stamp}`,
        status: "published",
        trigger: { type: "page-load" },
        targeting: { frequency_days: 1 },
        blocks: [
          { type: "heading", headline: "Join the smoke list" },
          { type: "text", content: "Popup smoke body" },
          { type: "email_capture", button: "Subscribe" },
        ],
      },
    });
    expect(popup.status()).toBe(201);
    const popupBody = await popup.json();
    const popupKey = popupBody.public_key ?? popupBody.id;
    expect(popupKey).toBeTruthy();
    const publicPopup = await request.get(`/api/public/popups/${popupKey}`);
    expect(publicPopup.status()).toBe(200);
    expect(await publicPopup.json()).toMatchObject({
      id: popupBody.id,
      status: "published",
    });
    const popupSubmit = await request.post(
      `/api/public/popups/${popupKey}/submit`,
      {
        data: {
          email: `smoke-popup-${stamp}@example.com`,
          metadata: { source: "local-smoke" },
        },
      },
    );
    expect(popupSubmit.status()).toBe(202);
    expect(await popupSubmit.json()).toMatchObject({
      ok: true,
      popup_id: popupBody.id,
    });
    const popupJS = await request.get("/popup.js");
    expect(popupJS.status()).toBe(200);
    expect(await popupJS.text()).toContain("data-postwave-popup");
    const popupEmbedJS = await request.get("/embed/popup.js");
    expect(popupEmbedJS.status()).toBe(200);
    const popupEmbedText = await popupEmbedJS.text();
    expect(popupEmbedText).toContain("data-postwave-popup-key");
    expect(popupEmbedText).toContain("/api/public/popups/");

    const v3Root = await request.get("/api/mailchimp/3.0/");
    expect(v3Root.status()).toBe(200);
    expect(await v3Root.json()).toMatchObject({ account_id: "postwave" });
    const v3Lists = await request.get("/api/mailchimp/3.0/lists");
    expect(v3Lists.status()).toBe(200);
    const v3ListsBody = await v3Lists.json();
    expect(v3ListsBody.total_items).toBe(1);
    const listID = v3ListsBody.lists[0].id;
    const v3Email = `smoke-v3-${stamp}@example.com`;
    const v3Create = await request.post(
      `/api/mailchimp/3.0/lists/${listID}/members`,
      {
        data: {
          email_address: v3Email,
          status: "subscribed",
          merge_fields: { FNAME: "Smoke" },
          tags: ["v3-smoke"],
        },
      },
    );
    expect(v3Create.status()).toBe(200);
    expect(await v3Create.json()).toMatchObject({
      email_address: v3Email,
      status: "subscribed",
    });
    const v3Member = await request.get(
      `/api/mailchimp/3.0/lists/${listID}/members/${encodeURIComponent(v3Email)}`,
    );
    expect(v3Member.status()).toBe(200);
    expect(await v3Member.json()).toMatchObject({
      email_address: v3Email,
    });
    const v3Tags = await request.post(
      `/api/mailchimp/3.0/lists/${listID}/members/${encodeURIComponent(v3Email)}/tags`,
      {
        data: {
          tags: [
            { name: "v3-smoke", status: "inactive" },
            { name: "buyer", status: "active" },
          ],
        },
      },
    );
    expect(v3Tags.status()).toBe(200);
    expect((await v3Tags.json()).tags).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "buyer" })]),
    );

    const integration = await request.post(
      "/api/v1/mailchimp-compat/ecommerce/integrations",
      {
        data: {
          provider: "shopify",
          shop_domain: `smoke-${stamp}.myshopify.com`,
          status: "connected",
        },
      },
    );
    expect(integration.status()).toBe(201);
    const integrationBody = await integration.json();
    const sync = await request.post(
      `/api/v1/mailchimp-compat/ecommerce/integrations/${integrationBody.id}/sync-demo`,
    );
    expect(sync.status()).toBe(202);
    expect((await sync.json()).orders).toBeGreaterThanOrEqual(2);

    const backfill = await request.post(
      `/api/v1/commerce/integrations/${integrationBody.id}/backfill`,
      { data: {} },
    );
    expect(backfill.status()).toBe(202);

    for (const resource of ["customers", "products", "orders", "events"]) {
      const res = await request.get(
        `/api/v1/commerce/integrations/${integrationBody.id}/${resource}`,
      );
      expect(res.status(), resource).toBe(200);
      expect((await res.json()).items.length, resource).toBeGreaterThan(0);
    }

    const analytics = await request.get(
      `/api/v1/commerce/integrations/${integrationBody.id}/analytics`,
    );
    expect(analytics.status()).toBe(200);
    expect(await analytics.json()).toMatchObject({
      orders: expect.any(Number),
      revenue_cents: expect.any(Number),
      orders_by_status: expect.any(Object),
    });

    const v3Stores = await request.get("/api/mailchimp/3.0/ecommerce/stores");
    expect(v3Stores.status()).toBe(200);
    expect((await v3Stores.json()).stores).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: integrationBody.id }),
      ]),
    );
    const v3Store = await request.get(
      `/api/mailchimp/3.0/ecommerce/stores/${integrationBody.id}`,
    );
    expect(v3Store.status()).toBe(200);
    expect(await v3Store.json()).toMatchObject({ id: integrationBody.id });

    const oauthStart = await request.get(
      `/api/v1/commerce/shopify/oauth/start?shop=oauth-${stamp}`,
    );
    expect(oauthStart.status()).toBe(200);
    const oauthBody = await oauthStart.json();
    expect(oauthBody).toMatchObject({
      provider: "shopify",
      shop_domain: `oauth-${stamp}.myshopify.com`,
      local: true,
    });
    const oauthCallback = await request.get(oauthBody.authorize_url);
    expect(oauthCallback.status()).toBe(200);
    const oauthIntegration = (await oauthCallback.json()).integration;
    expect(oauthIntegration).toMatchObject({
      provider: "shopify",
      shop_domain: `oauth-${stamp}.myshopify.com`,
      status: "connected",
    });
    const shopifyWebhook = await request.post(
      "/api/public/commerce/shopify/webhooks",
      {
        headers: {
          "X-Shopify-Shop-Domain": `oauth-${stamp}.myshopify.com`,
          "X-Shopify-Topic": "customers/create",
          "X-Shopify-Webhook-Id": `smoke-webhook-${stamp}`,
        },
        data: {
          id: `customer-${stamp}`,
          email: `shopper-${stamp}@example.com`,
          first_name: "Smoke",
          last_name: "Shopper",
          accepts_marketing: true,
          tags: "newsletter, buyer",
        },
      },
    );
    expect(shopifyWebhook.status()).toBe(202);
    const duplicateWebhook = await request.post(
      "/api/public/commerce/shopify/webhooks",
      {
        headers: {
          "X-Shopify-Shop-Domain": `oauth-${stamp}.myshopify.com`,
          "X-Shopify-Topic": "customers/create",
          "X-Shopify-Webhook-Id": `smoke-webhook-${stamp}`,
        },
        data: {
          id: `customer-${stamp}`,
          email: `shopper-${stamp}@example.com`,
        },
      },
    );
    expect(duplicateWebhook.status()).toBe(200);

    const summary = await request.get("/api/v1/mailchimp-compat/summary");
    expect(summary.status()).toBe(200);
    const summaryBody = await summary.json();
    expect(summaryBody.ecommerce.integrations).toBeGreaterThan(0);
    expect(summaryBody.growth.conversions).toBeGreaterThan(0);

    await page.goto("/app/compatibility", { waitUntil: "networkidle" });
    await expect(
      page.getByRole("heading", { name: "Mailchimp compatibility" }),
    ).toBeVisible();
    await expect(page.getByText("Contact model")).toBeVisible();
    await expect(page.getByText("Ecommerce")).toBeVisible();
  });
});

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push(msg.text());
    }
  });
  return errors;
}

function collectAPIFailures(
  page: Page,
): Array<{ url: string; status: number }> {
  const failures: Array<{ url: string; status: number }> = [];
  page.on("response", (response) => {
    const url = response.url();
    if (url.includes("/api/") && response.status() >= 400) {
      failures.push({ url, status: response.status() });
    }
  });
  return failures;
}

function isAllowedAPIFailure(
  route: string,
  failure: { url: string; status: number },
): boolean {
  return (
    route === "/app/sequences/voice-profile" &&
    failure.url.includes("/api/v1/voice/profile") &&
    failure.status === 404
  );
}

async function expectHealth(
  request: APIRequestContext,
  baseURL: string,
): Promise<void> {
  const res = await request.get(`${baseURL}/api/health`);
  expect(res.status()).toBe(200);
}

async function expectOK(promise: Promise<{ status(): number }>): Promise<void> {
  const res = await promise;
  expect(res.status()).toBeGreaterThanOrEqual(200);
  expect(res.status()).toBeLessThan(300);
}

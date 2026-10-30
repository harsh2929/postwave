import { expect, test } from "@playwright/test";

import { loginAsDemo } from "../helpers/auth";

/**
 * Smoke tests for four admin surfaces, as apps/web exposes them.
 *
 * This file was written against the DESKTOP app, which routes by Section key
 * and mounts each of these as its own page reached by clicking a sidebar
 * BUTTON. apps/web has real URL routes and renders nav as <a href> links, and
 * it folds three of the four into pages it already had:
 *
 *   Inbound routes   /app/routing                 (a section of Routing)
 *   SCIM             /app/settings/security       (two cards on Security)
 *   HIPAA            /app/compliance              (the "Not offered" section)
 *   Audit sinks      /app/settings/audit-sinks    ("Audit streaming")
 *
 * So the navigation is by URL, and the landmarks are the ones web actually
 * renders. Where web has no equivalent affordance at all — there is no
 * create-a-route form; its routing API client is list-only — the test is left
 * FAILING rather than softened into something that passes.
 *
 * Navigations wait for `domcontentloaded` rather than `load`: the dashboard
 * shell keeps long-lived event-stream connections open, so `load` can outlast
 * the 30s navigation timeout on the dev server while the page is already
 * interactive. Every assertion below still auto-waits for its own subject.
 *
 * We assert the page renders + the primary API call fires. The detailed
 * DB-shape coverage lives in the Go integration suite; these specs catch the
 * obvious full-stack regressions (route doesn't mount, API client URL drift,
 * nav wiring lost).
 */

test.describe("inbound routes admin", () => {
  test.beforeEach(async ({ page }) => {
    // The Next dev server compiles routes and proxies every /api call
    // in-process, so a warm route can still take 20s+ to answer while other
    // suites share the box. These ceilings only bound WAITING — no assertion
    // is relaxed by them.
    test.setTimeout(180_000);
    // No navigation here: the tests that watch for an API call must attach
    // the listener before the page that issues it loads.
    await loginAsDemo(page, { navigate: false });
  });

  test("renders + lists routes", async ({ page }) => {
    // The list endpoint must fire on page load.
    const listReq = page.waitForRequest(
      (req) =>
        req.url().includes("/api/v1/inbound-routes") && req.method() === "GET",
      { timeout: 60_000 },
    );
    await page.goto("/app/routing", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await expect(
      page.getByRole("heading", { level: 1, name: "Routing" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /^Inbound routes$/i }),
    ).toBeVisible();
    await expect.soft(listReq).resolves.toBeTruthy();

    // Either the empty-state message or the list of routes is visible —
    // scoped to the inbound-routes section so the outbound-webhook section's
    // own empty state can't stand in for it.
    const section = page.locator('section[aria-labelledby="rt-routes"]');
    const list = section.getByRole("list");
    const empty = section.getByText(/No routes defined/i);
    // Generous: the list only settles after the proxied API round-trip, which
    // the Next dev server can take well past the 10s default under load.
    await expect(list.or(empty).first()).toBeVisible({ timeout: 60_000 });
  });

  test('"+ New route" opens the create modal', async ({ page }) => {
    await page.goto("/app/routing", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    // Prove the page mounted first, so a failure below is unambiguously
    // "web has no create-route affordance" and not "the page never loaded".
    await expect(
      page.getByRole("heading", { level: 1, name: "Routing" }),
    ).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: /\+ New route/i }).click();
    await expect(
      page.getByRole("heading", { name: /New inbound route/i }),
    ).toBeVisible();
    // Modal must collect at least Name + Recipient.
    await expect(page.getByLabel(/^Name$/i).first()).toBeVisible();
    await expect(page.getByLabel(/Match recipient/i).first()).toBeVisible();
  });
});

test.describe("SCIM admin", () => {
  test.beforeEach(async ({ page }) => {
    // The Next dev server compiles routes and proxies every /api call
    // in-process, so a warm route can still take 20s+ to answer while other
    // suites share the box. These ceilings only bound WAITING — no assertion
    // is relaxed by them.
    test.setTimeout(180_000);
    await loginAsDemo(page, { navigate: false });
  });

  test("renders Tokens + Role mappings panels", async ({ page }) => {
    const tokensReq = page.waitForRequest(
      (req) =>
        req.url().includes("/api/v1/scim/tokens") && req.method() === "GET",
      { timeout: 60_000 },
    );
    const mappingsReq = page.waitForRequest(
      (req) =>
        req.url().includes("/api/v1/scim/role-mappings") &&
        req.method() === "GET",
      { timeout: 60_000 },
    );

    await page.goto("/app/settings/security", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    // SCIM is not its own page on web; it is two cards on Security.
    await expect(
      page.getByRole("heading", { level: 1, name: "Security" }),
    ).toBeVisible();
    // Card titles render as <div>, not headings, so they are matched by their
    // exact text rather than by role.
    await expect(
      page.getByText("SCIM provisioning tokens", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("SAML group → role mappings", { exact: true }),
    ).toBeVisible();
    await expect.soft(tokensReq).resolves.toBeTruthy();
    await expect.soft(mappingsReq).resolves.toBeTruthy();
  });

  test('"Mint token" states the one-shot reveal contract', async ({ page }) => {
    // Desktop puts minting behind a "+ Mint token" modal; web mints from an
    // inline form on the SCIM card. Either way the operator must be told the
    // token is shown once BEFORE they mint one.
    await page.goto("/app/settings/security", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await expect(page.getByLabel("Description (optional)")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Mint token", exact: true }),
    ).toBeVisible();
    // The "shown once" warning must be present so operators know the
    // one-shot reveal contract.
    await expect(page.getByText(/shown once at creation/i)).toBeVisible();
  });
});

test.describe("HIPAA policy", () => {
  test.beforeEach(async ({ page }) => {
    // The Next dev server compiles routes and proxies every /api call
    // in-process, so a warm route can still take 20s+ to answer while other
    // suites share the box. These ceilings only bound WAITING — no assertion
    // is relaxed by them.
    test.setTimeout(180_000);
    await loginAsDemo(page, { navigate: false });
  });

  test("states the no-BAA and no-PHI contract without readiness actions", async ({
    page,
  }) => {
    await page.goto("/app/compliance", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    // Web groups every unsupported framework under one refusal heading and
    // lists HIPAA inside it, rather than giving HIPAA its own page.
    const notOffered = page.locator(
      'section[aria-labelledby="cp-unsupported"]',
    );
    // The refusal section only exists once /api/v1/compliance/programs has
    // answered, so this first assertion waits out the proxied round-trip.
    await expect(
      notOffered.getByRole("heading", { name: /^Not offered$/i }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      notOffered.getByRole("listitem").filter({ hasText: /hipaa/i }),
    ).toHaveCount(1);

    await expect(
      notOffered.getByText(/does not offer.*Business Associate/i),
    ).toBeVisible();
    // The prohibition is rendered in the server's own words (this is a legal
    // statement the page deliberately does not paraphrase), so the assertion
    // quotes the server: "...must not be used to upload, store, process, or
    // send Protected Health Information (PHI)".
    await expect(
      notOffered.getByText(
        /must not be used to upload, store, process, or send/i,
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /Sign BAA/i })).toHaveCount(
      0,
    );
  });
});

test.describe("audit sinks admin", () => {
  test.beforeEach(async ({ page }) => {
    // The Next dev server compiles routes and proxies every /api call
    // in-process, so a warm route can still take 20s+ to answer while other
    // suites share the box. These ceilings only bound WAITING — no assertion
    // is relaxed by them.
    test.setTimeout(180_000);
    await loginAsDemo(page, { navigate: false });
  });

  test("renders + lists sinks", async ({ page }) => {
    const listReq = page.waitForRequest(
      (req) =>
        req.url().includes("/api/v1/audit-sinks") && req.method() === "GET",
      { timeout: 60_000 },
    );
    await page.goto("/app/settings/audit-sinks", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    // Web titles the page "Audit streaming"; the page <h1> comes from the
    // settings shell and the card below repeats it as an <h2>, so the level
    // is pinned rather than resolved with .first().
    await expect(
      page.getByRole("heading", { level: 1, name: "Audit streaming" }),
    ).toBeVisible();
    await expect(
      page.getByText("Streaming sinks", { exact: true }),
    ).toBeVisible();
    await expect.soft(listReq).resolves.toBeTruthy();
  });

  test("kind selector shows kind-specific fields", async ({ page }) => {
    await page.goto("/app/settings/audit-sinks", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    // "Add sink" is SERVER-RENDERED — it is present in the HTML the dev server
    // returns (verified with curl), so Playwright can click it several hundred
    // ms before React has hydrated and attached Radix's trigger handler. That
    // click is swallowed silently: the button is there, it is enabled, and
    // nothing happens. Same failure mode, and same remedy, as the "Replay tour"
    // case in settings.spec.ts. The ACTION is retried until it takes effect;
    // the assertion below is unchanged and still has to hold.
    const addSink = page.getByRole("button", { name: /Add sink/i });
    const modal = page.getByRole("dialog");
    const modalTitle = modal.getByRole("heading", {
      name: /Add streaming sink/i,
    });
    await expect(async () => {
      await addSink.click({ timeout: 10_000 });
      await expect(modalTitle).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 60_000 });

    // http is web's default kind — its single config field is the URL.
    await expect(modal.getByLabel(/^URL$/i)).toBeVisible();

    // Datadog — Site + API key fields must appear, and the http field go.
    // (The form marks server-defaulted keys "(optional)" in the label text.)
    await modal.getByLabel(/^Kind$/i).selectOption("datadog");
    await expect(modal.getByLabel(/^Site \(optional\)$/i)).toBeVisible();
    await expect(modal.getByLabel(/^API key$/i)).toBeVisible();
    await expect(modal.getByLabel(/^URL$/i)).toHaveCount(0);

    // Switch to S3 — the field set must change again.
    await modal.getByLabel(/^Kind$/i).selectOption("s3");
    await expect(modal.getByLabel(/^Region$/i)).toBeVisible();
    await expect(modal.getByLabel(/^Bucket$/i)).toBeVisible();
    await expect(modal.getByLabel(/^AWS access key id$/i)).toBeVisible();
    await expect(modal.getByLabel(/^Site \(optional\)$/i)).toHaveCount(0);
  });
});

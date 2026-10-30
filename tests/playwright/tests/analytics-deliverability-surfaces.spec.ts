import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { loginAsDemo } from "../helpers/auth";

const SURFACES = [
  ["/app/analytics", "Analytics"],
  ["/app/reports", "Reports"],
  ["/app/reporting-catalogue", "Reporting catalogue"],
  ["/app/analytics-destinations", "Analytics destinations"],
  ["/app/inbox-reality", "Inbox Reality"],
  ["/app/inbox-reality/predict", "Pre-send predictor"],
  ["/app/deliverability", "Deliverability"],
  ["/app/sending-health", "Sending health"],
  ["/app/human-reach", "Human-engaged reach"],
  ["/app/preflight", "Pre-flight"],
  ["/app/list-hygiene", "List hygiene"],
  ["/app/bot-opens", "Machine opens"],
  ["/app/dmarc", "DMARC"],
  ["/app/verification", "Email verification"],
  ["/app/suppressions", "Suppressions"],
] as const;

const BLOCKING_IMPACTS = new Set(["critical", "serious"]);

interface BrowserDiagnostics {
  consoleErrors: string[];
  pageErrors: string[];
}

function captureBrowserDiagnostics(page: Page): BrowserDiagnostics {
  const diagnostics: BrowserDiagnostics = {
    consoleErrors: [],
    pageErrors: [],
  };
  page.on("console", (message) => {
    if (message.type() === "error")
      diagnostics.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => diagnostics.pageErrors.push(error.message));
  return diagnostics;
}

async function waitForSettledMain(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const main = document.querySelector("main#main-content");
      if (!main) return false;
      if (main.querySelector('[aria-busy="true"]')) return false;
      return !Array.from(main.querySelectorAll("p")).some((paragraph) =>
        /^Loading(?:\s|…)/u.test(paragraph.textContent?.trim() ?? ""),
      );
    },
    undefined,
    { timeout: 45_000 },
  );
}

async function expectNoBlockingAxeViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page })
    .include("main#main-content")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = result.violations.filter(
    (violation) => violation.impact && BLOCKING_IMPACTS.has(violation.impact),
  );
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}

async function expectResponsiveDocument(
  page: Page,
  path: string,
): Promise<void> {
  const geometry = await page.evaluate(() => ({
    viewport: window.innerWidth,
    html: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    duplicateIds: Array.from(document.querySelectorAll("[id]"))
      .map((node) => node.id)
      .filter((id, index, ids) => ids.indexOf(id) !== index),
  }));
  expect(
    Math.max(geometry.html, geometry.body),
    `${path} overflows ${geometry.viewport}px`,
  ).toBeLessThanOrEqual(geometry.viewport + 1);
  expect(geometry.duplicateIds, `${path} duplicate DOM ids`).toEqual([]);

  if ((page.viewportSize()?.width ?? 1024) >= 640) return;
  const targetFailures = await page
    .locator("main#main-content")
    .evaluate((main) => {
      const visible = (element: Element): boolean => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          box.width > 0 &&
          box.height > 0
        );
      };
      const failures: string[] = [];
      const controls = main.querySelectorAll(
        'button:not([disabled]), a[href], input:not([type="checkbox"]):not([type="radio"]), select, textarea',
      );
      for (const control of controls) {
        if (!visible(control)) continue;
        const box = control.getBoundingClientRect();
        if (box.width >= 43.5 && box.height >= 43.5) continue;
        const label =
          control.getAttribute("aria-label") ??
          control.textContent?.trim().replace(/\s+/gu, " ") ??
          control.tagName;
        failures.push(
          `${control.tagName} “${label.slice(0, 60)}” is ${Math.round(box.width)}×${Math.round(box.height)}`,
        );
      }
      for (const checkbox of main.querySelectorAll('input[type="checkbox"]')) {
        if (!visible(checkbox)) continue;
        const target = checkbox.closest("label") ?? checkbox;
        const box = target.getBoundingClientRect();
        if (box.width < 23.5 || box.height < 23.5) {
          failures.push(
            `checkbox “${checkbox.getAttribute("aria-label") ?? "labelled option"}” has a ${Math.round(box.width)}×${Math.round(box.height)} target`,
          );
        }
      }
      return failures;
    });
  expect(targetFailures, `${path} undersized mobile targets`).toEqual([]);
}

async function auditSurface(
  page: Page,
  path: string,
  heading: string,
): Promise<void> {
  const diagnostics = captureBrowserDiagnostics(page);
  const response = await page.goto(path, {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  expect(response?.status(), `${path} document response`).toBeLessThan(400);
  await expect(
    page.getByRole("heading", { level: 1, name: heading, exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("main#main-content")).toHaveCount(1);
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page).toHaveTitle(
    new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu"),
  );
  await waitForSettledMain(page);
  await expectResponsiveDocument(page, path);
  await expectNoBlockingAxeViolations(page);
  expect(diagnostics.pageErrors, `${path} uncaught page errors`).toEqual([]);
  expect(diagnostics.consoleErrors, `${path} console errors`).toEqual([]);
}

test.describe("analytics, reporting, and deliverability surface quality", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await loginAsDemo(page, { navigate: false });
  });

  for (const [path, heading] of SURFACES) {
    test(`${path} is complete, responsive, and accessible`, async ({
      page,
    }) => {
      test.slow();
      await auditSurface(page, path, heading);
    });
  }

  test("analytics tabs, range, keyboard, and history are URL-backed", async ({
    page,
  }) => {
    test.slow();
    const diagnostics = captureBrowserDiagnostics(page);
    await page.goto("/app/analytics?range=7d&tab=reach&keep=1#reports", {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });

    const reach = page.getByRole("tab", { name: "Reach", exact: true });
    await expect(reach).toHaveAttribute("aria-selected", "true");
    await expect(page.getByLabel("Date range", { exact: true })).toHaveValue(
      "7d",
    );

    const campaign = page.getByRole("tab", {
      name: "Campaign",
      exact: true,
    });
    await campaign.click();
    await expect(campaign).toHaveAttribute("aria-selected", "true");
    expect(page.url()).toContain("tab=campaign");
    expect(page.url()).toContain("range=7d");
    expect(page.url()).toContain("keep=1");
    expect(page.url()).toContain("#reports");

    await page.goBack();
    await expect(reach).toHaveAttribute("aria-selected", "true");
    await reach.focus();
    await page.keyboard.press("ArrowRight");
    await expect(
      page.getByRole("tab", { name: "Overview", exact: true }),
    ).toHaveAttribute("aria-selected", "true");

    await page.getByLabel("Date range", { exact: true }).selectOption("90d");
    expect(page.url()).toContain("range=90d");
    expect(page.url()).toContain("keep=1");
    expect(page.url()).toContain("#reports");

    for (const name of ["Campaign", "Audience", "Reach"] as const) {
      await page.getByRole("tab", { name, exact: true }).click();
      await expect(
        page.getByRole("tab", { name, exact: true }),
      ).toHaveAttribute("aria-selected", "true");
      await expectResponsiveDocument(page, `/app/analytics?tab=${name}`);
      await expectNoBlockingAxeViolations(page);
    }
    expect(diagnostics.pageErrors).toEqual([]);
    expect(diagnostics.consoleErrors).toEqual([]);
  });

  test("report builder searches, selects by keyboard, and renders real rows", async ({
    page,
  }) => {
    test.slow();
    const diagnostics = captureBrowserDiagnostics(page);
    await page.goto("/app/reports", {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    const search = page.getByLabel("Find a metric", { exact: true });
    await search.fill("not-a-real-metric");
    await expect(page.getByText(/No metrics match/u)).toBeVisible();

    await search.fill("campaign sent");
    const metric = page.getByRole("checkbox", { name: /Campaign sent/u });
    await metric.focus();
    await page.keyboard.press("Space");
    await expect(metric).toBeChecked();

    const save = page.getByRole("button", { name: "Save report", exact: true });
    await expect(save).toBeDisabled();
    await page.getByLabel("Report name", { exact: true }).fill("QA preview");
    await expect(save).toBeEnabled();

    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Preview result", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole("region", { name: "Report preview rows", exact: true }),
    ).toContainText("campaign.sent");
    expect(diagnostics.pageErrors).toEqual([]);
    expect(diagnostics.consoleErrors).toEqual([]);
  });

  test("pre-send predictor supports example, clear, and keyboard submission", async ({
    page,
  }) => {
    test.slow();
    const diagnostics = captureBrowserDiagnostics(page);
    await page.goto("/app/inbox-reality/predict", {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    await page
      .getByRole("button", { name: "Load example", exact: true })
      .click();
    await expect(page.getByLabel("Subject", { exact: true })).not.toHaveValue(
      "",
    );
    await expect(page.getByLabel("HTML body", { exact: true })).not.toHaveValue(
      "",
    );

    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(page.getByLabel("Subject", { exact: true })).toHaveValue("");
    await page
      .getByRole("button", { name: "Load example", exact: true })
      .click();
    await page.getByLabel("Subject", { exact: true }).press("Control+Enter");
    await expect(
      page.getByText("Contributing signals", { exact: true }),
    ).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByText("Why this forecast", { exact: true }),
    ).toBeVisible();
    await page
      .getByLabel("Subject", { exact: true })
      .fill("A changed subject invalidates the forecast");
    await expect(
      page.getByText("Contributing signals", { exact: true }),
    ).toBeHidden();
    expect(diagnostics.pageErrors).toEqual([]);
    expect(diagnostics.consoleErrors).toEqual([]);
  });

  test("suppression deep links and dialogs expose validation without mutation", async ({
    page,
  }) => {
    test.slow();
    const diagnostics = captureBrowserDiagnostics(page);
    await page.goto("/app/suppressions?add=1", {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    const addDialog = page.getByRole("dialog", { name: "Add suppression" });
    await expect(addDialog).toBeVisible({ timeout: 30_000 });
    const email = addDialog.getByLabel("Email", { exact: true });
    await email.fill("not-an-email");
    await email.blur();
    await expect(
      addDialog.getByText("Enter a valid email address."),
    ).toBeVisible();
    await expect(
      addDialog.getByRole("button", { name: "Add", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(addDialog).toBeHidden();

    await page
      .getByRole("button", { name: "Bulk import", exact: true })
      .click();
    const importDialog = page.getByRole("dialog", {
      name: "Bulk import suppressions",
    });
    await importDialog
      .getByLabel("Addresses", { exact: true })
      .fill("valid@example.com\nnot-an-email");
    await expect(importDialog).toContainText("1 valid, 1 invalid");
    await expect(importDialog).toContainText("Skipping 1 invalid");
    await page.keyboard.press("Escape");

    const search = page.getByLabel("Search suppressed addresses by email", {
      exact: true,
    });
    await search.fill("bounce@example.com");
    await expect(page).toHaveURL(/q=bounce%40example\.com/u, {
      timeout: 5_000,
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.getByLabel("Search suppressed addresses by email", { exact: true }),
    ).toHaveValue("bounce@example.com");

    await page.evaluate(() => {
      window.history.pushState(
        window.history.state,
        "",
        "/app/suppressions?reason=spam_complaint",
      );
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(
      page.getByLabel("Filter by reason", { exact: true }),
    ).toHaveValue("spam_complaint");
    await page.goBack();
    await expect(
      page.getByLabel("Search suppressed addresses by email", { exact: true }),
    ).toHaveValue("bounce@example.com");
    expect(diagnostics.pageErrors).toEqual([]);
    expect(diagnostics.consoleErrors).toEqual([]);
  });

  test("a live Inbox Reality campaign report supports disclosures", async ({
    page,
  }) => {
    test.slow();
    const campaignsResponse = await page.request.get(
      "/api/v1/campaigns?limit=20",
    );
    expect(campaignsResponse.ok()).toBe(true);
    const campaigns = (await campaignsResponse.json()) as Array<{
      id: string;
      status: string;
    }>;
    const sent = campaigns.find((campaign) => campaign.status === "sent");
    expect(sent, "demo backend needs one sent campaign report").toBeDefined();

    const path = `/app/inbox-reality/campaigns/${encodeURIComponent(sent!.id)}`;
    const diagnostics = captureBrowserDiagnostics(page);
    const response = await page.goto(path, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    expect(response?.status()).toBeLessThan(400);
    await expect(page).toHaveTitle(/Campaign placement report/iu);
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.locator("h1")).not.toHaveText(
      "Campaign report unavailable",
    );
    await expect(page.locator("main#main-content")).toHaveCount(1);
    await waitForSettledMain(page);
    await expect(page.locator("h1")).toHaveCount(1);

    const signals = page.getByRole("button", { name: /All signals/u });
    await signals.click();
    await expect(signals).toHaveAttribute("aria-expanded", "true");
    await expect(
      page.getByRole("group", { name: "Raw deliverability signals" }),
    ).toBeVisible();

    const seed = page.getByRole("button", { name: /Seed mailbox detail/u });
    if (await seed.count()) {
      await seed.click();
      await expect(seed).toHaveAttribute("aria-expanded", "true");
      await expect(
        page.getByRole("region", { name: "Seed mailbox detail" }),
      ).toBeVisible();
    }

    await expectResponsiveDocument(page, path);
    await expectNoBlockingAxeViolations(page);
    expect(diagnostics.pageErrors).toEqual([]);
    expect(diagnostics.consoleErrors).toEqual([]);
  });
});

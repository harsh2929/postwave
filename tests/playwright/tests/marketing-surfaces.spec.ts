import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const MARKETING_SOURCE = resolve(
  process.cwd(),
  "../../apps/web/src/app/(marketing)",
);

function walkFiles(directory: string, files: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const candidate = join(directory, entry);
    if (statSync(candidate).isDirectory()) walkFiles(candidate, files);
    else files.push(candidate);
  }
  return files;
}

const MARKETING_ROUTES = [
  "/",
  "/about",
  "/accessibility",
  "/affiliates",
  "/analytics",
  "/api-docs",
  "/audiences",
  "/automations",
  "/blog",
  "/blog/why-we-built-voice-profiles",
  "/blog/author/the-moosewave-team",
  "/blog/tag/engineering",
  "/changelog",
  "/commerce",
  "/customers",
  "/deliverability",
  "/developers",
  "/docs",
  "/features",
  "/forms",
  "/integrations",
  "/integrations/slack",
  "/landing-pages",
  "/legal/account-deletion",
  "/legal/affiliate-terms",
  "/legal/aup",
  "/legal/cookies",
  "/legal/dpa",
  "/legal/dpia",
  "/legal/privacy",
  "/legal/refund",
  "/legal/report-content",
  "/legal/sub-processors",
  "/legal/terms",
  "/legal/tom",
  "/mcp",
  "/migrate-anywhere",
  "/migrations",
  "/migrations/mailchimp",
  "/podcasts",
  "/pricing",
  "/pricing/success",
  "/roadmap",
  "/security",
  "/sms",
  "/voice",
  "/vs",
  "/vs/beehiiv",
  "/vs/convertkit",
  "/vs/mailchimp",
  "/vs/mailerlite",
  "/vs/sendy",
  "/vs/substack",
] as const;

// Run the same serious/critical WCAG gate against every route template, not a
// hand-picked sample. Dynamic families use one representative static instance
// here; the route-template inventory itself is enforced by a unit contract.
const AXE_ROUTES = MARKETING_ROUTES;

const TEMPLATE_BY_REPRESENTATIVE = new Map<string, string>([
  ["/blog/why-we-built-voice-profiles", "/blog/[slug]"],
  ["/blog/author/the-moosewave-team", "/blog/author/[author]"],
  ["/blog/tag/engineering", "/blog/tag/[tag]"],
  ["/integrations/slack", "/integrations/[slug]"],
  ["/migrations/mailchimp", "/migrations/[from]"],
]);

const BLOCKING_IMPACTS = new Set(["critical", "serious"]);

function collectBrowserErrors(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return { consoleErrors, pageErrors };
}

async function primeSettledMarketingChrome(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "moosewave.cookie.consent.v1",
      JSON.stringify({
        choice: "reject",
        prefs: { essential: true, analytics: false, marketing: false },
        ts: new Date().toISOString(),
      }),
    );
    window.localStorage.setItem("moosewave.preprod_banner.dismissed.v1", "1");
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
}

async function gotoMarketing(page: Page, path: string): Promise<void> {
  const response = await page.goto(path, {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  // /legal and /vs are draft families behind the public-release gate
  // (apps/web/src/lib/public-release.ts): without a runtime
  // POSTWAVE_PUBLIC_RELEASE_APPROVAL they answer 404 on purpose. That hold is
  // the contract under test in public-release.test.ts; here it is a documented
  // skip, not a structural failure.
  if (response?.status() === 404 && /^\/(legal|vs)(\/|$)/.test(path)) {
    test.skip(
      true,
      `${path} is release-held until POSTWAVE_PUBLIC_RELEASE_APPROVAL is set`,
    );
  }
  expect(response?.status(), `${path} document response`).toBeLessThan(400);
  await expect(page.locator("h1")).toHaveCount(1, { timeout: 30_000 });
}

async function openDisclosure(
  page: Page,
  trigger: ReturnType<Page["getByRole"]>,
): Promise<string> {
  const controlsId = await trigger.getAttribute("aria-controls");
  expect(controlsId).toBeTruthy();
  const stableTrigger = page.locator(`button[aria-controls="${controlsId}"]`);
  await expect
    .poll(
      async () => {
        const expanded = await stableTrigger.getAttribute("aria-expanded");
        if (expanded !== "true") await stableTrigger.click();
        return stableTrigger.getAttribute("aria-expanded");
      },
      { timeout: 30_000 },
    )
    .toBe("true");
  return controlsId!;
}

async function waitForReactHandlers(
  target: ReturnType<Page["locator"]>,
): Promise<void> {
  await expect
    .poll(
      () =>
        target.evaluate((node) =>
          Object.getOwnPropertyNames(node).some((key) =>
            key.startsWith("__reactProps$"),
          ),
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
}

test.describe("marketing route inventory", () => {
  test("covers every marketing page template in the browser matrix", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "The source-to-browser inventory needs one project.",
    );
    // Keep a browser fixture in the signature so this remains part of the same
    // shipped Playwright matrix rather than becoming an unexecuted Node helper.
    expect(page).toBeTruthy();

    const discovered = walkFiles(MARKETING_SOURCE)
      .filter((path) => path.endsWith("/page.tsx"))
      .map((path) => {
        const route = `/${relative(MARKETING_SOURCE, path).replace(
          /(^|\/)page\.tsx$/,
          "",
        )}`;
        return route === "/" ? route : route.replace(/\/$/, "");
      })
      .sort();
    const covered = [
      ...new Set(
        MARKETING_ROUTES.map(
          (route) => TEMPLATE_BY_REPRESENTATIVE.get(route) ?? route,
        ),
      ),
    ].sort();

    expect(covered).toEqual(discovered);
  });

  for (const path of MARKETING_ROUTES) {
    test(`${path} has complete, stable public-page structure`, async ({
      page,
      isMobile,
    }) => {
      test.slow();
      if (isMobile) await page.setViewportSize({ width: 320, height: 800 });
      await primeSettledMarketingChrome(page);
      const errors = collectBrowserErrors(page);
      await gotoMarketing(page, path);

      await expect(page.locator("main#main-content")).toHaveCount(1);
      await expect(page.locator("main")).toHaveCount(1);
      await expect(page).not.toHaveTitle(/^Moosewave$/);
      await expect(page).not.toHaveTitle(/postwave/i);
      await expect(
        page.locator("body"),
        `${path} exposes the retired product name to a public visitor`,
      ).not.toContainText(/postwave/i);
      await expect(
        page.locator('a[href*="postwave" i]'),
        `${path} links a public visitor to a retired product address`,
      ).toHaveCount(0);
      await expect(
        page.locator("body"),
        `${path} exposes the retired lifetime/sending catalog`,
      ).not.toContainText(
        /Studio LTD|Studio Lifetime|Cloud Sending|Pro Sending|unlimited generations/i,
      );

      const structure = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        htmlWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        mainWidth: document.querySelector("main")?.scrollWidth ?? 0,
        duplicateIds: Array.from(document.querySelectorAll("[id]"))
          .map((node) => node.id)
          .filter((id, index, ids) => ids.indexOf(id) !== index),
        overflowers: Array.from(
          document.querySelectorAll<HTMLElement>("body *"),
        )
          .flatMap((node) => {
            const rect = node.getBoundingClientRect();
            return rect.right > document.documentElement.clientWidth + 1 ||
              rect.left < -1
              ? [
                  {
                    tag: node.tagName.toLowerCase(),
                    className: String(node.className).slice(0, 180),
                    text: (node.textContent ?? "").trim().slice(0, 80),
                    left: Math.round(rect.left),
                    right: Math.round(rect.right),
                    scrollWidth: node.scrollWidth,
                    clientWidth: node.clientWidth,
                  },
                ]
              : [];
          })
          .slice(0, 12),
      }));
      expect(
        // Wide tables/code samples intentionally own an inner scroll region.
        // Mobile Chromium includes that inner content in html.scrollWidth even
        // when neither the body nor main page canvas can pan horizontally, so
        // page overflow is the body/main relationship rather than the root's
        // aggregate descendant metric.
        Math.max(structure.bodyWidth, structure.mainWidth),
        `${path} overflows ${structure.viewport}px: ${JSON.stringify(structure.overflowers)}`,
      ).toBeLessThanOrEqual(structure.viewport + 1);
      expect(structure.duplicateIds, `${path} duplicate DOM ids`).toEqual([]);
      expect(errors.pageErrors, `${path} uncaught page errors`).toEqual([]);
      expect(errors.consoleErrors, `${path} console errors`).toEqual([]);
    });
  }
});

test.describe("marketing family accessibility matrix", () => {
  for (const path of AXE_ROUTES) {
    test(`${path} has no blocking accessibility violations`, async ({
      page,
      isMobile,
    }) => {
      test.slow();
      if (isMobile) await page.setViewportSize({ width: 412, height: 915 });
      await primeSettledMarketingChrome(page);
      await gotoMarketing(page, path);

      const result = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      const blocking = result.violations.filter(
        (violation) =>
          violation.impact && BLOCKING_IMPACTS.has(violation.impact),
      );
      expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
    });
  }
});

test.describe("marketing shared chrome", () => {
  test("desktop product disclosure stays inside tablet and desktop viewports", async ({
    page,
    isMobile,
  }) => {
    test.slow();
    test.skip(isMobile, "Desktop disclosure is hidden in the phone project.");
    await page.setViewportSize({ width: 768, height: 800 });
    await primeSettledMarketingChrome(page);
    await gotoMarketing(page, "/");

    const trigger = page.getByRole("button", { name: "Product", exact: true });
    const panelId = await openDisclosure(page, trigger);
    const panel = page.locator(`[id="${panelId}"]`);
    await expect(panel).toBeVisible();

    const geometry = await panel.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom,
        viewportWidth: document.documentElement.clientWidth,
        viewportHeight: document.documentElement.clientHeight,
        documentWidth: document.documentElement.scrollWidth,
      };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
    expect(geometry.documentWidth).toBeLessThanOrEqual(
      geometry.viewportWidth + 1,
    );

    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("real-phone navigation traps focus, scrolls, and restores the page", async ({
    page,
    isMobile,
  }) => {
    test.slow();
    test.skip(!isMobile, "Phone chrome is exercised in the mobile project.");
    await primeSettledMarketingChrome(page);
    await gotoMarketing(page, "/");

    const trigger = page.getByRole("button", { name: "Open navigation" });
    await expect(trigger).toBeVisible();
    await openDisclosure(page, trigger);
    const dialog = page.getByRole("dialog", { name: "Site navigation" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("a").first()).toBeFocused();
    expect(
      await page.locator("body").evaluate((body) => body.style.overflow),
    ).toBe("hidden");

    const shortTargets = await dialog.locator("a").evaluateAll((links) =>
      links.flatMap((link) => {
        const rect = link.getBoundingClientRect();
        return rect.height < 43.5 ? [link.textContent?.trim() ?? ""] : [];
      }),
    );
    expect(shortTargets, "mobile navigation keeps 44px targets").toEqual([]);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    expect(
      await page.locator("body").evaluate((body) => body.style.overflow),
    ).toBe("");
  });

  test("320px chrome fits and the final drawer link remains reachable", async ({
    page,
    isMobile,
  }) => {
    test.slow();
    test.skip(
      isMobile,
      "The desktop project supplies the explicit 320px viewport.",
    );
    await page.setViewportSize({ width: 320, height: 568 });
    await primeSettledMarketingChrome(page);
    await gotoMarketing(page, "/");

    const header = page.locator("header").first();
    const headerGeometry = await header.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      page: document.documentElement.scrollWidth,
    }));
    expect(headerGeometry.page).toBeLessThanOrEqual(
      headerGeometry.viewport + 1,
    );

    const trigger = page.getByRole("button", { name: "Open navigation" });
    const requestAccess = header.getByRole("link", { name: "Request access" });
    for (const control of [trigger, requestAccess]) {
      expect((await control.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
        43.5,
      );
    }

    await openDisclosure(page, trigger);
    const dialog = page.getByRole("dialog", { name: "Site navigation" });
    const signIn = dialog.getByRole("link", { name: "Sign in", exact: true });
    await signIn.scrollIntoViewIfNeeded();
    await expect(signIn).toBeVisible();
    const panelGeometry = await dialog.evaluate((node) => ({
      bottom: node.getBoundingClientRect().bottom,
      viewport: document.documentElement.clientHeight,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
    }));
    expect(panelGeometry.bottom).toBeLessThanOrEqual(panelGeometry.viewport);
    expect(panelGeometry.scrollHeight).toBeGreaterThan(
      panelGeometry.clientHeight,
    );
  });

  test("skip link and fixed-light viewport policy are explicit", async ({
    page,
  }) => {
    test.slow();
    await primeSettledMarketingChrome(page);
    await gotoMarketing(page, "/");
    await page.keyboard.press("Home");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("main#main-content")).toBeFocused();
    await expect(page.locator('meta[name="color-scheme"]')).toHaveAttribute(
      "content",
      "light",
    );
  });

  test("phone cookie preferences are operable, persistent, and reopen from the footer", async ({
    page,
    isMobile,
  }) => {
    test.skip(
      !isMobile,
      "Consent chrome is exercised in the real-phone project.",
    );
    test.slow();
    await page.addInitScript(() => {
      window.localStorage.setItem("moosewave.preprod_banner.dismissed.v1", "1");
      window.localStorage.removeItem("moosewave.cookie.consent.v1");
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await gotoMarketing(page, "/pricing");

    const region = page.getByRole("region", { name: "Cookie preferences" });
    await expect(region).toBeVisible();
    const shortButtons = await region.locator("button").evaluateAll((buttons) =>
      buttons.flatMap((button) => {
        const rect = button.getBoundingClientRect();
        return rect.height < 43.5 ? [button.textContent?.trim() ?? ""] : [];
      }),
    );
    expect(shortButtons, "cookie actions keep 44px phone targets").toEqual([]);

    const customize = region.getByRole("button", { name: "Customize" });
    await waitForReactHandlers(customize);
    await customize.click();
    const analytics = region.getByRole("checkbox", { name: /Analytics/ });
    const marketing = region.getByRole("checkbox", { name: /Marketing/ });
    await expect(analytics).not.toBeChecked();
    await expect(marketing).not.toBeChecked();
    const shortChoices = await region
      .locator("label")
      .evaluateAll((labels) =>
        labels.flatMap((label) =>
          label.getBoundingClientRect().height < 43.5
            ? [label.textContent?.trim() ?? ""]
            : [],
        ),
      );
    expect(shortChoices, "preference rows keep 44px phone targets").toEqual([]);

    await region.getByRole("button", { name: "Save preferences" }).click();
    await expect(region).toBeHidden();

    const footerButton = page.getByRole("button", {
      name: "Cookie preferences",
    });
    await footerButton.scrollIntoViewIfNeeded();
    await footerButton.click();
    await expect(region).toBeVisible();
    await expect(
      region.getByRole("button", { name: "Save preferences" }),
    ).toBeFocused();
    await analytics.check();
    await region.getByRole("button", { name: "Save preferences" }).click();
    await expect(region).toBeHidden();
    expect(
      await page.evaluate(() =>
        window.localStorage.getItem("moosewave.cookie.consent.v1"),
      ),
    ).toContain('"analytics":true');
  });

  test("pre-production notice dismisses persistently with a phone-sized target", async ({
    page,
    isMobile,
  }) => {
    test.skip(
      !isMobile,
      "Banner persistence is exercised in the phone project.",
    );
    test.slow();
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "moosewave.cookie.consent.v1",
        JSON.stringify({
          choice: "reject",
          prefs: { essential: true, analytics: false, marketing: false },
          ts: new Date().toISOString(),
        }),
      );
      window.localStorage.removeItem("moosewave.preprod_banner.dismissed.v1");
    });
    await gotoMarketing(page, "/");
    const notice = page.getByRole("note", {
      name: "Pre-production qualification notice",
    });
    await expect(notice).toBeVisible();
    const dismiss = notice.getByRole("button", {
      name: "Dismiss pre-production notice",
    });
    expect((await dismiss.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
      43.5,
    );
    await waitForReactHandlers(dismiss);
    await dismiss.click();
    await expect(notice).toBeHidden();
    expect(
      await page.evaluate(() =>
        window.localStorage.getItem("moosewave.preprod_banner.dismissed.v1"),
      ),
    ).toBe("1");
  });
});

test.describe("marketing interactive components", () => {
  test("FAQ, install tabs, directory filters, and changelog filters expose state", async ({
    page,
    isMobile,
  }) => {
    test.setTimeout(300_000);
    test.skip(
      isMobile,
      "One browser project is sufficient for component state coverage.",
    );
    await primeSettledMarketingChrome(page);

    await gotoMarketing(page, "/features");
    const faqToggle = page
      .locator("button[aria-expanded]:not([aria-controls])")
      .filter({ hasText: /all/i });
    await waitForReactHandlers(faqToggle);
    await faqToggle.click();
    await expect(faqToggle).toHaveText("Collapse all");
    await expect(faqToggle).toHaveAttribute("aria-expanded", "true");

    await gotoMarketing(page, "/developers");
    const tablist = page.getByRole("tablist", { name: "Install snippets" });
    const selected = tablist.getByRole("tab", { selected: true });
    await waitForReactHandlers(selected);
    const selectedId = await selected.getAttribute("id");
    await selected.press("ArrowRight");
    await expect(
      tablist.getByRole("tab", { selected: true }),
    ).not.toHaveAttribute("id", selectedId ?? "");

    await gotoMarketing(page, "/integrations");
    const integrationSearch = page.getByRole("searchbox", {
      name: "Search integrations",
    });
    await waitForReactHandlers(integrationSearch);
    await integrationSearch.fill("definitely-not-an-integration");
    await expect(page.getByText(/No integrations match/)).toBeVisible();
    await integrationSearch.fill("");
    const commerce = page.getByRole("button", {
      name: "Commerce",
      exact: true,
    });
    await waitForReactHandlers(commerce);
    await commerce.click();
    await expect(commerce).toHaveAttribute("aria-pressed", "true");

    await gotoMarketing(page, "/changelog");
    const planned = page.getByRole("button", { name: "Planned", exact: true });
    await waitForReactHandlers(planned);
    await planned.click();
    await expect(planned).toHaveAttribute("aria-pressed", "true");
  });
});

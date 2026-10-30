import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

const ROUTES = [
  { path: "/en/forms/newsletter" },
  { path: "/en/forms/reader-survey" },
  { path: "/en/forms/feedback", expectedStatus: 404 },
  { path: "/en/forms/success" },
  { path: "/en/forms/success?mode=double" },
  { path: "/en/forms/newsletter/confirm/confirmed_demo" },
  { path: "/en/forms/newsletter/confirm/already_demo" },
  { path: "/en/forms/newsletter/confirm/expired_demo" },
  { path: "/en/forms/newsletter/confirm/missing_demo" },
  { path: "/en/forms/newsletter/confirm/unavailable_demo" },
  { path: "/en/preferences/tok_reader@example.com" },
  { path: "/en/preferences/tok_reader@example.com?frequency=true" },
  { path: "/en/preferences/gpc_reader@example.com" },
  { path: "/en/preferences/empty_reader@example.com" },
  { path: "/en/preferences/expired_demo" },
  { path: "/en/preferences/unavailable_demo" },
  { path: "/en/preferences/missing_demo", expectedStatus: 404 },
  { path: "/en/landing/demo-launch" },
  { path: "/en/landing/unavailable-launch" },
  { path: "/en/landing/draft-launch", expectedStatus: 404 },
  { path: "/en/archive/demo-letter" },
  { path: "/en/archive/demo-letter/designing-for-the-inbox" },
  { path: "/en/archive/demo-letter/not-an-issue" },
  { path: "/en/archive/demo-letter/unavailable" },
  { path: "/en/archive/empty-letter" },
  { path: "/en/archive/unavailable-letter" },
  { path: "/en/gift/demo-token" },
  { path: "/status" },
  { path: "/offline" },
  { path: "/definitely-not-a-postwave-route", expectedStatus: 404 },
  { path: "/es/preferences/tok_lector@example.com" },
  { path: "/fr/archive/demo-letter" },
  { path: "/de/forms/newsletter" },
  { path: "/pt/landing/demo-launch" },
  { path: "/ja/gift/demo-token" },
] as const;

const BLOCKING_IMPACTS = new Set(["critical", "serious"]);

function collectRuntimeErrors(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedResponses: Array<{
    url: string;
    status: number;
    resourceType: string;
  }> = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() < 400) return;
    failedResponses.push({
      url: response.url(),
      status: response.status(),
      resourceType: response.request().resourceType(),
    });
  });
  return {
    consoleErrors,
    failedResponses,
    pageErrors,
    clear() {
      consoleErrors.length = 0;
      failedResponses.length = 0;
      pageErrors.length = 0;
    },
  };
}

async function waitForReactHandler(control: Locator): Promise<void> {
  await expect
    .poll(
      () =>
        control.evaluate((node) =>
          Object.getOwnPropertyNames(node).some((key) =>
            key.startsWith("__reactProps$"),
          ),
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
}

async function gotoPublic(
  page: Page,
  path: string,
  beforeRecovery?: () => void,
): Promise<number> {
  const warm = await page.request.get(path, { timeout: 90_000 });
  let response = await page.goto(path, {
    waitUntil: "load",
    timeout: 90_000,
  });
  expect(response, `${path} returned a document`).not.toBeNull();
  if (warm.status() !== response!.status()) {
    // next dev can briefly serve its not-found boundary while a route manifest
    // is being rebuilt. Require an immediate stable recovery instead of
    // mistaking that single warm-up response for the application's state.
    const recoveredWarm = await page.request.get(path, { timeout: 90_000 });
    beforeRecovery?.();
    response = await page.goto(path, {
      waitUntil: "load",
      timeout: 90_000,
    });
    expect(response, `${path} returned a recovered document`).not.toBeNull();
    expect(response!.status(), `${path} recovered document status`).toBe(
      recoveredWarm.status(),
    );
  }
  await expect(page.locator("main")).toBeVisible({ timeout: 30_000 });
  return response!.status();
}

test.describe("localized subscriber and public utility route inventory", () => {
  for (const route of ROUTES) {
    test(`${route.path} is structured, responsive, and accessible`, async ({
      page,
      isMobile,
    }) => {
      test.slow();
      if (isMobile) await page.setViewportSize({ width: 320, height: 800 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      const errors = collectRuntimeErrors(page);
      const status = await gotoPublic(page, route.path, errors.clear);
      const expectedStatus =
        "expectedStatus" in route ? route.expectedStatus : 200;
      expect(status).toBe(expectedStatus);

      // Chromium logs an expected 404 main document as a generic console
      // resource error. Account for that one document explicitly while still
      // failing on a missing script, image, API response, or unrelated frame.
      const expectedURL = new URL(route.path, page.url());
      const expectedDocumentFailure = errors.failedResponses.some(
        (failure) =>
          failure.resourceType === "document" &&
          failure.status === expectedStatus &&
          new URL(failure.url).pathname === expectedURL.pathname,
      );
      const unexpectedResponses = errors.failedResponses.filter(
        (failure) =>
          !(
            failure.resourceType === "document" &&
            failure.status === expectedStatus &&
            new URL(failure.url).pathname === expectedURL.pathname
          ),
      );
      const unexpectedConsoleErrors = errors.consoleErrors.filter(
        (message) =>
          !(
            expectedStatus >= 400 &&
            expectedDocumentFailure &&
            message.includes(`status of ${expectedStatus}`)
          ),
      );

      await expect(page.locator("main")).toHaveCount(1);
      await expect(page.locator("main h1")).toHaveCount(1);
      await expect(page).toHaveTitle(/\S+/);

      const structure = await page.evaluate((mobile) => {
        const viewport = document.documentElement.clientWidth;
        const duplicateIds = Array.from(document.querySelectorAll("[id]"))
          .map((node) => node.id)
          .filter((id, index, ids) => ids.indexOf(id) !== index);
        const smallTargets = mobile
          ? Array.from(
              document.querySelectorAll<HTMLElement>(
                'button, a[href], select, textarea, input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"])',
              ),
            )
              .filter((node) => {
                const style = getComputedStyle(node);
                const rect = node.getBoundingClientRect();
                const visuallyClipped =
                  rect.width <= 1 &&
                  rect.height <= 1 &&
                  style.overflow === "hidden" &&
                  Boolean(style.clip && style.clip !== "auto");
                return (
                  style.display !== "none" &&
                  style.visibility !== "hidden" &&
                  rect.width > 0 &&
                  rect.height > 0 &&
                  !visuallyClipped &&
                  !node.matches(":disabled") &&
                  !(
                    node instanceof HTMLAnchorElement &&
                    style.display === "inline"
                  )
                );
              })
              .flatMap((node) => {
                const rect = node.getBoundingClientRect();
                return rect.height < 43.5 || rect.width < 24
                  ? [
                      {
                        label:
                          node.getAttribute("aria-label") ||
                          node.textContent
                            ?.trim()
                            .replace(/\s+/g, " ")
                            .slice(0, 80),
                        width: Math.round(rect.width),
                        height: Math.round(rect.height),
                      },
                    ]
                  : [];
              })
          : [];
        return {
          viewport,
          bodyWidth: document.body.scrollWidth,
          mainWidth: document.querySelector("main")?.scrollWidth ?? 0,
          duplicateIds,
          smallTargets,
        };
      }, isMobile);

      expect(
        Math.max(structure.bodyWidth, structure.mainWidth),
        `${route.path} overflows ${structure.viewport}px`,
      ).toBeLessThanOrEqual(structure.viewport + 1);
      expect(structure.duplicateIds, `${route.path} duplicate ids`).toEqual([]);
      expect(structure.smallTargets, `${route.path} small targets`).toEqual([]);

      const axe = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      const blocking = axe.violations.filter(
        (violation) =>
          violation.impact && BLOCKING_IMPACTS.has(violation.impact),
      );
      expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
      expect(
        unexpectedResponses,
        `${route.path} unexpected failed responses`,
      ).toEqual([]);
      expect(errors.pageErrors, `${route.path} page errors`).toEqual([]);
      expect(unexpectedConsoleErrors, `${route.path} console errors`).toEqual(
        [],
      );
    });
  }
});

test.describe("subscriber journey interactions", () => {
  test("compiled hosted form keeps its opaque attempt across uncertain transport", async ({
    page,
  }) => {
    const submittedAttempts: string[] = [];
    let deterministicReject = false;
    await page.addInitScript(() => {
      const browser = window as typeof window & {
        __signupCaptchaResets?: number;
        grecaptcha?: { reset: () => void };
      };
      browser.__signupCaptchaResets = 0;
      browser.grecaptcha = {
        reset: () => {
          browser.__signupCaptchaResets =
            (browser.__signupCaptchaResets ?? 0) + 1;
        },
      };
    });
    await page.route("**/api/public/forms/newsletter/submit", async (route) => {
      const body = new URLSearchParams(route.request().postData() ?? "");
      submittedAttempts.push(body.get("submission_attempt_id") ?? "");
      if (deterministicReject) {
        await route.fulfill({
          status: 422,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "bad_email",
              message: "Review the address.",
            },
          }),
        });
        return;
      }
      await route.fulfill({ status: 503, body: "" });
    });

    await gotoPublic(page, "/en/forms/newsletter");
    const form = page.locator("form");
    const email = form.locator('input[name="email"]');
    const attempt = form.locator('input[name="submission_attempt_id"]');
    await email.fill("reader@example.com");
    await expect(attempt).toHaveValue(/^[a-f0-9]{32}$/);
    const first = await attempt.inputValue();

    await form.evaluate((node: HTMLFormElement) => node.requestSubmit());
    await expect.poll(() => submittedAttempts.length).toBe(1);
    await expect(attempt).toHaveValue(first);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & { __signupCaptchaResets?: number })
              .__signupCaptchaResets ?? 0,
        ),
      )
      .toBe(1);

    await form.evaluate((node: HTMLFormElement) => node.requestSubmit());
    await expect.poll(() => submittedAttempts.length).toBe(2);
    expect(submittedAttempts).toEqual([first, first]);

    await email.fill("changed@example.com");
    await expect.poll(() => attempt.inputValue()).not.toBe(first);
    const changed = await attempt.inputValue();
    deterministicReject = true;
    await form.evaluate((node: HTMLFormElement) => node.requestSubmit());
    await expect.poll(() => submittedAttempts.length).toBe(3);
    expect(submittedAttempts[2]).toBe(changed);
    await expect.poll(() => attempt.inputValue()).not.toBe(changed);
    await expect(page.getByRole("alert")).toContainText("Review the address.");
  });

  test("survey validation, step focus, and preserved answers work end to end", async ({
    page,
  }) => {
    test.slow();
    await gotoPublic(page, "/en/forms/reader-survey");
    const next = page.getByRole("button", { name: "Next", exact: true });
    await waitForReactHandler(next);

    await next.click();
    await expect(
      page.getByRole("alert").filter({ hasText: "required fields" }),
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: /Email address/ }),
    ).toBeFocused();

    await page
      .getByRole("textbox", { name: /Email address/ })
      .fill("reader@example.com");
    await page
      .getByRole("combobox", { name: /Which best describes you/ })
      .selectOption("writer");
    await next.click();
    await expect(page.getByText("Step 2 of 3")).toBeVisible();
    await expect(
      page.locator('[role="group"][aria-labelledby="survey-step-progress"]'),
    ).toBeFocused();

    await next.click();
    await expect(
      page.getByRole("alert").filter({ hasText: "required fields" }),
    ).toBeVisible();
    await page.getByRole("radio", { name: "Every issue" }).check();
    await page.getByRole("radio", { name: "8", exact: true }).check();
    await page
      .getByRole("textbox", { name: /What would make/ })
      .fill("More teardown examples with the numbers included.");
    await next.click();
    await expect(page.getByText("Step 3 of 3")).toBeVisible();

    await page.getByRole("button", { name: "Back" }).click();
    await expect(
      page.getByRole("radio", { name: "Every issue" }),
    ).toBeChecked();
    await expect(
      page.getByRole("radio", { name: "8", exact: true }),
    ).toBeChecked();
    await expect(
      page.getByRole("textbox", { name: /What would make/ }),
    ).toHaveValue("More teardown examples with the numbers included.");
  });

  test("preferences save, confirmation, cancellation, and frequency bounds are deliberate", async ({
    page,
  }) => {
    test.slow();
    await gotoPublic(page, "/en/preferences/tok_reader@example.com");
    const save = page.getByRole("button", { name: "Save preferences" });
    await waitForReactHandler(save);
    await page.getByRole("checkbox", { name: /Weekly digest/ }).uncheck();
    await save.click();
    await expect(
      page.getByRole("status").filter({ hasText: "Preferences saved" }),
    ).toBeVisible();

    const unsubscribe = page.getByRole("button", {
      name: "Unsubscribe from everything",
    });
    await unsubscribe.click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Yes, unsubscribe me" }),
    ).toBeFocused();
    await dialog.getByRole("button", { name: "Keep my subscriptions" }).click();
    await expect(dialog).toBeHidden();
    await expect(unsubscribe).toBeFocused();

    await unsubscribe.click();
    await dialog.getByRole("button", { name: "Yes, unsubscribe me" }).click();
    await expect(dialog).toBeHidden();
    for (const checkbox of await page.getByRole("checkbox").all()) {
      await expect(checkbox).not.toBeChecked();
      await expect(checkbox).toBeDisabled();
    }

    await page.goto("/en/preferences/tok_reader@example.com?frequency=true");
    const paused = page.getByRole("radio", { name: /Pause for a while/ });
    await waitForReactHandler(paused);
    await paused.check();
    const days = page.getByRole("spinbutton");
    await days.fill("999");
    await days.blur();
    await expect(days).toHaveValue("365");
    await page.getByRole("button", { name: "Save preference" }).click();
    await expect(page.getByRole("status")).toContainText("Paused until");
  });

  test("landing signup announces success and recoverable failure", async ({
    page,
  }) => {
    let shouldSucceed = true;
    await page.route(
      "**/api/public/landing-pages/demo-launch/convert",
      (route) => route.fulfill({ status: shouldSucceed ? 204 : 503, body: "" }),
    );
    await gotoPublic(page, "/en/landing/demo-launch");
    const email = page.getByRole("textbox", { name: "Email address" });
    const submit = page.getByRole("button", { name: "Subscribe" });
    await waitForReactHandler(submit);
    await email.fill("reader@example.com");
    await submit.click();
    await expect(page.getByRole("status")).toContainText("You're on the list");

    shouldSucceed = false;
    await email.fill("retry@example.com");
    await expect(page.getByRole("status")).toHaveCount(0);
    await submit.click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Could not subscribe" }),
    ).toBeVisible();
  });

  test("language switching preserves the public destination", async ({
    page,
  }) => {
    await gotoPublic(page, "/en/forms/newsletter");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await skip.focus();
    const skipBox = await skip.boundingBox();
    expect(skipBox?.height ?? 0).toBeGreaterThanOrEqual(43.5);
    await skip.press("Enter");
    await expect(page.locator("main#public-subscriber-main")).toBeFocused();

    const language = page.getByRole("combobox", { name: "Language" });
    await waitForReactHandler(language);
    await language.selectOption("es");
    await expect(page).toHaveURL(
      /\/es\/forms\/newsletter#public-subscriber-main$/,
    );
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
    await expect(page.getByRole("combobox", { name: "Idioma" })).toHaveValue(
      "es",
    );

    await gotoPublic(
      page,
      "/en/preferences/tok_reader@example.com?frequency=true#frequency-settings",
    );
    const preferenceLanguage = page.getByRole("combobox", {
      name: "Language",
    });
    await waitForReactHandler(preferenceLanguage);
    await preferenceLanguage.selectOption("es");
    await expect(page).toHaveURL(
      /\/es\/preferences\/tok_reader@example\.com\?frequency=true#frequency-settings$/,
    );
    await expect(page.getByRole("combobox", { name: "Idioma" })).toHaveValue(
      "es",
    );
  });

  test("status history anchors and offline connectivity feedback remain keyboard reachable", async ({
    page,
  }) => {
    await gotoPublic(page, "/status");
    const degradedCard = page
      .getByTestId("status-service")
      .filter({ hasText: "Deliverability checks" });
    await degradedCard
      .getByRole("link", { name: /View 90-day history/ })
      .click();
    await expect(page).toHaveURL(/#history-deliverability-checks-/);
    const historyRegion = page
      .getByRole("region", { name: "Deliverability checks" })
      .last();
    await historyRegion.focus();
    await expect(historyRegion).toBeFocused();

    await gotoPublic(page, "/offline");
    await expect(page.getByRole("status")).toContainText("back online", {
      timeout: 30_000,
    });
    await page.evaluate(() => {
      Object.defineProperty(window.navigator, "onLine", {
        configurable: true,
        get: () => false,
      });
      window.dispatchEvent(new Event("offline"));
    });
    await expect(page.getByRole("status")).toContainText("still offline");
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(window.navigator, "onLine", {
        configurable: true,
        get: () => true,
      });
      window.dispatchEvent(new Event("online"));
    });
    await expect(page.getByRole("status")).toContainText("back online");
  });
});

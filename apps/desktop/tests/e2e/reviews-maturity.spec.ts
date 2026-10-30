import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../visual/fixture";
import {
  ACTIVE_WIDGET_NAME,
  ACTIVE_WIDGET_URL,
  attachReviewsEvidence,
  expectNoReviewsHorizontalOverflow,
  INACTIVE_URL_CANARY,
  openReviews,
  PENDING_REVIEW_TITLE,
  PRIVATE_CONTACT_CANARY,
  PRIVATE_PAYLOAD_CANARY,
  requestCount,
  saveReviewsEvidence,
  seriousReviewsAxeViolations,
  type ReviewsHarness,
} from "./reviews-evidence-harness";

function workspaceTab(page: Page, name: RegExp): Locator {
  return page
    .getByRole("tablist", { name: "Reviews workspaces" })
    .getByRole("tab", { name });
}

function widgetCard(page: Page, name: string): Locator {
  return page.getByRole("article", { name, exact: true });
}

async function pointerCanActivate(control: Locator): Promise<boolean> {
  try {
    await control.click({ trial: true, timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

async function parkPointerOutsideViewport(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  await page.mouse.move(
    (viewport?.width ?? 1_440) + 100,
    (viewport?.height ?? 1_000) + 100,
  );
}

async function pressFocused(
  page: Page,
  control: Locator,
  key = "Enter",
): Promise<void> {
  await control.evaluate((element) => {
    (element as HTMLElement).focus();
  });
  await page.keyboard.press(key);
}

async function openWidgetWorkspace(
  page: Page,
  harness: ReviewsHarness,
): Promise<void> {
  const moderation = workspaceTab(page, /Moderation inbox/u);
  const widgets = workspaceTab(page, /Storefront widgets/u);

  await moderation.focus();
  await moderation.press("ArrowRight");
  await expect(widgets).toBeFocused();
  await expect(moderation).toHaveAttribute("aria-selected", "true");
  await expect(widgets).toHaveAttribute("aria-selected", "false");
  expect(requestCount(harness, "/api/v1/reviews/widgets")).toBe(0);

  await widgets.press("Enter");
  await expect(widgets).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("heading", { name: "Review widgets", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => requestCount(harness, "/api/v1/reviews/widgets"))
    .toBeGreaterThanOrEqual(1);
}

test("desktop moderation loads full evidence and requires a cancelable publish confirmation", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openReviews(page, bootApp, setTheme, {
    theme: "dark",
  });

  await expect(
    page.getByRole("region", { name: "Review queue" }),
  ).toBeVisible();
  await expect(page.locator(".reviews-card")).toHaveCount(2);
  await expect(
    page.getByRole("button", {
      name: new RegExp(`Review and decide ${PENDING_REVIEW_TITLE}`, "u"),
    }),
  ).toBeVisible();
  await expect(page.locator(".reviews-page")).not.toContainText(
    PRIVATE_CONTACT_CANARY,
  );
  await expect(page.locator(".reviews-page")).not.toContainText(
    PRIVATE_PAYLOAD_CANARY,
  );
  await expectNoReviewsHorizontalOverflow(page);
  expect(await seriousReviewsAxeViolations(page)).toEqual([]);
  await saveReviewsEvidence(page, testInfo, "reviews-moderation-desktop");

  const opener = page.getByRole("button", {
    name: new RegExp(`Review and decide ${PENDING_REVIEW_TITLE}`, "u"),
  });
  await opener.focus();
  await opener.press("Enter");
  const detail = page.getByRole("dialog", {
    name: "Review evidence",
    exact: true,
  });
  await expect(detail).toBeVisible();
  await expect(
    detail.getByText(PENDING_REVIEW_TITLE, { exact: true }),
  ).toBeVisible();
  await expect(
    detail.getByRole("heading", { name: "Reported trust flags" }),
  ).toBeVisible();
  await expect(
    detail.getByText("Service-reported public replies"),
  ).toBeVisible();
  await expect
    .poll(() => requestCount(harness, "/api/v1/reviews/review-pending-001"))
    .toBeGreaterThanOrEqual(1);
  const publish = detail.getByRole("button", {
    name: "Publish review",
    exact: true,
  });
  await expect(publish).toBeEnabled();
  await expect(detail).not.toContainText(PRIVATE_CONTACT_CANARY);
  await expect(detail).not.toContainText(PRIVATE_PAYLOAD_CANARY);
  await expectNoReviewsHorizontalOverflow(page);
  expect(await seriousReviewsAxeViolations(page, ".modal-card")).toEqual([]);
  await saveReviewsEvidence(page, testInfo, "reviews-detail-desktop", {
    resetScroll: false,
  });

  await publish.click();
  const confirmation = page.getByRole("dialog", {
    name: "Publish this review now?",
    exact: true,
  });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText("Immediate server-side publication");
  await expect(
    confirmation.getByRole("button", {
      name: "Publish review now",
      exact: true,
    }),
  ).toBeEnabled();
  await expectNoReviewsHorizontalOverflow(page);
  await saveReviewsEvidence(page, testInfo, "reviews-publish-confirm-desktop", {
    resetScroll: false,
  });

  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(confirmation).toHaveCount(0);
  await expect(publish).toBeFocused();
  expect(harness.requests.filter(({ method }) => method !== "GET")).toEqual([]);

  await detail
    .locator(".modal-footer")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(detail).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(harness.unexpectedRequests).toEqual([]);
  expect(harness.runtimeErrors).toEqual([]);
  await attachReviewsEvidence(testInfo, "reviews-moderation-requests", {
    requests: harness.requests,
    unexpectedRequests: harness.unexpectedRequests,
  });
});

test("manual route tabs defer widget reads and guarded active review stays distinct from inactive inventory", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openReviews(page, bootApp, setTheme, {
    theme: "light",
  });
  await openWidgetWorkspace(page, harness);

  const active = widgetCard(page, ACTIVE_WIDGET_NAME);
  const draft = widgetCard(page, "Checkout proof draft");
  const paused = widgetCard(page, "Collection summary paused");
  await expect(active).toContainText("Reported public endpoint");
  await expect(active).toContainText(ACTIVE_WIDGET_URL);
  await expect(active).toContainText("Endpoint access withheld");
  await expect(active).toContainText(
    "Tenant ownership and rendered output are not verified",
  );
  await expect(active.getByRole("link")).toHaveCount(0);
  await expect(
    active.getByRole("button", { name: "Copy endpoint URL" }),
  ).toHaveCount(0);
  await expect(
    active.getByRole("button", { name: "Review installation" }),
  ).toBeVisible();
  await expect(draft).toContainText("This widget is a draft");
  await expect(paused).toContainText("This widget is paused");
  await expect(draft.getByRole("button")).toHaveCount(0);
  await expect(paused.getByRole("button")).toHaveCount(0);
  await expect(page.locator(".reviews-page")).not.toContainText(
    INACTIVE_URL_CANARY,
  );
  expect(
    requestCount(
      harness,
      /^\/api\/v1\/reviews\/widgets\/[^/]+\/embed\/(?:iframe|script)$/u,
    ),
  ).toBe(0);
  await expectNoReviewsHorizontalOverflow(page);
  expect(await seriousReviewsAxeViolations(page)).toEqual([]);
  await active.scrollIntoViewIfNeeded();
  await saveReviewsEvidence(page, testInfo, "reviews-widgets-desktop", {
    resetScroll: false,
  });

  const installationOpener = active.getByRole("button", {
    name: "Review installation",
    exact: true,
  });
  await installationOpener.focus();
  await installationOpener.press("Enter");
  const installation = page.getByRole("dialog", {
    name: `Review installation · ${ACTIVE_WIDGET_NAME}`,
    exact: true,
  });
  await expect(installation).toBeVisible();
  await expect(installation.getByText("Iframe copy blocked")).toBeAttached();
  const scriptMethod = installation.getByRole("button", {
    name: /Script Review/u,
  });
  const scriptPointerActionable = await pointerCanActivate(scriptMethod);
  await saveReviewsEvidence(
    page,
    testInfo,
    "reviews-installation-pointer-open-desktop",
    { resetScroll: false },
  );
  await parkPointerOutsideViewport(page);
  await expect(installation.getByText("Iframe copy blocked")).toBeVisible();
  await expect(
    installation.getByRole("button", { name: "Iframe copy unavailable" }),
  ).toBeDisabled();
  expect(
    requestCount(
      harness,
      "/api/v1/reviews/widgets/widget-active-001/embed/iframe",
    ),
  ).toBe(1);
  expect(
    requestCount(
      harness,
      "/api/v1/reviews/widgets/widget-active-001/embed/script",
    ),
  ).toBe(0);
  await expectNoReviewsHorizontalOverflow(page);
  await saveReviewsEvidence(
    page,
    testInfo,
    "reviews-installation-iframe-blocker-desktop",
    { resetScroll: false },
  );

  await pressFocused(page, scriptMethod);
  await expect(
    installation.getByText("Storefront delivery not certified"),
  ).toBeVisible();
  await expect(
    installation.getByRole("button", { name: "Script copy unavailable" }),
  ).toBeDisabled();
  await expect
    .poll(() =>
      requestCount(
        harness,
        "/api/v1/reviews/widgets/widget-active-001/embed/script",
      ),
    )
    .toBe(1);
  expect(await seriousReviewsAxeViolations(page, ".modal-card")).toEqual([]);
  await saveReviewsEvidence(
    page,
    testInfo,
    "reviews-installation-script-blocker-desktop",
    { resetScroll: false },
  );

  await installation
    .locator(".modal-footer")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(installation).toHaveCount(0);
  await expect(installationOpener).toBeFocused();

  const widgets = workspaceTab(page, /Storefront widgets/u);
  const moderation = workspaceTab(page, /Moderation inbox/u);
  await widgets.focus();
  await widgets.press("Home");
  await expect(moderation).toBeFocused();
  await expect(widgets).toHaveAttribute("aria-selected", "true");
  await moderation.press("Space");
  await expect(moderation).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("heading", { name: "Moderation inbox", exact: true }),
  ).toBeVisible();

  expect(
    scriptPointerActionable,
    "The installation method must remain pointer-actionable after opening from a hoverable widget card.",
  ).toBe(true);
  expect(harness.unexpectedRequests).toEqual([]);
  expect(harness.runtimeErrors).toEqual([]);
  await attachReviewsEvidence(testInfo, "reviews-widget-requests", {
    requests: harness.requests,
    unexpectedRequests: harness.unexpectedRequests,
  });
});

test("400px moderation, widgets, and installation states remain contained and keyboard operable", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openReviews(page, bootApp, setTheme, {
    theme: "dark",
  });
  await page.setViewportSize({ width: 400, height: 844 });

  await expect(
    page.getByRole("heading", { name: "Moderation inbox", exact: true }),
  ).toBeVisible();
  await expectNoReviewsHorizontalOverflow(page);
  await saveReviewsEvidence(page, testInfo, "reviews-moderation-narrow-400");

  await openWidgetWorkspace(page, harness);
  const active = widgetCard(page, ACTIVE_WIDGET_NAME);
  await active.scrollIntoViewIfNeeded();
  await expectNoReviewsHorizontalOverflow(page);
  await saveReviewsEvidence(page, testInfo, "reviews-widgets-narrow-400", {
    resetScroll: false,
  });

  await active
    .getByRole("button", { name: "Review installation", exact: true })
    .click();
  const installation = page.getByRole("dialog", {
    name: `Review installation · ${ACTIVE_WIDGET_NAME}`,
    exact: true,
  });
  await expect(installation.getByText("Iframe copy blocked")).toBeAttached();
  const scriptMethod = installation.getByRole("button", {
    name: /Script Review/u,
  });
  const scriptPointerActionable = await pointerCanActivate(scriptMethod);
  await saveReviewsEvidence(
    page,
    testInfo,
    "reviews-installation-pointer-open-narrow-400",
    { resetScroll: false },
  );
  await parkPointerOutsideViewport(page);
  await expect(installation.getByText("Iframe copy blocked")).toBeVisible();
  await expectNoReviewsHorizontalOverflow(page);
  await pressFocused(page, scriptMethod);
  await expect(
    installation.getByText("Storefront delivery not certified"),
  ).toBeVisible();
  await expect(
    installation.getByRole("button", { name: "Script copy unavailable" }),
  ).toBeDisabled();
  await expectNoReviewsHorizontalOverflow(page);
  expect(await seriousReviewsAxeViolations(page, ".modal-card")).toEqual([]);
  const scriptCopy = installation.getByRole("button", {
    name: "Script copy unavailable",
  });
  const closeButton = installation
    .locator(".modal-footer")
    .getByRole("button", { name: "Close", exact: true });
  const [scriptCopyBox, modalFooterBox, modalCardBox, closeButtonBox] =
    await Promise.all([
      scriptCopy.boundingBox(),
      installation.locator(".modal-footer").boundingBox(),
      installation.boundingBox(),
      closeButton.boundingBox(),
    ]);
  expect(scriptCopyBox).not.toBeNull();
  expect(modalFooterBox).not.toBeNull();
  expect(modalCardBox).not.toBeNull();
  expect(closeButtonBox).not.toBeNull();
  expect(
    Math.round((scriptCopyBox?.y ?? 0) + (scriptCopyBox?.height ?? 0)),
    "The narrow disabled-copy control must finish above the sticky modal footer.",
  ).toBeLessThanOrEqual(Math.round(modalFooterBox?.y ?? 0) + 1);
  expect(
    Math.round((modalCardBox?.y ?? 0) + (modalCardBox?.height ?? 0)),
    "The narrow installation dialog must remain inside the viewport.",
  ).toBeLessThanOrEqual(845);
  expect(
    Math.round((closeButtonBox?.y ?? 0) + (closeButtonBox?.height ?? 0)),
    "The narrow dialog close action must remain fully visible.",
  ).toBeLessThanOrEqual(844);
  await saveReviewsEvidence(
    page,
    testInfo,
    "reviews-installation-script-blocker-narrow-400",
    { resetScroll: false },
  );

  const installationLayout = await installation
    .locator(".reviews-installation")
    .evaluate((element) => {
      const gridTemplateColumns =
        window.getComputedStyle(element).gridTemplateColumns;
      return {
        columnCount:
          gridTemplateColumns === "none"
            ? 1
            : gridTemplateColumns.trim().split(/\s+/u).length,
        gridTemplateColumns,
        width: Math.round(element.getBoundingClientRect().width),
      };
    });
  await attachReviewsEvidence(testInfo, "reviews-responsive-requests", {
    installationLayout,
    requests: harness.requests,
    viewport: { width: 400, height: 844 },
  });

  expect(
    installationLayout.columnCount,
    "The narrow installation dialog must reflow its method navigation and code panel into one readable column.",
  ).toBe(1);
  expect(
    scriptPointerActionable,
    "The narrow installation method must remain pointer-actionable after opening from a hoverable widget card.",
  ).toBe(true);
  expect(harness.unexpectedRequests).toEqual([]);
  expect(harness.runtimeErrors).toEqual([]);
});

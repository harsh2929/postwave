import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type Page,
  type Route,
  type TestInfo,
} from "@playwright/test";

import { loginAsDemo } from "../helpers/auth";

const CREATED_FORM_ID = "form-created-closure";
const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

const NEWSLETTER_STRUCTURE = {
  fields: [
    {
      id: "h",
      kind: "heading",
      label: "Heading",
      required: false,
      content: "Subscribe to our newsletter",
    },
    {
      id: "email",
      kind: "email",
      label: "Email address",
      placeholder: "you@example.com",
      required: true,
    },
    {
      id: "name",
      kind: "name",
      label: "First name",
      placeholder: "Jane",
      required: false,
    },
    {
      id: "consent",
      kind: "checkbox",
      label: "I agree to receive emails. You can unsubscribe at any time.",
      required: true,
    },
    {
      id: "hp",
      kind: "honeypot",
      label: "Leave this empty",
      required: false,
      defaultValue: "",
    },
    {
      id: "submit",
      kind: "submit",
      label: "Subscribe",
      required: false,
    },
  ],
};

interface FixtureState {
  createAttempts: number;
  createBodies: Array<Record<string, unknown>>;
  listReads: number;
  patchAttempts: number;
  patchBodies: Array<Record<string, unknown>>;
  patchIfMatch: Array<string | null>;
  releaseFirstCreate: (() => void) | null;
  releaseFirstPatch: (() => void) | null;
}

const CREATED_FORM = {
  id: CREATED_FORM_ID,
  tenantId: TENANT_ID,
  slug: "launch-newsletter",
  name: "Launch newsletter",
  optInMode: "double",
  status: "draft",
  structure: NEWSLETTER_STRUCTURE,
  settings: {
    successMessage: "Welcome aboard.",
    successRedirectUrl: "/forms/success?ok=1",
  },
  createdAt: "2026-08-27T08:00:00.000Z",
  updatedAt: "2026-08-27T08:00:00.000Z",
};

async function json(
  route: Route,
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers,
    body: JSON.stringify(body),
  });
}

async function installFixtures(page: Page): Promise<FixtureState> {
  const state: FixtureState = {
    createAttempts: 0,
    createBodies: [],
    listReads: 0,
    patchAttempts: 0,
    patchBodies: [],
    patchIfMatch: [],
    releaseFirstCreate: null,
    releaseFirstPatch: null,
  };

  await page.route("**/api/health", (route) => json(route, { status: "ok" }));
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();

    if (path === "/api/v1/auth/me" && method === "GET") {
      await json(route, {
        user_id: USER_ID,
        tenant_id: TENANT_ID,
        email: "owner@example.test",
        role: "owner",
        effective_role: "owner",
        auth_provider: "local",
        email_verified: true,
        workspace_name: "Forms closure",
        workspace_slug: "demo",
      });
      return;
    }
    if (path === "/api/v1/auth/workspaces" && method === "GET") {
      await json(route, {
        workspaces: [
          {
            id: TENANT_ID,
            name: "Forms closure",
            slug: "demo",
            role: "owner",
            current: true,
          },
        ],
      });
      return;
    }
    if (path === "/api/v1/onboarding/steps" && method === "GET") {
      await json(route, {
        steps: { dashboard_tour: { state: "dismissed" } },
      });
      return;
    }
    if (path === "/api/v1/notifications" && method === "GET") {
      await json(route, { items: [], unread_count: 0 });
      return;
    }
    if (path === "/api/v1/approvals" && method === "GET") {
      await json(route, { approvals: [] });
      return;
    }
    if (path === "/api/v1/forms" && method === "GET") {
      state.listReads += 1;
      await json(route, [
        {
          ...CREATED_FORM,
          id: "form-existing-closure",
          name: "Reserved form",
          slug: "taken-slug",
        },
      ]);
      return;
    }
    if (path === "/api/v1/forms" && method === "POST") {
      state.createAttempts += 1;
      state.createBodies.push(
        request.postDataJSON() as Record<string, unknown>,
      );
      if (state.createAttempts === 1) {
        await new Promise<void>((resolve) => {
          state.releaseFirstCreate = resolve;
        });
        state.releaseFirstCreate = null;
        await json(
          route,
          {
            error: {
              code: "slug_taken",
              message: "That slug was reserved by another editor.",
            },
          },
          409,
        );
        return;
      }
      await json(route, CREATED_FORM, 201, {
        etag: '"form-created-closure-v1"',
      });
      return;
    }
    if (path === `/api/v1/forms/${CREATED_FORM_ID}` && method === "PATCH") {
      state.patchAttempts += 1;
      state.patchBodies.push(request.postDataJSON() as Record<string, unknown>);
      state.patchIfMatch.push(request.headers()["if-match"] ?? null);
      if (state.patchAttempts === 1) {
        await new Promise<void>((resolve) => {
          state.releaseFirstPatch = resolve;
        });
        state.releaseFirstPatch = null;
        await json(
          route,
          {
            error: {
              code: "starter_conflict",
              message: "Starter application was temporarily blocked.",
            },
          },
          409,
        );
        return;
      }
      await json(route, CREATED_FORM, 200, {
        etag: '"form-created-closure-v2"',
      });
      return;
    }
    if (path === `/api/v1/forms/${CREATED_FORM_ID}` && method === "GET") {
      await json(route, CREATED_FORM);
      return;
    }

    await route.fallback();
  });

  return state;
}

async function certifySurface(page: Page, mobile: boolean): Promise<void> {
  const metrics = await page.evaluate((checkTouch) => {
    const main = document.querySelector<HTMLElement>("main#main-content");
    const visible = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      );
    };
    const undersized = checkTouch
      ? Array.from(
          main?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),a[href],input:not([type="hidden"]):not(:disabled),textarea:not(:disabled)',
          ) ?? [],
        )
          .filter(visible)
          .map((control) => {
            const target =
              control instanceof HTMLInputElement &&
              ["checkbox", "radio"].includes(control.type)
                ? (control.closest<HTMLElement>("label") ?? control)
                : control;
            const rect = target.getBoundingClientRect();
            return {
              height: rect.height,
              label:
                control.getAttribute("aria-label") ??
                control.textContent?.trim().slice(0, 80) ??
                control.tagName,
              width: rect.width,
            };
          })
          .filter((control) => control.width < 43.5 || control.height < 43.5)
      : [];

    return {
      documentOverflow:
        Math.max(
          document.body.scrollWidth,
          document.documentElement.scrollWidth,
        ) - window.innerWidth,
      h1Count: document.querySelectorAll("h1").length,
      mainCount: document.querySelectorAll("main#main-content").length,
      mainOverflow: main ? main.scrollWidth - main.clientWidth : 0,
      title: document.title,
      undersized,
    };
  }, mobile);

  expect.soft(metrics.mainCount, "one named dashboard main").toBe(1);
  expect.soft(metrics.h1Count, "one page heading").toBe(1);
  expect
    .soft(metrics.documentOverflow, "document overflow")
    .toBeLessThanOrEqual(1);
  expect.soft(metrics.mainOverflow, "main overflow").toBeLessThanOrEqual(1);
  expect.soft(metrics.title).not.toMatch(/404|not found/iu);
  expect.soft(metrics.undersized, "44px mobile controls").toEqual([]);

  const axe = await new AxeBuilder({ page })
    .include("#main-content")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = axe.violations.filter((violation) =>
    ["critical", "serious"].includes(violation.impact ?? ""),
  );
  expect.soft(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}

const AUDIT_CASES = [
  {
    label: "desktop",
    project: "chromium-desktop",
    viewport: { width: 1280, height: 900 },
  },
  {
    label: "exact 320",
    project: "chromium-mobile",
    viewport: { width: 320, height: 800 },
  },
] as const;

test.describe("new form creation closure", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(() => {
      (
        window as typeof window & {
          __POSTWAVE_FORCE_REAL_API_FOR_E2E__?: boolean;
        }
      ).__POSTWAVE_FORCE_REAL_API_FOR_E2E__ = true;
    });
    await loginAsDemo(page, { navigate: false });
  });

  for (const auditCase of AUDIT_CASES) {
    test(`${auditCase.label}: creation intent survives validation, conflict, and retry`, async ({
      page,
    }, testInfo: TestInfo) => {
      test.skip(testInfo.project.name !== auditCase.project);
      test.slow();
      test.setTimeout(180_000);
      await page.setViewportSize(auditCase.viewport);
      const state = await installFixtures(page);
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => {
        // The suite's `serviceWorkers: "block"` browser shim probes every
        // frame, including FormPreview's deliberately originless sandbox.
        // Chromium rejects that shim access; it is not application script.
        if (
          error.message.includes(
            "Service worker is disabled because the context is sandboxed and lacks the 'allow-same-origin' flag.",
          )
        ) {
          return;
        }
        pageErrors.push(error.message);
      });

      await page.goto("/app/forms/new", { waitUntil: "domcontentloaded" });
      await expect(
        page.getByRole("heading", { level: 1, name: "New form" }),
      ).toBeVisible();
      await expect.poll(() => state.listReads).toBe(1);
      await certifySurface(page, auditCase.viewport.width === 320);

      const waitlist = page.getByRole("button", { name: /^Waitlist/u });
      const newsletter = page.getByRole("button", {
        name: /^Newsletter signup/u,
      });
      const doubleOptIn = page.getByRole("radio", {
        name: /Double opt-in/u,
      });
      const singleOptIn = page.getByRole("radio", {
        name: /Single opt-in/u,
      });
      await waitlist.click();
      await expect(waitlist).toHaveAttribute("aria-pressed", "true");
      await expect(singleOptIn).toBeChecked();
      const templateOnlyCancel = page.getByRole("button", {
        name: "Cancel",
        exact: true,
      });
      page.once("dialog", async (dialog) => {
        expect(dialog.type()).toBe("confirm");
        expect(dialog.message()).toContain("unsaved changes");
        await dialog.dismiss();
      });
      await templateOnlyCancel.click();
      await expect(page).toHaveURL(/\/app\/forms\/new$/u);
      await expect(templateOnlyCancel).toBeFocused();
      await newsletter.click();
      await expect(newsletter).toHaveAttribute("aria-pressed", "true");
      await expect(doubleOptIn).toBeChecked();

      const name = page.getByLabel("Name", { exact: true });
      const slug = page.getByLabel("Slug", { exact: true });
      const success = page.getByLabel("Success message");
      const redirect = page.getByLabel("Success redirect URL (optional)");
      const cancel = page.getByRole("button", {
        name: "Cancel",
        exact: true,
      });
      const submit = page.locator('form button[type="submit"]');
      await expect(name).toHaveAttribute("maxlength", "200");

      await name.fill("Launch newsletter");
      await slug.fill("taken-slug");
      await success.fill("Welcome aboard.");
      await redirect.fill("http://unsafe.example.test/thanks");
      await submit.click();
      await expect(page.getByText("That slug is already taken.")).toBeVisible();
      await expect(
        page.getByText(
          "Redirect URL must be HTTPS, localhost HTTP, or root-relative.",
        ),
      ).toBeVisible();
      await expect(slug).toBeFocused();
      expect(state.createAttempts).toBe(0);

      await slug.fill("launch-newsletter");
      await submit.click();
      await expect(redirect).toBeFocused();
      expect(state.createAttempts).toBe(0);
      await redirect.fill("/bad%0d%0aLocation:https://unsafe.example.test");
      await submit.click();
      await expect(redirect).toBeFocused();
      expect(state.createAttempts).toBe(0);
      await redirect.fill("/forms/success?ok=1");

      page.once("dialog", async (dialog) => {
        expect(dialog.type()).toBe("confirm");
        expect(dialog.message()).toContain("unsaved changes");
        await dialog.dismiss();
      });
      await cancel.click();
      await expect(page).toHaveURL(/\/app\/forms\/new$/u);
      await expect(cancel).toBeFocused();

      await submit.evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
      await expect.poll(() => state.createAttempts).toBe(1);
      await expect.poll(() => Boolean(state.releaseFirstCreate)).toBe(true);
      await expect(page.locator("form")).toHaveAttribute("aria-busy", "true");
      await expect(submit).toBeDisabled();
      await expect(cancel).toBeDisabled();
      await expect(name).toBeDisabled();
      await expect(slug).toBeDisabled();
      await expect(success).toBeDisabled();
      await expect(redirect).toBeDisabled();
      await expect(newsletter).toBeDisabled();
      await expect(doubleOptIn).toBeDisabled();
      await cancel.evaluate((button: HTMLButtonElement) => button.click());
      await page.keyboard.press("Escape");
      await expect(page).toHaveURL(/\/app\/forms\/new$/u);
      expect(state.createAttempts).toBe(1);

      state.releaseFirstCreate?.();
      const error = page.locator('form [role="alert"]');
      await expect(error).toContainText("reserved by another editor");
      await expect(error).toBeFocused();
      await expect(page.locator("form")).toHaveAttribute("aria-busy", "false");
      await expect(name).toHaveValue("Launch newsletter");
      await expect(slug).toHaveValue("launch-newsletter");
      await expect(success).toHaveValue("Welcome aboard.");
      await expect(redirect).toHaveValue("/forms/success?ok=1");
      await certifySurface(page, auditCase.viewport.width === 320);

      await submit.click();
      await expect.poll(() => state.createAttempts).toBe(2);
      await expect.poll(() => state.patchAttempts).toBe(1);
      await expect.poll(() => Boolean(state.releaseFirstPatch)).toBe(true);
      expect(state.patchIfMatch).toEqual(['"form-created-closure-v1"']);
      await expect(page.locator("form")).toHaveAttribute("aria-busy", "true");
      await expect(submit).toBeDisabled();
      await expect(cancel).toBeDisabled();
      await expect(name).toBeDisabled();
      await expect(newsletter).toBeDisabled();
      await expect(page).toHaveURL(/\/app\/forms\/new$/u);

      state.releaseFirstPatch?.();
      await expect(error).toContainText(
        "Form “Launch newsletter” was created, but the Newsletter signup starter could not be applied.",
      );
      await expect(error).toContainText("Retry the starter");
      await expect(error).toBeFocused();
      await expect(page.locator("form")).toHaveAttribute("aria-busy", "false");
      await expect(name).toBeDisabled();
      const retryStarter = page.getByRole("button", {
        name: "Retry starter",
        exact: true,
      });
      const openSaved = page.getByRole("button", {
        name: "Open saved form",
        exact: true,
      });
      await expect(retryStarter).toBeEnabled();
      await expect(openSaved).toBeEnabled();
      expect(state.createAttempts).toBe(2);
      await certifySurface(page, auditCase.viewport.width === 320);

      await retryStarter.click();
      await expect.poll(() => state.patchAttempts).toBe(2);
      await expect(page).toHaveURL(
        new RegExp(`/app/forms/${CREATED_FORM_ID}$`, "u"),
      );
      await expect(
        page.getByRole("heading", {
          level: 1,
          name: "Edit form: Launch newsletter",
        }),
      ).toBeVisible();

      const expectedCreate = {
        name: "Launch newsletter",
        optInMode: "double",
        slug: "launch-newsletter",
        successMessage: "Welcome aboard.",
        successRedirectUrl: "/forms/success?ok=1",
      };
      expect(state.createBodies).toEqual([expectedCreate, expectedCreate]);
      expect(state.patchBodies).toHaveLength(2);
      expect(state.patchBodies[1]).toEqual(state.patchBodies[0]);
      expect(state.patchIfMatch).toEqual([
        '"form-created-closure-v1"',
        '"form-created-closure-v1"',
      ]);
      expect(state.patchBodies[0]).toEqual({
        structure: NEWSLETTER_STRUCTURE,
      });
      expect(pageErrors).toEqual([]);
    });
  }
});

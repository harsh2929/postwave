import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type Page,
  type Route,
  type TestInfo,
} from "@playwright/test";

import { loginAsDemo } from "../helpers/auth";

interface FieldFixture {
  config: { pii_flag: boolean };
  created_at: string;
  id: string;
  key: string;
  label: string;
  tenant_id: string;
  type: "string";
  updated_at: string;
}

interface FixtureState {
  createAttempts: number;
  deleteAttempts: number;
  editAttempts: number;
  fields: FieldFixture[];
  mode: "auto" | "strict" | "off";
  modeAttempts: number;
  releaseEdit: (() => void) | null;
}

function originalField(tenantId: string): FieldFixture {
  return {
    id: "field-1",
    tenant_id: tenantId,
    key: "loyalty_tier",
    label: "Loyalty tier",
    type: "string",
    config: { pii_flag: false },
    created_at: "2026-08-20T00:00:00.000Z",
    updated_at: "2026-08-20T00:00:00.000Z",
  };
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installFixtures(page: Page): Promise<FixtureState> {
  // Dashboard auth is rendered on the server, outside browser routing. Reuse
  // that exact principal for client refetches so strict fresh-authority checks
  // exercise the mutation rather than correctly rejecting a fixture mismatch.
  const authResponse = await page.request.get("/api/v1/auth/me");
  expect(authResponse.ok(), "authoritative demo identity lookup").toBe(true);
  const me = (await authResponse.json()) as Record<string, unknown>;
  if (
    typeof me.user_id !== "string" ||
    me.user_id.length === 0 ||
    typeof me.tenant_id !== "string" ||
    me.tenant_id.length === 0
  ) {
    throw new Error("Authoritative demo identity omitted user_id or tenant_id");
  }
  const seededField = originalField(me.tenant_id);
  await page.route("**/api/health", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok" }),
    }),
  );
  const state: FixtureState = {
    createAttempts: 0,
    deleteAttempts: 0,
    editAttempts: 0,
    fields: [seededField],
    mode: "auto",
    modeAttempts: 0,
    releaseEdit: null,
  };
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();

    if (path === "/api/v1/auth/me") {
      await json(route, {
        ...me,
        workspace_name: "Custom field matrix",
        workspace_slug: "demo",
      });
      return;
    }
    if (path === "/api/v1/auth/workspaces" && method === "GET") {
      await json(route, {
        workspaces: [
          {
            id: me.tenant_id,
            name: "Custom field matrix",
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
    if (path === "/api/v1/onboarding-progress" && method === "GET") {
      await json(route, {});
      return;
    }
    if (path === "/api/v1/events" && method === "GET") {
      // A 204 tells EventSource not to reconnect while keeping this focused
      // dialog matrix independent from the live event service.
      await route.fulfill({ status: 204 });
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
    if (path === "/api/v1/custom-fields/mode" && method === "GET") {
      await json(route, { custom_fields_mode: state.mode });
      return;
    }
    if (path === "/api/v1/custom-fields/mode" && method === "PATCH") {
      state.modeAttempts += 1;
      if (state.modeAttempts === 1) {
        await json(
          route,
          {
            error: "Validator mode changed elsewhere.",
            message: "Validator mode changed elsewhere.",
          },
          409,
        );
        return;
      }
      state.mode = "strict";
      await json(route, { custom_fields_mode: state.mode });
      return;
    }
    if (path === "/api/v1/settings/custom-fields/usage") {
      await json(route, {
        total_subscribers: 10,
        fields: state.fields.map((field) => ({
          key: field.key,
          label: field.label,
          filled: field.id === seededField.id ? 4 : 0,
          rate: field.id === seededField.id ? 0.4 : 0,
        })),
      });
      return;
    }
    if (
      path === "/api/v1/custom-fields/field-1/references" &&
      method === "GET"
    ) {
      await json(route, {
        segments: [{ id: "segment-1", name: "VIP segment" }],
        flows: [],
        forms: [],
      });
      return;
    }
    if (path === "/api/v1/custom-fields/field-1" && method === "PATCH") {
      state.editAttempts += 1;
      if (state.editAttempts === 1) {
        await json(
          route,
          {
            error: "Field changed elsewhere.",
            message: "Field changed elsewhere.",
          },
          409,
        );
        return;
      }
      await new Promise<void>((resolve) => {
        state.releaseEdit = resolve;
      });
      const body = request.postDataJSON() as {
        config: { pii_flag: boolean };
        label: string;
      };
      const updated = {
        ...seededField,
        label: body.label,
        config: body.config,
        updated_at: "2026-08-26T00:00:00.000Z",
      };
      state.fields = state.fields.map((field) =>
        field.id === updated.id ? updated : field,
      );
      await json(route, updated);
      return;
    }
    if (path === "/api/v1/custom-fields/field-1" && method === "DELETE") {
      state.deleteAttempts += 1;
      if (state.deleteAttempts === 1) {
        await json(
          route,
          {
            error: "A downstream reference changed.",
            message: "A downstream reference changed.",
          },
          409,
        );
        return;
      }
      state.fields = state.fields.filter((field) => field.id !== "field-1");
      await json(route, { ok: true });
      return;
    }
    if (path === "/api/v1/custom-fields" && method === "GET") {
      await json(route, state.fields);
      return;
    }
    if (path === "/api/v1/custom-fields" && method === "POST") {
      state.createAttempts += 1;
      if (state.createAttempts === 1) {
        await json(
          route,
          {
            error: "A field with this key already exists.",
            message: "A field with this key already exists.",
          },
          409,
        );
        return;
      }
      const body = request.postDataJSON() as {
        key: string;
        label: string;
      };
      const created: FieldFixture = {
        ...seededField,
        id: "field-created",
        key: body.key,
        label: body.label,
      };
      state.fields = [created, ...state.fields];
      await json(route, created, 201);
      return;
    }

    await route.fallback();
  });
  return state;
}

async function prepare(page: Page, testInfo: TestInfo): Promise<boolean> {
  const mobile = testInfo.project.name.includes("mobile");
  await page.setViewportSize(
    mobile ? { width: 320, height: 800 } : { width: 1280, height: 900 },
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await loginAsDemo(page, { navigate: false });
  return mobile;
}

function collectRuntimeErrors(page: Page): () => void {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedResponses: string[] = [];
  const onConsole = (message: { type(): string; text(): string }): void => {
    if (message.type() === "error") consoleErrors.push(message.text());
  };
  const onPageError = (error: Error): void => {
    pageErrors.push(error.message);
  };
  const onResponse = (response: { status(): number; url(): string }): void => {
    if (response.status() >= 400 && response.status() !== 409) {
      failedResponses.push(`${response.status()} ${response.url()}`);
    }
  };
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("response", onResponse);

  return () => {
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
    page.off("response", onResponse);
    expect(pageErrors, "uncaught page errors").toEqual([]);
    expect(failedResponses, "failed HTTP responses").toEqual([]);
    expect(
      consoleErrors.filter(
        (message) =>
          !(
            message.includes("Failed to load resource") &&
            message.includes("409")
          ),
      ),
      "app console errors",
    ).toEqual([]);
  };
}

async function certifySurface(
  page: Page,
  selector: string,
  mobile: boolean,
): Promise<void> {
  const surface = page.locator(selector);
  await expect(surface).toBeVisible();
  await surface.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  const geometry = await surface.evaluate((element, checkTouch) => {
    const visible = (node: HTMLElement): boolean => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden";
    };
    const undersized = checkTouch
      ? Array.from(
          element.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled), select:not(:disabled)",
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
              label: target.getAttribute("aria-label") ?? target.textContent,
              width: rect.width,
              height: rect.height,
            };
          })
          .filter((target) => target.width < 43.5 || target.height < 43.5)
      : [];
    return {
      viewport: innerWidth,
      pageWidth: Math.max(
        document.documentElement.scrollWidth,
        document.body.scrollWidth,
      ),
      undersized,
    };
  }, mobile);
  expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewport + 1);
  expect(geometry.undersized).toEqual([]);
  const axe = await new AxeBuilder({ page })
    .include(selector)
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    axe.violations.filter((violation) =>
      ["critical", "serious"].includes(violation.impact ?? ""),
    ),
  ).toEqual([]);
}

test.describe("custom-field hidden dialog closure", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ serviceWorkers: "block" });

  test("create, edit, validator switch, and referenced delete remain truthful and recoverable", async ({
    page,
  }, testInfo) => {
    test.slow();
    const mobile = await prepare(page, testInfo);
    const state = await installFixtures(page);
    const assertRuntimeClean = collectRuntimeErrors(page);
    await page.goto("/app/settings/custom-fields", {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByRole("heading", { level: 1, name: "Custom Fields" }),
    ).toBeVisible();
    await expect(page.getByText("loyalty_tier", { exact: true })).toBeVisible();

    const addTrigger = page.getByRole("button", { name: "Add field" });
    await addTrigger.click();
    await expect(page.locator("#cf-key")).toBeFocused();
    const createSubmit = page
      .locator("#new-custom-field")
      .getByRole("button", { name: "Create", exact: true });
    await page.locator("#cf-key").fill("Bad key");
    await page.locator("#cf-label").fill("Member level");
    await createSubmit.click();
    await expect(
      page.getByRole("alert").filter({ hasText: "lowercase letters" }),
    ).toBeVisible();
    await certifySurface(page, "#new-custom-field", mobile);
    expect(state.createAttempts).toBe(0);
    await page.locator("#cf-key").fill("member_level");
    await createSubmit.click();
    await expect(
      page.getByRole("alert").filter({ hasText: "already exists" }),
    ).toBeFocused();
    await certifySurface(page, "#new-custom-field", mobile);
    await createSubmit.click();
    await expect(page.locator("#new-custom-field")).toBeHidden();
    await expect(addTrigger).toBeFocused();
    expect(state.createAttempts).toBe(2);

    let originalRow = page.getByRole("row").filter({ hasText: "loyalty_tier" });
    const editTrigger = originalRow.getByRole("button", { name: "Edit" });
    await editTrigger.click();
    await expect(page.locator("#edit-label")).toBeFocused();
    await certifySurface(page, '[role="dialog"]', mobile);
    await expect(
      page.getByRole("button", { name: "Save changes" }),
    ).toBeDisabled();
    await page.locator("#edit-label").fill("Member tier");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "changed elsewhere" }),
    ).toBeFocused();
    await expect(page.getByRole("dialog")).toBeVisible();
    await certifySurface(page, '[role="dialog"]', mobile);

    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("dialog")).toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#edit-label")).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect.poll(() => Boolean(state.releaseEdit)).toBe(true);
    state.releaseEdit?.();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(editTrigger).toBeFocused();
    expect(state.editAttempts).toBe(2);

    // The validator controls are correctly hidden from the accessibility tree
    // while their modal confirmation is open. Keep a DOM-visible role locator
    // so we can still assert that the underlying selection did not commit on
    // the failed request.
    const strict = page.getByRole("radio", {
      name: /Strict/u,
      includeHidden: true,
    });
    await strict.click();
    await expect(
      page.getByRole("heading", { name: "Switch validator mode to strict?" }),
    ).toBeVisible();
    await certifySurface(page, '[role="dialog"]', mobile);
    await page.getByRole("button", { name: "Switch mode" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "changed elsewhere" }),
    ).toBeFocused();
    await expect(strict).toHaveAttribute("aria-checked", "false");
    await certifySurface(page, '[role="dialog"]', mobile);
    await page.getByRole("button", { name: "Switch mode" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(strict).toHaveAttribute("aria-checked", "true");
    await expect(strict).toBeFocused();
    expect(state.modeAttempts).toBe(2);

    const off = page.getByRole("radio", { name: /Off/u });
    await off.click();
    await expect(
      page.getByRole("heading", { name: "Switch validator mode to off?" }),
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toContainText(
      "disables validation entirely",
    );
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(off).toBeFocused();
    expect(state.modeAttempts).toBe(2);

    originalRow = page.getByRole("row").filter({ hasText: "loyalty_tier" });
    await originalRow.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByRole("dialog")).toContainText("VIP segment");
    await expect(page.getByRole("dialog")).toContainText("1 object");
    await certifySurface(page, '[role="dialog"]', mobile);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(
      page.getByRole("alert").filter({ hasText: "reference changed" }),
    ).toBeFocused();
    await expect(page.getByRole("dialog")).toBeVisible();
    await certifySurface(page, '[role="dialog"]', mobile);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(
      page.getByRole("heading", { name: "Declared fields" }),
    ).toBeFocused();
    await expect(page.getByText("loyalty_tier", { exact: true })).toHaveCount(
      0,
    );
    expect(state.deleteAttempts).toBe(2);
    assertRuntimeClean();
  });
});

import { expect, test } from "@playwright/test";
import { loginAsDemo, logout } from "../helpers/auth";

/**
 * Backend-backed auth smoke tests. Deterministic credential, email-link,
 * invitation, TOTP, and CLI state coverage lives in
 * auth-state-closure.spec.ts; keep this file limited to flows whose purpose is
 * proving the docker-compose session itself.
 */
test.describe("auth", () => {
  test("login page renders with email and password fields", async ({
    page,
  }) => {
    await page.goto("/login");

    await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();
    await expect(page.getByLabel(/email/i)).toBeVisible();
    // `/password/i` also matches the field's own "Show password" reveal toggle
    // (aria-label="Show password"), which is a deliberate part of
    // components/ui/password-input.tsx — so the loose pattern is ambiguous,
    // not the markup. Name the field's label exactly.
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
    // /login deliberately offers three sign-in affordances — the credentials
    // submit, "Sign in with a passkey", and "Sign in with another device" —
    // so the loose pattern matches all three. This assertion is about the
    // credentials form's own submit button; name it exactly.
    await expect(
      page.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeVisible();
  });

  test("logout clears the session", async ({ page, context }) => {
    await loginAsDemo(page);
    await expect(page).toHaveURL(/\/app(\/|$)/);

    // Open user menu and trigger logout.
    //
    // The header menu is deliberately a `<nav aria-label="Account actions">`
    // holding real links and buttons rather than an ARIA `menu`/`menuitem`
    // tree (components/ui/header-menu.tsx), so "Sign out" carries the button
    // role. Scoping to that nav keeps the locator unambiguous against the
    // other "Sign out" buttons the app has on /app/settings/security.
    // The nav rail also has an "Account" section disclosure, so match the
    // header trigger by its exact accessible-name prefix.
    await page.getByRole("button", { name: /^Account menu for / }).click();
    // Sign-out first races the web-push revoke against its deadline and then
    // dynamically imports the auth mutation chunk, which the dev server used
    // by this suite compiles on demand; allow for that before the request.
    const logoutResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/v1/auth/logout") &&
        response.request().method() === "POST",
      { timeout: 60_000 },
    );
    await page
      .getByRole("navigation", { name: "Account actions" })
      .getByRole("button", { name: "Sign out" })
      .click();
    expect((await logoutResponse).status()).toBeLessThan(400);

    // The shell pushes /login after the session is revoked. Under the dev
    // auth bypass (the CI browser job runs with POSTWAVE_LOCAL_AUTH_BYPASS=1)
    // the middleware treats every request as signed in and bounces /login
    // straight back to /app, so the redirect is only observable without it.
    if (!process.env.POSTWAVE_LOCAL_AUTH_BYPASS) {
      await expect(page).toHaveURL(/\/login|\/$/);
    }

    // Confirm a fresh navigation does not silently re-auth via stale cookies.
    // Also unobservable under the bypass, which re-authenticates every request.
    await logout(context);
    await page.goto("/app");
    if (!process.env.POSTWAVE_LOCAL_AUTH_BYPASS) {
      await expect(page).toHaveURL(/\/login/);
    }
  });

  test("dev bypass mode lands directly on the dashboard", async ({ page }) => {
    await loginAsDemo(page);
    await expect(page).toHaveURL(/\/app(\/|$)/);
    await expect(page.getByRole("navigation")).toBeVisible();
  });
});

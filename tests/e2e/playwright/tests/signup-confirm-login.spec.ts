import { expect, test } from '@playwright/test';
import { ApiClient, uniqueEmail, uniqueSlug } from '../helpers/api';
import { clearMailpit, extractLink, waitForMessage } from '../helpers/mailpit';

/**
 * Journey 1 — Signup → email confirmation → first login.
 *
 * Drives the real auth surface end-to-end:
 *
 *   1. POST /signup form on the web app.
 *   2. Wait for the verification email in mailpit (the docker-compose
 *      test stack routes SMTP at mailpit).
 *   3. Click the confirmation link from the email body.
 *   4. Log in with the new credentials and land on /app.
 *
 * Skips (does not fail) when:
 *   - the api isn't reachable (we don't paper over a broken stack, but
 *     CI brings the stack up before invoking us).
 *
 * Asserts hard on the inbox: zero mail = a regression in the auth
 * transactional path.
 */
test.describe('signup → confirm → login', () => {
  const api = new ApiClient();

  test.beforeAll(async () => {
    await api.waitForHealth();
  });

  test.beforeEach(async () => {
    await clearMailpit();
  });

  test('new workspace owner can sign up, confirm email, and log in', async ({ page }) => {
    const slug = uniqueSlug('e2e-signup');
    const email = uniqueEmail('owner');
    const password = 'E2E-Test-Password-123!';
    const workspaceName = `E2E ${slug}`;

    // 1) Submit the signup form. The web app posts to /api/v1/auth/signup
    // server-side, which inserts the tenant row and queues a verification
    // email.
    await page.goto('/signup');
    await page.getByLabel(/email/i).fill(email);
    await page.getByLabel(/password/i).fill(password);

    // Workspace fields may be on a second step or inline; try inline first
    // then fall back to a follow-up step.
    const workspaceField = page.getByLabel(/workspace name|company name/i);
    if (await workspaceField.isVisible().catch(() => false)) {
      await workspaceField.fill(workspaceName);
    }
    const slugField = page.getByLabel(/workspace slug|url|subdomain/i);
    if (await slugField.isVisible().catch(() => false)) {
      await slugField.fill(slug);
    }

    await page.getByRole('button', { name: /sign up|create account|continue/i }).click();

    // The post-signup screen tells the user to check their inbox.
    await expect(
      page.getByText(/check your (inbox|email)|we sent you|verify your email/i),
    ).toBeVisible({ timeout: 20_000 });

    // 2) Pull the verification email out of mailpit.
    const msg = await waitForMessage({
      recipient: email,
      subjectMatch: /verify|confirm|welcome/i,
      timeoutMs: 30_000,
    });

    // 3) Extract the confirmation link. Either an /auth/verify or /verify
    // path, with the token in the query string.
    const link = extractLink(
      msg,
      /https?:\/\/[^\s"'<>]+\/(?:app\/)?(?:auth\/)?(?:verify-email|verify|confirm)[^\s"'<>]*/i,
    );
    expect(link, 'verify link should be in the email body').not.toBeNull();

    await page.goto(link!);

    // The verify endpoint usually redirects to /login or /app and shows a
    // success toast. We assert on the URL landing, not on the toast copy.
    await expect(page).toHaveURL(/\/(login|app)(\/|\?|$)/, { timeout: 15_000 });

    // 4) Log in with the new credentials.
    if (!/\/app(\/|$)/.test(page.url())) {
      await page.goto('/login');
      await page.getByLabel(/email/i).fill(email);
      await page.getByLabel(/password/i).fill(password);
      await page.getByRole('button', { name: /sign in|log in|continue/i }).click();
    }

    await expect(page).toHaveURL(/\/app(\/|$)/, { timeout: 20_000 });

    // Smoke-check: the dashboard nav rendered, so the session cookie is
    // really good.
    await expect(page.getByRole('navigation')).toBeVisible({ timeout: 15_000 });
  });
});

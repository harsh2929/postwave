import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type Page,
  type Request,
  type Route,
} from "@playwright/test";

const BLOCKING_IMPACTS = new Set(["critical", "serious"]);
const SIGNATURE = "A".repeat(43);
const VALID_PASSWORD = "correct-horse-battery-staple";

type PendingGate = {
  promise: Promise<void>;
  resolve: () => void;
};

function pendingGate(): PendingGate {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function json(
  route: Route,
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers,
    body: JSON.stringify(body),
  });
}

function apiError(code: string, message: string) {
  return { error: { code, message } };
}

function bodyOf(request: Request): Record<string, unknown> {
  return request.postDataJSON() as Record<string, unknown>;
}

function authLiveRegion(
  page: Page,
  role: "alert" | "status",
  text: string | RegExp,
) {
  return page
    .locator("main#auth-main .pw-auth-content")
    .getByRole(role)
    .filter({ hasText: text });
}

function authAlert(page: Page, text: string | RegExp) {
  return authLiveRegion(page, "alert", text);
}

function authStatus(page: Page, text: string | RegExp) {
  return authLiveRegion(page, "status", text);
}

function proofQuery(flow: "magic" | "reset") {
  return new URLSearchParams({
    token: `${flow}-proof-token`,
    v: "1",
    flow,
    aud: "web",
    sig: SIGNATURE,
  }).toString();
}

async function expectScrubbed(page: Page, pathname: string) {
  await expect
    .poll(() => {
      const url = new URL(page.url());
      return `${url.pathname}${url.search}${url.hash}`;
    })
    .toBe(pathname);
}

async function settleFiniteAnimations(page: Page) {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .filter((animation) => {
        const iterations = animation.effect?.getTiming().iterations;
        return typeof iterations === "number" && Number.isFinite(iterations);
      })
      .every((animation) => animation.playState === "finished"),
  );
}

async function expectNoOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    viewport: window.innerWidth,
    html: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    authClient:
      document.querySelector<HTMLElement>(".pw-auth-content")?.clientWidth ?? 0,
    authScroll:
      document.querySelector<HTMLElement>(".pw-auth-content")?.scrollWidth ?? 0,
  }));
  expect(
    Math.max(widths.html, widths.body),
    `auth state overflows ${widths.viewport}px viewport`,
  ).toBeLessThanOrEqual(widths.viewport + 1);
  expect(
    widths.authScroll,
    "auth content must not hide intrinsic-width overflow",
  ).toBeLessThanOrEqual(widths.authClient + 1);
}

async function expectPrimaryTouchTargets(page: Page) {
  if ((page.viewportSize()?.width ?? 1024) > 412) return;
  const undersized = await page
    .locator(
      [
        ".pw-auth-content [data-slot='button']",
        ".pw-auth-content [data-slot='input']",
        ".pw-auth-content button[aria-label='Show password']",
        ".pw-auth-content button[aria-label='Hide password']",
        ".pw-auth-content #device-user-code",
      ].join(", "),
    )
    .evaluateAll((nodes) =>
      nodes.flatMap((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none";
        return visible && rect.height < 43.5
          ? [
              {
                tag: node.tagName,
                name:
                  node.getAttribute("aria-label") ??
                  node.textContent?.trim() ??
                  "",
                height: rect.height,
              },
            ]
          : [];
      }),
    );
  expect(undersized, "primary auth controls keep a 44px target").toEqual([]);
}

async function expectA11y(page: Page) {
  await settleFiniteAnimations(page);
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = result.violations.filter(
    (violation) => violation.impact && BLOCKING_IMPACTS.has(violation.impact),
  );
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}

async function expectStateQuality(page: Page) {
  await expect(page.locator("main#auth-main")).toHaveCount(1);
  await expect(page.locator("h1")).toHaveCount(1);
  await expectNoOverflow(page);
  await expectPrimaryTouchTargets(page);
  await expectA11y(page);
}

async function observeAppNavigation(page: Page) {
  let requests = 0;
  // Match the top-level application destination, not Next's client chunks
  // (for example `/_next/static/chunks/app/login/page.js`). Aborting those
  // chunks leaves the server-rendered form visible but permanently disables
  // hydration, which can make auth controls look broken for the wrong reason.
  await page.route(/^https?:\/\/[^/]+\/app(?:[/?].*)?$/u, async (route) => {
    requests += 1;
    await route.abort("aborted");
  });
  return {
    count: () => requests,
    wait: async () => {
      await expect.poll(() => requests).toBeGreaterThan(0);
    },
  };
}

const WHOAMI_SIGNED_OUT = apiError("no_session", "Not signed in");

test.describe("deterministic auth state closure", () => {
  test("login closes pending, error, remember, reveal, OAuth, and safe-next states", async ({
    page,
  }) => {
    test.slow();
    const gate = pendingGate();
    const bodies: Record<string, unknown>[] = [];
    let attempts = 0;

    await page.route("**/api/v1/auth/login", async (route) => {
      attempts += 1;
      bodies.push(bodyOf(route.request()));
      if (attempts === 1) {
        await gate.promise;
        await json(
          route,
          apiError("invalid_credentials", "invalid credentials"),
          401,
        );
        return;
      }
      await json(route, {
        needs_workspace: false,
        user_id: "user-1",
        tenant_id: "tenant-1",
      });
    });
    await page.route("**/api/v1/auth/me", (route) =>
      json(route, WHOAMI_SIGNED_OUT, 401),
    );

    await page.goto("/login?next=%2Fverify-email&reason=session_expired", {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator("[data-login-hydrated='true']")).toBeVisible();
    await expect(page.getByText("Your session expired")).toBeVisible();

    const email = page.getByLabel("Email", { exact: true });
    const password = page.getByLabel("Password", { exact: true });
    await expect(email).toBeFocused();
    await email.fill("reader@example.com");
    await password.fill(VALID_PASSWORD);

    const reveal = page.getByRole("button", {
      name: /^(?:Show|Hide) password$/u,
    });
    await reveal.click();
    await expect(password).toHaveAttribute("type", "text");
    await expect(reveal).toBeFocused();
    const remember = page.getByLabel("Keep me signed in");
    await remember.check();
    expect(
      await remember.evaluate(
        (node) => node.closest("label")?.getBoundingClientRect().height ?? 0,
      ),
    ).toBeGreaterThanOrEqual(43.5);

    await expect(
      page.getByRole("link", { name: "Sign in with Google" }),
    ).toHaveAttribute(
      "href",
      "/api/v1/auth/oauth/google/start?redirect_to=%2Fverify-email",
    );

    const submit = page.getByRole("button", {
      name: /^(?:Sign in|Signing in…)$/u,
    });
    await submit.click();
    await expect.poll(() => attempts).toBe(1);
    await expect(page.locator("form[aria-busy='true']")).toBeVisible();
    await expect(submit).toBeDisabled();
    await expect(submit).toHaveText("Signing in…");
    await expect(email).toBeDisabled();
    gate.resolve();

    await expect(authAlert(page, "Invalid email or password.")).toHaveText(
      "Invalid email or password.",
    );
    await expect(submit).toBeEnabled();
    expect(bodies[0]).toEqual({
      email: "reader@example.com",
      password: VALID_PASSWORD,
      remember: true,
    });
    await expectStateQuality(page);

    await Promise.all([
      page.waitForURL(/\/verify-email$/u),
      submit.click({ noWaitAfter: true }),
    ]);
    expect(bodies[1]).toEqual(bodies[0]);
    await expect(
      page.getByRole("heading", { name: "Verification failed" }),
    ).toBeVisible();
  });

  test("login rejects a cross-origin next target for credentials and OAuth", async ({
    page,
  }) => {
    const appNavigation = await observeAppNavigation(page);
    await page.route("**/api/v1/auth/login", (route) =>
      json(route, {
        needs_workspace: false,
        user_id: "user-1",
        tenant_id: "tenant-1",
      }),
    );

    await page.goto(
      "/login?next=https%3A%2F%2Fevil.example%2Fsteal&reason=continue",
    );
    await expect(page.locator("[data-login-hydrated='true']")).toBeVisible();
    await expect(page.getByText("Sign in to continue to /app.")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Sign in with Google" }),
    ).toHaveAttribute(
      "href",
      "/api/v1/auth/oauth/google/start?redirect_to=%2Fapp",
    );

    await page.getByLabel("Email", { exact: true }).fill("safe@example.com");
    await page.getByLabel("Password", { exact: true }).fill(VALID_PASSWORD);
    await page
      .getByRole("button", { name: "Sign in", exact: true })
      .click({ noWaitAfter: true });
    await appNavigation.wait();
    expect(page.url()).not.toContain("evil.example");
  });

  test("signup closes slug probes, password guards, pending, errors, success, and OAuth", async ({
    page,
  }) => {
    test.slow();
    const appNavigation = await observeAppNavigation(page);
    const firstGate = pendingGate();
    const signupBodies: Record<string, unknown>[] = [];
    let signupAttempts = 0;
    let signupMode: "slug" | "rate" | "success" = "slug";

    await page.route(/\/api\/v1\/auth\/slug-available\?/u, async (route) => {
      const slug = new URL(route.request().url()).searchParams.get("slug");
      await json(route, { available: slug !== "taken-team" });
    });
    await page.route("**/api/v1/auth/signup", async (route) => {
      signupAttempts += 1;
      signupBodies.push(bodyOf(route.request()));
      if (signupMode === "slug") {
        await firstGate.promise;
        await json(route, apiError("slug_taken", "slug taken"), 409);
      } else if (signupMode === "rate") {
        await json(route, apiError("rate_limited", "slow down"), 429);
      } else {
        await json(route, { user_id: "user-2", tenant_id: "tenant-2" }, 201);
      }
    });

    await page.goto("/signup");
    const email = page.getByLabel("Email", { exact: true });
    const password = page.getByLabel("Password", { exact: true });
    const name = page.getByLabel("Workspace name");
    const slug = page.getByLabel("Workspace slug");
    await expect(email).toBeFocused();
    await email.fill("creator@example.com");
    await password.fill("too-short");
    await name.fill("Taken Team");
    await expect(slug).toHaveValue("taken-team");
    await expect(page.getByTestId("slug-availability")).toHaveText(
      "That workspace slug is taken.",
    );

    await page.getByRole("button", { name: "Create workspace" }).click();
    expect(signupAttempts).toBe(0);
    expect(
      await password.evaluate((node) =>
        (node as HTMLInputElement).checkValidity(),
      ),
    ).toBe(false);

    await page.getByRole("button", { name: "Show password" }).click();
    await expect(password).toHaveAttribute("type", "text");
    await password.fill(VALID_PASSWORD);
    await slug.fill("open-team");
    await expect(page.getByTestId("slug-availability")).toHaveText(
      "✓ Available",
    );
    await expect(
      page.getByRole("link", { name: "Continue with Google" }),
    ).toHaveAttribute(
      "href",
      "/api/v1/auth/oauth/google/start?redirect_to=%2Fapp",
    );

    const create = page.getByRole("button", {
      name: /^(?:Create workspace|Creating workspace…)$/u,
    });
    await create.click();
    await expect.poll(() => signupAttempts).toBe(1);
    await expect(page.locator("form[aria-busy='true']")).toBeVisible();
    await expect(create).toHaveText("Creating workspace…");
    await expect(create).toBeDisabled();
    firstGate.resolve();
    await expect(
      authAlert(page, "That workspace slug is taken. Try a different one."),
    ).toHaveText("That workspace slug is taken. Try a different one.");

    signupMode = "rate";
    await create.click();
    await expect(
      authAlert(page, "Too many attempts; try again in a few minutes."),
    ).toHaveText("Too many attempts; try again in a few minutes.");
    await expectStateQuality(page);
    signupMode = "success";
    await create.click({ noWaitAfter: true });
    await appNavigation.wait();

    // 429 is replay-safe because the shared client gives POSTs an idempotency
    // key. All transport attempts must remain byte-for-byte identical.
    expect(signupBodies).toHaveLength(5);
    for (const body of signupBodies) {
      expect(body).toEqual({
        email: "creator@example.com",
        password: VALID_PASSWORD,
        workspace_name: "Taken Team",
        workspace_slug: "open-team",
      });
    }
  });

  test("forgot-password success and failure have identical privacy-safe confirmation and focus", async ({
    page,
  }) => {
    const gate = pendingGate();
    let attempts = 0;
    const bodies: Record<string, unknown>[] = [];
    await page.route("**/api/v1/auth/password-reset/start", async (route) => {
      attempts += 1;
      bodies.push(bodyOf(route.request()));
      if (attempts === 1) {
        await gate.promise;
        await json(route, { ok: true }, 202);
      } else {
        await json(route, apiError("internal", "mail unavailable"), 503);
      }
    });

    const submitOnce = async (deferred: boolean) => {
      await page.goto("/forgot-password");
      await page.getByLabel("Email", { exact: true }).fill("same@example.com");
      const submit = page.getByRole("button", {
        name: /^(?:Send reset link|Sending…)$/u,
      });
      await submit.click();
      if (deferred) {
        await expect.poll(() => attempts).toBe(1);
        await expect(page.locator("form[aria-busy='true']")).toBeVisible();
        await expect(submit).toHaveText("Sending…");
        gate.resolve();
      }
      const status = authStatus(
        page,
        "If an account exists for same@example.com",
      );
      await expect(status).toBeVisible();
      await expect(status).toBeFocused();
      return status.innerText();
    };

    const successCopy = await submitOnce(true);
    const failureCopy = await submitOnce(false);
    expect(failureCopy).toBe(successCopy);
    expect(successCopy).toContain("If an account exists for same@example.com");
    expect(bodies).toHaveLength(4);
    for (const body of bodies) {
      expect(body).toEqual({
        email: "same@example.com",
        link_version: 1,
        link_audience: "web",
      });
    }
    await expectStateQuality(page);
  });

  test("magic-link entry is privacy-safe and publishes a deterministic pending/focus contract", async ({
    page,
  }) => {
    const gate = pendingGate();
    let requestBody: Record<string, unknown> | undefined;
    await page.route("**/api/v1/auth/magic-link/start", async (route) => {
      requestBody = bodyOf(route.request());
      await gate.promise;
      await json(route, apiError("internal", "mail unavailable"), 503);
    });

    await page.goto("/magic-link");
    await page.getByLabel("Email", { exact: true }).fill("magic@example.com");
    const submit = page.getByRole("button", {
      name: /^(?:Send magic link|Sending…)$/u,
    });
    await submit.click();
    await expect.poll(() => requestBody).toBeTruthy();
    await expect(page.locator("form[aria-busy='true']")).toBeVisible();
    await expect(submit).toHaveText("Sending…");
    gate.resolve();

    const status = authStatus(
      page,
      "If an account exists for magic@example.com",
    );
    await expect(status).toContainText(
      "If an account exists for magic@example.com",
    );
    await expect(status).toBeFocused();
    expect(requestBody).toEqual({
      email: "magic@example.com",
      link_version: 1,
      link_audience: "web",
    });
    await expectStateQuality(page);
  });

  test("magic-link consume closes alias success, invalid, 429, and URL-scrubbing states", async ({
    page,
  }) => {
    test.slow();
    const appNavigation = await observeAppNavigation(page);
    const successGate = pendingGate();
    let mode: "success" | "invalid" | "rate" = "success";
    const bodies: Record<string, unknown>[] = [];
    await page.route("**/api/v1/auth/magic-link/consume", async (route) => {
      bodies.push(bodyOf(route.request()));
      if (mode === "success") {
        await successGate.promise;
        await json(route, { ok: true });
      } else if (mode === "invalid") {
        await json(route, apiError("invalid_token", "invalid"), 400);
      } else {
        await json(route, apiError("rate_limited", "slow down"), 429, {
          "Retry-After": "45",
        });
      }
    });

    await page.goto(`/browser-auth/magic?${proofQuery("magic")}`);
    await expectScrubbed(page, "/browser-auth/magic");
    await expect(
      authStatus(page, "One moment, redirecting you to your workspace…"),
    ).toHaveAttribute("aria-busy", "true");
    successGate.resolve();
    await appNavigation.wait();
    expect(bodies[0]).toEqual({
      token: "magic-proof-token",
      link_version: 1,
      link_flow: "magic",
      link_audience: "web",
      link_signature: SIGNATURE,
    });

    mode = "rate";
    await page.goto(`/magic-link?${proofQuery("magic")}`);
    await expectScrubbed(page, "/magic-link");
    await expect(
      authAlert(page, "Too many attempts; try again in a few minutes."),
    ).toHaveText("Too many attempts; try again in a few minutes.");

    mode = "invalid";
    await page.goto(`/magic-link?${proofQuery("magic")}`);
    await expectScrubbed(page, "/magic-link");
    await expect(
      authAlert(page, "This sign-in link is invalid or has expired."),
    ).toHaveText("This sign-in link is invalid or has expired.");

    const consumedBeforeMalformed = bodies.length;
    expect(consumedBeforeMalformed).toBe(3);
    await page.goto(
      `/magic-link?token=altered&v=1&flow=magic&aud=web&sig=short`,
    );
    await expectScrubbed(page, "/magic-link");
    await expect(
      page.getByRole("heading", { name: "Sign-in link didn’t work" }),
    ).toBeVisible();
    expect(bodies).toHaveLength(consumedBeforeMalformed);
    await expectStateQuality(page);
  });

  test("reset-password closes canonical errors and browser-alias success without retaining its proof", async ({
    page,
  }) => {
    test.slow();
    let mode: "rate" | "invalid" | "success" = "rate";
    const bodies: Record<string, unknown>[] = [];
    const gate = pendingGate();
    let first = true;
    await page.route("**/api/v1/auth/password-reset/confirm", async (route) => {
      bodies.push(bodyOf(route.request()));
      if (first) {
        first = false;
        await gate.promise;
      }
      if (mode === "rate") {
        await json(route, apiError("rate_limited", "slow down"), 429);
      } else if (mode === "invalid") {
        await json(route, apiError("expired_token", "expired"), 410);
      } else {
        await json(route, { ok: true });
      }
    });

    await page.goto(`/reset-password?${proofQuery("reset")}`);
    await expectScrubbed(page, "/reset-password");
    const password = page.getByLabel("New password");
    const confirm = page.getByLabel("Confirm password");
    const submit = page.getByRole("button", {
      name: /^(?:Update password|Updating…)$/u,
    });
    await password.fill(VALID_PASSWORD);
    await confirm.fill(`${VALID_PASSWORD}!`);
    await expect(page.getByText("Passwords do not match.")).toBeVisible();
    await expect(confirm).toHaveAttribute("aria-invalid", "true");
    await confirm.fill(VALID_PASSWORD);

    await submit.click();
    await expect.poll(() => bodies).toHaveLength(1);
    await expect(page.locator("form[aria-busy='true']")).toBeVisible();
    await expect(submit).toHaveText("Updating…");
    gate.resolve();
    await expect(
      authAlert(page, "Too many attempts; try again in a few minutes."),
    ).toHaveText("Too many attempts; try again in a few minutes.");

    mode = "invalid";
    await submit.click();
    await expect(
      authAlert(page, "This reset link is invalid or has expired."),
    ).toHaveText("This reset link is invalid or has expired.");
    await expectStateQuality(page);

    mode = "success";
    await page.goto(`/browser-auth/reset?${proofQuery("reset")}`);
    await expectScrubbed(page, "/browser-auth/reset");
    await page.getByLabel("New password").fill(VALID_PASSWORD);
    await page.getByLabel("Confirm password").fill(VALID_PASSWORD);
    await Promise.all([
      page.waitForURL(/\/login$/u),
      page.getByRole("button", { name: "Update password" }).click(),
    ]);

    expect(bodies).toHaveLength(5);
    for (const body of bodies) {
      expect(body).toEqual({
        token: "reset-proof-token",
        link_version: 1,
        link_flow: "reset",
        link_audience: "web",
        link_signature: SIGNATURE,
        new_password: VALID_PASSWORD,
      });
    }
  });

  test("verify-email consumes valid tokens, distinguishes invalid and 429, and scrubs every token value", async ({
    page,
  }) => {
    test.slow();
    let mode: "success" | "invalid" | "rate" = "success";
    const tokens: string[] = [];
    await page.route("**/api/v1/auth/me", (route) =>
      json(route, WHOAMI_SIGNED_OUT, 401),
    );
    await page.route("**/api/v1/auth/verify-email", async (route) => {
      tokens.push(String(bodyOf(route.request()).token));
      if (mode === "success") {
        await json(route, { ok: true });
      } else if (mode === "invalid") {
        await json(route, apiError("invalid_token", "invalid"), 400);
      } else {
        await json(route, apiError("rate_limited", "slow down"), 429);
      }
    });

    await page.goto("/verify-email?token=verified-token");
    await expectScrubbed(page, "/verify-email");
    await expect(
      page.getByRole("heading", { name: "Email verified" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Continue to Moosewave" }),
    ).toHaveAttribute("href", "/app");

    mode = "invalid";
    await page.goto("/verify-email?token=invalid-token");
    await expectScrubbed(page, "/verify-email");
    await expect(authAlert(page, "Link expired or invalid.")).toHaveText(
      "Link expired or invalid.",
    );

    mode = "rate";
    await page.goto("/verify-email?token=rate-token");
    await expectScrubbed(page, "/verify-email");
    await expect(
      authAlert(page, "Too many attempts; try again in a few minutes."),
    ).toHaveText("Too many attempts; try again in a few minutes.");

    const consumedBeforeOverLimit = tokens.length;
    await page.goto(`/verify-email?token=${"x".repeat(2049)}`);
    await expectScrubbed(page, "/verify-email");
    await expect(authAlert(page, "Missing token.")).toHaveText(
      "Missing token.",
    );
    expect(tokens).toHaveLength(consumedBeforeOverLimit);
    expect(tokens).toEqual([
      "verified-token",
      "invalid-token",
      "rate-token",
      "rate-token",
      "rate-token",
    ]);
    await expectStateQuality(page);
  });

  test("TOTP challenge closes authenticator failure, recovery focus, pending, and success", async ({
    page,
  }) => {
    test.slow();
    const recoveryGate = pendingGate();
    const challengeBodies: Record<string, unknown>[] = [];
    await page.route("**/api/v1/auth/me", (route) =>
      json(route, {
        user_id: "user-1",
        tenant_id: "tenant-1",
        email: "owner@example.com",
        role: "owner",
        auth_provider: "password",
        email_verified: true,
        workspace_name: "Proof Studio",
        workspace_slug: "proof-studio",
        totp_enabled: true,
        mfa_required: true,
        mfa_satisfied: false,
      }),
    );
    await page.route("**/api/v1/auth/totp/challenge", async (route) => {
      const body = bodyOf(route.request());
      challengeBodies.push(body);
      if ("code" in body) {
        await json(route, apiError("invalid_code", "wrong code"), 401);
      } else {
        await recoveryGate.promise;
        await json(route, { mfa_satisfied: true });
      }
    });

    await page.goto("/totp-challenge?next=%2Fcli%2Fauth");
    const code = page.getByLabel("Authentication code");
    await expect(code).toBeFocused();
    await code.fill("123456");
    await expect(
      authAlert(page, "That code didn't work. Try again."),
    ).toHaveText("That code didn't work. Try again.");
    expect(challengeBodies[0]).toEqual({ code: "123456" });
    await expectStateQuality(page);

    await page
      .getByRole("button", { name: "Use a recovery code instead" })
      .click();
    const recovery = page.getByLabel("Recovery code");
    await expect(recovery).toBeFocused();
    await recovery.fill("abcd-efgh-ijkl");
    const verify = page.getByRole("button", {
      name: /^(?:Verify|Verifying…)$/u,
    });
    await verify.click();
    await expect.poll(() => challengeBodies).toHaveLength(2);
    await expect(page.locator("form[aria-busy='true']")).toBeVisible();
    await expect(verify).toHaveText("Verifying…");
    await expect(verify).toBeDisabled();
    recoveryGate.resolve();

    await page.waitForURL(/\/cli\/auth$/u);
    expect(challengeBodies[1]).toEqual({
      recovery_code: "abcd-efgh-ijkl",
    });
    await expect(
      page.getByRole("heading", { name: "Review a device request" }),
    ).toBeVisible();
  });

  test("TOTP enrollment is complete, gated, touch-safe, and intrinsically contained at 320px", async ({
    page,
  }) => {
    test.slow();
    await page.setViewportSize({ width: 320, height: 800 });
    const enrollGate = pendingGate();
    let enrollCalls = 0;
    let verifyBody: Record<string, unknown> | undefined;
    await page.route("**/api/v1/auth/me", (route) =>
      json(route, {
        user_id: "user-1",
        tenant_id: "tenant-1",
        email: "owner@example.com",
        role: "owner",
        auth_provider: "password",
        email_verified: true,
        workspace_name: "Proof Studio",
        workspace_slug: "proof-studio",
        totp_enabled: false,
        mfa_required: true,
        mfa_satisfied: false,
      }),
    );
    await page.route("**/api/v1/auth/totp/enroll", async (route) => {
      enrollCalls += 1;
      await enrollGate.promise;
      await json(route, {
        otpauth_uri:
          "otpauth://totp/Moosewave:owner@example.com?secret=ABCDEFGHIJKLMNOP&issuer=Moosewave",
        recovery_codes: [
          "abcd-1234-ef56",
          "bcde-2345-fa67",
          "cdef-3456-ab78",
          "defa-4567-bc89",
          "efab-5678-cd90",
          "fabc-6789-de01",
          "abcd-7890-ef12",
          "bcde-8901-fa23",
        ],
      });
    });
    await page.route("**/api/v1/auth/totp/verify", async (route) => {
      verifyBody = bodyOf(route.request());
      await json(route, { verified: true, mfa_satisfied: true });
    });

    await page.goto("/totp-challenge?next=%2Fcli%2Fauth");
    const setup = page.getByRole("button", {
      name: /^(?:Set up two-factor authentication|Starting…)$/u,
    });
    await setup.click();
    await expect.poll(() => enrollCalls).toBe(1);
    await expect(page.locator("[aria-busy='true']")).toBeVisible();
    await expect(setup).toHaveText("Starting…");
    enrollGate.resolve();

    await expect(page.getByText("abcd-1234-ef56")).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy all" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Download" })).toBeVisible();
    const acknowledge = page.getByLabel("I have saved my recovery codes.");
    const verify = page.getByRole("button", {
      name: /^(?:Verify|Verifying…)$/u,
    });
    await page.getByLabel("Authentication code").fill("654321");
    await expect(verify).toBeDisabled();
    await acknowledge.check();
    await expect(verify).toBeEnabled();
    expect(
      await acknowledge.evaluate(
        (node) => node.closest("label")?.getBoundingClientRect().height ?? 0,
      ),
    ).toBeGreaterThanOrEqual(43.5);
    await expectStateQuality(page);

    await Promise.all([
      page.waitForURL(/\/cli\/auth$/u),
      verify.click({ noWaitAfter: true }),
    ]);
    expect(verifyBody).toEqual({ code: "654321" });
  });

  test("accept-invite closes missing, invalid, conflict, rate-limit, pending, success, and scrub states", async ({
    page,
  }) => {
    test.slow();
    const appNavigation = await observeAppNavigation(page);
    const firstGate = pendingGate();
    let mode: "missing" | "conflict" | "rate" | "success" = "missing";
    let first = true;
    const bodies: Record<string, unknown>[] = [];
    await page.route("**/api/v1/auth/accept-invite", async (route) => {
      bodies.push(bodyOf(route.request()));
      if (first) {
        first = false;
        await firstGate.promise;
      }
      if (mode === "missing") {
        await json(route, apiError("invite_not_found", "not found"), 404);
      } else if (mode === "conflict") {
        await json(route, apiError("already_member", "already member"), 409);
      } else if (mode === "rate") {
        await json(route, apiError("rate_limited", "slow down"), 429);
      } else {
        await json(
          route,
          {
            user_id: "user-invited",
            tenant_id: "tenant-invited",
            email: "invitee@example.com",
            email_verified: true,
          },
          201,
        );
      }
    });

    await page.goto("/accept-invite");
    await expect(
      page.getByRole("heading", { name: "Invitation link required" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Go to sign in" }),
    ).toBeVisible();
    await expectStateQuality(page);

    await page.goto("/accept-invite?token=invite-secret-token");
    await expectScrubbed(page, "/accept-invite");
    const password = page.getByLabel("Password", { exact: true });
    const confirm = page.getByLabel("Confirm password");
    const submit = page.getByRole("button", {
      name: /^(?:Join workspace|Joining…)$/u,
    });
    await password.fill("too-short");
    await confirm.fill("different");
    await expect(confirm).toHaveAttribute("aria-invalid", "true");
    await expect(submit).toBeDisabled();
    await password.fill(VALID_PASSWORD);
    await confirm.fill(VALID_PASSWORD);

    await submit.click();
    await expect.poll(() => bodies).toHaveLength(1);
    await expect(page.locator("form[aria-busy='true']")).toBeVisible();
    await expect(submit).toHaveText("Joining…");
    firstGate.resolve();
    await expect(
      authAlert(page, "invalid, has already been used, or has expired"),
    ).toContainText("invalid, has already been used, or has expired");

    mode = "conflict";
    await submit.click();
    await expect(
      authAlert(page, "already a member of the workspace"),
    ).toContainText("already a member of the workspace");
    mode = "rate";
    await submit.click();
    await expect(
      authAlert(page, "Too many attempts; try again in a few minutes."),
    ).toHaveText("Too many attempts; try again in a few minutes.");
    await expectStateQuality(page);

    mode = "success";
    await submit.click({ noWaitAfter: true });
    await appNavigation.wait();
    expect(bodies).toHaveLength(6);
    for (const body of bodies) {
      expect(body).toEqual({
        token: "invite-secret-token",
        password: VALID_PASSWORD,
      });
    }
  });

  test("CLI device approval closes entry, inspect, approve, deny, login, and MFA outcomes", async ({
    page,
  }) => {
    test.slow();
    await page.setViewportSize({ width: 320, height: 800 });
    type DeviceMode = "consent" | "needs-login" | "needs-mfa";
    let mode: DeviceMode = "consent";
    let inspectGate: PendingGate | null = pendingGate();
    let decisionGate: PendingGate | null = pendingGate();
    const bodies: Record<string, unknown>[] = [];
    const details = {
      grant_kind: "session",
      account: {
        email: "owner.with.a.long.address@example.com",
        workspace_name: "Proof Studio",
        workspace_slug: "proof-studio",
      },
      device: {
        device_label: "Chromium browser on a narrow Windows workstation",
        device_type: "desktop",
        device_os: "Windows 11",
        device_client: "Chromium",
      },
      expires_in: 480,
      remember: false,
      scopes: [],
      requires_mfa: false,
      consent_token: "session-bound-consent-token-1234567890",
    };

    await page.route("**/api/v1/auth/cli/device/approve", async (route) => {
      const body = bodyOf(route.request());
      bodies.push(body);
      if (body.action === "inspect") {
        if (inspectGate) await inspectGate.promise;
        if (mode === "needs-login") {
          await json(route, apiError("no_session", "sign in"), 401);
        } else if (mode === "needs-mfa") {
          await json(route, apiError("mfa_required", "verify"), 403);
        } else {
          await json(route, details);
        }
        return;
      }
      if (decisionGate) await decisionGate.promise;
      await json(route, { ...details, ok: true });
    });

    await page.goto("/cli/auth");
    const code = page.getByLabel("Device code");
    const review = page.getByRole("button", { name: "Review request" });
    await expect(code).toBeFocused();
    await expect(review).toBeDisabled();
    await code.fill("bcdf ghjk");
    await expect(code).toHaveValue("BCDF-GHJK");
    await review.click();
    await expect(authStatus(page, "Checking the device request…")).toHaveText(
      "Checking the device request…",
    );
    inspectGate?.resolve();
    inspectGate = null;

    await expect(
      page.getByRole("heading", { name: "Approve sign-in?" }),
    ).toBeVisible();
    await expect(page.getByText(details.device.device_label)).toBeVisible();
    await expect(page.getByText("BCDF-GHJK")).toBeVisible();
    await expectStateQuality(page);

    const approve = page.getByRole("button", {
      name: /^(?:Approve sign-in|Approving…)$/u,
    });
    await approve.click();
    await expect(approve).toHaveText("Approving…");
    await expect(approve).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Deny request" }),
    ).toBeDisabled();
    decisionGate?.resolve();
    decisionGate = null;
    await expect(authStatus(page, "Sign-in approved")).toContainText(
      "Sign-in approved",
    );
    expect(bodies.slice(0, 2)).toEqual([
      { user_code: "BCDF-GHJK", action: "inspect" },
      {
        user_code: "BCDF-GHJK",
        action: "approve",
        consent_token: details.consent_token,
      },
    ]);

    inspectGate = null;
    decisionGate = null;
    await page.goto("/cli/auth?user_code=BCDF-GHJK");
    await expect(
      page.getByRole("heading", { name: "Approve sign-in?" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Deny request" }).click();
    await expect(authStatus(page, "Request denied")).toContainText(
      "Request denied",
    );
    expect(bodies.at(-1)).toEqual({
      user_code: "BCDF-GHJK",
      action: "deny",
      consent_token: details.consent_token,
    });

    mode = "needs-login";
    await page.goto("/cli/auth?user_code=BCDF-GHJK");
    await expect(
      page.getByRole("link", { name: "Go to sign in" }),
    ).toHaveAttribute(
      "href",
      "/login?next=%2Fcli%2Fauth%3Fuser_code%3DBCDF-GHJK",
    );

    mode = "needs-mfa";
    await page.goto("/cli/auth?user_code=BCDF-GHJK");
    await expect(
      page.getByRole("link", {
        name: "Continue to two-factor authentication",
      }),
    ).toHaveAttribute(
      "href",
      "/totp-challenge?next=%2Fcli%2Fauth%3Fuser_code%3DBCDF-GHJK",
    );
  });

  test("CLI loopback fails closed, offers sign-in recovery, and returns a bound code to localhost", async ({
    page,
  }) => {
    test.slow();
    await page.setViewportSize({ width: 320, height: 800 });
    const state = "state-bound-1234567890";
    const challenge = "c".repeat(43);
    const validQuery = new URLSearchParams({
      port: "43123",
      state,
      code_challenge: challenge,
      challenge_method: "S256",
    }).toString();
    let mode: "unauthorized" | "success" = "unauthorized";
    const bodies: Record<string, unknown>[] = [];
    await page.route("**/api/v1/auth/cli/authorize", async (route) => {
      bodies.push(bodyOf(route.request()));
      if (mode === "unauthorized") {
        await json(route, apiError("no_session", "sign in"), 401);
      } else {
        await json(route, { code: "loopback-one-time-code" });
      }
    });
    await page.route(
      /^http:\/\/127\.0\.0\.1:43123\/callback\?/u,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><title>CLI complete</title><h1>CLI authorization received</h1>",
        });
      },
    );

    await page.goto(
      `/cli/auth?port=70000&state=short&code_challenge=short&challenge_method=plain`,
    );
    await expect(
      page.getByText(/Invalid or missing CLI authorization request/u),
    ).toBeVisible();
    await expectStateQuality(page);

    await page.goto(`/cli/auth?${validQuery}`);
    await page.getByRole("button", { name: "Authorize" }).click();
    const login = page.getByRole("link", { name: "Go to sign in" });
    await expect(login).toBeVisible();
    const loginHref = await login.getAttribute("href");
    expect(loginHref).toContain("/login?next=");
    expect(decodeURIComponent(loginHref ?? "")).toContain(
      `/cli/auth?port=43123&state=${state}`,
    );

    mode = "success";
    await page.goto(`/cli/auth?${validQuery}`);
    await Promise.all([
      page.waitForURL(/^http:\/\/127\.0\.0\.1:43123\/callback\?/u),
      page.getByRole("button", { name: "Authorize" }).click(),
    ]);
    const callback = new URL(page.url());
    expect(callback.searchParams.get("code")).toBe("loopback-one-time-code");
    expect(callback.searchParams.get("state")).toBe(state);
    expect(bodies).toEqual([
      {
        state,
        code_challenge: challenge,
        challenge_method: "S256",
        port: 43123,
      },
      {
        state,
        code_challenge: challenge,
        challenge_method: "S256",
        port: 43123,
      },
    ]);
  });
});

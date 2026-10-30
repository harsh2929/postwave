import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const AUTH_SURFACES = [
  { path: "/login", heading: "Sign in" },
  { path: "/signup", heading: "Create your workspace" },
  { path: "/forgot-password", heading: "Reset your password" },
  { path: "/magic-link", heading: "Sign in with a magic link" },
  { path: "/reset-password", heading: "Reset link required" },
  { path: "/verify-email", heading: "Verification failed" },
  { path: "/totp-challenge", heading: "Two-factor authentication" },
  { path: "/accept-invite", heading: "Invitation link required" },
  { path: "/cli/auth", heading: "Review a device request" },
  { path: "/browser-auth/magic", heading: "Sign in with a magic link" },
  { path: "/browser-auth/reset", heading: "Reset link required" },
] as const;

const BLOCKING_IMPACTS = new Set(["critical", "serious"]);

test.describe("auth surface quality", () => {
  for (const surface of AUTH_SURFACES) {
    test(`${surface.path} is accessible, responsive, and structurally complete`, async ({
      page,
    }) => {
      test.slow();
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(surface.path, {
        waitUntil: "domcontentloaded",
        timeout: 90_000,
      });

      const heading = page.getByRole("heading", {
        name: surface.heading,
        exact: true,
      });
      await expect(heading).toBeVisible({ timeout: 30_000 });
      await expect(page.locator("main#auth-main")).toHaveCount(1);
      await expect(page.locator("h1")).toHaveCount(1);
      await expect(page).toHaveTitle(/Moosewave/);
      await expect(page).not.toHaveTitle(/^Moosewave$/);

      const overflow = await page.evaluate(() => ({
        viewport: window.innerWidth,
        html: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
      }));
      expect(
        Math.max(overflow.html, overflow.body),
        `${surface.path} overflows a ${overflow.viewport}px viewport`,
      ).toBeLessThanOrEqual(overflow.viewport + 1);

      if ((page.viewportSize()?.width ?? 1024) < 640) {
        const undersized = await page
          .locator(
            ".pw-auth-content [data-slot='button'], .pw-auth-content [data-slot='input']",
          )
          .evaluateAll((nodes) =>
            nodes.flatMap((node) => {
              const rect = node.getBoundingClientRect();
              const visible =
                rect.width > 0 &&
                rect.height > 0 &&
                getComputedStyle(node).visibility !== "hidden";
              return visible && rect.height < 43.5
                ? [
                    {
                      tag: node.tagName,
                      text: node.textContent?.trim() ?? "",
                      height: rect.height,
                    },
                  ]
                : [];
            }),
          );
        expect(
          undersized,
          "auth controls must keep a 44px mobile target",
        ).toEqual([]);
      }

      // The auth card has a short compositor-only arrival. Reduced motion
      // collapses it, but wait for that final frame so axe never samples
      // half-transparent text against the page underneath.
      await page.waitForFunction(() =>
        document
          .getAnimations()
          .filter((animation) => {
            const iterations = animation.effect?.getTiming().iterations;
            return (
              typeof iterations === "number" && Number.isFinite(iterations)
            );
          })
          .every((animation) => animation.playState === "finished"),
      );
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

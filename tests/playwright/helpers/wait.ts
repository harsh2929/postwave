import type { Locator, Page } from '@playwright/test';

/**
 * Wait helpers used across spec files.
 *
 * Keep these intentionally narrow — most waits should use Playwright's
 * built-in auto-waiting. These helpers only exist for the cases where
 * we genuinely need a settled DOM (animations, deferred fetches, etc).
 */

/**
 * Wait until `selector` is visible. Falls back to a custom timeout
 * because some pages defer their initial render until tenant context
 * has been hydrated.
 */
export async function waitForStableContent(
  page: Page,
  selector: string,
  timeoutMs = 5_000,
): Promise<void> {
  await page.waitForSelector(selector, { state: 'visible', timeout: timeoutMs });
}

/**
 * Wait until `locator` resolves to a non-empty text value.
 *
 * Useful for stat cards that start as a skeleton or "—" placeholder before
 * the first API response lands.
 */
export async function waitForNonEmptyText(
  locator: Locator,
  timeoutMs = 5_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  // Poll on a 100ms cadence — Playwright's auto-retry assertions can't
  // easily express "trimmed text length > 0 and not '—'".
  while (Date.now() < deadline) {
    const text = (await locator.first().textContent())?.trim() ?? '';
    if (text.length > 0 && text !== '—' && text !== '-') {
      return text;
    }
    await locator.page().waitForTimeout(100);
  }
  throw new Error(
    `waitForNonEmptyText timed out after ${timeoutMs}ms waiting on ${locator}`,
  );
}

/**
 * Wait for any pending network activity on `urlPattern` to complete.
 *
 * Use sparingly — prefer `page.waitForResponse(...)` when you know
 * the exact request you care about.
 */
export async function waitForApi(
  page: Page,
  urlPattern: string | RegExp,
  timeoutMs = 10_000,
): Promise<void> {
  await page.waitForResponse(
    (response) => {
      const url = response.url();
      const matches =
        typeof urlPattern === 'string' ? url.includes(urlPattern) : urlPattern.test(url);
      return matches && response.status() < 500;
    },
    { timeout: timeoutMs },
  );
}

/**
 * Retry a flaky assertion. The callback should throw on failure.
 *
 * Last resort for assertions that don't fit Playwright's expect.poll —
 * almost always prefer expect.poll over this.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 5;
  const delayMs = options.delayMs ?? 250;
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

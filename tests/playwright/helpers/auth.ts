import type { BrowserContext, Page } from '@playwright/test';

/**
 * Auth helpers for the docker-compose dev stack.
 *
 * In production the app uses email + password or magic-link auth.
 * In local-dev mode (POSTWAVE_LOCAL_AUTH_BYPASS=1) the API trusts the
 * `X-Tenant-Slug` header and `postwave-tenant-slug` cookie to identify
 * which tenant the browser is acting as, so Playwright can skip the UI
 * login entirely.
 */

const DEFAULT_TENANT_SLUG = 'demo';

export type DemoTenant = 'demo' | 'acme' | (string & {});

export interface LoginOptions {
  /** Tenant slug to authenticate as. Defaults to `demo`. */
  tenant?: DemoTenant;
  /** If true, navigate to /app after attaching cookies. */
  navigate?: boolean;
  /** Path under /app to land on. Only honored when navigate is true. */
  startPath?: string;
}

/**
 * Attach the dev-mode tenant cookie + storage entries to a browser context
 * so subsequent requests look authenticated as the chosen demo tenant.
 *
 * Safe to call multiple times — addCookies replaces existing values.
 */
export async function loginAsDemo(
  page: Page,
  options: LoginOptions = {},
): Promise<void> {
  const tenant = options.tenant ?? DEFAULT_TENANT_SLUG;
  const baseURL = page.context().browser()?.contexts()[0]
    ? new URL(page.url() || 'http://localhost:3000').origin
    : 'http://localhost:3000';
  const url = process.env.POSTWAVE_E2E_URL ?? baseURL;

  await page.context().addCookies([
    {
      name: 'postwave-tenant-slug',
      value: tenant,
      url,
    },
    {
      // The web app also reads this cookie to seed the React tenant context
      // before the first API round-trip lands.
      name: 'postwave-dev-mode',
      value: '1',
      url,
    },
  ]);

  await page.addInitScript((slug) => {
    try {
      window.localStorage.setItem('postwave:tenant-slug', slug);
      window.localStorage.setItem('postwave:dev-bypass', '1');
    } catch {
      // localStorage may be unavailable on some about:blank pages — ignore.
    }
  }, tenant);

  if (options.navigate !== false) {
    const path = options.startPath ?? '/app';
    await page.goto(path);
  }
}

/**
 * Clear the dev-mode cookies so the next navigation lands on the login page.
 */
export async function logout(context: BrowserContext): Promise<void> {
  await context.clearCookies();
  await context.addInitScript(() => {
    try {
      window.localStorage.removeItem('postwave:tenant-slug');
      window.localStorage.removeItem('postwave:dev-bypass');
    } catch {
      // ignore
    }
  });
}

/**
 * Set the X-Tenant-Slug header on every request issued from `context`.
 *
 * Useful for tests that exercise multi-tenant boundaries (e.g. confirming
 * tenant A cannot see tenant B's data).
 */
export async function setTenantHeader(
  context: BrowserContext,
  tenant: DemoTenant,
): Promise<void> {
  await context.setExtraHTTPHeaders({ 'X-Tenant-Slug': tenant });
}

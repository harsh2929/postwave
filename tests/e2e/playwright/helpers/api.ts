/**
 * Lightweight Moosewave API client for the Playwright golden-path suite.
 *
 * Wraps fetch with the dev-stack tenant/role headers and JSON ergonomics
 * the tests need. We talk to the api container directly (port 8080) for
 * back-channel verification — the user-facing flows go through the web
 * container (port 3000).
 */

const DEFAULT_API_BASE = process.env.POSTWAVE_E2E_API_BASE ?? 'http://localhost:8080';

export interface ApiOptions {
  base?: string;
  tenantSlug?: string;
  adminRole?: string;
  extraHeaders?: Record<string, string>;
}

export class ApiClient {
  private readonly base: string;
  private readonly tenantSlug?: string;
  private readonly adminRole?: string;
  private readonly extraHeaders: Record<string, string>;

  constructor(opts: ApiOptions = {}) {
    this.base = opts.base ?? DEFAULT_API_BASE;
    this.tenantSlug = opts.tenantSlug;
    this.adminRole = opts.adminRole ?? 'admin';
    this.extraHeaders = opts.extraHeaders ?? {};
  }

  withTenant(slug: string): ApiClient {
    return new ApiClient({
      base: this.base,
      tenantSlug: slug,
      adminRole: this.adminRole,
      extraHeaders: this.extraHeaders,
    });
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T; raw: string }> {
    const url = `${this.base}${path}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...this.extraHeaders,
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (this.tenantSlug) {
      headers['X-Tenant-Slug'] = this.tenantSlug;
      headers['X-Postwave-Tenant'] = this.tenantSlug;
    }
    if (this.adminRole) {
      headers['X-Postwave-Role'] = this.adminRole;
    }
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    let parsed: unknown = null;
    if (raw.length > 0) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
    }
    return { status: res.status, body: parsed as T, raw };
  }

  async waitForHealth(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr = '';
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.base}/api/health`);
        if (res.ok) return;
        lastErr = `status=${res.status}`;
      } catch (err) {
        lastErr = String(err);
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    throw new Error(`api never became healthy at ${this.base}: ${lastErr}`);
  }
}

/**
 * Generate a unique slug for a journey so concurrent runs (or retries)
 * don't collide on tenant rows.
 */
export function uniqueSlug(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${rand}`;
}

export function uniqueEmail(prefix: string): string {
  return `${prefix}+${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}@e2e.postwave.local`;
}

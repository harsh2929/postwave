/**
 * Seed data helpers used across specs.
 *
 * The docker-compose stack ships with a `/api/v1/onboarding/sample-data`
 * endpoint that seeds a single demo tenant with subscribers, campaigns,
 * and a couple of completed migrations. We hit that endpoint once at
 * the start of the suite (see global setup hook in CI) and reuse the
 * seeded values here.
 */

export const DEMO_TENANT = {
  slug: 'demo',
  email: 'owner@demo.postwave.local',
  password: 'demo-password',
} as const;

export const SAMPLE_CAMPAIGNS = [
  {
    name: 'Welcome Series — Issue #1',
    subject: 'Welcome to the demo workspace',
    status: 'sent',
  },
  {
    name: 'Product Update — May',
    subject: 'What is shipping this month',
    status: 'draft',
  },
] as const;

export const SAMPLE_SUBSCRIBERS = [
  {
    email: 'alice@example.com',
    firstName: 'Alice',
    status: 'active',
  },
  {
    email: 'bob@example.com',
    firstName: 'Bob',
    status: 'active',
  },
] as const;

export const TOUR_STEP_COUNT = 10;

/**
 * Request the backend to (re)seed sample data into the demo tenant.
 *
 * Idempotent — the API treats it as an upsert.
 */
export async function seedSampleData(baseURL: string, tenantSlug = DEMO_TENANT.slug): Promise<void> {
  const response = await fetch(`${baseURL}/api/v1/onboarding/sample-data`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-Slug': tenantSlug,
    },
    body: JSON.stringify({ reset: false }),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to seed sample data (${response.status}): ${await response.text()}`,
    );
  }
}

/**
 * Remove the sample data so a test can exercise the empty-state code paths.
 */
export async function clearSampleData(baseURL: string, tenantSlug = DEMO_TENANT.slug): Promise<void> {
  const response = await fetch(`${baseURL}/api/v1/onboarding/sample-data`, {
    method: 'DELETE',
    headers: { 'X-Tenant-Slug': tenantSlug },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `Failed to clear sample data (${response.status}): ${await response.text()}`,
    );
  }
}

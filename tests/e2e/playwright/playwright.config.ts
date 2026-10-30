import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the Moosewave real-e2e golden-path suite.
 *
 * Targets the docker-compose test stack:
 *   infra/docker-compose.yml + docker-compose.full.yml + docker-compose.test.yml
 *
 * That stack includes a Mailpit container on http://localhost:8025 so the
 * signup-email-confirmation and campaign-send journeys can assert
 * outbound delivery against a real (test) SMTP catch-all.
 *
 * Knobs (env vars):
 *   POSTWAVE_E2E_WEB_BASE     default http://localhost:3000
 *   POSTWAVE_E2E_API_BASE     default http://localhost:8080
 *   POSTWAVE_E2E_MAILPIT_BASE default http://localhost:8025
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false, // Journeys share the mailpit inbox; keep serial for stable assertions.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [
        ['html', { open: 'never', outputFolder: 'playwright-report' }],
        ['github'],
        ['list'],
      ]
    : 'list',
  outputDir: 'test-results',
  timeout: 90_000,
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL: process.env.POSTWAVE_E2E_WEB_BASE ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});

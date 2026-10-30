import { expect, test, type Page, type Route } from "@playwright/test";

import { loginAsDemo } from "../helpers/auth";

const TEXT_ONLY_BODY =
  "Authoritative plain-text launch note. Keep this exact punctuation & spacing.";
const RETAINED_LEGACY_HTML =
  '<p data-legacy="true">This retained HTML is not authoritative.</p>';
const EFFECTIVE_HTML =
  '<main data-voice-case="effective-html"><h1>HTML is authoritative</h1><p>Score this markup.</p></main>';
const UNUSED_HTML_FALLBACK_TEXT =
  "Plain text selected because the HTML field contains only whitespace.";
const WHITESPACE_HTML = "  \n\t  ";
const CRITICAL_HTML =
  '<main data-voice-case="critical"><h1>Critical mobile drift</h1><p>Inspect the long guidance.</p></main>';
const RACE_OLD_HTML =
  '<main data-voice-case="race-old"><p>Older server revision.</p></main>';
const RACE_NEW_HTML =
  '<main data-voice-case="race-new"><p>Newest refreshed revision.</p></main>';

const CRITICAL_REASON =
  "The draft departs from the established voice because its framing is unusually severe; review https://voice-guidance.example.test/" +
  "critical-context-without-natural-breakpoints-".repeat(5);
const CRITICAL_SUGGESTIONS = [
  "Replace the opening with a calm, direct statement that preserves the specific customer outcome.",
  "Shorten this uninterrupted-token-before-send-".repeat(7),
  "Keep the evidence, but remove urgency that the source material does not support.",
] as const;

interface CampaignFixture {
  id: string;
  tenant_id: string;
  name: string;
  subject: string;
  status: "draft";
  campaign_type: "regular" | "plain_text";
  editor_mode: "html" | "plain_text";
  body_html: string;
  plain_text: string;
  from_name: string;
  delivery_settings: { from_email: string };
  created_at: string;
  updated_at: string;
}

interface DriftRequestBody {
  html?: string;
  text?: string;
  profile_id?: string;
}

interface VoiceDriftFixtureState {
  driftBodies: DriftRequestBody[];
  predictBodies: unknown[];
  unexpectedApiCalls: string[];
  releaseStaleDrift: () => void;
  staleDriftSettled: Promise<void>;
  waitForStaleDrift: () => Promise<void>;
}

function campaign(
  id: string,
  name: string,
  subject: string,
  content: Pick<
    CampaignFixture,
    "body_html" | "campaign_type" | "editor_mode" | "plain_text"
  >,
  minute: number,
): CampaignFixture {
  const timestamp = `2026-08-27T10:${String(minute).padStart(2, "0")}:00.000Z`;
  return {
    id,
    tenant_id: "tenant_voice_drift",
    name,
    subject,
    status: "draft",
    ...content,
    from_name: "Moosewave Voice Lab",
    delivery_settings: { from_email: "voice@example.test" },
    created_at: timestamp,
    updated_at: timestamp,
  };
}

const TEXT_ONLY_CAMPAIGN = campaign(
  "campaign_voice_text",
  "Authoritative text campaign",
  "Text-mode contract",
  {
    campaign_type: "plain_text",
    editor_mode: "plain_text",
    body_html: RETAINED_LEGACY_HTML,
    plain_text: TEXT_ONLY_BODY,
  },
  5,
);

const HTML_CAMPAIGN = campaign(
  "campaign_voice_html",
  "Effective HTML campaign",
  "HTML precedence contract",
  {
    campaign_type: "regular",
    editor_mode: "html",
    body_html: EFFECTIVE_HTML,
    plain_text: "This fallback must be omitted while HTML is present.",
  },
  4,
);

const WHITESPACE_HTML_CAMPAIGN = campaign(
  "campaign_voice_whitespace",
  "Whitespace HTML fallback campaign",
  "Whitespace fallback contract",
  {
    campaign_type: "regular",
    editor_mode: "html",
    body_html: WHITESPACE_HTML,
    plain_text: UNUSED_HTML_FALLBACK_TEXT,
  },
  3,
);

const EMPTY_CAMPAIGN = campaign(
  "campaign_voice_empty",
  "Empty content campaign",
  "Honest skipped state",
  {
    campaign_type: "regular",
    editor_mode: "html",
    body_html: " \n ",
    plain_text: "\t ",
  },
  2,
);

const CRITICAL_CAMPAIGN = campaign(
  "campaign_voice_critical",
  "Critical mobile guidance campaign",
  "Critical guidance at 320 pixels",
  {
    campaign_type: "regular",
    editor_mode: "html",
    body_html: CRITICAL_HTML,
    plain_text: "Unused critical fallback.",
  },
  1,
);

const RACE_CAMPAIGN_OLD = campaign(
  "campaign_voice_race",
  "Race refresh campaign",
  "Older revision subject",
  {
    campaign_type: "regular",
    editor_mode: "html",
    body_html: RACE_OLD_HTML,
    plain_text: "Unused old fallback.",
  },
  0,
);

const RACE_CAMPAIGN_NEW: CampaignFixture = {
  ...RACE_CAMPAIGN_OLD,
  subject: "Newest revision subject",
  body_html: RACE_NEW_HTML,
  plain_text: "Unused new fallback.",
  updated_at: "2026-08-27T10:59:00.000Z",
};

const CAMPAIGNS = [
  TEXT_ONLY_CAMPAIGN,
  HTML_CAMPAIGN,
  WHITESPACE_HTML_CAMPAIGN,
  EMPTY_CAMPAIGN,
  CRITICAL_CAMPAIGN,
  RACE_CAMPAIGN_OLD,
] as const;

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function makeDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function installVoiceDriftRoutes(
  page: Page,
): Promise<VoiceDriftFixtureState> {
  const driftBodies: DriftRequestBody[] = [];
  const predictBodies: unknown[] = [];
  const unexpectedApiCalls: string[] = [];
  const staleStarted = makeDeferred();
  const staleRelease = makeDeferred();
  const staleSettled = makeDeferred();
  let staleReleased = false;
  let raceRefreshed = false;

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === "/api/health") {
      await json(route, { status: "ok" });
      return;
    }

    // Authenticated dashboard shell dependencies.
    if (path === "/api/v1/auth/me" && method === "GET") {
      await json(route, {
        user_id: "user_voice_drift",
        tenant_id: "tenant_voice_drift",
        email: "voice.operator@example.test",
        role: "owner",
        effective_role: "owner",
        auth_provider: "password",
        email_verified: true,
        workspace_name: "Voice drift browser lab",
        workspace_slug: "voice-drift-browser-lab",
      });
      return;
    }
    if (path === "/api/v1/auth/workspaces" && method === "GET") {
      await json(route, { workspaces: [] });
      return;
    }
    if (path === "/api/v1/onboarding/steps" && method === "GET") {
      await json(route, {
        steps: { dashboard_tour: { state: "dismissed" } },
      });
      return;
    }
    if (path === "/api/v1/onboarding-progress" && method === "GET") {
      await json(route, {
        steps: [
          {
            key: "sent_first_campaign",
            label: "Send your first campaign",
            description: "Already completed in this deterministic fixture.",
            completed: true,
          },
        ],
        completed: 1,
        total: 1,
        percent: 100,
        all_done: true,
      });
      return;
    }
    if (path === "/api/v1/approvals" && method === "GET") {
      await json(route, { approvals: [] });
      return;
    }
    if (path === "/api/v1/notifications" && method === "GET") {
      await json(route, { items: [], unread_count: 0 });
      return;
    }
    if (path === "/api/v1/events" && method === "GET") {
      // The dashboard opens one workspace event bus and one presence stream.
      // A short, valid SSE response keeps both requests inside this fixture.
      // No product event is emitted, and the retry hint keeps the browser's
      // native reconnect policy quiet if it observes the finite fixture end.
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: {
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
        body: "retry: 60000\n\n",
      });
      return;
    }

    // Campaign list, count, detail, and every send-dialog gate.
    if (path === "/api/v1/campaigns/count" && method === "GET") {
      await json(route, {
        total: CAMPAIGNS.length,
        by_status: { draft: CAMPAIGNS.length },
      });
      return;
    }
    if (path === "/api/v1/campaigns" && method === "GET") {
      const query = url.searchParams.get("query")?.trim().toLowerCase() ?? "";
      if (query === "race refresh") raceRefreshed = true;
      const rows = CAMPAIGNS.map((item) =>
        raceRefreshed && item.id === RACE_CAMPAIGN_OLD.id
          ? RACE_CAMPAIGN_NEW
          : item,
      ).filter(
        (item) =>
          !query ||
          item.name.toLowerCase().includes(query) ||
          item.subject.toLowerCase().includes(query),
      );
      await json(route, rows);
      return;
    }

    const campaignMatch = path.match(
      /^\/api\/v1\/campaigns\/([^/]+)(?:\/(.+))?$/,
    );
    if (campaignMatch) {
      const id = decodeURIComponent(campaignMatch[1]);
      const suffix = campaignMatch[2] ?? "";
      const item =
        (raceRefreshed && id === RACE_CAMPAIGN_NEW.id
          ? RACE_CAMPAIGN_NEW
          : CAMPAIGNS.find((candidate) => candidate.id === id)) ??
        (id === RACE_CAMPAIGN_NEW.id ? RACE_CAMPAIGN_NEW : undefined);

      if (suffix === "send-preview" && method === "GET") {
        await json(route, {
          campaign_id: id,
          audience_kind: "workspace",
          recipients: 24,
          suppressed_excluded: 2,
          deliverable: 22,
          tier_cap_today: 1_000,
          tier_cap_remaining: 900,
          tier_cap_remaining_after: 878,
          over_cap: false,
          counted_at: "2026-08-27T11:00:00.000Z",
        });
        return;
      }
      if (suffix === "checklist" && method === "GET") {
        await json(route, {
          campaign_id: id,
          ready: true,
          checks: [
            {
              key: "sender",
              label: "Sender identity",
              status: "pass",
              detail: "Verified for the deterministic browser fixture.",
            },
          ],
        });
        return;
      }
      if (suffix === "assurance" && method === "GET") {
        await json(
          route,
          {
            error: {
              code: "not_found",
              message: "No assurance receipt for this fixture.",
            },
          },
          404,
        );
        return;
      }
      if (!suffix && method === "GET" && item) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { ETag: `"${id}-voice-v1"` },
          body: JSON.stringify(item),
        });
        return;
      }
    }

    // Inbox Reality is a parallel advisory in the same dialog. Keep all of
    // its inputs real-shaped so a voice assertion never passes behind an
    // unrelated loading/error state.
    if (path === "/api/v1/reputation" && method === "GET") {
      await json(route, {
        domain: "example.test",
        ip: "203.0.113.44",
        google_score: "high",
        microsoft_score: "high",
        sender_score: 94,
        blacklist_hits: [],
        checked_at: "2026-08-27T11:00:00.000Z",
        data_available: true,
        sources_succeeded: ["fixture"],
        sources_failed: [],
      });
      return;
    }
    if (path === "/api/v1/auth-checks" && method === "GET") {
      const pass = { status: "ok", detail: "Fixture passes." };
      await json(route, [
        {
          domain: "example.test",
          spf: pass,
          dkim: pass,
          dmarc: pass,
          bimi: pass,
          ptr: pass,
        },
      ]);
      return;
    }
    if (path === "/api/v1/predict" && method === "POST") {
      predictBodies.push(request.postDataJSON());
      await json(route, {
        predicted: { primary: 0.88, promotions: 0.09, spam: 0.03 },
        content: {
          spam_score: 0.04,
          spam_reasons: [],
          image_text_ratio: 0.1,
          link_reputation: "ok",
          html_issues: [],
        },
        risk: {
          model: {
            name: "deterministic-browser-fixture",
            version: "1",
            kind: "fixture",
            source: "playwright",
            trained: false,
          },
          weights: {
            content: 0.25,
            reputation: 0.25,
            auth: 0.25,
            engagement: 0.25,
          },
        },
        at: "2026-08-27T11:00:00.000Z",
      });
      return;
    }

    if (path === "/api/v1/voice/drift" && method === "POST") {
      const body = request.postDataJSON() as DriftRequestBody;
      driftBodies.push(body);

      if (body.html === RACE_OLD_HTML) {
        staleStarted.resolve();
        await staleRelease.promise;
        try {
          await json(route, {
            score: 12,
            severity: "critical",
            reason: "Stale old revision must never render.",
            suggestions: ["Stale suggestion."],
          });
        } catch {
          // Passing AbortSignal to fetch is part of the contract. Chromium may
          // cancel this held route when the query key changes, in which case
          // there is deliberately no response left to fulfill.
        } finally {
          staleSettled.resolve();
        }
        return;
      }
      if (body.html === RACE_NEW_HTML) {
        await json(route, {
          score: 86,
          severity: "warn",
          reason: "Newest refreshed revision is authoritative.",
          suggestions: ["Keep the refreshed revision."],
        });
        return;
      }
      if (body.html === CRITICAL_HTML) {
        await json(route, {
          score: 17,
          severity: "critical",
          reason: CRITICAL_REASON,
          suggestions: [...CRITICAL_SUGGESTIONS],
        });
        return;
      }
      if (body.text === TEXT_ONLY_BODY) {
        await json(route, { score: 96, severity: "ok", suggestions: [] });
        return;
      }
      if (body.html === EFFECTIVE_HTML) {
        await json(route, {
          score: 74,
          severity: "warn",
          reason: "HTML fixture resolved.",
          suggestions: ["Tighten the HTML introduction."],
        });
        return;
      }
      if (body.text === UNUSED_HTML_FALLBACK_TEXT) {
        await json(route, { score: 92, severity: "ok", suggestions: [] });
        return;
      }

      await json(route, { score: 80, severity: "ok", suggestions: [] });
      return;
    }

    unexpectedApiCalls.push(`${method} ${path}`);
    await json(
      route,
      { error: { code: "not_found", message: "Unexpected API fixture path." } },
      404,
    );
  });

  // The deferred campaign-intelligence panel shares this page. Returning
  // complete empty contracts keeps it deterministic while the send dialog is
  // selected and avoids leaking requests to the demo backend.
  await page.route("**/api/mailchimp/**", async (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/mailchimp/3.0/campaign-manager/calendar") {
      await json(route, {
        touchpoints: [],
        tasks: [],
        capabilities: [],
        summary: {},
      });
      return;
    }
    if (path === "/api/mailchimp/3.0/reports/custom") {
      await json(route, {
        id: "voice-drift-report",
        view: "campaign",
        metrics: ["sent", "opened", "clicked", "revenue_cents"],
        group_by: ["campaign"],
        rows: [],
        graph: [],
        generated_at: "2026-08-27T11:00:00.000Z",
      });
      return;
    }

    const campaignId =
      path.match(/^\/api\/mailchimp\/3\.0\/campaigns\/([^/]+)\//)?.[1] ??
      "campaign_voice_fixture";
    if (path.endsWith("/multivariate")) {
      await json(route, {
        campaign_id: campaignId,
        enabled: false,
        winner_metric: "open_rate",
        evaluation_window_hours: 24,
        sample_pct: 0,
        winner_recipients_pct: 100,
        variations: [],
        dimensions: [],
        limits: {},
      });
      return;
    }
    if (
      path.endsWith("/send-time-optimization") ||
      path.endsWith("/send-day-optimization")
    ) {
      await json(route, {
        campaign_id: campaignId,
        recommendation: {
          label: "Learning",
          score: 0,
          confidence: "insufficient_data",
          reason: "Deterministic empty fixture.",
        },
        data_points: 0,
        method: "fixture",
      });
      return;
    }
    if (path.endsWith("/delivery-insights")) {
      await json(route, {
        campaign_id: campaignId,
        status: "draft",
        can_cancel: false,
        cancelled: false,
        progress: {},
        delivery_status: "draft",
        warnings: [],
      });
      return;
    }
    if (path.endsWith("/inbox")) {
      await json(route, {
        campaign_id: campaignId,
        replies: [],
        threads: [],
        total_items: 0,
        distinct_replyers: 0,
        reply_rate: 0,
      });
      return;
    }
    if (/\/api\/mailchimp\/3\.0\/reports\/[^/]+\/click-map$/.test(path)) {
      await json(route, {
        campaign_id: campaignId,
        total_clicks: 0,
        links: [],
        device_views: [],
      });
      return;
    }

    unexpectedApiCalls.push(`${route.request().method()} ${path}`);
    await json(
      route,
      { error: { code: "not_found", message: "Unexpected API fixture path." } },
      404,
    );
  });

  return {
    driftBodies,
    predictBodies,
    unexpectedApiCalls,
    releaseStaleDrift: () => {
      if (staleReleased) return;
      staleReleased = true;
      staleRelease.resolve();
    },
    staleDriftSettled: staleSettled.promise,
    waitForStaleDrift: () => staleStarted.promise,
  };
}

async function prepareCampaigns(page: Page): Promise<VoiceDriftFixtureState> {
  const state = await installVoiceDriftRoutes(page);
  await page.goto("/app/campaigns", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Campaigns" })).toBeVisible();
  await expect(page.getByTestId("campaign-row")).toHaveCount(CAMPAIGNS.length);
  return state;
}

async function openSendDialog(
  page: Page,
  item: CampaignFixture,
): Promise<ReturnType<Page["getByRole"]>> {
  const row = page
    .getByTestId("campaign-row")
    .filter({ hasText: item.name })
    .first();
  await expect(row).toBeVisible();
  // The name is a real detail link and occupies the row centre on narrow
  // screens. Activate the focusable row through its documented keyboard path;
  // the checkbox is a separate bulk-selection model and must not be mistaken
  // for the active campaign that owns Schedule and Send.
  await row.focus();
  await row.press("Enter");
  await expect(row).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Send campaign" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function closeSendDialog(
  dialog: ReturnType<Page["getByRole"]>,
): Promise<void> {
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
}

test.describe("voice drift send-dialog contract", () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(() => {
      (
        window as typeof window & {
          __POSTWAVE_FORCE_REAL_API_FOR_E2E__?: boolean;
        }
      ).__POSTWAVE_FORCE_REAL_API_FOR_E2E__ = true;
    });
    await loginAsDemo(page, { navigate: false });
  });

  test("desktop: sends only authoritative effective content and skips empty copy", async ({
    page,
  }) => {
    test.skip(
      test.info().project.name !== "chromium-desktop",
      "Owned by chromium-desktop",
    );
    const state = await prepareCampaigns(page);

    const textDialog = await openSendDialog(page, TEXT_ONLY_CAMPAIGN);
    await expect(textDialog.getByTestId("voice-drift-banner")).toContainText(
      "96/100",
    );
    await expect(
      textDialog.getByTestId("inbox-reality-banner"),
    ).toHaveAttribute("data-state", "predicted");
    expect(state.driftBodies).toEqual([{ text: TEXT_ONLY_BODY }]);
    await closeSendDialog(textDialog);

    const htmlDialog = await openSendDialog(page, HTML_CAMPAIGN);
    await expect(htmlDialog.getByTestId("voice-drift-banner")).toContainText(
      "74/100",
    );
    expect(state.driftBodies).toEqual([
      { text: TEXT_ONLY_BODY },
      { html: EFFECTIVE_HTML },
    ]);
    await closeSendDialog(htmlDialog);

    const fallbackDialog = await openSendDialog(page, WHITESPACE_HTML_CAMPAIGN);
    await expect(
      fallbackDialog.getByTestId("voice-drift-banner"),
    ).toContainText("92/100");
    expect(state.driftBodies).toEqual([
      { text: TEXT_ONLY_BODY },
      { html: EFFECTIVE_HTML },
      { text: UNUSED_HTML_FALLBACK_TEXT },
    ]);
    await closeSendDialog(fallbackDialog);

    const requestsBeforeEmpty = state.driftBodies.length;
    const emptyDialog = await openSendDialog(page, EMPTY_CAMPAIGN);
    await expect(
      emptyDialog.getByTestId("voice-drift-banner-empty"),
    ).toHaveText(
      "Voice drift check skipped — add campaign content to check brand voice before sending.",
    );
    await expect(
      emptyDialog.getByRole("button", { name: "Send now" }),
    ).toBeEnabled();
    await page.waitForTimeout(150);
    expect(state.driftBodies).toHaveLength(requestsBeforeEmpty);
    expect(state.predictBodies.length).toBeGreaterThan(0);
    expect(state.unexpectedApiCalls).toEqual([]);
  });

  test("desktop: a refreshed edit wins after an older score resolves late", async ({
    page,
  }) => {
    test.skip(
      test.info().project.name !== "chromium-desktop",
      "Owned by chromium-desktop",
    );
    const state = await prepareCampaigns(page);

    try {
      const oldDialog = await openSendDialog(page, RACE_CAMPAIGN_OLD);
      await state.waitForStaleDrift();
      await expect(
        oldDialog.getByTestId("voice-drift-banner-loading"),
      ).toBeVisible();
      await closeSendDialog(oldDialog);

      const search = page.getByLabel("Search campaigns");
      await search.fill("Race refresh");
      await page.getByRole("button", { name: "Search", exact: true }).click();
      const refreshedRow = page
        .getByTestId("campaign-row")
        .filter({ hasText: RACE_CAMPAIGN_NEW.name });
      await expect(refreshedRow).toContainText(RACE_CAMPAIGN_NEW.subject);

      const newDialog = await openSendDialog(page, RACE_CAMPAIGN_NEW);
      const currentBanner = newDialog.getByTestId("voice-drift-banner");
      await expect(currentBanner).toContainText("86/100");
      await expect(currentBanner).toContainText(
        "Newest refreshed revision is authoritative.",
      );

      state.releaseStaleDrift();
      await state.staleDriftSettled;
      await page.waitForTimeout(100);
      await expect(currentBanner).toContainText("86/100");
      await expect(currentBanner).not.toContainText(
        "Stale old revision must never render.",
      );
      expect(state.driftBodies).toEqual([
        { html: RACE_OLD_HTML },
        { html: RACE_NEW_HTML },
      ]);
      expect(state.unexpectedApiCalls).toEqual([]);
    } finally {
      state.releaseStaleDrift();
    }
  });

  test("320px: critical long guidance is contained, operable, and advisory", async ({
    page,
  }) => {
    test.skip(
      test.info().project.name !== "chromium-mobile",
      "Owned by chromium-mobile",
    );
    await page.setViewportSize({ width: 320, height: 800 });
    const state = await prepareCampaigns(page);
    const dialog = await openSendDialog(page, CRITICAL_CAMPAIGN);
    const banner = dialog.getByTestId("voice-drift-banner");

    await expect(banner).toHaveAttribute("data-severity", "critical");
    await expect(banner).toContainText("Strong voice drift — 17/100");
    await expect(banner).toContainText(CRITICAL_REASON);
    await expect(banner).toContainText(
      "Advisory only — this never blocks a send.",
    );

    const disclosure = banner.locator("button[aria-controls]");
    await expect(disclosure).toHaveAccessibleName("Why?");
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    const controlBox = await disclosure.boundingBox();
    expect(controlBox).not.toBeNull();
    expect(controlBox!.height).toBeGreaterThanOrEqual(44);
    const controlledId = await disclosure.getAttribute("aria-controls");
    expect(controlledId).toBeTruthy();
    await disclosure.focus();
    await expect(disclosure).toBeFocused();
    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await expect(disclosure).toHaveAccessibleName("Hide details");

    const details = banner.locator("ul");
    await expect(details).toHaveAttribute("id", controlledId!);
    await expect(details).toBeVisible();
    for (const suggestion of CRITICAL_SUGGESTIONS) {
      await expect(details).toContainText(suggestion);
    }

    const sendNow = dialog.getByRole("button", { name: "Send now" });
    await expect(sendNow).toBeEnabled();
    const geometry = await page.evaluate(() => {
      const openDialog = document.querySelector<HTMLElement>(
        '[role="dialog"][data-state="open"]',
      );
      const drift = document.querySelector<HTMLElement>(
        '[data-testid="voice-drift-banner"]',
      );
      return {
        viewport: window.innerWidth,
        html: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
        dialogClient: openDialog?.clientWidth ?? 0,
        dialogScroll: openDialog?.scrollWidth ?? 0,
        bannerClient: drift?.clientWidth ?? 0,
        bannerScroll: drift?.scrollWidth ?? 0,
      };
    });
    expect(Math.max(geometry.html, geometry.body)).toBeLessThanOrEqual(
      geometry.viewport + 1,
    );
    expect(geometry.dialogScroll).toBeLessThanOrEqual(
      geometry.dialogClient + 1,
    );
    expect(geometry.bannerScroll).toBeLessThanOrEqual(
      geometry.bannerClient + 1,
    );
    expect(state.driftBodies).toEqual([{ html: CRITICAL_HTML }]);
    expect(state.unexpectedApiCalls).toEqual([]);
  });
});

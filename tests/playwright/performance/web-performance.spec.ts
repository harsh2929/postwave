import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

type ProfileName = "desktop" | "mobile";
type ProfileLimits = {
  cpuSlowdown: number;
  maxNavigationClickEventMs: number;
  maxLongTaskTotalMs: number;
  maxHeapMiB: number;
  maxHeapGrowthMiB: number;
  maxDomNodes: number;
};
type PerformanceBudgets = {
  schemaVersion: number;
  publicRoutes: string[];
  browser: {
    navigationCycles: number;
    desktop: ProfileLimits;
    mobile: ProfileLimits;
  };
};

const workspaceRoot = path.resolve(__dirname, "../../..");
const budgetPath = path.join(
  workspaceRoot,
  "apps/web/performance-budgets.json",
);
const evidencePath = path.join(
  workspaceRoot,
  ".lighthouseci/browser/user-centric-performance.json",
);
const budgets = JSON.parse(
  fs.readFileSync(budgetPath, "utf8"),
) as PerformanceBudgets;

declare global {
  interface Window {
    __postwaveLongTasks?: { total: number; maximum: number };
    __postwaveEventTimingAvailable?: boolean;
    __postwaveDocumentNonce?: string;
    __postwaveClickObservation?: {
      documentNonce: string;
      startedAt: number;
      token: string;
    };
    __postwavePerformanceObservers?: PerformanceObserver[];
    __postwaveNavigationClicks?: Array<{
      duration: number | null;
      inputDelay: number | null;
      interactionId: number | null;
      observationToken: string;
      presentationDelay: number | null;
      processingDuration: number | null;
      reported: boolean;
      sameDocument: boolean;
      startTime: number | null;
      upperBoundMs: number | null;
    }>;
  }
}

async function settlePage(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts?.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await page.waitForTimeout(250);
}

const LINK_FOR_ROUTE: Record<string, string> = {
  "/": "/",
  "/pricing": "/pricing",
  "/docs/getting-started": "/docs/getting-started",
  "/status": "/status",
  "/login": "/login",
};

async function resetLongTasks(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (!window.__postwaveLongTasks) {
      throw new Error("Long Tasks observer was unavailable before navigation");
    }
    window.__postwaveLongTasks = { total: 0, maximum: 0 };
  });
}

type ClickObservation = {
  documentNonce: string;
  token: string;
};

async function beginTrustedClickObservation(
  page: Page,
): Promise<ClickObservation> {
  return page.evaluate(() => {
    if (!window.__postwaveEventTimingAvailable) {
      throw new Error("Event Timing API was unavailable before trusted click");
    }
    const documentNonce = window.__postwaveDocumentNonce;
    if (!documentNonce) {
      throw new Error(
        "init-script document nonce was unavailable before click",
      );
    }
    const token = crypto.randomUUID();
    window.__postwaveNavigationClicks = [];
    window.__postwaveClickObservation = {
      documentNonce,
      startedAt: performance.now(),
      token,
    };
    return { documentNonce, token };
  });
}

async function navigateInApp(
  page: Page,
  route: string,
): Promise<ClickObservation> {
  // The public header intentionally links to the docs hub. Use that real
  // navigation first, then exercise the hub's visible Get started link so the
  // measured click lands on the exact canonical route in the budget matrix.
  if (
    route === "/docs/getting-started" &&
    !(await page
      .locator('a[href="/docs/getting-started"]:visible')
      .first()
      .isVisible())
  ) {
    const docsHub = page.locator('a[href="/docs"]:visible').first();
    await expect(docsHub, "visible link to the docs hub").toBeVisible();
    const hubObservation = await beginTrustedClickObservation(page);
    await Promise.all([
      page.waitForURL((url) => url.pathname === "/docs"),
      docsHub.click(),
    ]);
    await page.waitForLoadState("domcontentloaded");
    await settlePage(page);
    await readNavigationClickTiming(page, hubObservation);
  }

  // Docs exposes sign-in directly at desktop widths. On a phone its compact
  // header keeps only the home brand visible, so follow that real link and use
  // the marketing mobile menu instead of falling back to a document reload.
  if (
    route === "/login" &&
    new URL(page.url()).pathname.startsWith("/docs/") &&
    !(await page.locator('a[href="/login"]:visible').first().isVisible())
  ) {
    const home = page.locator('a[href="/"]:visible').first();
    await expect(
      home,
      "visible docs link back to the public site",
    ).toBeVisible();
    const homeObservation = await beginTrustedClickObservation(page);
    await Promise.all([
      page.waitForURL((url) => url.pathname === "/"),
      home.click(),
    ]);
    await page.waitForLoadState("domcontentloaded");
    await settlePage(page);
    await readNavigationClickTiming(page, homeObservation);
  }

  const href = LINK_FOR_ROUTE[route];
  if (!href) throw new Error(`No user navigation contract for ${route}`);
  let link = page.locator(`a[href="${href}"]:visible`).first();
  if (route === "/login" && !(await link.isVisible())) {
    const openNavigation = page.getByRole("button", {
      name: "Open navigation",
    });
    await expect(
      openNavigation,
      "marketing mobile navigation trigger",
    ).toBeVisible();
    const menuObservation = await beginTrustedClickObservation(page);
    await openNavigation.click();
    await readNavigationClickTiming(page, menuObservation);
    link = page.locator(`a[href="${href}"]:visible`).first();
  }
  await expect(link, `visible in-app link to ${route}`).toBeVisible();
  await resetLongTasks(page);
  const observation = await beginTrustedClickObservation(page);
  await Promise.all([
    page.waitForURL((url) => url.pathname === route),
    link.click(),
  ]);
  await page.waitForLoadState("domcontentloaded");
  return observation;
}

type NavigationClickTiming = NonNullable<
  Window["__postwaveNavigationClicks"]
>[number];
type InteractionPerformanceEventTiming = PerformanceEventTiming & {
  interactionId: number;
};
const EVENT_TIMING_REPORTING_FLOOR_MS = 16;

async function readNavigationClickTiming(
  page: Page,
  observation: ClickObservation,
): Promise<NavigationClickTiming> {
  await page.waitForTimeout(100);
  const state = await page.evaluate((expected) => {
    const active = window.__postwaveClickObservation;
    const timing = window.__postwaveNavigationClicks
      ?.filter((entry) => entry.observationToken === expected.token)
      .at(-1);
    const result = {
      active,
      available: window.__postwaveEventTimingAvailable === true,
      documentNonce: window.__postwaveDocumentNonce,
      timing,
    };
    delete window.__postwaveClickObservation;
    window.__postwaveNavigationClicks = [];
    return result;
  }, observation);
  if (!state.available) {
    throw new Error("Event Timing API became unavailable after navigation");
  }
  if (
    state.documentNonce !== observation.documentNonce ||
    state.active?.documentNonce !== observation.documentNonce
  ) {
    throw new Error(
      "init-script document nonce changed across trusted click; refusing hard-navigation timing",
    );
  }
  if (state.active?.token !== observation.token) {
    throw new Error("trusted click observation token was reset or replaced");
  }
  const timing = state.timing ?? {
    // Chromium's minimum `event` reporting bucket is 16 ms. When a trusted
    // click changed the URL but produced no entry after paint, the honest
    // result is an upper bound, not a fabricated point measurement.
    duration: null,
    inputDelay: null,
    interactionId: null,
    observationToken: observation.token,
    presentationDelay: null,
    processingDuration: null,
    reported: false,
    sameDocument: true,
    startTime: null,
    upperBoundMs: EVENT_TIMING_REPORTING_FLOOR_MS,
  };
  if (
    (timing.reported &&
      (timing.duration === null ||
        !Number.isFinite(timing.duration) ||
        timing.duration < 0)) ||
    (!timing.reported &&
      timing.upperBoundMs !== EVENT_TIMING_REPORTING_FLOOR_MS) ||
    (timing.reported &&
      (timing.interactionId === null || timing.interactionId <= 0)) ||
    timing.observationToken !== observation.token ||
    timing.sameDocument !== true
  ) {
    throw new Error("trusted navigation click produced no valid Event Timing");
  }
  return timing;
}

function writeEvidence(profile: ProfileName, evidence: unknown): void {
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(evidencePath)) {
    existing = JSON.parse(fs.readFileSync(evidencePath, "utf8")) as Record<
      string,
      unknown
    >;
  }
  existing.schemaVersion = 1;
  existing.generatedAt = new Date().toISOString();
  existing[profile] = evidence;
  fs.writeFileSync(evidencePath, `${JSON.stringify(existing, null, 2)}\n`);
}

test("public journey stays responsive and memory-bounded", async ({
  page,
  context,
}, testInfo) => {
  const profile: ProfileName = testInfo.project.name.includes("mobile")
    ? "mobile"
    : "desktop";
  const limits = budgets.browser[profile];
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("Emulation.setCPUThrottlingRate", {
    rate: limits.cpuSlowdown,
  });
  await page.addInitScript(() => {
    window.__postwaveDocumentNonce = crypto.randomUUID();
    delete window.__postwaveLongTasks;
    delete window.__postwaveClickObservation;
    window.__postwaveEventTimingAvailable = false;
    window.__postwaveNavigationClicks = [];
    window.__postwavePerformanceObservers = [];
    if (typeof PerformanceObserver !== "function") return;
    try {
      const longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const blocking = Math.max(0, entry.duration - 50);
          if (!window.__postwaveLongTasks) continue;
          window.__postwaveLongTasks.total += blocking;
          window.__postwaveLongTasks.maximum = Math.max(
            window.__postwaveLongTasks.maximum,
            entry.duration,
          );
        }
      });
      longTaskObserver.observe({ type: "longtask", buffered: true });
      window.__postwavePerformanceObservers.push(longTaskObserver);
      window.__postwaveLongTasks = { total: 0, maximum: 0 };
    } catch {
      // The assertion below treats an absent observer result as a hard failure.
    }
    try {
      if (!PerformanceObserver.supportedEntryTypes.includes("event")) return;
      const eventObserver = new PerformanceObserver((list) => {
        for (const rawEntry of list.getEntries()) {
          const entry = rawEntry as InteractionPerformanceEventTiming;
          if (entry.name !== "click" || entry.interactionId <= 0) continue;
          const observation = window.__postwaveClickObservation;
          if (!observation || entry.startTime < observation.startedAt) continue;
          window.__postwaveNavigationClicks?.push({
            duration: entry.duration,
            inputDelay: Math.max(0, entry.processingStart - entry.startTime),
            interactionId: entry.interactionId,
            observationToken: observation.token,
            presentationDelay: Math.max(
              0,
              entry.duration - (entry.processingEnd - entry.startTime),
            ),
            processingDuration: Math.max(
              0,
              entry.processingEnd - entry.processingStart,
            ),
            reported: true,
            sameDocument:
              window.__postwaveDocumentNonce === observation.documentNonce,
            startTime: entry.startTime,
            upperBoundMs: null,
          });
        }
      });
      eventObserver.observe({
        type: "event",
        buffered: true,
        // Chromium rounds Event Timing to 8 ms and treats 0 as the request to
        // report its minimum observable 16 ms bucket. Passing 16 suppresses
        // those fast-but-valid navigation clicks entirely.
        durationThreshold: 0,
      } as PerformanceObserverInit & { durationThreshold: number });
      window.__postwavePerformanceObservers.push(eventObserver);
      window.__postwaveEventTimingAvailable = true;
    } catch {
      // A missing Event Timing sample is a hard failure below.
    }
  });

  const samples: Array<{
    cycle: number;
    route: string;
    navigationClick: NavigationClickTiming | null;
    longTaskTotalMs: number;
    maxLongTaskMs: number;
    heapMiB: number;
    domNodes: number;
  }> = [];
  let initialNavigation = true;

  for (let cycle = 1; cycle <= budgets.browser.navigationCycles; cycle += 1) {
    for (const route of budgets.publicRoutes) {
      let navigatedByClick = true;
      let clickObservation: ClickObservation | null = null;
      if (initialNavigation) {
        await page.goto(route, { waitUntil: "load" });
        initialNavigation = false;
        navigatedByClick = false;
      } else {
        clickObservation = await navigateInApp(page, route);
      }
      await settlePage(page);
      let navigationClick: NavigationClickTiming | null = null;
      if (navigatedByClick) {
        if (!clickObservation) {
          throw new Error("trusted navigation produced no click observation");
        }
        navigationClick = await readNavigationClickTiming(
          page,
          clickObservation,
        );
      }
      const pageMetrics = await page.evaluate(() => ({
        domNodes: document.getElementsByTagName("*").length,
        longTasks: window.__postwaveLongTasks ?? null,
      }));
      if (!pageMetrics.longTasks) {
        throw new Error(
          "Long Tasks API was unavailable; refusing a partial pass",
        );
      }
      await cdp.send("HeapProfiler.collectGarbage");
      const performance = await cdp.send("Performance.getMetrics");
      const heapBytes = performance.metrics.find(
        (metric) => metric.name === "JSHeapUsedSize",
      )?.value;
      if (typeof heapBytes !== "number" || !Number.isFinite(heapBytes)) {
        throw new Error("Chrome did not expose JSHeapUsedSize");
      }
      const sample = {
        cycle,
        route,
        navigationClick,
        longTaskTotalMs: pageMetrics.longTasks.total,
        maxLongTaskMs: pageMetrics.longTasks.maximum,
        heapMiB: heapBytes / 1024 / 1024,
        domNodes: pageMetrics.domNodes,
      };
      samples.push(sample);

      if (sample.navigationClick) {
        const boundedEventMs = sample.navigationClick.reported
          ? sample.navigationClick.duration
          : sample.navigationClick.upperBoundMs;
        if (boundedEventMs === null) {
          throw new Error("navigation-click Event Timing had no usable bound");
        }
        expect(
          boundedEventMs,
          `${profile} ${route} trusted navigation-click Event Timing`,
        ).toBeLessThanOrEqual(limits.maxNavigationClickEventMs);
      }
      expect(
        sample.longTaskTotalMs,
        `${profile} ${route} total blocking portion of long tasks`,
      ).toBeLessThanOrEqual(limits.maxLongTaskTotalMs);
      expect(sample.heapMiB, `${profile} ${route} JS heap`).toBeLessThanOrEqual(
        limits.maxHeapMiB,
      );
      expect(
        sample.domNodes,
        `${profile} ${route} DOM nodes`,
      ).toBeLessThanOrEqual(limits.maxDomNodes);
    }
  }

  for (const route of budgets.publicRoutes) {
    expect(
      samples.some(
        (sample) => sample.route === route && sample.navigationClick,
      ),
      `${profile} ${route} must have a trusted navigation-click Event Timing sample`,
    ).toBe(true);
  }

  const firstFinalRoute = samples.find(
    (sample) =>
      sample.cycle === 1 &&
      sample.route === budgets.publicRoutes[budgets.publicRoutes.length - 1],
  );
  const finalSample = samples.at(-1);
  if (!firstFinalRoute || !finalSample) {
    throw new Error("memory journey produced incomplete samples");
  }
  const heapGrowthMiB = Math.max(
    0,
    finalSample.heapMiB - firstFinalRoute.heapMiB,
  );
  expect(
    heapGrowthMiB,
    `${profile} repeated-journey JS heap growth`,
  ).toBeLessThanOrEqual(limits.maxHeapGrowthMiB);

  writeEvidence(profile, {
    source:
      "same-context trusted Next link clicks with PerformanceEventTiming; Chromium CDP Performance.getMetrics after forced GC",
    interactionScope:
      "Navigation clicks only; this is not visit-wide INP or representative task INP certification.",
    cpuSlowdown: limits.cpuSlowdown,
    navigationCycles: budgets.browser.navigationCycles,
    heapGrowthMiB: Number(heapGrowthMiB.toFixed(2)),
    samples: samples.map((sample) => ({
      ...sample,
      navigationClick: sample.navigationClick
        ? {
            ...sample.navigationClick,
            duration:
              sample.navigationClick.duration === null
                ? null
                : Number(sample.navigationClick.duration.toFixed(1)),
            inputDelay:
              sample.navigationClick.inputDelay === null
                ? null
                : Number(sample.navigationClick.inputDelay.toFixed(1)),
            presentationDelay:
              sample.navigationClick.presentationDelay === null
                ? null
                : Number(sample.navigationClick.presentationDelay.toFixed(1)),
            processingDuration:
              sample.navigationClick.processingDuration === null
                ? null
                : Number(sample.navigationClick.processingDuration.toFixed(1)),
            upperBoundMs:
              sample.navigationClick.upperBoundMs === null
                ? null
                : Number(sample.navigationClick.upperBoundMs.toFixed(1)),
          }
        : null,
      longTaskTotalMs: Number(sample.longTaskTotalMs.toFixed(1)),
      maxLongTaskMs: Number(sample.maxLongTaskMs.toFixed(1)),
      heapMiB: Number(sample.heapMiB.toFixed(2)),
    })),
  });
});

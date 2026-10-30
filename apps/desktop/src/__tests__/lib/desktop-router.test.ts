import { describe, expect, it, vi } from "vitest";

import { PERSISTENT_DESKTOP_SECTIONS } from "../../lib/desktop-routes";
import { mapDeepLinkToPath } from "../../lib/dashboard-url";
import {
  DesktopRouterController,
  type DesktopRouterEnvironment,
  desktopRouteIdentityScope,
  parseDesktopRoute,
  persistentDesktopRouteCount,
  routeForDesktopSection,
  serializeDesktopRoute,
  settingsAnchorFromHeading,
} from "../../lib/desktop-router";

interface FakeEntry {
  url: string;
  state: unknown;
}

class FakeRouterEnvironment implements DesktopRouterEnvironment {
  readonly storage: Map<string, string>;
  readonly entries: FakeEntry[];
  index = 0;
  pushes = 0;
  replaces = 0;
  goBehavior: "normal" | "deferred-pop" | "no-pop" | "no-op" = "normal";
  readonly deferredIndexes: number[] = [];
  readonly #popHandlers = new Set<(state: unknown) => void>();

  constructor(
    url = "/app/dashboard",
    state: unknown = null,
    storage = new Map<string, string>(),
  ) {
    this.entries = [{ url, state }];
    this.storage = storage;
  }

  location = (): string => this.entries[this.index]?.url ?? "/app/dashboard";

  historyState = (): unknown => this.entries[this.index]?.state ?? null;

  pushState = (state: unknown, url: string): void => {
    this.entries.splice(this.index + 1);
    this.entries.push({ state, url });
    this.index = this.entries.length - 1;
    this.pushes += 1;
  };

  replaceState = (state: unknown, url: string): void => {
    this.entries[this.index] = { state, url };
    this.replaces += 1;
  };

  go = (delta: number): void => {
    if (this.goBehavior === "no-op") return;
    const next = this.index + delta;
    if (next < 0 || next >= this.entries.length || next === this.index) return;
    if (this.goBehavior === "deferred-pop") {
      this.deferredIndexes.push(next);
      return;
    }
    this.index = next;
    if (this.goBehavior === "no-pop") return;
    for (const handler of this.#popHandlers) handler(this.historyState());
  };

  flushDeferredPop(): void {
    const next = this.deferredIndexes.shift();
    if (next === undefined || next < 0 || next >= this.entries.length) return;
    this.index = next;
    for (const handler of this.#popHandlers) handler(this.historyState());
  }

  subscribePopState = (handler: (state: unknown) => void): (() => void) => {
    this.#popHandlers.add(handler);
    return () => this.#popHandlers.delete(handler);
  };

  getStorage = (key: string): string | null => this.storage.get(key) ?? null;

  setStorage = (key: string, value: string): void => {
    this.storage.set(key, value);
  };

  removeStorage = (key: string): void => {
    this.storage.delete(key);
  };

  back(): void {
    if (this.index === 0) return;
    this.index -= 1;
    for (const handler of this.#popHandlers) handler(this.historyState());
  }

  forward(): void {
    if (this.index >= this.entries.length - 1) return;
    this.index += 1;
    for (const handler of this.#popHandlers) handler(this.historyState());
  }
}

describe("desktop route codec", () => {
  it("round-trips every one of the 54 persistent destinations uniquely", () => {
    expect(persistentDesktopRouteCount()).toBe(54);
    expect(new Set(PERSISTENT_DESKTOP_SECTIONS).size).toBe(54);

    const urls = new Set<string>();
    for (const section of PERSISTENT_DESKTOP_SECTIONS) {
      const url = serializeDesktopRoute({ section });
      const parsed = parseDesktopRoute(url);
      expect(parsed, section).toMatchObject({
        ok: true,
        route: { section },
        canonicalUrl: url,
        redirected: false,
      });
      urls.add(url);
    }
    expect(urls.size).toBe(54);
  });

  it("canonicalizes resource, tab, query, sort, filters and overlay", () => {
    const url = serializeDesktopRoute({
      section: "campaigns",
      resourceId: "campaign_42",
      tab: "report",
      query: "high intent",
      sort: { field: "created-at", direction: "desc" },
      filters: [
        { key: "status", value: "active" },
        { key: "channel", value: "email" },
      ],
      overlay: { name: "compare", resourceId: "campaign_41" },
    });

    expect(url).toBe(
      "/app/campaigns/campaign_42?tab=report&q=high+intent&sort=created-at&dir=desc&f.channel=email&f.status=active&overlay=compare&overlayId=campaign_41",
    );
    expect(parseDesktopRoute(url)).toEqual({
      ok: true,
      route: {
        section: "campaigns",
        resourceId: "campaign_42",
        tab: "report",
        query: "high intent",
        sort: { field: "created-at", direction: "desc" },
        filters: [
          { key: "channel", value: "email" },
          { key: "status", value: "active" },
        ],
        overlay: { name: "compare", resourceId: "campaign_41" },
      },
      canonicalUrl: url,
      redirected: false,
    });
  });

  it("supports a strict Settings anchor only on Settings", () => {
    const url = serializeDesktopRoute({
      section: "settings",
      settingsAnchor: "desktop-updates",
    });
    expect(url).toBe("/app/settings?anchor=desktop-updates");
    expect(parseDesktopRoute(url)).toMatchObject({
      ok: true,
      route: { section: "settings", settingsAnchor: "desktop-updates" },
    });
    expect(parseDesktopRoute("/app/dashboard?anchor=desktop-updates")).toEqual({
      ok: false,
      reason: "invalid-parameter",
    });
    expect(settingsAnchorFromHeading("Custom Fields Governance")).toBe(
      "custom-fields-governance",
    );
    expect(settingsAnchorFromHeading("Keyboard shortcuts")).toBe(
      "keyboard-shortcuts",
    );
    expect(settingsAnchorFromHeading("Not a real section")).toBeNull();
  });

  it("converges supported legacy and native-link paths on canonical routes", () => {
    expect(parseDesktopRoute("/Automations")).toMatchObject({
      ok: true,
      route: { section: "automations" },
      canonicalUrl: "/app/automations",
      redirected: true,
    });
    expect(parseDesktopRoute("/app/outbound-webhooks")).toMatchObject({
      ok: true,
      route: { section: "webhooks", tab: "outbound" },
      canonicalUrl: "/app/webhooks?tab=outbound",
    });
    expect(parseDesktopRoute("/app/hipaa")).toMatchObject({
      ok: true,
      route: { section: "compliance", tab: "hipaa" },
    });
    expect(
      parseDesktopRoute("/app/subscribers?email=person%2Bnews%40example.com"),
    ).toMatchObject({
      ok: true,
      route: {
        section: "subscribers",
        resourceId: "person+news@example.com",
      },
      canonicalUrl: "/app/subscribers/person%2Bnews%40example.com",
    });
    expect(routeForDesktopSection("outboundWebhooks")).toEqual({
      section: "webhooks",
      tab: "outbound",
    });
    expect(routeForDesktopSection("hipaa")).toEqual({
      section: "compliance",
      tab: "hipaa",
    });
    expect(
      parseDesktopRoute(
        "https://app.moosewave.com/#analytics?metric=opens&range=7d&focus=velocity",
      ),
    ).toMatchObject({
      ok: true,
      route: {
        section: "analytics",
        filters: [
          { key: "focus", value: "velocity" },
          { key: "metric", value: "opens" },
          { key: "range", value: "7d" },
        ],
      },
      redirected: true,
    });
  });

  it.each([
    ["moosewave://approval/approval_7", "approvals", "approval_7"],
    ["moosewave://campaign/campaign_7", "campaigns", "campaign_7"],
    ["moosewave://sequence/sequence_7", "sequences", "sequence_7"],
    [
      "moosewave://subscriber/person%40example.com",
      "subscribers",
      "person@example.com",
    ],
    ["moosewave://settings", "settings", undefined],
  ] as const)(
    "maps native intent %s through the same typed codec",
    (deepLink, section, resourceId) => {
      const path = mapDeepLinkToPath(deepLink);
      expect(path).not.toBeNull();
      const parsed = parseDesktopRoute(path!);
      expect(parsed).toMatchObject({
        ok: true,
        route: {
          section,
          ...(resourceId ? { resourceId } : {}),
        },
      });
    },
  );

  it.each([
    ["/app/not-real", "unknown-destination"],
    ["/app/campaigns/id/extra", "invalid-path"],
    ["/app/campaigns/%252e%252e", "invalid-path"],
    ["/app/campaigns/%2e%2e", "invalid-path"],
    ["/app/campaigns/id?next=settings", "unknown-parameter"],
    ["/app/campaigns?id=one&id=two", "unknown-parameter"],
    ["/app/campaigns?tab=one&tab=two", "duplicate-parameter"],
    ["/app/campaigns?dir=desc", "invalid-parameter"],
    ["/app/campaigns?sort=created&dir=sideways", "invalid-parameter"],
    ["/app/campaigns?overlayId=one", "invalid-parameter"],
    ["/app/campaigns?q=%0Asecret", "invalid-parameter"],
    ["javascript:alert(1)", "invalid-url"],
    ["https://user:secret@example.com/app/audit", "invalid-url"],
  ])("rejects malformed or ambiguous route %s", (url, reason) => {
    expect(parseDesktopRoute(url)).toEqual({ ok: false, reason });
  });

  it("bounds filter count and total route size", () => {
    const tooMany = new URLSearchParams();
    for (let index = 0; index < 17; index += 1) {
      tooMany.set(`f.filter-${index}`, String(index));
    }
    expect(parseDesktopRoute(`/app/audit?${tooMany.toString()}`)).toEqual({
      ok: false,
      reason: "too-many-filters",
    });
    expect(parseDesktopRoute(`/app/audit?q=${"a".repeat(5000)}`)).toEqual({
      ok: false,
      reason: "route-too-long",
    });
  });
});

describe("desktop history controller", () => {
  it("derives stable opaque scopes without storing raw identity labels", () => {
    const first = desktopRouteIdentityScope("user@example.com", "tenant-a");
    expect(first).toMatch(/^[a-f0-9]{16}$/u);
    expect(first).toBe(
      desktopRouteIdentityScope("user@example.com", "tenant-a"),
    );
    expect(first).not.toBe(
      desktopRouteIdentityScope("user@example.com", "tenant-b"),
    );
    expect(first).not.toContain("user");
    expect(desktopRouteIdentityScope(null, "tenant-a")).toBeNull();
  });

  it("restores exact resource state and scroll through Back and Forward", () => {
    const environment = new FakeRouterEnvironment(
      "/app/campaigns/campaign_1?tab=report&f.status=sent",
    );
    const router = new DesktopRouterController(environment);
    router.setIdentity("user-a", "tenant-a");
    router.recordScroll(640);
    router.navigate({
      section: "settings",
      settingsAnchor: "api-keys",
    });
    router.recordScroll(90);

    environment.back();
    expect(router.getSnapshot()).toMatchObject({
      route: {
        section: "campaigns",
        resourceId: "campaign_1",
        tab: "report",
        filters: [{ key: "status", value: "sent" }],
      },
      source: "history",
      restoreScrollTop: 640,
    });

    environment.forward();
    expect(router.getSnapshot()).toMatchObject({
      route: { section: "settings", settingsAnchor: "api-keys" },
      source: "history",
      restoreScrollTop: 90,
    });
    expect(environment.pushes).toBe(1);
  });

  it("stores and restores only a safe destination when an app reopens", () => {
    const storage = new Map<string, string>();
    const firstEnvironment = new FakeRouterEnvironment(
      "/app/dashboard",
      null,
      storage,
    );
    const first = new DesktopRouterController(firstEnvironment);
    first.setIdentity("user-a", "tenant-a");
    first.navigate({
      section: "audit",
      query: "delivery failed",
      sort: { field: "occurred-at", direction: "desc" },
      filters: [{ key: "severity", value: "high" }],
      overlay: { name: "event", resourceId: "evt_17" },
    });
    first.recordScroll(777);

    const atRest = [...storage.values()].join("\n");
    expect(atRest).toContain('"section":"audit"');
    expect(atRest).not.toMatch(
      /delivery failed|occurred-at|severity|high|event|evt_17|canonicalUrl|scrollTop/u,
    );

    const reopenedEnvironment = new FakeRouterEnvironment(
      "/app/dashboard",
      null,
      storage,
    );
    const reopened = new DesktopRouterController(reopenedEnvironment);
    reopened.setIdentity("user-a", "tenant-a");
    expect(reopened.getSnapshot().route).toEqual({ section: "audit" });
    expect(reopened.getSnapshot().source).toBe("identity");
    expect(reopened.getSnapshot().restoreScrollTop).toBe(0);
  });

  it("purges exact legacy and malformed route records without adoption", () => {
    const scope = desktopRouteIdentityScope("user-a", "tenant-a")!;
    const key = `postwave.desktop.route.v1:${scope}`;
    for (const unsafe of [
      "/app/subscribers/person%40example.com?q=secret",
      JSON.stringify({
        canonicalUrl: "/app/campaigns/customer-id?q=private",
        scrollTop: 42,
      }),
      "not-json",
    ]) {
      const storage = new Map([[key, unsafe]]);
      const router = new DesktopRouterController(
        new FakeRouterEnvironment("/app/dashboard", null, storage),
      );
      router.setIdentity("user-a", "tenant-a");
      expect(router.getSnapshot().route).toEqual({ section: "dashboard" });
      expect([...storage.values()].join("\n")).not.toContain("private");
      expect([...storage.values()].join("\n")).not.toContain("example.com");
    }
  });

  it("expires a stale destination record instead of reviving old context", () => {
    const scope = desktopRouteIdentityScope("user-a", "tenant-a")!;
    const key = `postwave.desktop.route.v1:${scope}`;
    const storage = new Map([
      [
        key,
        JSON.stringify({
          version: 2,
          section: "campaigns",
          savedAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
        }),
      ],
    ]);
    const router = new DesktopRouterController(
      new FakeRouterEnvironment("/app/dashboard", null, storage),
    );

    router.setIdentity("user-a", "tenant-a");

    expect(router.getSnapshot().route).toEqual({ section: "dashboard" });
    expect([...storage.values()].join("\n")).not.toContain("campaigns");
  });

  it("never restores one identity's task into another identity", () => {
    const environment = new FakeRouterEnvironment();
    const router = new DesktopRouterController(environment);
    router.setIdentity("user-a", "tenant-a");
    router.navigate({ section: "approvals", resourceId: "approval-a" });

    router.setIdentity("user-b", "tenant-b");
    expect(router.getSnapshot().route).toEqual({ section: "dashboard" });
    expect(environment.location()).not.toContain("approval-a");

    router.navigate({ section: "lists", resourceId: "list-b" });
    router.setIdentity("user-a", "tenant-a");
    expect(router.getSnapshot().route).toEqual({
      section: "approvals",
      resourceId: "approval-a",
    });
    expect(environment.location()).not.toContain("list-b");
  });

  it("adopts an explicit deep link for the identity without extra pushes", () => {
    const environment = new FakeRouterEnvironment();
    const router = new DesktopRouterController(environment);
    router.navigate(
      { section: "sequences", resourceId: "sequence_9", tab: "runs" },
      { source: "deep-link" },
    );
    const pushes = environment.pushes;
    router.setIdentity("user-a", "tenant-a");

    expect(router.getSnapshot().route).toEqual({
      section: "sequences",
      resourceId: "sequence_9",
      tab: "runs",
    });
    expect(environment.pushes).toBe(pushes);
  });

  it("re-emits a repeated deep link without duplicating browser history", () => {
    const environment = new FakeRouterEnvironment();
    const router = new DesktopRouterController(environment);
    const intent = { section: "campaigns", resourceId: "campaign_9" } as const;
    router.navigate(intent, { source: "deep-link" });
    const first = router.getSnapshot();
    const pushes = environment.pushes;

    router.navigate(intent, { source: "deep-link" });

    expect(router.getSnapshot().revision).toBe(first.revision + 1);
    expect(router.getSnapshot().source).toBe("deep-link");
    expect(environment.pushes).toBe(pushes);
    expect(environment.location()).toBe("/app/campaigns/campaign_9");
  });

  it("uses one pre-reviewed Back for a locally pushed drawer without re-running the history guard", async () => {
    const environment = new FakeRouterEnvironment();
    const router = new DesktopRouterController(environment);
    router.navigate({ section: "subscribers" });
    router.recordScroll(384);
    router.navigate({
      section: "subscribers",
      overlay: { name: "subscriber-detail", resourceId: "subscriber-42" },
    });
    const request = vi.fn();
    router.setHistoryTransitionGuard({
      shouldIntercept: (transition) => Boolean(transition.from.overlay),
      request,
    });

    await expect(
      router.navigateApprovedBackTo({ section: "subscribers" }),
    ).resolves.toBe("applied");

    expect(router.getSnapshot()).toMatchObject({
      route: { section: "subscribers" },
      source: "history",
      restoreScrollTop: 384,
    });
    expect(environment.location()).toBe("/app/subscribers");
    expect(environment.entries).toHaveLength(3);
    expect(request).not.toHaveBeenCalled();

    environment.forward();
    expect(router.getSnapshot().route).toEqual({
      section: "subscribers",
      overlay: { name: "subscriber-detail", resourceId: "subscriber-42" },
    });
  });

  it("rejects an unexpected previous entry and restores the protected drawer", async () => {
    const environment = new FakeRouterEnvironment();
    const router = new DesktopRouterController(environment);
    router.navigate({ section: "subscribers" });
    router.navigate({
      section: "subscribers",
      overlay: { name: "subscriber-detail", resourceId: "subscriber-42" },
    });

    await expect(
      router.navigateApprovedBackTo({ section: "dashboard" }),
    ).resolves.toBe("failed");

    expect(router.getSnapshot()).toMatchObject({
      route: {
        section: "subscribers",
        overlay: {
          name: "subscriber-detail",
          resourceId: "subscriber-42",
        },
      },
      source: "history",
    });
    expect(environment.location()).toContain("overlay=subscriber-detail");
    expect(environment.index).toBe(2);
  });

  it("restores a newer route when it supersedes approved Back without a caller guard", async () => {
    const environment = new FakeRouterEnvironment();
    const router = new DesktopRouterController(environment);
    router.navigate({ section: "subscribers" });
    router.navigate({
      section: "subscribers",
      overlay: { name: "subscriber-detail", resourceId: "subscriber-42" },
    });
    environment.goBehavior = "deferred-pop";
    const result = router.navigateApprovedBackTo({ section: "subscribers" });
    router.navigate({ section: "settings", settingsAnchor: "api-keys" });

    environment.flushDeferredPop();
    expect(router.getSnapshot().route).toEqual({
      section: "settings",
      settingsAnchor: "api-keys",
    });
    environment.flushDeferredPop();

    await expect(result).resolves.toBe("superseded");
    expect(router.getSnapshot().route).toEqual({
      section: "settings",
      settingsAnchor: "api-keys",
    });
    expect(environment.location()).toBe("/app/settings?anchor=api-keys");
  });

  it("restores the new identity route without relying on a caller guard", async () => {
    const environment = new FakeRouterEnvironment();
    const router = new DesktopRouterController(environment);
    router.setIdentity("user-a", "tenant-a");
    router.navigate({ section: "subscribers" });
    router.navigate({
      section: "subscribers",
      overlay: { name: "subscriber-detail", resourceId: "subscriber-42" },
    });
    environment.goBehavior = "deferred-pop";
    const result = router.navigateApprovedBackTo({ section: "subscribers" });
    router.setIdentity("user-b", "tenant-b");

    environment.flushDeferredPop();
    expect(router.getSnapshot().route).toEqual({ section: "dashboard" });
    environment.flushDeferredPop();

    await expect(result).resolves.toBe("superseded");
    expect(router.getSnapshot().route).toEqual({ section: "dashboard" });
    expect(environment.location()).toBe("/app/dashboard");
  });

  it("quarantines a late pop after timeout and preserves a newer route", async () => {
    vi.useFakeTimers();
    try {
      const environment = new FakeRouterEnvironment();
      const router = new DesktopRouterController(environment);
      router.navigate({ section: "subscribers" });
      router.navigate({
        section: "subscribers",
        overlay: {
          name: "subscriber-detail",
          resourceId: "subscriber-42",
        },
      });
      environment.goBehavior = "deferred-pop";

      const result = router.navigateApprovedBackTo(
        { section: "subscribers" },
        { timeoutMs: 25 },
      );
      await vi.advanceTimersByTimeAsync(25);
      await expect(result).resolves.toBe("failed");

      router.navigate({ section: "settings", settingsAnchor: "api-keys" });
      environment.flushDeferredPop();
      expect(router.getSnapshot().route).toEqual({
        section: "settings",
        settingsAnchor: "api-keys",
      });
      environment.flushDeferredPop();

      expect(router.getSnapshot().route).toEqual({
        section: "settings",
        settingsAnchor: "api-keys",
      });
      expect(environment.location()).toBe("/app/settings?anchor=api-keys");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects Back immediately when no prior indexed entry exists", async () => {
    const environment = new FakeRouterEnvironment("/app/subscribers");
    const router = new DesktopRouterController(environment);

    await expect(
      router.navigateApprovedBackTo({ section: "dashboard" }),
    ).resolves.toBe("failed");
    expect(router.getSnapshot().route).toEqual({ section: "subscribers" });
    expect(environment.index).toBe(0);
  });

  it.each(["no-pop", "no-op"] as const)(
    "rejects a %s history implementation after a bounded wait without losing the protected drawer",
    async (goBehavior) => {
      vi.useFakeTimers();
      try {
        const environment = new FakeRouterEnvironment();
        const router = new DesktopRouterController(environment);
        router.navigate({ section: "subscribers" });
        router.navigate({
          section: "subscribers",
          overlay: {
            name: "subscriber-detail",
            resourceId: "subscriber-42",
          },
        });
        environment.goBehavior = goBehavior;

        const result = router.navigateApprovedBackTo(
          { section: "subscribers" },
          { timeoutMs: 25 },
        );
        await vi.advanceTimersByTimeAsync(25);

        await expect(result).resolves.toBe("failed");
        expect(router.getSnapshot().route).toEqual({
          section: "subscribers",
          overlay: {
            name: "subscriber-detail",
            resourceId: "subscriber-42",
          },
        });
        expect(environment.location()).toContain("overlay=subscriber-detail");
        expect(environment.index).toBe(2);
        expect(environment.historyState()).toMatchObject({ index: 2 });

        // A traversal that may still arrive is restored once. A silent move
        // that was already observed can release ownership immediately.
        environment.goBehavior = "normal";
        environment.back();
        if (goBehavior === "no-op") {
          expect(environment.index).toBe(2);
          expect(router.getSnapshot().route).toEqual({
            section: "subscribers",
            overlay: {
              name: "subscriber-detail",
              resourceId: "subscriber-42",
            },
          });
          environment.back();
        }
        expect(environment.index).toBe(1);
        expect(router.getSnapshot().route).toEqual({
          section: "subscribers",
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("keeps sole ownership of a silent Back until one later pop releases it", async () => {
    vi.useFakeTimers();
    try {
      const environment = new FakeRouterEnvironment();
      const router = new DesktopRouterController(environment);
      router.navigate({ section: "subscribers" });
      router.navigate({
        section: "subscribers",
        overlay: {
          name: "subscriber-detail",
          resourceId: "subscriber-42",
        },
      });
      environment.goBehavior = "no-op";

      const first = router.navigateApprovedBackTo(
        { section: "subscribers" },
        { timeoutMs: 25 },
      );
      await vi.advanceTimersByTimeAsync(25);
      await expect(first).resolves.toBe("failed");
      await vi.advanceTimersByTimeAsync(10_000);

      environment.goBehavior = "normal";
      await expect(
        router.navigateApprovedBackTo({ section: "subscribers" }),
      ).resolves.toBe("failed");
      environment.back();
      expect(environment.index).toBe(2);
      expect(router.getSnapshot().route).toMatchObject({
        overlay: { name: "subscriber-detail" },
      });
      await expect(
        router.navigateApprovedBackTo({ section: "subscribers" }),
      ).resolves.toBe("applied");
      expect(environment.index).toBe(1);
      expect(router.getSnapshot().route).toEqual({ section: "subscribers" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("owns an arbitrarily late unexpected Back until its restoration lands", async () => {
    vi.useFakeTimers();
    try {
      const environment = new FakeRouterEnvironment();
      const router = new DesktopRouterController(environment);
      router.navigate({ section: "subscribers" });
      router.navigate({
        section: "subscribers",
        overlay: {
          name: "subscriber-detail",
          resourceId: "subscriber-42",
        },
      });
      environment.goBehavior = "deferred-pop";

      const result = router.navigateApprovedBackTo(
        { section: "dashboard" },
        { timeoutMs: 25 },
      );
      await vi.advanceTimersByTimeAsync(25);
      await expect(result).resolves.toBe("failed");
      await vi.advanceTimersByTimeAsync(10_000);
      router.navigate({ section: "settings", settingsAnchor: "api-keys" });

      environment.flushDeferredPop();
      expect(router.getSnapshot().route).toEqual({
        section: "settings",
        settingsAnchor: "api-keys",
      });
      environment.flushDeferredPop();

      expect(environment.index).toBe(3);
      expect(environment.location()).toBe("/app/settings?anchor=api-keys");
      expect(router.getSnapshot().route).toEqual({
        section: "settings",
        settingsAnchor: "api-keys",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not enqueue a duplicate restoration while the first remains pending", async () => {
    vi.useFakeTimers();
    try {
      const environment = new FakeRouterEnvironment();
      const router = new DesktopRouterController(environment);
      router.navigate({ section: "subscribers" });
      router.navigate({
        section: "subscribers",
        overlay: {
          name: "subscriber-detail",
          resourceId: "subscriber-42",
        },
      });
      environment.goBehavior = "deferred-pop";

      const result = router.navigateApprovedBackTo(
        { section: "dashboard" },
        { timeoutMs: 25 },
      );
      environment.flushDeferredPop();
      expect(environment.index).toBe(1);
      expect(environment.deferredIndexes).toEqual([2]);

      await vi.advanceTimersByTimeAsync(25);
      await expect(result).resolves.toBe("failed");
      expect(environment.deferredIndexes).toEqual([2]);

      environment.flushDeferredPop();
      expect(environment.index).toBe(2);
      router.navigate({ section: "settings", settingsAnchor: "api-keys" });
      environment.flushDeferredPop();

      expect(environment.deferredIndexes).toEqual([]);
      expect(environment.location()).toBe("/app/settings?anchor=api-keys");
      expect(router.getSnapshot().route).toEqual({
        section: "settings",
        settingsAnchor: "api-keys",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores a superseding route after an ordered nonmatching origin", async () => {
    const environment = new FakeRouterEnvironment();
    const router = new DesktopRouterController(environment);
    router.navigate({ section: "subscribers" });
    router.navigate({
      section: "subscribers",
      overlay: {
        name: "subscriber-detail",
        resourceId: "subscriber-42",
      },
    });
    environment.goBehavior = "deferred-pop";
    const result = router.navigateApprovedBackTo({ section: "dashboard" });
    router.navigate({ section: "settings", settingsAnchor: "api-keys" });

    environment.flushDeferredPop();
    expect(environment.index).toBe(1);
    expect(environment.deferredIndexes).toEqual([3]);
    expect(router.getSnapshot().route).toEqual({
      section: "settings",
      settingsAnchor: "api-keys",
    });

    environment.flushDeferredPop();
    await expect(result).resolves.toBe("superseded");
    expect(environment.deferredIndexes).toEqual([]);
    expect(environment.index).toBe(3);
    expect(environment.location()).toBe("/app/settings?anchor=api-keys");
  });

  it("uses the issued coordinate when a superseded origin has a stale index", async () => {
    const environment = new FakeRouterEnvironment();
    const router = new DesktopRouterController(environment);
    router.navigate({ section: "campaigns", resourceId: "campaign-1" });
    router.navigate({ section: "campaigns", resourceId: "campaign-2" });
    router.navigate({ section: "settings", settingsAnchor: "appearance" });
    router.navigate({ section: "subscribers" });
    router.navigate({
      section: "subscribers",
      overlay: {
        name: "subscriber-detail",
        resourceId: "subscriber-42",
      },
    });
    router.navigate({ section: "lists", resourceId: "list-6" });
    router.navigate({ section: "lists", resourceId: "list-7" });
    router.navigate({ section: "settings", settingsAnchor: "desktop-updates" });
    router.navigate({ section: "settings", settingsAnchor: "privacy" });
    environment.go(-4);
    expect(environment.index).toBe(5);

    environment.goBehavior = "deferred-pop";
    const result = router.navigateApprovedBackTo({ section: "subscribers" });
    router.navigate(
      { section: "settings", settingsAnchor: "api-keys" },
      { replace: true },
    );
    const validOriginState = environment.entries[4]!.state;
    environment.entries[4]!.state = {
      ...(validOriginState as Record<string, unknown>),
      index: 0,
    };

    environment.flushDeferredPop();
    expect(environment.index).toBe(4);
    expect(environment.deferredIndexes).toEqual([5]);
    expect(environment.entries[9]!.url).toBe("/app/settings?anchor=privacy");
    expect(router.getSnapshot().route).toEqual({
      section: "settings",
      settingsAnchor: "api-keys",
    });

    environment.flushDeferredPop();
    await expect(result).resolves.toBe("superseded");
    expect(environment.index).toBe(5);
    expect(environment.location()).toBe("/app/settings?anchor=api-keys");
    environment.entries[4]!.state = validOriginState;
    environment.goBehavior = "normal";
    await expect(
      router.navigateApprovedBackTo({ section: "subscribers" }),
    ).resolves.toBe("applied");
    expect(environment.index).toBe(4);
  });

  it("does not persist scroll onto a silently traversed origin", async () => {
    vi.useFakeTimers();
    try {
      const environment = new FakeRouterEnvironment();
      const router = new DesktopRouterController(environment);
      router.navigate({ section: "subscribers" });
      router.navigate({
        section: "subscribers",
        overlay: {
          name: "subscriber-detail",
          resourceId: "subscriber-42",
        },
      });
      environment.goBehavior = "no-pop";

      const result = router.navigateApprovedBackTo(
        { section: "subscribers" },
        { timeoutMs: 25 },
      );
      expect(environment.index).toBe(1);
      router.recordScroll(480);
      expect(environment.entries[1]!.url).toBe("/app/subscribers");
      expect(environment.entries[1]!.state).toMatchObject({ index: 1 });

      await vi.advanceTimersByTimeAsync(25);
      await expect(result).resolves.toBe("failed");
      expect(environment.index).toBe(2);
      expect(environment.entries[1]!.url).toBe("/app/subscribers");
      expect(environment.entries[1]!.state).toMatchObject({ index: 1 });
      expect(environment.entries[2]!.state).toMatchObject({ index: 2 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases ownership after a post-timeout silent restoration aligns", async () => {
    vi.useFakeTimers();
    try {
      const environment = new FakeRouterEnvironment();
      const router = new DesktopRouterController(environment);
      router.navigate({ section: "subscribers" });
      router.navigate({
        section: "subscribers",
        overlay: {
          name: "subscriber-detail",
          resourceId: "subscriber-42",
        },
      });
      environment.goBehavior = "deferred-pop";
      const result = router.navigateApprovedBackTo(
        { section: "subscribers" },
        { timeoutMs: 25 },
      );
      await vi.advanceTimersByTimeAsync(25);
      await expect(result).resolves.toBe("failed");
      router.navigate({ section: "settings", settingsAnchor: "api-keys" });

      environment.goBehavior = "no-pop";
      environment.flushDeferredPop();
      expect(environment.index).toBe(3);
      expect(environment.location()).toBe("/app/settings?anchor=api-keys");

      environment.goBehavior = "normal";
      await expect(
        router.navigateApprovedBackTo({
          section: "subscribers",
          overlay: {
            name: "subscriber-detail",
            resourceId: "subscriber-42",
          },
        }),
      ).resolves.toBe("applied");
    } finally {
      vi.useRealTimers();
    }
  });

  it("repairs the visible URL after a post-timeout restoration no-op", async () => {
    vi.useFakeTimers();
    try {
      const environment = new FakeRouterEnvironment();
      const router = new DesktopRouterController(environment);
      router.navigate({ section: "subscribers" });
      router.navigate({
        section: "subscribers",
        overlay: {
          name: "subscriber-detail",
          resourceId: "subscriber-42",
        },
      });
      environment.goBehavior = "deferred-pop";
      const result = router.navigateApprovedBackTo(
        { section: "subscribers" },
        { timeoutMs: 25 },
      );
      await vi.advanceTimersByTimeAsync(25);
      await expect(result).resolves.toBe("failed");
      router.navigate({ section: "settings", settingsAnchor: "api-keys" });

      environment.goBehavior = "no-op";
      environment.flushDeferredPop();
      expect(environment.location()).toBe("/app/subscribers");
      await vi.advanceTimersByTimeAsync(1_000);

      expect(environment.location()).toBe("/app/settings?anchor=api-keys");
      expect(router.getSnapshot().route).toEqual({
        section: "settings",
        settingsAnchor: "api-keys",
      });
      expect(environment.historyState()).toMatchObject({ index: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores from an unexpected silent null-state origin without overwriting it", async () => {
    vi.useFakeTimers();
    try {
      const environment = new FakeRouterEnvironment();
      const router = new DesktopRouterController(environment);
      router.navigate({ section: "subscribers" });
      router.navigate({
        section: "subscribers",
        overlay: {
          name: "subscriber-detail",
          resourceId: "subscriber-42",
        },
      });
      environment.entries[1]!.state = null;
      environment.goBehavior = "no-pop";

      const result = router.navigateApprovedBackTo(
        { section: "dashboard" },
        { timeoutMs: 25 },
      );
      await vi.advanceTimersByTimeAsync(25);

      await expect(result).resolves.toBe("failed");
      expect(environment.index).toBe(2);
      expect(environment.entries[1]).toMatchObject({
        url: "/app/subscribers",
        state: null,
      });
      expect(environment.entries[2]!.url).toContain(
        "overlay=subscriber-detail",
      );
      expect(environment.historyState()).toMatchObject({ index: 2 });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["null state", () => null],
    [
      "legacy state without an index",
      (state: unknown) => ({
        ...(state as Record<string, unknown>),
        index: undefined,
      }),
    ],
    [
      "self-consistent state with a stale index",
      (state: unknown) => ({
        ...(state as Record<string, unknown>),
        index: 0,
      }),
    ],
  ])(
    "drains an unexpected %s pop before a fresh approved Back",
    async (_label, corruptState) => {
      const environment = new FakeRouterEnvironment();
      const router = new DesktopRouterController(environment);
      router.navigate({ section: "subscribers" });
      router.navigate({
        section: "subscribers",
        overlay: {
          name: "subscriber-detail",
          resourceId: "subscriber-42",
        },
      });
      environment.entries[1]!.state = corruptState(
        environment.entries[1]!.state,
      );

      await expect(
        router.navigateApprovedBackTo({ section: "dashboard" }),
      ).resolves.toBe("failed");
      expect(environment.index).toBe(2);
      expect(router.getSnapshot().route).toMatchObject({
        overlay: { name: "subscriber-detail" },
      });

      router.navigate({ section: "subscribers" }, { replace: true });
      router.navigate({
        section: "subscribers",
        overlay: {
          name: "subscriber-detail",
          resourceId: "subscriber-84",
        },
      });
      await expect(
        router.navigateApprovedBackTo({ section: "subscribers" }),
      ).resolves.toBe("applied");
      expect(environment.index).toBe(2);
      expect(router.getSnapshot().route).toEqual({ section: "subscribers" });
    },
  );

  it("drains an exact-coordinate pop with the wrong identity scope", async () => {
    const environment = new FakeRouterEnvironment();
    const router = new DesktopRouterController(environment);
    router.setIdentity("user-a", "tenant-a");
    router.navigate({ section: "subscribers" });
    router.navigate({
      section: "subscribers",
      overlay: {
        name: "subscriber-detail",
        resourceId: "subscriber-42",
      },
    });
    environment.entries[1]!.state = {
      ...(environment.entries[1]!.state as Record<string, unknown>),
      scope: desktopRouteIdentityScope("user-b", "tenant-b"),
    };

    await expect(
      router.navigateApprovedBackTo({ section: "subscribers" }),
    ).resolves.toBe("failed");
    expect(environment.index).toBe(2);
    expect(router.getSnapshot().route).toMatchObject({
      overlay: { name: "subscriber-detail" },
    });

    router.navigate({ section: "subscribers" }, { replace: true });
    router.navigate({
      section: "subscribers",
      overlay: {
        name: "subscriber-detail",
        resourceId: "subscriber-84",
      },
    });
    await expect(
      router.navigateApprovedBackTo({ section: "subscribers" }),
    ).resolves.toBe("applied");
  });

  it("rejects an unscoped legacy target and restores a consistent indexed entry", async () => {
    const environment = new FakeRouterEnvironment();
    const router = new DesktopRouterController(environment);
    router.navigate({ section: "subscribers" });
    router.navigate({
      section: "subscribers",
      overlay: {
        name: "subscriber-detail",
        resourceId: "subscriber-42",
      },
    });
    const validOriginState = environment.entries[1]!.state;
    environment.entries[1]!.state = null;

    await expect(
      router.navigateApprovedBackTo({ section: "subscribers" }),
    ).resolves.toBe("failed");

    expect(environment.index).toBe(2);
    expect(environment.historyState()).toMatchObject({ index: 2 });
    expect(router.getSnapshot().route).toEqual({
      section: "subscribers",
      overlay: {
        name: "subscriber-detail",
        resourceId: "subscriber-42",
      },
    });
    environment.entries[1]!.state = validOriginState;
    await expect(
      router.navigateApprovedBackTo({ section: "subscribers" }),
    ).resolves.toBe("applied");
    expect(environment.index).toBe(1);
  });

  it("rejects an exact-looking target whose state canonical URL disagrees", async () => {
    vi.useFakeTimers();
    try {
      const environment = new FakeRouterEnvironment();
      const router = new DesktopRouterController(environment);
      router.navigate({ section: "subscribers" });
      router.navigate({
        section: "subscribers",
        overlay: {
          name: "subscriber-detail",
          resourceId: "subscriber-42",
        },
      });
      const validOriginState = environment.entries[1]!.state;
      const forgedState = {
        ...(environment.entries[1]!.state as Record<string, unknown>),
        canonicalUrl: "/app/dashboard",
        index: 2,
      };
      environment.entries[1]!.state = forgedState;

      const result = router.navigateApprovedBackTo(
        { section: "subscribers" },
        { timeoutMs: 25 },
      );
      await vi.advanceTimersByTimeAsync(25);
      await expect(result).resolves.toBe("failed");

      expect(environment.index).toBe(2);
      expect(environment.entries[1]).toEqual({
        url: "/app/subscribers",
        state: forgedState,
      });
      expect(environment.location()).toContain("overlay=subscriber-detail");
      expect(router.getSnapshot().route).toEqual({
        section: "subscribers",
        overlay: {
          name: "subscriber-detail",
          resourceId: "subscriber-42",
        },
      });
      environment.entries[1]!.state = validOriginState;
      await expect(
        router.navigateApprovedBackTo({ section: "subscribers" }),
      ).resolves.toBe("applied");
      expect(environment.index).toBe(1);
      router.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rolls Back to the mounted route during lifecycle review, then resumes the exact target", async () => {
    const environment = new FakeRouterEnvironment();
    const router = new DesktopRouterController(environment);
    router.navigate({ section: "campaigns", resourceId: "campaign_9" });
    router.recordScroll(480);
    router.navigate({ section: "settings", settingsAnchor: "api-keys" });

    let continueHistory: (() => Promise<void>) | null = null;
    let finishReview: (() => void) | null = null;
    const reviewed = new Promise<void>((resolve) => {
      finishReview = resolve;
    });
    router.setHistoryTransitionGuard({
      shouldIntercept: () => true,
      request: (transition, resume) => {
        expect(transition).toEqual({
          from: { section: "settings", settingsAnchor: "api-keys" },
          to: { section: "campaigns", resourceId: "campaign_9" },
        });
        continueHistory = async () => {
          await resume();
          finishReview?.();
        };
        return reviewed;
      },
    });

    environment.back();

    expect(router.getSnapshot().route).toEqual({
      section: "settings",
      settingsAnchor: "api-keys",
    });
    expect(environment.location()).toBe("/app/settings?anchor=api-keys");

    const resume = continueHistory as (() => Promise<void>) | null;
    expect(resume).not.toBeNull();
    await resume?.();

    expect(router.getSnapshot()).toMatchObject({
      route: { section: "campaigns", resourceId: "campaign_9" },
      source: "history",
      restoreScrollTop: 480,
    });
    expect(environment.location()).toBe("/app/campaigns/campaign_9");
  });

  it("lets a history guard recognize in-place Settings anchor moves", () => {
    const environment = new FakeRouterEnvironment();
    const router = new DesktopRouterController(environment);
    router.navigate({ section: "settings", settingsAnchor: "api-keys" });
    router.navigate({ section: "settings", settingsAnchor: "appearance" });
    const request = vi.fn();
    router.setHistoryTransitionGuard({
      shouldIntercept: (transition) =>
        !(
          transition.from.section === "settings" &&
          transition.to.section === "settings"
        ),
      request,
    });

    environment.back();

    expect(router.getSnapshot().route).toEqual({
      section: "settings",
      settingsAnchor: "api-keys",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps the exact history position when lifecycle review cancels Back", async () => {
    const environment = new FakeRouterEnvironment();
    const router = new DesktopRouterController(environment);
    router.navigate({ section: "campaigns" });
    router.navigate({ section: "settings" });
    let intercept = true;
    router.setHistoryTransitionGuard({
      shouldIntercept: () => intercept,
      request: async () => "cancelled",
    });

    environment.back();
    await Promise.resolve();
    await Promise.resolve();
    expect(router.getSnapshot().route).toEqual({ section: "settings" });
    expect(environment.location()).toBe("/app/settings");

    intercept = false;
    environment.back();
    expect(router.getSnapshot().route).toEqual({ section: "campaigns" });
    expect(environment.location()).toBe("/app/campaigns");
  });

  it("rolls back and resumes a multi-entry Back jump without losing the target scroll", async () => {
    const environment = new FakeRouterEnvironment();
    const router = new DesktopRouterController(environment);
    router.navigate({ section: "campaigns", resourceId: "campaign_4" });
    router.recordScroll(404);
    router.navigate({ section: "lists", resourceId: "list_5" });
    router.navigate({ section: "settings" });

    let continueHistory: (() => Promise<void>) | undefined;
    let finish: (() => void) | undefined;
    const review = new Promise<void>((resolve) => {
      finish = resolve;
    });
    router.setHistoryTransitionGuard({
      shouldIntercept: () => true,
      request: (_transition, resume) => {
        continueHistory = async () => {
          await resume();
          finish?.();
        };
        return review;
      },
    });

    environment.go(-2);
    expect(router.getSnapshot().route).toEqual({ section: "settings" });
    expect(environment.location()).toBe("/app/settings");

    await continueHistory?.();
    expect(router.getSnapshot()).toMatchObject({
      route: { section: "campaigns", resourceId: "campaign_4" },
      restoreScrollTop: 404,
    });
  });

  it("applies the same lifecycle rollback to Forward navigation", async () => {
    const environment = new FakeRouterEnvironment();
    const router = new DesktopRouterController(environment);
    router.navigate({ section: "campaigns" });
    router.navigate({ section: "templates", resourceId: "template_2" });
    environment.back();
    expect(router.getSnapshot().route).toEqual({ section: "campaigns" });

    let continueHistory: (() => Promise<void>) | undefined;
    let finish: (() => void) | undefined;
    const review = new Promise<void>((resolve) => {
      finish = resolve;
    });
    router.setHistoryTransitionGuard({
      shouldIntercept: () => true,
      request: (_transition, resume) => {
        continueHistory = async () => {
          await resume();
          finish?.();
        };
        return review;
      },
    });

    environment.forward();
    expect(router.getSnapshot().route).toEqual({ section: "campaigns" });
    expect(environment.location()).toBe("/app/campaigns");

    await continueHistory?.();
    expect(router.getSnapshot()).toMatchObject({
      route: { section: "templates", resourceId: "template_2" },
      source: "history",
    });
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type Audit = { findings: { id: string; severity: string }[] };

function repoFile(path: string): string {
  return readFileSync(resolve(process.cwd(), "../..", path), "utf8");
}

describe("mobile P2 remediation ledger", () => {
  it("contains every and only mobile P2 audit id exactly once", () => {
    const audit = JSON.parse(
      repoFile("docs/logic-audit-2026-07/mobile-findings.json"),
    ) as Audit;
    const ledger = repoFile(
      "docs/logic-audit-2026-07/mobile-p2-remediation.md",
    );
    const expected = audit.findings
      .filter((finding) => finding.severity === "P2")
      .map((finding) => finding.id)
      .sort();
    const actual = Array.from(
      ledger.matchAll(/^\|\s+((?:M\d+-[^|]+|GAP-\d+)#\d+)\s+\|/gm),
      (match) => match[1],
    ).sort();

    expect(actual).toHaveLength(18);
    expect(new Set(actual).size).toBe(actual.length);
    expect(actual).toEqual(expected);
  });

  it("locks the cross-cutting P2 source contracts", () => {
    const root = repoFile("apps/mobile/app/_layout.tsx");
    const biometric = repoFile("apps/mobile/src/components/BiometricGate.tsx");
    const subscribers = repoFile("apps/mobile/src/hooks/useSubscribers.ts");
    // The suppression list moved out of the catch-all useOps module into its
    // own endpoint-family hook (useOps spanned ten unrelated resource domains,
    // so every deliverability screen transitively imported SCIM and agency
    // types). The CONTRACT being locked here is unchanged — "the suppression
    // list is read from the paginated deliverability endpoint" — so, following
    // the precedent set for the subscribers and dashboard guards below, the
    // guard moves with the code rather than being deleted.
    const ops = repoFile("apps/mobile/src/hooks/useSuppressionOps.ts");
    // The page-size constant and the paging rule moved to the pure module so
    // they could be unit-tested in the node environment when the list learned
    // to reach past page 1; the guard follows them rather than being dropped.
    const suppressionPage = repoFile("apps/mobile/src/lib/suppressionPage.ts");
    // The sending-settings screen was split into a render shell, a controller
    // hook and a writes hook to stay inside its complexity budget. The contract
    // this ledger pins — that the quiet-hours write sends the per-recipient
    // flag — now lives with the write that sends it. Concatenating the chain
    // keeps the assertion about BEHAVIOUR rather than about which file happens
    // to hold the line today.
    const sending = [
      repoFile("apps/mobile/app/(tabs)/sending-settings.tsx"),
      repoFile("apps/mobile/src/hooks/useSendingSettingsForm.ts"),
      repoFile("apps/mobile/src/hooks/useSendingWrites.ts"),
      repoFile("apps/mobile/src/components/deliverability/SendingSettingsBody.tsx"),
      repoFile("apps/mobile/src/components/deliverability/SendingThrottleForm.tsx"),
      repoFile("apps/mobile/src/components/deliverability/SendingSaveControls.tsx"),
      repoFile("apps/mobile/src/components/deliverability/ClearLimitsControl.tsx"),
      repoFile("apps/mobile/src/components/deliverability/QuietHoursAdvisories.tsx"),
    ].join("\n");
    const realtime = repoFile(
      "apps/mobile/src/api/event-cache-invalidation.ts",
    );
    const dashboard = repoFile("apps/mobile/src/hooks/useDashboard.ts");
    const dashboardScreen = repoFile("apps/mobile/app/(tabs)/dashboard.tsx");
    const dashboardMetrics = repoFile(
      "apps/mobile/src/lib/dashboardMetrics.ts",
    );
    // The picker moved out of CampaignDetailControls into its own file when it
    // grew a scroll-to-selection effect, a measured row height and an
    // OS-text-size-aware container. The CONTRACT is unchanged — a wheel nested
    // inside the sheet's ScrollView must not eat the parent's gestures — so the
    // pointer follows the code rather than the guard being dropped.
    const wheel = repoFile(
      "apps/mobile/src/components/campaigns/DateTimeWheel.tsx",
    );
    const sheet = repoFile("apps/mobile/src/components/KeyboardFormSheet.tsx");
    const eas = JSON.parse(repoFile("apps/mobile/eas.json")) as {
      cli?: { appVersionSource?: string };
    };

    expect(root).toContain("OfflineMutationFailureBanner");
    expect(root).toContain("resumePausedMutations");
    expect(biometric).toContain('if (next !== "active")');
    expect(biometric).toContain("setLocked(true)");
    // The contract is "one page fetcher, built by the shared params builder,
    // hitting the paginated list endpoint" — NOT the exact arity. The builder
    // gained a fourth argument when the list learned to sort (sort/order are
    // read by the Go handler's normalizeSort but are absent from the SDK's
    // ListSubscribersParams, so the builder is the only place the two facts
    // are reconciled). Pin the call through the builder, and keep the real
    // guard: the screen must not silently switch to /subscribers/search,
    // which pages differently and 400s on a half-typed operator.
    expect(subscribers).toContain(
      "subscriberListParams(query, status, pageParam",
    );
    expect(subscribers).not.toContain("client.subscribers.search(");
    // The page size is a named constant and the page number is a parameter now
    // (the list learned to search server-side and to page), so pin the endpoint
    // and the fact that it is still paginated rather than the old literal.
    expect(ops).toContain("/api/v1/deliverability/suppressions?page=");
    expect(suppressionPage).toContain("SUPPRESSION_PAGE_SIZE = 50");
    expect(sending).toContain("quiet_hours_per_recipient: form.perRecipient");
    // M13 correction (2026-07-20): the original remediation removed BOTH list.*
    // and sequence.* believing neither was published to the SSE bus. That was
    // right for sequence.* but WRONG for list.*: `list.subscriber.added` IS
    // bus-published (apps/api/internal/subscribers/bulk_operations.go →
    // d.emit → d.Bus.Publish, topic "list.subscriber.added"), web subscribes to
    // it, and mobile has a Lists tab (app/(tabs)/lists/index.tsx, ["lists"] query).
    // So list.* is re-subscribed; only sequence.* stays removed as genuinely dead.
    expect(realtime).toContain('"list.*"');
    expect(realtime).not.toContain('"sequence.*"');
    expect(dashboard).toContain("unique_opens_30d");
    expect(dashboard).toContain("unique_delivered_30d");
    // The original guard pinned the literal clamp inside the screen's local
    // `fmtPct` helper. That helper is gone: the screen now formats through
    // lib/format's `percent()` and never derives a rate itself. The contract it
    // was protecting — "an out-of-domain open rate is never rendered as a
    // believable number" — moved to two stronger chokepoints, so the guard
    // moves with it rather than being deleted:
    //   1. counts-derived rates REFUSE a numerator larger than the denominator
    //      (previously they were clamped to a plausible 100%);
    //   2. the legacy precomputed rate, which has no counts to check, is still
    //      clamped into [0,1].
    expect(dashboardMetrics).toContain("numerator > denominator");
    expect(dashboard).toContain("Math.min(1, Math.max(0, legacy))");
    expect(dashboardScreen).not.toContain("function fmtPct");
    expect(wheel).toContain("nestedScrollEnabled");
    expect(sheet).toContain("nestedScrollEnabled");
    expect(eas.cli?.appVersionSource).toBe("remote");
  });
});

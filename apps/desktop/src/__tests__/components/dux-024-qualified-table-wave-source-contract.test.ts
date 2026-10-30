import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const migratedSurfaces = [
  "components/deliverability/FrequencyCapsCard.tsx",
  "components/deliverability/IntelligentRetryCard.tsx",
  "components/deliverability/SpamTrapGuardCard.tsx",
  "components/experiments/ControlGroupsCard.tsx",
  "components/referrals/LeaderboardCard.tsx",
  "components/templates/TemplateLeaderboardSection.tsx",
  "components/track/EventCatalog.tsx",
] as const;

describe("DUX-024 qualified-table contained wave", () => {
  it.each(migratedSurfaces)(
    "migrates %s to the native table contract",
    (path) => {
      const component = source(path);

      expect(component).toContain("DataTable");
      expect(component).toContain("<DataTable");
      expect(component).not.toContain('className="list-header"');
      expect(component).not.toContain('className="list-row"');
    },
  );

  it("uses an explicit event filter action instead of a row-wide pseudo-button", () => {
    const catalog = source("components/track/EventCatalog.tsx");

    expect(catalog).toContain('id: "actions"');
    expect(catalog).toContain("aria-pressed={selected}");
    expect(catalog).not.toContain('role="button"');
    expect(catalog).not.toContain("onKeyDown");
  });

  it("renders control-group reports through the table expansion contract", () => {
    const groups = source("components/experiments/ControlGroupsCard.tsx");

    expect(groups).toContain("expansion={{");
    expect(groups).toContain("control-group-report-${group.id}");
    expect(groups).toContain("<ControlGroupReportPanel");
    expect(groups).toContain(
      "aria-controls={`control-group-report-${group.id}`}",
    );
  });

  it("retains verified refresh data and invalidates stale or unmounted reads", () => {
    const frequency = source("components/deliverability/FrequencyCapsCard.tsx");
    const retry = source("components/deliverability/IntelligentRetryCard.tsx");
    const traps = source("components/deliverability/SpamTrapGuardCard.tsx");
    const referrals = source("components/referrals/LeaderboardCard.tsx");
    const templates = source(
      "components/templates/TemplateLeaderboardSection.tsx",
    );
    const catalog = source("components/track/EventCatalog.tsx");
    const track = source("pages/Track.tsx");

    expect(frequency).toContain("hasVerifiedRowsRef");
    expect(frequency).toContain("requestIdRef.current += 1");
    expect(retry).not.toContain("setRows(null)");
    expect(retry).toContain("requestIdRef.current += 1");
    expect(traps).toContain("Promise.allSettled");
    expect(traps).toContain("if (parsedStats) setStats(parsedStats)");
    expect(traps).toContain("if (parsedHits) setHits(parsedHits)");
    expect(traps).toContain("requestId !== requestIdRef.current");
    expect(referrals).toContain("loadedWindow === window");
    expect(referrals).toContain("loading={scopedData === null && !err}");
    expect(templates).toContain("loadedDays === days");
    expect(templates).toContain("loading={scopedRows === null && !err}");
    expect(catalog).toContain("loading={loading && items === null}");
    expect(track).toContain("useProductEventCatalog");
    expect(track).toContain("{ identity: `product-event-catalog:${range}` }");
    expect(track).toContain(
      "{ identity: `product-event-stats:${range}:${eventName}` }",
    );
    expect(track.match(/stale: resource\.stale/gu)).toHaveLength(2);
  });
});

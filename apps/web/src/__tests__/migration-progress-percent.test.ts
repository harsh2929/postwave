// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { migrationProgressPercent } from "@/lib/migration-progress-percent";

describe("migrationProgressPercent", () => {
  it("uses the same complete counter set for list and detail views", () => {
    expect(
      migrationProgressPercent({
        subscribers_total: 10,
        subscribers_done: 10,
        templates_total: 10,
        templates_done: 5,
        source_archive_total: 10,
        source_archive_done: 0,
      }),
    ).toBe(50);
  });

  it("returns honest boundary values", () => {
    expect(migrationProgressPercent(null)).toBe(0);
    expect(migrationProgressPercent({})).toBe(0);
    expect(
      migrationProgressPercent({ templates_total: 1, templates_done: 2 }),
    ).toBe(100);
  });

  it("does not count Beehiiv rebuild and premium metadata inventory as unfinished runtime work", () => {
    expect(
      migrationProgressPercent(
        {
          subscribers_total: 100,
          subscribers_done: 100,
          segments_total: 3,
          segments_done: 3,
          automations_total: 5,
          automations_done: 0,
          paid_subs_total: 40,
          paid_subs_done: 0,
          archive_total: 10,
          archive_done: 10,
        },
        "beehiiv",
      ),
    ).toBe(100);
  });

  it("does not count Klaviyo flow rebuild inventory as unfinished runtime work", () => {
    expect(
      migrationProgressPercent(
        {
          subscribers_total: 100,
          subscribers_done: 100,
          segments_total: 3,
          segments_done: 3,
          automations_total: 5,
          automations_done: 0,
          archive_total: 10,
          archive_done: 10,
          templates_total: 4,
          templates_done: 4,
        },
        "klaviyo",
      ),
    ).toBe(100);
  });
});

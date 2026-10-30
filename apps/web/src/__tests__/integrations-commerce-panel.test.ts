// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import {
  commerceStatusClass,
  commerceSyncClass,
  formatCommerceDate,
  syncFailureEvents,
} from "../app/(dashboard)/app/integrations/commerce-integrations-panel";
import type { CommerceEventRow } from "@/lib/commerce-api";

function event(id: number, eventType: string): CommerceEventRow {
  return {
    id,
    event_type: eventType,
    metadata: {},
    at: "2026-01-01T00:00:00.000Z",
  };
}

describe("commerce integrations panel helpers", () => {
  it("maps integration statuses and sync tones to badge classes", () => {
    expect(commerceStatusClass("active")).toBe("bg-accent/15 text-accent");
    expect(commerceStatusClass("connected")).toBe("bg-accent/15 text-accent");
    expect(commerceStatusClass("error")).toBe(
      "bg-destructive/15 text-destructive-emphasis",
    );
    expect(commerceStatusClass("paused")).toBe(
      "bg-muted text-muted-foreground",
    );

    expect(commerceSyncClass("success")).toBe("bg-accent/15 text-accent");
    expect(commerceSyncClass("danger")).toBe(
      "bg-destructive/15 text-destructive-emphasis",
    );
    expect(commerceSyncClass("warning")).toBe(
      "bg-warning/15 text-warning-emphasis",
    );
    expect(commerceSyncClass("neutral")).toBe(
      "bg-muted text-muted-foreground",
    );
  });

  it("keeps only sync failure events for the commerce panel", () => {
    const failed = event(1, "sync_failed");
    const completed = event(2, "sync_completed");
    const failedAgain = event(3, "sync_failed");

    expect(syncFailureEvents([failed, completed, failedAgain])).toEqual([
      failed,
      failedAgain,
    ]);
  });

  it("formats absent and invalid commerce dates defensively", () => {
    expect(formatCommerceDate(null)).toBe("never");
    expect(formatCommerceDate(undefined)).toBe("never");
    expect(formatCommerceDate("not-a-date")).toBe("not-a-date");
    expect(formatCommerceDate("2026-01-02T03:04:00.000Z")).toContain("Jan");
  });
});

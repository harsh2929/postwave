import { describe, expect, it } from "vitest";

import {
  migrationStatusLabel,
  migrationStatusVariant,
} from "@/lib/migration-status";
import type { MigrationStatus } from "@/lib/types";

describe("migration status mapping (MIGR-004)", () => {
  it("humanises underscored codes identically for list and detail", () => {
    expect(migrationStatusLabel("rolled_back")).toBe("rolled back");
    expect(migrationStatusLabel("dry_run")).toBe("dry run");
    expect(migrationStatusLabel("importing")).toBe("importing");
  });

  it("maps rolled_back to warning (not the old grey secondary)", () => {
    expect(migrationStatusVariant("rolled_back")).toBe("warning");
  });

  it("keeps completed/failed semantics", () => {
    expect(migrationStatusVariant("completed")).toBe("success");
    expect(migrationStatusVariant("failed")).toBe("destructive");
  });

  it("treats every in-flight status as secondary", () => {
    const inflight: MigrationStatus[] = [
      "pending",
      "authenticating",
      "discovering",
      "dry_run",
      "awaiting_confirmation",
      "importing",
      "rolling_back",
    ];
    for (const s of inflight) expect(migrationStatusVariant(s)).toBe("secondary");
  });
});

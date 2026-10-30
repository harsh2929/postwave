import { describe, expect, it } from "vitest";

import { offlineBannerCopy } from "./offlineBannerCopy";

const idle = { pendingWrites: 0, failedWrites: 0, rechecking: false };

describe("offlineBannerCopy", () => {
  it("never claims data is cached", () => {
    // shouldPersistQuery returns false unconditionally, so the old
    // "showing cached data" line was false on every screen without a
    // hand-written vault projection.
    const copy = offlineBannerCopy(idle);
    expect(`${copy.title} ${copy.detail ?? ""}`.toLowerCase()).not.toContain(
      "cached",
    );
  });

  it("says nothing beyond the connection when there is nothing pending", () => {
    const copy = offlineBannerCopy(idle);
    expect(copy.title).toBe("No connection");
    expect(copy.detail).toBeNull();
    expect(copy.accessibilityLabel).toBe("No connection.");
  });

  it("surfaces the queue depth the user could not otherwise see", () => {
    const copy = offlineBannerCopy({ ...idle, pendingWrites: 3 });
    expect(copy.detail).toContain("3 changes waiting to send");
    expect(copy.accessibilityLabel).toContain("3 changes waiting to send");
  });

  it("uses singular grammar for one change", () => {
    const copy = offlineBannerCopy({ ...idle, pendingWrites: 1 });
    expect(copy.detail).toContain("1 change waiting to send");
    expect(copy.detail).toContain("it will go out");
  });

  it("reports failures separately from pending work", () => {
    const copy = offlineBannerCopy({
      ...idle,
      pendingWrites: 2,
      failedWrites: 1,
    });
    expect(copy.detail).toContain("2 changes waiting to send");
    expect(copy.detail).toContain("1 change couldn't be sent");
  });

  it("labels the re-probe control by its state", () => {
    expect(offlineBannerCopy(idle).actionLabel).toBe("Check again");
    expect(offlineBannerCopy({ ...idle, rechecking: true }).actionLabel).toBe(
      "Checking…",
    );
  });
});

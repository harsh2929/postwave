// Single-slot pending deep-link target handoff.
//
// The command palette (and TagDetailSlideover's per-row drill-down)
// stash {section, id} via setPendingDeepLinkTarget before calling
// setSection; the destination page consumes the slot once on mount.
// These tests pin the consume-once and last-write-wins semantics every
// consumer (Approvals, Campaigns, Subscribers, Lists, Forms,
// Templates, Tags) relies on.

import { describe, expect, it } from "vitest";

import {
  consumePendingDeepLinkTarget,
  onPendingDeepLinkTarget,
  setPendingDeepLinkTarget,
} from "../../lib/deep-link";
import { navigateDesktopRoute } from "../../lib/desktop-router";

describe("pending deep-link target handoff", () => {
  it("returns null when nothing was stashed", () => {
    expect(consumePendingDeepLinkTarget()).toBeNull();
  });

  it("hands the stashed target to the first consumer only", () => {
    setPendingDeepLinkTarget({ section: "lists", id: "42" });
    expect(consumePendingDeepLinkTarget()).toEqual({
      section: "lists",
      id: "42",
    });
    // Consume-once: a second mount (e.g. React StrictMode re-run or a
    // later visit to the same section) must not re-open the slideover.
    expect(consumePendingDeepLinkTarget()).toBeNull();
  });

  it("last write wins when a new target is set before consumption", () => {
    setPendingDeepLinkTarget({ section: "forms", id: "a" });
    setPendingDeepLinkTarget({ section: "tags", id: "b" });
    expect(consumePendingDeepLinkTarget()).toEqual({
      section: "tags",
      id: "b",
    });
    expect(consumePendingDeepLinkTarget()).toBeNull();
  });

  it("carries email ids verbatim (Subscribers keys on email)", () => {
    setPendingDeepLinkTarget({
      section: "subscribers",
      id: "vip@example.com",
    });
    expect(consumePendingDeepLinkTarget()).toEqual({
      section: "subscribers",
      id: "vip@example.com",
    });
  });

  it("notifies mounted consumers when a new target is set", () => {
    const seen: Array<{ section: string; id: string }> = [];
    const unsubscribe = onPendingDeepLinkTarget((target) => {
      seen.push(target);
    });
    setPendingDeepLinkTarget({ section: "segments", id: "seg_1" });
    unsubscribe();
    setPendingDeepLinkTarget({ section: "segments", id: "seg_2" });

    expect(seen).toEqual([{ section: "segments", id: "seg_1" }]);
    expect(consumePendingDeepLinkTarget()).toEqual({
      section: "segments",
      id: "seg_2",
    });
  });

  it("bridges a canonical resource route to mounted and mount-time consumers", () => {
    const seen: Array<{ section: string; id: string }> = [];
    const unsubscribe = onPendingDeepLinkTarget((target) => seen.push(target));
    navigateDesktopRoute(
      { section: "campaigns", resourceId: "campaign_77" },
      { source: "deep-link" },
    );
    unsubscribe();

    expect(seen).toContainEqual({
      section: "campaigns",
      id: "campaign_77",
    });
    expect(consumePendingDeepLinkTarget()).toEqual({
      section: "campaigns",
      id: "campaign_77",
    });
    expect(consumePendingDeepLinkTarget()).toBeNull();
    navigateDesktopRoute({ section: "dashboard" }, { replace: true });
  });
});

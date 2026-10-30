/**
 * Creation verbs — the role gate is the TARGET SCREEN's, verb by verb.
 *
 * The three screens do not share one rule (campaigns admits any non-viewer via
 * campaignAccess; lists and forms sit on the editor floor, which fails closed
 * in api-key mode), and a palette that offered "New list" to someone whose
 * Lists screen hides its own button would be a verb that lands on nothing.
 * The cases below pin each disagreement rather than a convenient average.
 */
import { describe, expect, it } from "vitest";

import { CAMPAIGN_CREATE_PARAM } from "@/components/onboarding/onboardingRoutes";

import { PALETTE_CREATE_PARAM, buildCreateItems } from "./paletteCreateItems";
import { scorePaletteItem, type PaletteAccess } from "./paletteItems";

const session = (role: string | null, online = true): PaletteAccess => ({
  role,
  mode: "session",
  online,
});
const ids = (access: PaletteAccess) =>
  buildCreateItems(access).map((item) => item.id);

describe("buildCreateItems — role gates mirror the target screens", () => {
  it("offers all three verbs to an editor, in desktop's order", () => {
    expect(ids(session("editor"))).toEqual([
      "create:campaign",
      "create:form",
      "create:list",
    ]);
  });

  it("offers all three to admin and owner", () => {
    for (const role of ["admin", "owner"]) {
      expect(ids(session(role))).toHaveLength(3);
    }
  });

  it("offers nothing to a viewer", () => {
    expect(ids(session("viewer"))).toEqual([]);
  });

  it("offers only New campaign to a legacy member — campaignAccess admits any non-viewer, the editor floor ranks member as viewer", () => {
    expect(ids(session("member"))).toEqual(["create:campaign"]);
  });

  it("keeps New campaign but drops the editor-floor verbs in api-key mode, as the screens do", () => {
    expect(ids({ role: "owner", mode: "api_key", online: true })).toEqual([
      "create:campaign",
    ]);
  });

  it("offers nothing without a usable online session", () => {
    expect(ids(session("owner", false))).toEqual([]);
  });

  it("treats an unstated online term as online, for callers that predate it", () => {
    expect(buildCreateItems({ role: "editor", mode: "session" })).toHaveLength(
      3,
    );
  });
});

describe("buildCreateItems — every verb is the screen's own create wire", () => {
  const items = buildCreateItems(session("editor"));

  it("carries the flag the campaigns screen consumes, on the list route, and never an actionKey", () => {
    expect(PALETTE_CREATE_PARAM).toBe(CAMPAIGN_CREATE_PARAM);
    for (const item of items) {
      expect(item.kind).toBe("create");
      expect(item.params).toEqual({ [CAMPAIGN_CREATE_PARAM]: "1" });
      expect(item.actionKey).toBeUndefined();
    }
    expect(items.map((item) => item.route)).toEqual([
      "/(tabs)/campaigns",
      "/(tabs)/forms",
      "/(tabs)/lists",
    ]);
  });

  it("renders desktop's hint verbatim", () => {
    expect(items.map((item) => item.subtitle)).toEqual([
      "Draft → Subject → Send",
      "Create a signup form",
      "Group of subscribers",
    ]);
  });

  it("never offers New template or Import subscribers", () => {
    expect(ids(session("owner")).join(" ")).not.toMatch(/template|import/u);
  });

  it("matches by noun as well as by verb", () => {
    const [campaign, form, list] = items;
    expect(scorePaletteItem(list!, "create list")).toBeLessThan(
      Number.POSITIVE_INFINITY,
    );
    // A prefix on the title, so "new form" ranks like a screen name would.
    expect(scorePaletteItem(form!, "new form")).toBeLessThan(100);
    // And a noun does not bleed across verbs.
    expect(scorePaletteItem(campaign!, "create list")).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});

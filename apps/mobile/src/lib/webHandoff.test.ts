import { describe, expect, it } from "vitest";

import { webHandoffUrl, WEB_HANDOFF_NOTE } from "./webHandoff";

const APP = "https://app.moosewave.com";

describe("webHandoffUrl", () => {
  it("builds the dashboard URL for every entity the row is rendered on", () => {
    // All three are wired: SubscriberDetailSections, CampaignDetailContent and
    // sequences/[id]. Each target exists on the web —
    // apps/web/src/app/(dashboard)/app/{subscribers,campaigns,sequences}/[id].
    expect(webHandoffUrl(APP, "subscriber", "abc-123")).toBe(
      "https://app.moosewave.com/app/subscribers/abc-123",
    );
    expect(webHandoffUrl(APP, "campaign", "c1")).toBe(
      "https://app.moosewave.com/app/campaigns/c1",
    );
    expect(webHandoffUrl(APP, "sequence", "s1")).toBe(
      "https://app.moosewave.com/app/sequences/s1",
    );
  });

  it("still BUILDS a URL for `approval`, which is why the row's union excludes it", () => {
    // route-map has an `approval` entity, so this function happily emits a
    // path for it — but apps/web/src/app/(dashboard)/app/approvals has only a
    // page.tsx and no [id] route, so the link would 404. The guard is the
    // WebHandoffRow prop union, not this function, and this test exists so
    // that the next person to widen the union finds the reason written down.
    expect(webHandoffUrl(APP, "approval", "a1")).toBe(
      "https://app.moosewave.com/app/approvals/a1",
    );
  });

  it("uses the CONFIGURED origin so a self-hosted build hands off to itself", () => {
    // buildUniversalLink hardcodes app.moosewave.com; this must not.
    expect(webHandoffUrl("https://mail.acme.example", "subscriber", "s1")).toBe(
      "https://mail.acme.example/app/subscribers/s1",
    );
    expect(
      webHandoffUrl("https://mail.acme.example/", "subscriber", "s1"),
    ).toBe("https://mail.acme.example/app/subscribers/s1");
  });

  it("refuses an entity web does not ship at all", () => {
    // Inventing a path here would put a second, drifting copy of the URL
    // grammar in the mobile app. `segment` is `web: "none"` in the shared
    // registry — web ships segments only nested under subscribers — so there
    // is no honest destination and the handoff must be withheld, not guessed.
    expect(webHandoffUrl(APP, "segment", "s1")).toBeNull();
    expect(webHandoffUrl(APP, "", "x")).toBeNull();
    expect(webHandoffUrl(APP, "not-an-entity", "x")).toBeNull();
  });

  it("lands on the list record now that web ships its detail route", () => {
    expect(webHandoffUrl(APP, "list", "l1")).toBe(`${APP}/app/lists/l1`);
  });

  it("refuses an unsafe id rather than pasting it into a URL", () => {
    expect(webHandoffUrl(APP, "subscriber", "../../admin")).toBeNull();
    expect(webHandoffUrl(APP, "subscriber", "a b")).toBeNull();
    expect(webHandoffUrl(APP, "subscriber", "")).toBeNull();
    expect(webHandoffUrl(APP, "subscriber", null)).toBeNull();
    expect(webHandoffUrl(APP, "subscriber", undefined)).toBeNull();
  });

  it("refuses a non-https or malformed origin", () => {
    expect(
      webHandoffUrl("http://app.moosewave.com", "subscriber", "s1"),
    ).toBeNull();
    expect(webHandoffUrl("app.moosewave.com", "subscriber", "s1")).toBeNull();
    expect(webHandoffUrl("", "subscriber", "s1")).toBeNull();
    expect(
      webHandoffUrl("https://host/with/path", "subscriber", "s1"),
    ).toBeNull();
  });

  it("warns that the link may ask for a sign-in", () => {
    // The in-app browser does not carry the app's session; say so up front.
    expect(WEB_HANDOFF_NOTE).toContain("sign in");
  });
});

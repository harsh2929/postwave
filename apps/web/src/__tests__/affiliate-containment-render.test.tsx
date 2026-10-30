import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import AffiliateDetailPage from "@/app/(dashboard)/app/affiliates/[id]/page";
import AffiliatesPage from "@/app/(dashboard)/app/affiliates/page";
import AffiliatesUnavailablePage from "@/app/(marketing)/affiliates/page";
import AffiliateTermsUnavailablePage from "@/app/(marketing)/legal/affiliate-terms/page";
import {
  createAffiliate,
  createPayout,
  getAffiliate,
  getAffiliateProgramPage,
  listAffiliates,
  listAllConversions,
  listConversions,
  listPayouts,
  markPayoutSent,
  updateAffiliate,
  updateConversionStatus,
} from "@/lib/affiliates-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("affiliate web containment", () => {
  it("renders both dashboard routes without network access or controls", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const listMarkup = renderToStaticMarkup(<AffiliatesPage />);
    const detailMarkup = renderToStaticMarkup(<AffiliateDetailPage />);
    const combined = `${listMarkup}\n${detailMarkup}`;

    expect(fetch).not.toHaveBeenCalled();
    expect(combined).toContain("Affiliate operations are unavailable");
    expect(combined).toContain("Affiliate record access is unavailable");
    expect(combined).toContain("No API access");
    expect(combined).not.toMatch(/<button|<form|<input|<select|<textarea/u);
    expect(combined).not.toMatch(
      /Create affiliate|Approve conversion|Initiate payout|Mark sent/u,
    );
  });

  it("renders public status pages without an application or commercial offer", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const marketing = renderToStaticMarkup(<AffiliatesUnavailablePage />);
    const terms = renderToStaticMarkup(<AffiliateTermsUnavailablePage />);
    const combined = `${marketing}\n${terms}`;

    expect(fetch).not.toHaveBeenCalled();
    expect(combined).toContain("Affiliate enrollment is closed");
    expect(combined).toContain("No affiliate program terms are in force");
    expect(combined).not.toMatch(/<button|<form|<input|mailto:/u);
    expect(combined).not.toMatch(/\$\d|%\s+of|Net-30|Apply now/u);
  });

  it("fails every retained affiliate adapter before production transport", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const calls = [
      getAffiliateProgramPage(),
      createAffiliate({ email: "partner@example.test", name: "Partner" }),
      listAffiliates(),
      getAffiliate("affiliate-1"),
      updateAffiliate("affiliate-1", { status: "approved" }),
      listConversions("affiliate-1"),
      listAllConversions("affiliate-1"),
      listPayouts("affiliate-1"),
      createPayout("affiliate-1"),
      markPayoutSent("affiliate-1", "payout-1", "external-1"),
      updateConversionStatus("affiliate-1", 1, "approved"),
    ];
    const results = await Promise.allSettled(calls);
    expect(results).toHaveLength(11);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(String(result.reason)).toMatch(/release-held/i);
      }
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

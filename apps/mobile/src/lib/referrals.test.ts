/**
 * Tests for lib/referrals.ts — the parsing half.
 *
 * The boundary half (do the constants still match the Go source?) is
 * referrals.boundary.test.ts, kept separate because it reads the filesystem
 * and the two fail for completely different reasons.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_REFERRAL_WINDOW,
  REFERRAL_EMPTY_WINDOW_DESCRIPTION,
  REFERRAL_PROGRAM_READ_ONLY_NOTE,
  REFERRAL_RUNTIME_AVAILABLE,
  REFERRAL_WINDOWS,
  isNoActiveProgramError,
  parseReferralFunnel,
  parseReferralLeaderboard,
  parseReferralPayouts,
  parseReferralProgram,
  parseReferralVariants,
  parseSubscriberReferral,
  parseTopReferrerCount,
  parseTopReferrers,
  payoutsSummaryLine,
  programSummaryLine,
  subscriberReferralErrorMessage,
  variantSummaryLine,
} from "./referrals";

describe("parseReferralFunnel", () => {
  it("reads the server's snake_case funnel", () => {
    expect(
      parseReferralFunnel({
        funnel: {
          conversions_7d: 3,
          conversions_30d: 11,
          conversions_90d: 40,
          clicks_total: 900,
          fraud_filtered_count: 2,
        },
      }),
    ).toEqual({
      conversions7d: 3,
      conversions30d: 11,
      conversions90d: 40,
      clicksTotal: 900,
      fraudFilteredCount: 2,
    });
  });

  it("keeps a genuine zero as zero", () => {
    const funnel = parseReferralFunnel({ funnel: { conversions_7d: 0 } });
    expect(funnel.conversions7d).toBe(0);
  });

  it("reports a MISSING measurement as null, never as zero", () => {
    // The screen renders null as an em-dash. Collapsing it to 0 would turn
    // "the server did not tell us" into "nobody referred anyone", which is a
    // different and much more alarming statement.
    const funnel = parseReferralFunnel({ funnel: {} });
    expect(funnel.conversions7d).toBeNull();
    expect(funnel.clicksTotal).toBeNull();
  });

  it("survives a non-object payload", () => {
    expect(parseReferralFunnel(null).conversions30d).toBeNull();
    expect(parseReferralFunnel("nope").conversions30d).toBeNull();
    expect(parseReferralFunnel({ funnel: 7 }).conversions30d).toBeNull();
  });

  it("rejects NaN and Infinity as measurements", () => {
    const funnel = parseReferralFunnel({
      funnel: { conversions_7d: Number.NaN, clicks_total: Number.POSITIVE_INFINITY },
    });
    expect(funnel.conversions7d).toBeNull();
    expect(funnel.clicksTotal).toBeNull();
  });
});

describe("parseReferralLeaderboard", () => {
  it("parses ranked rows", () => {
    const board = parseReferralLeaderboard({
      window_days: 90,
      items: [
        { referrer_email_masked: "a***@example.com", conversions: 12, milestone: 10, rank: 1 },
        { referrer_email_masked: "b***@example.com", conversions: 4, milestone: 0, rank: 2 },
      ],
    });
    expect(board.windowDays).toBe(90);
    expect(board.rows).toHaveLength(2);
    expect(board.rows[0]).toEqual({
      emailMasked: "a***@example.com",
      conversions: 12,
      milestone: 10,
      rank: 1,
    });
  });

  it("falls back to the mask rather than any other identity field", () => {
    const board = parseReferralLeaderboard({
      items: [{ conversions: 1, email: "real@example.com" }],
    });
    expect(board.rows[0]?.emailMasked).toBe("***");
    expect(JSON.stringify(board)).not.toContain("real@example.com");
  });

  it("drops rows with no conversion count instead of showing them as zero", () => {
    const board = parseReferralLeaderboard({
      items: [{ referrer_email_masked: "a***@x.com" }, { conversions: 2 }],
    });
    expect(board.rows).toHaveLength(1);
    expect(board.rows[0]?.conversions).toBe(2);
  });

  it("fills a missing rank from position", () => {
    const board = parseReferralLeaderboard({
      items: [{ conversions: 5 }, { conversions: 3 }],
    });
    expect(board.rows.map((r) => r.rank)).toEqual([1, 2]);
  });

  it("returns an empty list for a malformed envelope", () => {
    expect(parseReferralLeaderboard(undefined).rows).toEqual([]);
    expect(parseReferralLeaderboard({ items: "no" }).rows).toEqual([]);
  });
});

describe("parseTopReferrerCount", () => {
  it("counts the raw-UUID top referrers", () => {
    expect(parseTopReferrerCount({ top_referrers: [{}, {}, {}] })).toBe(3);
  });
  it("is null — not 0 — when the field is absent", () => {
    expect(parseTopReferrerCount({})).toBeNull();
  });
});

describe("parseReferralProgram", () => {
  it("parses milestones and sorts them by tier", () => {
    const program = parseReferralProgram({
      id: "prog-1",
      active: true,
      milestones: [
        { count: 10, reward_label: "Hoodie", reward_kind: "swag" },
        { count: 3, reward_label: "Sticker" },
      ],
      referee_reward_label: "10% off",
      verification_window_days: 14,
    });
    expect(program?.milestones.map((m) => m.count)).toEqual([3, 10]);
    expect(program?.milestones[0]?.rewardLabel).toBe("Sticker");
    expect(program?.milestones[1]?.rewardKind).toBe("swag");
    expect(program?.refereeRewardLabel).toBe("10% off");
    expect(program?.verificationWindowDays).toBe(14);
  });

  it("returns null when there is no programme id", () => {
    expect(parseReferralProgram({})).toBeNull();
    expect(parseReferralProgram({ id: "  " })).toBeNull();
  });

  it("skips milestones with no tier count", () => {
    const program = parseReferralProgram({
      id: "p",
      milestones: [{ reward_label: "Orphan" }, { count: 5 }],
    });
    expect(program?.milestones).toHaveLength(1);
  });

  it("treats a missing `active` as inactive rather than assuming", () => {
    expect(parseReferralProgram({ id: "p" })?.active).toBe(false);
  });
});

describe("isNoActiveProgramError", () => {
  it("recognises the 404 resting state on every shape the client can raise", () => {
    expect(isNoActiveProgramError({ status: 404 })).toBe(true);
    expect(isNoActiveProgramError({ code: "not_found" })).toBe(true);
    expect(isNoActiveProgramError(new Error("no active program"))).toBe(true);
  });

  it("does NOT swallow a real failure", () => {
    expect(isNoActiveProgramError({ status: 500 })).toBe(false);
    expect(isNoActiveProgramError(new Error("network request failed"))).toBe(false);
    expect(isNoActiveProgramError(null)).toBe(false);
    expect(isNoActiveProgramError("404")).toBe(false);
  });
});

/** The seven full-replace fields, empty — fixtures below render none of them. */
const EMPTY_REPLACE = {
  referee_reward_kind: "",
  referee_reward_label: "",
  referee_reward_image_asset_id: "",
  reward_value_cents: 0,
  reward_currency: "",
  reward_sku: "",
  verification_window_days: 0,
};

describe("programSummaryLine", () => {
  it("says so when nothing is configured", () => {
    expect(programSummaryLine(null)).toBe("No referral programme configured.");
  });

  it("summarises tiers and state", () => {
    expect(
      programSummaryLine({
        id: "p",
        active: true,
        milestones: [
          { count: 3, rewardLabel: "a", rewardKind: undefined, wireFields: {} },
          { count: 10, rewardLabel: "b", rewardKind: undefined, wireFields: {} },
        ],
        expiresAt: undefined,
        refereeRewardLabel: undefined,
        verificationWindowDays: undefined,
        replaceFields: EMPTY_REPLACE,
      }),
    ).toBe("Active · 2 tiers · top tier at 10 referrals");
  });

  it("singularises a one-tier, one-referral programme", () => {
    expect(
      programSummaryLine({
        id: "p",
        active: false,
        milestones: [{ count: 1, rewardLabel: "a", rewardKind: undefined, wireFields: {} }],
        expiresAt: undefined,
        refereeRewardLabel: undefined,
        verificationWindowDays: undefined,
        replaceFields: EMPTY_REPLACE,
      }),
    ).toBe("Inactive · 1 tier · top tier at 1 referral");
  });

  it("handles a programme with no tiers at all", () => {
    expect(
      programSummaryLine({
        id: "p",
        active: true,
        milestones: [],
        expiresAt: undefined,
        refereeRewardLabel: undefined,
        verificationWindowDays: undefined,
        replaceFields: EMPTY_REPLACE,
      }),
    ).toBe("Programme configured with no milestone tiers.");
  });
});

describe("window chips", () => {
  it("offers windows the server's clamp accepts", () => {
    // parseLeaderboardWindowDays clamps to [1,365]; a chip the server would
    // silently rewrite would make the heading disagree with the data.
    for (const w of REFERRAL_WINDOWS) {
      expect(w.days).toBeGreaterThan(0);
      expect(w.days).toBeLessThanOrEqual(365);
    }
    expect(REFERRAL_WINDOWS.map((w) => w.key)).toContain(DEFAULT_REFERRAL_WINDOW);
  });
});

/**
 * THE COPY THAT WENT FALSE.
 *
 * With `OperationalRuntimeAvailable` flipped to true server-side, every clause
 * of the old copy — "the referral runtime is off", "the public referral
 * redirect is unmounted", "no new conversion is being credited", "the endpoint
 * that issues it is behind the same closed runtime" — became a false statement
 * about live data. These assertions pin the strings that the app can actually
 * show a user, so reintroducing any of that wording while the gate is open
 * fails here rather than in front of an operator.
 */
describe("runtime-dependent copy", () => {
  const CLOSED_RUNTIME_CLAIMS = [
    /runtime is off/i,
    /redirect is unmounted/i,
    /no new conversion/i,
    /closed runtime/i,
    /this build cannot mint/i,
  ];

  it("matches every runtime claim to the world the mirror names", () => {
    // Guard the guard: say out loud which world the assertions below describe.
    // RE-CLOSED 2026-08-30 ("RELEASE REMAINS HELD…", referrals.go:46-52).
    // The empty-window description is CONDITIONAL on the mirror by design
    // (referralsCopy.ts:145-147): with the gate closed it must say that no new
    // conversion is being recorded — an empty window would otherwise read as
    // an ordinary quiet period. The read-only note renders in both worlds and
    // must stay neutral either way; the role is its subject, not the runtime.
    expect(REFERRAL_RUNTIME_AVAILABLE).toBe(false);
    expect(REFERRAL_EMPTY_WINDOW_DESCRIPTION).toMatch(/runtime is off/i);
    for (const claim of CLOSED_RUNTIME_CLAIMS) {
      expect(REFERRAL_PROGRAM_READ_ONLY_NOTE).not.toMatch(claim);
    }
  });

  it("still explains the empty window without inventing a cause for it", () => {
    expect(REFERRAL_EMPTY_WINDOW_DESCRIPTION).toContain(
      "Nobody has been credited with a referral inside the selected window",
    );
  });

  it("attributes the read-only programme card to the client, not the server", () => {
    // The distinction is the whole point: the server mounts
    // POST /api/v1/referral-programs, mobile simply does not author programmes.
    expect(REFERRAL_PROGRAM_READ_ONLY_NOTE).toMatch(/web or desktop app/);
  });
});

describe("parseTopReferrers", () => {
  it("reads the id, count and recency off the stats payload", () => {
    expect(
      parseTopReferrers({
        top_referrers: [
          { subscriber_id: "sub-1", count: 9, last_at: "2026-08-01T00:00:00Z" },
        ],
      }),
    ).toEqual([
      { subscriberId: "sub-1", count: 9, lastAt: "2026-08-01T00:00:00Z" },
    ]);
  });

  it("drops a row with no subscriber id — the only actionable field on it", () => {
    expect(
      parseTopReferrers({ top_referrers: [{ count: 4 }, { subscriber_id: "s" }] }),
    ).toHaveLength(1);
  });

  it("returns an empty list for a malformed envelope", () => {
    expect(parseTopReferrers(undefined)).toEqual([]);
    expect(parseTopReferrers({ top_referrers: "no" })).toEqual([]);
  });
});

describe("parseSubscriberReferral", () => {
  it("reads the minted code, its share URL and the unlocked tiers", () => {
    const view = parseSubscriberReferral({
      share_url: "https://example.test/r/abc123",
      ref_code: "abc123",
      referrals_count: 4,
      milestones_unlocked: [
        { count: 5, reward_label: "Hoodie" },
        { count: 1, reward_label: "Sticker", reward_kind: "swag" },
      ],
    });
    expect(view?.shareUrl).toBe("https://example.test/r/abc123");
    expect(view?.refCode).toBe("abc123");
    expect(view?.referralsCount).toBe(4);
    expect(view?.milestonesUnlocked.map((m) => m.count)).toEqual([1, 5]);
  });

  it("is null when there is no code and no link — never an empty share", () => {
    expect(parseSubscriberReferral({})).toBeNull();
    expect(parseSubscriberReferral({ ref_code: "  ", share_url: "" })).toBeNull();
  });

  it("keeps an absent count absent rather than calling it zero referrals", () => {
    expect(parseSubscriberReferral({ ref_code: "x" })?.referralsCount).toBeNull();
  });
});

describe("parseReferralPayouts", () => {
  const PAYLOAD = {
    items: [
      {
        id: "p1",
        referrer_id: "sub-1",
        milestone: 3,
        reward_label: "Free month",
        status: "pending",
        created_at: "2026-08-01T00:00:00Z",
      },
      {
        id: "p2",
        referrer_id: "sub-2",
        milestone: 1,
        reward_label: "Sticker",
        status: "paid",
        created_at: "2026-07-01T00:00:00Z",
      },
    ],
    total: 9,
  };

  it("reads the fulfilment rows and the server's unLIMITed total", () => {
    const list = parseReferralPayouts(PAYLOAD);
    expect(list.rows.map((r) => r.id)).toEqual(["p1", "p2"]);
    expect(list.rows[0]?.rewardLabel).toBe("Free month");
    expect(list.rows[0]?.status).toBe("pending");
    expect(list.total).toBe(9);
  });

  it("drops a row with no id — it has no identity and no handle", () => {
    expect(parseReferralPayouts({ items: [{ status: "paid" }] }).rows).toEqual([]);
  });

  it("keeps an absent total absent rather than assuming the rows in hand", () => {
    expect(parseReferralPayouts({ items: PAYLOAD.items }).total).toBeNull();
  });

  it("keeps an absent milestone absent rather than printing tier 0", () => {
    expect(
      parseReferralPayouts({ items: [{ id: "p", status: "paid" }] }).rows[0]
        ?.milestone,
    ).toBeNull();
  });

  it("preserves an unrecognised status verbatim", () => {
    expect(
      parseReferralPayouts({ items: [{ id: "p", status: "clawed_back" }] })
        .rows[0]?.status,
    ).toBe("clawed_back");
  });
});

describe("payoutsSummaryLine", () => {
  function row(id: string, status: string) {
    return {
      id,
      referrerId: "s",
      milestone: 1,
      rewardLabel: "r",
      status,
      createdAt: undefined,
    };
  }

  it("says so when nothing has been earned yet", () => {
    expect(payoutsSummaryLine({ rows: [], total: 0 })).toBe(
      "No milestone rewards have been recorded yet.",
    );
  });

  it("counts by status in lifecycle order, not payload order", () => {
    expect(
      payoutsSummaryLine({
        rows: [row("a", "paid"), row("b", "pending"), row("c", "pending")],
        total: 3,
      }),
    ).toBe("2 pending · 1 paid");
  });

  it("says which rows it is describing when the server has more", () => {
    // The alternative — "1 pending" over a page of 1 out of 40 — understates
    // the operator's actual workload, which is the one number this line owes.
    expect(
      payoutsSummaryLine({ rows: [row("a", "pending")], total: 40 }),
    ).toBe("1 pending · showing 1 of 40");
  });

  it("does not claim a truncation it was never told about", () => {
    expect(payoutsSummaryLine({ rows: [row("a", "paid")], total: null })).toBe(
      "1 paid",
    );
  });

  it("reports an unknown status rather than folding it into a known one", () => {
    expect(
      payoutsSummaryLine({ rows: [row("a", "clawed_back")], total: 1 }),
    ).toBe("1 clawed_back");
  });
});

describe("parseReferralVariants", () => {
  it("reads the arms, their split and their tier counts", () => {
    expect(
      parseReferralVariants({
        items: [
          {
            id: "v1",
            variant_key: "control",
            allocation_pct: 50,
            active: true,
            milestones: [{ count: 3 }],
          },
        ],
      }),
    ).toEqual([
      {
        id: "v1",
        key: "control",
        allocationPct: 50,
        active: true,
        milestoneCount: 1,
      },
    ]);
  });

  it("drops a nameless arm rather than rendering a percentage of nothing", () => {
    expect(
      parseReferralVariants({ items: [{ id: "v", allocation_pct: 50 }] }),
    ).toEqual([]);
  });

  it("treats a missing `active` as inactive rather than assuming", () => {
    expect(
      parseReferralVariants({ items: [{ variant_key: "b" }] })[0]?.active,
    ).toBe(false);
  });
});

describe("variantSummaryLine", () => {
  function variant(key: string, pct: number | null, active = true) {
    return { id: key, key, allocationPct: pct, active, milestoneCount: 0 };
  }

  it("is null when no arms are configured — the ordinary case, not a gap", () => {
    expect(variantSummaryLine([])).toBeNull();
    expect(variantSummaryLine(undefined)).toBeNull();
  });

  it("names each arm with its split and marks the dormant ones", () => {
    expect(
      variantSummaryLine([
        variant("control", 50),
        variant("variant_b", 50, false),
      ]),
    ).toBe("control 50% · variant_b 50% (inactive)");
  });

  it("prints an unsent allocation as unknown, never as 0%", () => {
    // 0% would say this arm receives no traffic. The payload said nothing.
    expect(variantSummaryLine([variant("control", null)])).toBe("control ?%");
  });
});

describe("subscriberReferralErrorMessage", () => {
  it("names the unset share base, which no amount of retrying fixes", () => {
    expect(subscriberReferralErrorMessage({ code: "share_base_missing" })).toMatch(
      /REFERRAL_SHARE_BASE_URL/,
    );
    expect(subscriberReferralErrorMessage({ status: 503 })).toMatch(
      /REFERRAL_SHARE_BASE_URL/,
    );
  });

  it("tells the caller to retry the one failure that is transient", () => {
    expect(subscriberReferralErrorMessage({ code: "code_contention" })).toMatch(
      /Try again/,
    );
    expect(subscriberReferralErrorMessage({ status: 409 })).toMatch(/Try again/);
  });

  it("falls back without echoing a server message written for nobody", () => {
    expect(
      subscriberReferralErrorMessage(new Error("pgx: connection reset")),
    ).toBe("Couldn't get this referrer's link.");
    expect(subscriberReferralErrorMessage(null)).toBe(
      "Couldn't get this referrer's link.",
    );
  });
});

/**
 * The persisted-cache shapes. TanStack's cache is written to disk by whichever
 * build of the app was installed at the time, so a value read back here is not
 * guaranteed to have been through this file's parser at all. A summary line is
 * never worth a red screen, so these assert the coercion rather than the copy.
 */
describe("payoutsSummaryLine against a stale cached envelope", () => {
  it("survives an envelope with no rows array", () => {
    expect(
      payoutsSummaryLine({ total: 3 } as unknown as Parameters<
        typeof payoutsSummaryLine
      >[0]),
    ).toBe("No milestone rewards have been recorded yet.");
  });

  it("ignores a non-numeric total instead of comparing against it", () => {
    expect(
      payoutsSummaryLine({
        rows: [
          {
            id: "a",
            referrerId: "s",
            milestone: 1,
            rewardLabel: "r",
            status: "paid",
            createdAt: undefined,
          },
        ],
        total: "9",
      } as unknown as Parameters<typeof payoutsSummaryLine>[0]),
    ).toBe("1 paid");
  });
});

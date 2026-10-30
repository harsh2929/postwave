/**
 * CampaignActivityFeed — the real helpers, imported.
 *
 * This file used to define its own `payloadCampaignId` and a `ringPrepend`
 * that production never had, and assert against those. A mirror test certifies
 * the mirror: the production function could have been deleted outright and
 * every case here would still have passed. The mirrors are gone; everything
 * below imports from `campaign-activity-feed-helpers`, which the component
 * also imports, so there is exactly one implementation under test.
 *
 * The back-fill is the row-6 deliverable and had NO coverage at all — the panel
 * opened blank on every campaign with history and the tests stayed green.
 */

import { describe, expect, it } from "vitest";

import {
  type AuditRowLike,
  type FeedEntry,
  RING_CAP,
  auditRowsToEntries,
  dedupeKeyForAuditRow,
  dedupeKeyForEvent,
  mergeBackfillEntries,
  payloadCampaignId,
} from "../../components/campaign-activity-feed-helpers";

/* ---------------------------------------------------------------- */
/* payloadCampaignId — the real one                                  */
/* ---------------------------------------------------------------- */

describe("payloadCampaignId", () => {
  it("pulls id off `campaign.*` payloads directly", () => {
    expect(payloadCampaignId("campaign.updated", { id: "c_1" })).toBe("c_1");
  });

  it("pulls campaign_id from approval.* payloads", () => {
    expect(
      payloadCampaignId("approval.requested", { campaign_id: "c_2" }),
    ).toBe("c_2");
  });

  it("falls back to resource_id for approval + resource_type=campaign", () => {
    expect(
      payloadCampaignId("approval.decided", {
        resource_type: "campaign",
        resource_id: "c_3",
      }),
    ).toBe("c_3");
  });

  it("audit.created only matches when resource_type is `campaign`", () => {
    expect(
      payloadCampaignId("audit.created", {
        resource_type: "subscriber",
        resource_id: "s_1",
      }),
    ).toBeNull();
    expect(
      payloadCampaignId("audit.created", {
        resource_type: "campaign",
        resource_id: "c_4",
      }),
    ).toBe("c_4");
  });

  it("returns null for unrelated payloads", () => {
    expect(payloadCampaignId("subscriber.added", { id: "sub_q" })).toBeNull();
  });

  it("prefers resource_id over campaign_id on audit.created", () => {
    // The only case where the `audit.created` branch differs from the generic
    // fallback below it, and therefore the only case that proves the branch is
    // doing anything: with both fields present the fallback would return
    // `campaign_id`. For an AUDIT row, `resource_id` is what the row is
    // actually about — a payload mentioning another campaign must not file the
    // entry under that other campaign's feed. Deleting the branch left all
    // other cases green, which is how this gap was found.
    expect(
      payloadCampaignId("audit.created", {
        resource_type: "campaign",
        resource_id: "c_self",
        campaign_id: "c_other",
      }),
    ).toBe("c_self");
  });
});

/* ---------------------------------------------------------------- */
/* Back-fill mapping                                                 */
/* ---------------------------------------------------------------- */

function row(
  over: Partial<AuditRowLike> & { id: string | number },
): AuditRowLike {
  return {
    action: "campaign.update",
    at: "2026-04-01T10:00:00Z",
    actorLabel: "ada@example.com",
    actorType: "human",
    ...over,
  };
}

describe("auditRowsToEntries", () => {
  it("maps an audit row onto a feed entry", () => {
    const [entry] = auditRowsToEntries(
      [row({ id: 7 })],
      () => "Subject changed",
    );
    expect(entry).toMatchObject({
      topic: "audit.campaign.update",
      at: "2026-04-01T10:00:00Z",
      actor: "ada@example.com",
      description: "Subject changed",
    });
  });

  it("falls back to actorType when there is no label", () => {
    // A system-performed action has no human label. An empty actor renders a
    // row that reads as if nobody did it.
    const [entry] = auditRowsToEntries(
      [row({ id: 8, actorLabel: null })],
      () => "Retention applied",
    );
    expect(entry?.actor).toBe("human");
  });

  it("gives every row a distinct React key even when ids repeat", () => {
    const entries = auditRowsToEntries(
      [row({ id: 9 }), row({ id: 9 })],
      () => "x",
    );
    expect(new Set(entries.map((e) => e.key)).size).toBe(2);
  });
});

/* ---------------------------------------------------------------- */
/* Cross-source de-duplication                                       */
/* ---------------------------------------------------------------- */

describe("dedupe identity", () => {
  it("gives two audit rows written in ONE transaction distinct identities", () => {
    // `audit_log.at` defaults to now(), which in Postgres is TRANSACTION START
    // time — so every row written by one request shares a byte-identical
    // timestamp. An identity built from (action, at) collapses them and a real
    // event disappears from the panel with nothing to show it existed.
    const entries = auditRowsToEntries(
      [
        row({ id: 1, at: "2026-04-01T10:00:00Z" }),
        row({ id: 2, at: "2026-04-01T10:00:00Z" }),
      ],
      () => "x",
    );
    expect(new Set(entries.map((e) => e.dedupeKey)).size).toBe(2);
    expect(mergeBackfillEntries([], entries)).toHaveLength(2);
  });

  it("keys a back-filled row on its row id", () => {
    expect(dedupeKeyForAuditRow(7)).toBe("audit-row:7");
  });

  it("keys a live event on topic and instant", () => {
    expect(dedupeKeyForEvent("campaign.sent", "t")).toBe("campaign.sent:t");
  });

  it("does NOT claim to match a live audit event to its back-filled row", () => {
    // Stated as a test so the limitation cannot quietly stop being true: the
    // two identities are deliberately different shapes. Making them match needs
    // the audit event id on the bus event AND on the list response; asserting
    // equality here with a hand-made timestamp would certify a fix that
    // production cannot reproduce, because the two `at` values come from
    // different clocks at different moments.
    const backfilled = auditRowsToEntries([row({ id: 1 })], () => "x")[0]!;
    const live = dedupeKeyForEvent("audit.created", "2026-04-01T10:00:00Z");
    expect(backfilled.dedupeKey).not.toBe(live);
  });
});

/* ---------------------------------------------------------------- */
/* Merge                                                             */
/* ---------------------------------------------------------------- */

function liveEntry(over: Partial<FeedEntry> & { key: string }): FeedEntry {
  const topic = over.topic ?? "campaign.updated";
  const at = over.at ?? "2026-04-01T10:00:00Z";
  return {
    topic,
    at,
    actor: "ada",
    description: "d",
    dedupeKey: `${topic}:${at}`,
    ...over,
  };
}

describe("mergeBackfillEntries", () => {
  it("shows back-filled history when the live feed is empty", () => {
    // The row-6 defect: the panel opened blank on every campaign that had not
    // changed since the slideover opened.
    const merged = mergeBackfillEntries(
      [],
      auditRowsToEntries([row({ id: 1 })], () => "Created"),
    );
    expect(merged).toHaveLength(1);
  });

  it("leaves a live entry untouched while adding back-filled history around it", () => {
    // The mid-flight race DOES still show one duplicate row. That is a real,
    // accepted cost, documented on dedupeKeyForAuditRow — so this asserts what
    // the merge actually guarantees (the row on screen is never replaced or
    // reordered away) rather than a de-duplication that cannot happen.
    const at = "2026-04-01T10:00:00Z";
    const already = liveEntry({ key: "live", topic: "audit.created", at });
    const merged = mergeBackfillEntries(
      [already],
      auditRowsToEntries([row({ id: 1, at })], () => "Subject changed"),
    );
    expect(
      merged.some((e) => e.key === "live"),
      "the row already on screen was dropped",
    ).toBe(true);
  });

  it("keeps a genuinely different event from the same instant", () => {
    const at = "2026-04-01T10:00:00Z";
    const merged = mergeBackfillEntries(
      [liveEntry({ key: "live", topic: "campaign.sent", at })],
      auditRowsToEntries([row({ id: 1, at })], () => "Subject changed"),
    );
    expect(merged).toHaveLength(2);
  });

  it("orders newest-first across both sources", () => {
    const merged = mergeBackfillEntries(
      [liveEntry({ key: "live", at: "2026-04-01T09:00:00Z" })],
      auditRowsToEntries(
        [row({ id: 1, at: "2026-04-01T11:00:00Z" })],
        () => "Newer",
      ),
    );
    expect(merged.map((e) => e.at)).toEqual([
      "2026-04-01T11:00:00Z",
      "2026-04-01T09:00:00Z",
    ]);
  });

  it("caps the merged feed at the ring size", () => {
    const backfill = auditRowsToEntries(
      Array.from({ length: 30 }, (_, i) =>
        row({ id: i, at: `2026-04-01T10:00:${String(i).padStart(2, "0")}Z` }),
      ),
      () => "x",
    );
    expect(mergeBackfillEntries([], backfill)).toHaveLength(RING_CAP);
  });

  it("keeps the NEWEST when capping, not the first ones seen", () => {
    // Truncating before sorting would keep the oldest 20 of 30 and silently
    // hide everything recent — the panel would look stale rather than short.
    const backfill = auditRowsToEntries(
      Array.from({ length: 30 }, (_, i) =>
        row({ id: i, at: `2026-04-01T10:00:${String(i).padStart(2, "0")}Z` }),
      ),
      () => "x",
    );
    const merged = mergeBackfillEntries([], backfill);
    expect(merged[0]?.at).toBe("2026-04-01T10:00:29Z");
    expect(merged[merged.length - 1]?.at).toBe("2026-04-01T10:00:10Z");
  });
});

// The argument order of mergeBackfillEntries is load-bearing, and only here.
//
// An adversarial review swapped `merge(prev, backfilled)` to
// `merge(backfilled, prev)` in the component and nothing failed. That mutation
// is invisible at the component level for a real reason: cross-source
// de-duplication is deliberately impossible (a live key and an audit key are
// different shapes), and the merge sorts by `at`, so the order of the two
// arrays changes nothing — EXCEPT when a live entry and a back-filled one carry
// the same instant.
//
// That case is exactly what the function's contract promises to handle: the
// live entry is already on screen, and swapping it for an identical-looking row
// is a flicker the user sees for no gain. Sort stability is what delivers it,
// which makes the argument order the whole mechanism.
describe("merge order on a tie", () => {
  it("keeps the live entry above a back-filled one stamped the same instant", () => {
    const at = "2026-08-06T10:00:00Z";
    const live: FeedEntry[] = [
      {
        key: "live-1",
        topic: "campaign.updated",
        at,
        actor: "live-actor",
        description: "Campaign updated",
        dedupeKey: "live:campaign.updated:" + at,
      },
    ];
    const backfilled: FeedEntry[] = [
      {
        key: "audit-1",
        topic: "audit.campaign.updated",
        at,
        actor: "audit-actor",
        description: "Campaign updated",
        dedupeKey: "audit:99",
      },
    ];

    const merged = mergeBackfillEntries(live, backfilled);
    expect(merged).toHaveLength(2);
    expect(merged[0]?.actor).toBe("live-actor");

    // And the reverse call really does produce the other order — otherwise the
    // assertion above would be passing on something other than the argument
    // order, and would keep passing if the mechanism were removed.
    const swapped = mergeBackfillEntries(backfilled, live);
    expect(swapped[0]?.actor).toBe("audit-actor");
  });
});

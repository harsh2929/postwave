// SPDX-License-Identifier: AGPL-3.0-only
//
// Sending a campaign has to drop the cached campaign lists on BOTH surfaces
// that can send it.
//
// The list client and the detail client carry near-duplicate handleSend
// handlers, and they had drifted. The list client invalidated unconditionally
// after the response branch. The detail client's only invalidation lived inside
// `applyUpdated`, which it calls under `if ("id" in res)` — and a real queued
// send resolves to CampaignQueueResponse, which carries `campaign_id`, not
// `id`. So the invalidation ran exactly when the send had NOT queued: the
// campaign moved to `sending` on the server while every cached view kept the
// pre-send status.
//
// The detail page also swallowed `approval_id` on the approval path, which is
// the only handle an operator has for chasing a pending approval.
//
// These are structural assertions on two hand-written handlers rather than a
// render test, because what went wrong is which branch the call sits in.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CAMPAIGNS = resolve(
  process.cwd(),
  "src/app/(dashboard)/app/campaigns",
);

// Route pages are intentionally tiny deferred-loader wrappers. Pin the modules
// that own the live handlers so code splitting cannot make this guard inspect
// a wrapper with no behaviour.
const LIST = readFileSync(join(CAMPAIGNS, "campaigns-client.tsx"), "utf8");
const DETAIL = readFileSync(
  join(CAMPAIGNS, "[id]/campaign-detail-client.tsx"),
  "utf8",
);

/** The body of `const handleSend = async () => { … }` in a client module. */
function handleSend(source: string, label: string): string {
  const start = source.indexOf("const handleSend = async ()");
  expect(start, `${label}: handleSend not found`).toBeGreaterThan(-1);
  const end = source.indexOf("\n  };", start);
  expect(end, `${label}: handleSend body not delimited`).toBeGreaterThan(start);
  return source.slice(start, end);
}

const SURFACES = [
  { label: "campaigns list", body: handleSend(LIST, "campaigns list") },
  { label: "campaign detail", body: handleSend(DETAIL, "campaign detail") },
];

describe("campaign send invalidates cached lists", () => {
  it("reads both handlers", () => {
    // Guard the guard: an empty body makes every assertion below vacuous, and
    // both surfaces must genuinely call the send API.
    for (const s of SURFACES) {
      expect(s.body.length, s.label).toBeGreaterThan(200);
      expect(s.body, s.label).toContain("await sendCampaign(");
    }
  });

  it("invalidates outside the `\"id\" in res` branch on both surfaces", () => {
    // The bug in one sentence: the only invalidate was reachable solely via a
    // response shape a queued send never produces. Assert the call is not
    // nested under that condition.
    for (const { label, body } of SURFACES) {
      const guard = body.indexOf('"id" in res');
      expect(guard, `${label}: no "id" in res branch`).toBeGreaterThan(-1);
      const invalidations = [
        ...body.matchAll(/invalidateCampaigns\(\)|invalidateQueries\(/g),
      ].map((m) => m.index!);
      expect(invalidations.length, `${label}: never invalidates`).toBeGreaterThan(
        0,
      );
      expect(
        invalidations.some((at) => at > guard),
        `${label}: only invalidates inside the "id" in res branch`,
      ).toBe(true);
    }
  });

  it("invalidates on the approval-required path too", () => {
    // That path returns early. An approval request changes server state, so
    // returning without invalidating leaves the list showing a campaign that
    // looks untouched.
    for (const { label, body } of SURFACES) {
      const approval = body.indexOf('"approval_required"');
      expect(approval, `${label}: no approval branch`).toBeGreaterThan(-1);
      const earlyReturn = body.indexOf("return;", approval);
      expect(earlyReturn, `${label}: approval branch does not return`)
        .toBeGreaterThan(-1);
      const between = body.slice(approval, earlyReturn);
      expect(
        /invalidateCampaigns\(\)|invalidateQueries\(/.test(between),
        `${label}: returns from the approval branch without invalidating`,
      ).toBe(true);
    }
  });

  it("surfaces the approval id on both surfaces", () => {
    for (const { label, body } of SURFACES) {
      expect(body, `${label}: drops approval_id`).toContain("res.approval_id");
    }
  });

  it("validates persisted link-bearing content before either send call", () => {
    for (const { label, body } of SURFACES) {
      const validation = body.indexOf("validateCampaignContentLinks(");
      const send = body.indexOf("await sendCampaign(");
      expect(validation, `${label}: missing content-link guard`).toBeGreaterThan(
        -1,
      );
      expect(validation, `${label}: validates after queueing`).toBeLessThan(send);
    }
    expect(
      SURFACES[0]?.body,
      "campaigns list: validates only its body-free list projection",
    ).toContain("await getCampaign(");
  });
});

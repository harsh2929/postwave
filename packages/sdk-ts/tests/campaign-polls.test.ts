import { describe, expect, it, vi } from "vitest";

import { PostwaveClient } from "../src/index.js";

const campaignId = "11111111-1111-4111-8111-111111111111";
const revisionId = "22222222-2222-4222-8222-222222222222";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("CampaignPollsResource", () => {
  it("uses authenticated campaign routes and preserves exclusion semantics", async () => {
    const seen: Array<{
      method: string;
      url: string;
      headers: Record<string, string>;
      body?: unknown;
    }> = [];
    const definition = {
      id: "33333333-3333-4333-8333-333333333333",
      campaign_id: campaignId,
      poll_key: "venue:primary",
      question: "Which venue?",
      two_step_required: false,
      options: [
        { option_key: "north", label: "North hall", position: 0 },
        { option_key: "south", label: "South hall", position: 1 },
      ],
      created_at: "2026-08-13T00:00:00Z",
    };
    const tally = {
      poll_id: definition.id,
      poll_key: definition.poll_key,
      question: definition.question,
      options: [
        { option_key: "north", label: "North hall", counted: 2 },
        { option_key: "south", label: "South hall", counted: 1 },
      ],
      machine_excluded: 4,
      unclassified_excluded: 9,
      voided_multi_option: 3,
      previewed_only: 12,
    };
    const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
      seen.push({
        method: String(init.method),
        url,
        headers: init.headers as Record<string, string>,
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      });
      if (url.endsWith("/tally")) return json(tally);
      if (init.method === "GET") {
        return json({ items: [definition], next_cursor: "pwcp1.next" });
      }
      return json(definition, 201);
    });
    const client = new PostwaveClient({
      apiKey: "pw_campaign_polls",
      fetch,
      retries: 0,
    });

    const created = await client.campaignPolls.materialize(campaignId, {
      content_revision_id: revisionId,
      poll_key: "venue:primary",
      two_step_required: false,
      closes_at: "2026-09-01T12:00:00Z",
    });
    const listed = await client.campaignPolls.list(campaignId);
    const result = await client.campaignPolls.tally(
      campaignId,
      "venue:primary",
    );

    const base = `https://api.moosewave.com/api/v1/campaigns/${campaignId}/polls`;
    expect(seen.map(({ method, url }) => [method, url])).toEqual([
      ["POST", base],
      ["GET", base],
      ["GET", `${base}/venue%3Aprimary/tally`],
    ]);
    expect(
      seen.every(
        ({ headers }) => headers.Authorization === "Bearer pw_campaign_polls",
      ),
    ).toBe(true);
    expect(seen[0]?.body).toEqual({
      content_revision_id: revisionId,
      poll_key: "venue:primary",
      two_step_required: false,
      closes_at: "2026-09-01T12:00:00Z",
    });
    expect(created.question).toBe("Which venue?");
    expect(listed.items).toHaveLength(1);
    expect(listed.next_cursor).toBe("pwcp1.next");
    expect(result.unclassified_excluded).toBe(9);
    expect(
      result.options.reduce((total, option) => total + option.counted, 0),
    ).toBe(3);
    expect("tenant_id" in result).toBe(false);
  });

  it("passes a bounded opaque keyset cursor without interpreting it", async () => {
    const cursor = "pwcp1.a2lk.eyJ2IjoxfQ.signature";
    const fetch = vi.fn(async (_url: string) => json({ items: [] }));
    const client = new PostwaveClient({ apiKey: "pw_campaign_polls", fetch });

    await client.campaignPolls.list(campaignId, { limit: 25, cursor });

    expect(fetch.mock.calls[0]?.[0]).toBe(
      `https://api.moosewave.com/api/v1/campaigns/${campaignId}/polls?limit=25&cursor=${cursor}`,
    );
  });

  it("rejects invalid list bounds and cursors before transport", () => {
    const fetch = vi.fn();
    const client = new PostwaveClient({ apiKey: "pw_campaign_polls", fetch });

    expect(() => client.campaignPolls.list(campaignId, { limit: 101 })).toThrow(
      /integer from 1 to 100/,
    );
    expect(() =>
      client.campaignPolls.list(campaignId, { cursor: "not a cursor" }),
    ).toThrow(/opaque ASCII cursor/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects caller-authored poll meaning before transport", async () => {
    const fetch = vi.fn();
    const client = new PostwaveClient({ apiKey: "pw_campaign_polls", fetch });

    expect(() =>
      client.campaignPolls.materialize(campaignId, {
        content_revision_id: revisionId,
        poll_key: "venue",
        question: "Caller-authored question",
        options: [{ option_key: "forged", label: "Forged" }],
      } as never),
    ).toThrow(/question and options come from the semantic AST/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects unstable poll references before transport", () => {
    const fetch = vi.fn();
    const client = new PostwaveClient({ apiKey: "pw_campaign_polls", fetch });

    expect(() =>
      client.campaignPolls.tally(campaignId, "not/a/reference"),
    ).toThrow(/stable ASCII reference/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

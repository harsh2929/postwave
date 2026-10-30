import { describe, expect, it, vi } from "vitest";

import {
  AGENCY_BILLING_MODE_RELEASE_HELD_CODE,
  AGENCY_BRANDING_UPDATE_RELEASE_HELD_CODE,
  AGENCY_CHILD_CREATE_RELEASE_HELD_CODE,
  AGENCY_CHILD_UNLINK_RELEASE_HELD_CODE,
  AGENCY_INVOICE_PREVIEW_RELEASE_HELD_CODE,
  AgencyReleaseHeldError,
  ParseError,
  PostwaveClient,
  decodeAgencyBranding,
  decodeAgencyChildrenPage,
} from "../src/index.js";

const child = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "child-one",
  name: "Child One",
  tier: "studio",
  parent_tenant_id: "22222222-2222-4222-8222-222222222222",
  billing_mode: "self",
  reseller_markup_bps: 0,
  whitelabel_enabled: false,
  created_at: "2026-09-12T08:00:00Z",
  updated_at: "2026-09-12T08:00:01Z",
} as const;

const branding = {
  whitelabel_enabled: false,
  brand_name: "",
  custom_domain: "",
  logo_url: "",
  primary_color: "",
  support_email: "",
  legal_entity: "",
  updated_at: "2026-09-12T08:00:01Z",
  etag: '"agency-branding:22222222-2222-4222-8222-222222222222:v0"',
} as const;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("AgencyResource bounded release contract", () => {
  it("performs transport only for the bounded roster and stored branding reads", async () => {
    const fetch = vi.fn(async (url: string) =>
      new URL(url).pathname.endsWith("/children")
        ? json({
            children: [child],
            count: 1,
            has_more: true,
            next_cursor: "next_1",
          })
        : json(branding),
    );
    const client = new PostwaveClient({
      apiKey: "pw_agency",
      tenantId: "parent",
      fetch,
      retries: 0,
    });

    await expect(
      client.agency.listChildren({ limit: 25, cursor: "prior_1" }),
    ).resolves.toEqual({
      children: [child],
      count: 1,
      has_more: true,
      next_cursor: "next_1",
    });
    await expect(client.agency.getBranding()).resolves.toEqual(branding);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://api.moosewave.com/api/v1/agency/children?limit=25&cursor=prior_1",
    );
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "https://api.moosewave.com/api/v1/agency/branding",
    );
  });

  it("fails all five held capabilities locally with typed non-retryable proof", async () => {
    const fetch = vi.fn();
    const client = new PostwaveClient({
      apiKey: "pw_agency",
      fetch,
      retries: 9,
    });
    const calls = [
      client.agency.createChild({ slug: "child", name: "Child" }),
      client.agency.unlinkChild(child.id),
      client.agency.updateBranding({ brand_name: "Brand" }),
      client.agency.setBillingMode({
        target_tenant_id: child.id,
        mode: "self",
        reason: "Operator request",
      }),
      client.agency.invoicePreview(30),
    ];
    const codes = [
      AGENCY_CHILD_CREATE_RELEASE_HELD_CODE,
      AGENCY_CHILD_UNLINK_RELEASE_HELD_CODE,
      AGENCY_BRANDING_UPDATE_RELEASE_HELD_CODE,
      AGENCY_BILLING_MODE_RELEASE_HELD_CODE,
      AGENCY_INVOICE_PREVIEW_RELEASE_HELD_CODE,
    ];

    for (const [index, call] of calls.entries()) {
      await expect(call).rejects.toMatchObject({
        name: "AgencyReleaseHeldError",
        status: 503,
        code: codes[index],
        retryable: false,
        committed: false,
      });
      await expect(call).rejects.toBeInstanceOf(AgencyReleaseHeldError);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects invalid pagination and malformed read envelopes", () => {
    const fetch = vi.fn();
    const client = new PostwaveClient({
      apiKey: "pw_agency",
      fetch,
      retries: 0,
    });

    for (const limit of [0, 201, 1.5, Number.NaN]) {
      expect(() => client.agency.listChildren({ limit })).toThrow(RangeError);
    }
    for (const cursor of ["", "with space", "x".repeat(513)]) {
      expect(() => client.agency.listChildren({ cursor })).toThrow(RangeError);
    }
    expect(fetch).not.toHaveBeenCalled();

    expect(() =>
      decodeAgencyChildrenPage({
        children: [child],
        count: 2,
        has_more: false,
      }),
    ).toThrow(ParseError);
    expect(() =>
      decodeAgencyChildrenPage({
        children: [],
        count: 0,
        has_more: false,
        next_cursor: "should-not-exist",
      }),
    ).toThrow(ParseError);
    expect(() => decodeAgencyBranding({ ...branding, secret: "leak" })).toThrow(
      ParseError,
    );
    expect(() =>
      decodeAgencyChildrenPage({
        children: [{ ...child, slug: "a".repeat(63) }],
        count: 1,
        has_more: false,
      }),
    ).not.toThrow();
    expect(() =>
      decodeAgencyChildrenPage({
        children: [{ ...child, slug: "a".repeat(64) }],
        count: 1,
        has_more: false,
      }),
    ).toThrow(ParseError);
    for (const host of ["127.0.0.1", "127.1", "0177.0.0.1", "0x7f.0.0.1"]) {
      expect(() =>
        decodeAgencyBranding({ ...branding, custom_domain: host }),
      ).toThrow(ParseError);
      expect(() =>
        decodeAgencyBranding({
          ...branding,
          logo_url: `https://${host}/logo.svg`,
        }),
      ).toThrow(ParseError);
    }
  });

  it("rejects a server page larger than the requested bound", async () => {
    const fetch = vi.fn(async () =>
      json({
        children: [
          child,
          { ...child, id: "33333333-3333-4333-8333-333333333333" },
        ],
        count: 2,
        has_more: false,
      }),
    );
    const client = new PostwaveClient({
      apiKey: "pw_agency",
      fetch,
      retries: 0,
    });
    await expect(
      client.agency.listChildren({ limit: 1 }),
    ).rejects.toBeInstanceOf(ParseError);
  });
});

/**
 * Sunset (list-hygiene) surface at the transport seam, plus the pure policy
 * mirror of the server's validatePolicy (handlers.go:343) so a bad draft
 * fails at the field instead of as a round-tripped 400.
 *
 * The RUN endpoint is deliberately untested because it is deliberately
 * unshipped: the desktop anchor withholds execution as draft mode and this
 * client matches (lib/listHygiene.ts header). The invariant that IS pinned:
 * every save goes up paused (`enabled: false`), create and update alike.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSunsetPolicy,
  fetchSunsetExecutions,
  fetchSunsetPolicies,
  updateSunsetPolicy,
} from "./listsHygiene";
import {
  parseExcludedTagsInput,
  sunsetCriteriaLine,
  sunsetPolicyProblem,
} from "@/lib/listHygiene";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

beforeEach(() => rawRequest.mockReset());

// camelCase on the wire — the sunset package predates the snake_case style.
const POLICY = {
  id: "p1",
  tenantId: "t",
  name: "Sunset 180d",
  inactiveDays: 180,
  action: "suppress",
  enabled: true,
  excludedTags: ["vip"],
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
};

describe("sunset policy reads", () => {
  it("parses the camelCase policy rows", async () => {
    rawRequest.mockResolvedValue({ data: { items: [POLICY] }, error: null });
    const rows = await fetchSunsetPolicies();
    expect(rows).toEqual([
      {
        id: "p1",
        name: "Sunset 180d",
        inactiveDays: 180,
        action: "suppress",
        enabled: true,
        excludedTags: ["vip"],
        updatedAt: "2026-08-01T00:00:00Z",
      },
    ]);
    expect(rawRequest).toHaveBeenCalledWith("GET", "/api/v1/sunset/policies");
  });

  it("parses executions", async () => {
    rawRequest.mockResolvedValue({
      data: {
        items: [
          {
            id: "e1",
            policyId: "p1",
            subscriberId: "s9",
            actionTaken: "suppress",
            reason: "inactive 201d",
            executedAt: "2026-08-25T00:00:00Z",
          },
        ],
      },
      error: null,
    });
    const rows = await fetchSunsetExecutions("p1");
    expect(rows[0]).toMatchObject({
      actionTaken: "suppress",
      reason: "inactive 201d",
    });
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/sunset/policies/p1/executions?limit=50",
    );
  });

  it("surfaces a failed read (an admin 403 must not render as 'no policies')", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { message: "forbidden", status: 403 },
    });
    await expect(fetchSunsetPolicies()).rejects.toMatchObject({ status: 403 });
  });
});

describe("sunset policy writes", () => {
  const draft = {
    name: " Sunset 180d ",
    inactiveDays: 180,
    action: "suppress" as const,
    excludedTags: ["vip"],
  };

  it("POSTs a trimmed create body that is ALWAYS paused", async () => {
    rawRequest.mockResolvedValue({ data: POLICY, error: null });
    await createSunsetPolicy(draft);
    expect(rawRequest).toHaveBeenCalledWith("POST", "/api/v1/sunset/policies", {
      name: "Sunset 180d",
      inactiveDays: 180,
      action: "suppress",
      enabled: false,
      excludedTags: ["vip"],
    });
  });

  it("PUTs an update to the policy's path — and it too stays paused", async () => {
    rawRequest.mockResolvedValue({ data: POLICY, error: null });
    await updateSunsetPolicy("p1", draft);
    expect(rawRequest.mock.calls[0]?.[0]).toBe("PUT");
    expect(rawRequest.mock.calls[0]?.[1]).toBe("/api/v1/sunset/policies/p1");
    expect(rawRequest.mock.calls[0]?.[2]).toMatchObject({ enabled: false });
  });

  it("surfaces a refused write instead of resolving", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { message: "forbidden", status: 403 },
    });
    await expect(createSunsetPolicy(draft)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("ships no run call — execution is desktop-parity withheld", async () => {
    // If someone re-adds runSunsetPolicy, this file must be revisited along
    // with the draft-mode note in the sheet — see lib/listHygiene.ts header.
    const mod = await import("./listsHygiene");
    expect("runSunsetPolicy" in mod).toBe(false);
  });
});

describe("sunsetPolicyProblem (mirror of server validatePolicy)", () => {
  const ok = {
    name: "x",
    inactiveDays: 90,
    action: "tag" as const,
    excludedTags: [],
  };
  it("accepts what the server accepts", () => {
    expect(sunsetPolicyProblem(ok)).toBeNull();
  });
  it("rejects what the server rejects, at the same bounds", () => {
    expect(sunsetPolicyProblem({ ...ok, name: " " })).not.toBeNull();
    expect(sunsetPolicyProblem({ ...ok, inactiveDays: 29 })).not.toBeNull();
    expect(sunsetPolicyProblem({ ...ok, inactiveDays: 731 })).not.toBeNull();
    expect(sunsetPolicyProblem({ ...ok, inactiveDays: 30 })).toBeNull();
    expect(sunsetPolicyProblem({ ...ok, inactiveDays: 730 })).toBeNull();
  });
});

describe("row copy", () => {
  it("describes the criteria the way desktop does", () => {
    expect(
      sunsetCriteriaLine({
        inactiveDays: 180,
        action: "suppress",
        excludedTags: ["vip", "partner"],
      }),
    ).toBe("Inactive ≥ 180 days → Suppress · excludes vip, partner");
    expect(
      sunsetCriteriaLine({ inactiveDays: 90, action: "tag", excludedTags: [] }),
    ).toBe("Inactive ≥ 90 days → Tag");
  });

  it("splits, trims and dedupes the excluded-tags input", () => {
    expect(parseExcludedTagsInput(" vip, partner ,vip,, ")).toEqual([
      "vip",
      "partner",
    ]);
  });
});

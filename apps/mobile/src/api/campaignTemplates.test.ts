/**
 * The transport seam for the template library's lifecycle pair and the
 * catalog-control query params. Same idiom as audienceDestinations.test.ts:
 * `rawRequest` mocked, asserting verbs, paths, headers and unwrapping —
 * because `rawRequest` resolves to the {data,error} ENVELOPE and a
 * body-driven test cannot see this seam.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("./request", () => ({
  rawRequest,
  checkedApiResult: async (
    promise: Promise<{
      error: { message: string; status?: number | undefined } | null;
    }>,
  ) => {
    const result = await promise;
    if (result.error) {
      const err = new Error(result.error.message) as Error & {
        status?: number | undefined;
      };
      err.status = result.error.status;
      throw err;
    }
    return result;
  },
}));

const { archiveTemplate, restoreTemplate, templateSearchPath } = await import(
  "./campaignTemplates"
);

beforeEach(() => {
  rawRequest.mockReset();
});

const TEMPLATE_BODY = {
  id: "tpl-1",
  slug: "spring",
  name: "Spring launch",
  subject: "s",
  variables: [],
  tags: [],
  template_kind: "editable",
  review_status: "approved",
  source_license_status: "owned",
  archived_at: "2026-08-01T10:00:00Z",
};

describe("the lifecycle pair", () => {
  it("PATCHes /{id}/archive carrying the strong If-Match verbatim", async () => {
    rawRequest.mockResolvedValue({ data: TEMPLATE_BODY, error: null });
    const row = await archiveTemplate("tpl-1", '"v7"');
    expect(rawRequest).toHaveBeenCalledWith(
      "PATCH",
      "/api/v1/campaign-templates/tpl-1/archive",
      undefined,
      { headers: { "If-Match": '"v7"' } },
    );
    // Envelope unwrapped before parsing: a parsed row proves it.
    expect(row?.id).toBe("tpl-1");
    expect(row?.archivedAt).toBe("2026-08-01T10:00:00Z");
  });

  it("PATCHes /{id}/restore for the reverse verb", async () => {
    rawRequest.mockResolvedValue({
      data: { ...TEMPLATE_BODY, archived_at: undefined },
      error: null,
    });
    await restoreTemplate("tpl-1", '"v8"');
    expect(rawRequest).toHaveBeenCalledWith(
      "PATCH",
      "/api/v1/campaign-templates/tpl-1/restore",
      undefined,
      { headers: { "If-Match": '"v8"' } },
    );
  });

  it("fails CLOSED on a weak or missing tag instead of collecting a 428", async () => {
    // requireTemplateIfMatch 428s on absence and 412s on W/-prefixed or
    // unquoted values; the client refuses before the round trip.
    await expect(archiveTemplate("tpl-1", "")).rejects.toThrow(/Reload/);
    await expect(archiveTemplate("tpl-1", 'W/"v7"')).rejects.toThrow(/Reload/);
    await expect(restoreTemplate("tpl-1", "v7")).rejects.toThrow(/Reload/);
    expect(rawRequest).not.toHaveBeenCalled();
  });
});

describe("templateSearchPath catalog controls", () => {
  it("threads source, favorited, archived and sort through as query params", () => {
    const path = templateSearchPath({
      query: "spring",
      goal: "promotional",
      source: "platform",
      favorited: true,
      archived: "active",
      sort: "most_used",
    });
    expect(path).toContain("query=spring");
    expect(path).toContain("goal=promotional");
    expect(path).toContain("source=platform");
    expect(path).toContain("favorited=1");
    expect(path).toContain("archived=active");
    expect(path).toContain("sort=most_used");
  });

  it("selects the archived shelf via archived=archived", () => {
    expect(templateSearchPath({ archived: "archived" })).toContain(
      "archived=archived",
    );
  });
});

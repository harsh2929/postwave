/**
 * The transport seam for template discovery. `rawRequest` resolves to the
 * `{data, error}` ENVELOPE — handing it to a parser yields null/[] on every
 * real response while body-driven tests stay green (the failure
 * src/api/audienceDestinations.test.ts documents) — so the seam is tested
 * with `rawRequest` mocked: verbs, paths, If-Match, and unwrapping.
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

const {
  createTemplateSavedSearch,
  deleteTemplateSavedSearch,
  fetchSavedSearchResults,
  fetchTemplateCompare,
  fetchTemplateStats,
  recordTemplateView,
  templateComparePath,
} = await import("./templateDiscovery");

beforeEach(() => {
  rawRequest.mockReset();
});

describe("templateComparePath", () => {
  it("repeats ?template= per identifier — the form the handler reads first", () => {
    expect(templateComparePath(["a", "b"])).toBe(
      "/api/v1/campaign-templates/compare?template=a&template=b",
    );
  });
});

describe("fetchTemplateCompare", () => {
  it("unwraps the envelope before parsing", async () => {
    rawRequest.mockResolvedValue({
      data: {
        items: [
          {
            requested_identifier: "tpl-1",
            template: {
              id: "tpl-1",
              slug: "s",
              name: "Spring",
              subject: "x",
              variables: [],
              tags: [],
              template_kind: "editable",
              review_status: "approved",
              source_license_status: "owned",
            },
          },
        ],
        unavailable_identifiers: [],
      },
      error: null,
    });
    const result = await fetchTemplateCompare(["tpl-1", "tpl-2"]);
    // parseTemplateCompare(envelope) would yield zero items; a parsed row
    // proves the seam unwrapped before parsing.
    expect(result.items.map((t) => t.id)).toEqual(["tpl-1"]);
  });
});

describe("recordTemplateView", () => {
  it("POSTs the encoded id to /{id}/view with no body", async () => {
    rawRequest.mockResolvedValue({ data: { ok: true }, error: null });
    await recordTemplateView("tpl 1");
    expect(rawRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/campaign-templates/tpl%201/view",
    );
  });
});

describe("saved searches", () => {
  it("POSTs {name, filters} on create", async () => {
    rawRequest.mockResolvedValue({ data: { id: "s1" }, error: null });
    await createTemplateSavedSearch({
      name: "Spring promos",
      filters: { q: "spring", archived: "active" },
    });
    expect(rawRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/campaign-template-saved-searches",
      { name: "Spring promos", filters: { q: "spring", archived: "active" } },
    );
  });

  it("DELETEs with the strong If-Match the route demands", async () => {
    rawRequest.mockResolvedValue({ data: { ok: true }, error: null });
    await deleteTemplateSavedSearch("s1", '"v3"');
    expect(rawRequest).toHaveBeenCalledWith(
      "DELETE",
      "/api/v1/campaign-template-saved-searches/s1",
      undefined,
      { headers: { "If-Match": '"v3"' } },
    );
  });

  it("pages results on the opaque cursor, passed back VERBATIM", async () => {
    rawRequest.mockResolvedValue({
      data: { items: [], next_cursor: null },
      error: null,
    });
    await fetchSavedSearchResults("s1", "b64cursor==");
    const path = rawRequest.mock.calls[0]![1] as string;
    expect(path).toContain("/api/v1/campaign-template-saved-searches/s1/results");
    expect(path).toContain("cursor=b64cursor%3D%3D");
  });
});

describe("fetchTemplateStats", () => {
  it("surfaces an envelope error as a throw, never a silent null", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { message: "discovery_state_unavailable", status: 503 },
    });
    await expect(fetchTemplateStats()).rejects.toThrow(/discovery/);
  });
});

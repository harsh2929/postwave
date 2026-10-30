/**
 * The transport seam for the landing-page writes (desktop-parity pass) —
 * the audienceDestinations idiom: exactly what rawRequest resolves to, in.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  archiveLandingPage,
  createLandingPage,
  updateLandingPageStatus,
} from "./landingPages";
import { rawRequest } from "./request";

vi.mock("./request", () => {
  const checkedApiResult = async (
    promise: Promise<{
      data: unknown;
      error: { message: string; status: number } | null;
    }>,
  ) => {
    const result = await promise;
    if (result.error) {
      const error = new Error(result.error.message) as Error & {
        status?: number;
      };
      error.status = result.error.status;
      throw error;
    }
    return result;
  };
  return { rawRequest: vi.fn(), checkedApiResult };
});

const mockedRaw = vi.mocked(rawRequest);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("updateLandingPageStatus", () => {
  it("PATCHes {status} and parses the returned page", async () => {
    mockedRaw.mockResolvedValue({
      data: { id: "lp-1", slug: "launch", name: "Launch", status: "draft" },
      error: null,
    });
    const page = await updateLandingPageStatus("lp-1", "draft");
    expect(mockedRaw).toHaveBeenCalledWith(
      "PATCH",
      "/api/v1/landing-pages/lp-1",
      { status: "draft" },
    );
    expect(page?.status).toBe("draft");
  });

  it("throws the envelope error — a failed unpublish must never look done", async () => {
    mockedRaw.mockResolvedValue({
      data: null,
      error: { message: "admin role required", status: 403 },
    });
    await expect(
      updateLandingPageStatus("lp-1", "draft"),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("createLandingPage", () => {
  it("POSTs desktop's exact body — {name, slug}, trimmed, and nothing else", async () => {
    mockedRaw.mockResolvedValue({
      data: { id: "lp-2", slug: "launch", name: "Launch", status: "draft" },
      error: null,
    });
    await createLandingPage({ name: " Launch ", slug: " launch " });
    expect(mockedRaw).toHaveBeenCalledWith("POST", "/api/v1/landing-pages", {
      name: "Launch",
      slug: "launch",
    });
  });
});

describe("archiveLandingPage", () => {
  it("DELETEs the page path (the server soft-archives)", async () => {
    mockedRaw.mockResolvedValue({ data: { ok: true }, error: null });
    await archiveLandingPage("lp-3");
    expect(mockedRaw).toHaveBeenCalledWith(
      "DELETE",
      "/api/v1/landing-pages/lp-3",
    );
  });

  it("surfaces a failed archive as a throw", async () => {
    mockedRaw.mockResolvedValue({
      data: null,
      error: { message: "not found", status: 404 },
    });
    await expect(archiveLandingPage("lp-3")).rejects.toMatchObject({
      status: 404,
    });
  });
});

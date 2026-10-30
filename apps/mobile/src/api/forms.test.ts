/**
 * The transport seam for the forms lifecycle verbs (desktop-parity pass).
 *
 * Same boundary as src/api/audienceDestinations.test.ts: given exactly the
 * `{data, error}` envelope `rawRequest` really resolves to, do the write
 * helpers send the right verb+path+body, unwrap the data, and surface a
 * failure as a THROW rather than as a quiet null?
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CREATE_FORM_PATH,
  createFormBody,
  createFormVariant,
  deleteForm,
  deleteFormVariant,
  evaluateFormVariants,
  fetchFormSubmissionsCsv,
  updateFormStatus,
  updateFormVariant,
} from "./forms";
import { rawRequest, sdkResource } from "./request";

vi.mock("./request", () => {
  /** Faithful double of checkedApiResult's contract: throw a status-tagged
   *  Error on an error envelope, hand the envelope back otherwise. The real
   *  one cannot be imported here — request.ts reaches react-native. */
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
  return { rawRequest: vi.fn(), sdkResource: vi.fn(), checkedApiResult };
});

const mockedRaw = vi.mocked(rawRequest);
const mockedResource = vi.mocked(sdkResource);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("updateFormStatus", () => {
  it("PATCHes /forms/{id} with exactly {status} and unwraps the row", async () => {
    mockedRaw.mockResolvedValue({
      data: { id: "f-1", status: "archived" },
      error: null,
    });
    const row = await updateFormStatus("f-1", "archived");
    expect(mockedRaw).toHaveBeenCalledWith("PATCH", "/api/v1/forms/f-1", {
      status: "archived",
    });
    expect(row?.status).toBe("archived");
  });

  it("id-encodes the path", async () => {
    mockedRaw.mockResolvedValue({ data: { id: "x" }, error: null });
    await updateFormStatus("f/1", "draft");
    expect(mockedRaw).toHaveBeenCalledWith(
      "PATCH",
      "/api/v1/forms/f%2F1",
      expect.anything(),
    );
  });

  it("throws the envelope error instead of returning null", async () => {
    mockedRaw.mockResolvedValue({
      data: null,
      error: { message: "editor role required", status: 403 },
    });
    await expect(updateFormStatus("f-1", "published")).rejects.toMatchObject({
      message: "editor role required",
      status: 403,
    });
  });
});

describe("deleteForm", () => {
  it("DELETEs /forms/{id}", async () => {
    mockedRaw.mockResolvedValue({ data: { ok: true }, error: null });
    await deleteForm("f-9");
    expect(mockedRaw).toHaveBeenCalledWith("DELETE", "/api/v1/forms/f-9");
  });

  it("surfaces a failed delete as a throw", async () => {
    mockedRaw.mockResolvedValue({
      data: null,
      error: { message: "not found", status: 404 },
    });
    await expect(deleteForm("f-9")).rejects.toMatchObject({ status: 404 });
  });
});

describe("createFormBody", () => {
  it("builds the exact CreateInput the server decodes — and NO status key", () => {
    // Status is what keeps the create QUEUEABLE offline: the server hardcodes
    // 'draft' (repo.go:207-208) and lib/offlineQueueSafety only body-guards
    // PATCH, so a status field appearing here would silently ship a
    // queueable publish.
    expect(
      createFormBody({
        name: "  Spring popup ",
        slug: " spring-popup ",
        optInMode: "double",
        successMessage: " Thanks! ",
      }),
    ).toEqual({
      name: "Spring popup",
      slug: "spring-popup",
      optInMode: "double",
      successMessage: "Thanks!",
    });
  });

  it("targets the mounted create route", () => {
    expect(CREATE_FORM_PATH).toBe("/api/v1/forms");
  });
});

describe("fetchFormSubmissionsCsv", () => {
  it("asks the SDK for the CSV as text and returns it", async () => {
    const request = vi.fn(async () => "id,email\ns-1,a@example.com");
    mockedResource.mockImplementation(async (call) => ({
      data: await call({ request } as never),
      error: null,
    }));
    const text = await fetchFormSubmissionsCsv("f-1");
    expect(request).toHaveBeenCalledWith(
      "GET",
      "/api/v1/forms/f-1/submissions.csv",
      { asText: true },
    );
    expect(text).toContain("a@example.com");
  });

  it("throws when the export fails rather than sharing an empty file", async () => {
    mockedResource.mockResolvedValue({
      data: null,
      error: { message: "admin role required", status: 403 },
    });
    await expect(fetchFormSubmissionsCsv("f-1")).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe("variant admin verbs", () => {
  it("creates with {label} only, adding trafficPct only when given", async () => {
    mockedRaw.mockResolvedValue({ data: { id: "v-1" }, error: null });
    await createFormVariant("f-1", { label: " Arm B " });
    expect(mockedRaw).toHaveBeenCalledWith(
      "POST",
      "/api/v1/forms/f-1/variants",
      { label: "Arm B" },
    );
    await createFormVariant("f-1", { label: "Arm C", trafficPct: 30 });
    expect(mockedRaw).toHaveBeenLastCalledWith(
      "POST",
      "/api/v1/forms/f-1/variants",
      { label: "Arm C", trafficPct: 30 },
    );
  });

  it("PATCHes a variant with a sparse body", async () => {
    mockedRaw.mockResolvedValue({ data: { id: "v-1" }, error: null });
    await updateFormVariant("f-1", "v-1", { status: "paused" });
    expect(mockedRaw).toHaveBeenCalledWith(
      "PATCH",
      "/api/v1/forms/f-1/variants/v-1",
      { status: "paused" },
    );
  });

  it("DELETEs a variant", async () => {
    mockedRaw.mockResolvedValue({ data: { ok: true }, error: null });
    await deleteFormVariant("f-1", "v-2");
    expect(mockedRaw).toHaveBeenCalledWith(
      "DELETE",
      "/api/v1/forms/f-1/variants/v-2",
    );
  });

  it("evaluates via POST with an empty body and hands back the decision", async () => {
    mockedRaw.mockResolvedValue({
      data: { decision: { weights: { "v-1": 60 } }, samples: [] },
      error: null,
    });
    const out = await evaluateFormVariants("f-1");
    expect(mockedRaw).toHaveBeenCalledWith(
      "POST",
      "/api/v1/forms/f-1/variants/evaluate",
      {},
    );
    expect(out?.decision?.weights?.["v-1"]).toBe(60);
  });

  it("throws on a refused variant write", async () => {
    mockedRaw.mockResolvedValue({
      data: null,
      error: { message: "label_taken", status: 409 },
    });
    await expect(
      createFormVariant("f-1", { label: "Arm B" }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

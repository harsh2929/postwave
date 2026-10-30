/**
 * The create-tag transport seam, driven with what `rawRequest` really
 * resolves to — the `{data, error}` envelope.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTag, TagCreateError, tagCreateFailureCopy } from "./tags";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

beforeEach(() => rawRequest.mockReset());

describe("createTag", () => {
  it("POSTs the body verbatim and unwraps the created row", async () => {
    rawRequest.mockResolvedValue({
      data: { id: "t-9", name: "vip", color: "teal" },
      error: null,
    });
    const created = await createTag({ name: "vip", color: "teal" });
    expect(rawRequest).toHaveBeenCalledWith("POST", "/api/v1/tags", {
      name: "vip",
      color: "teal",
    });
    expect(created).toEqual({ id: "t-9", name: "vip" });
  });

  it("surfaces a failure as a throw carrying status AND code", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 409, code: "name_taken", message: "tags: name already in use" },
    });
    const err = await createTag({ name: "vip" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TagCreateError);
    expect((err as TagCreateError).status).toBe(409);
    expect((err as TagCreateError).code).toBe("name_taken");
  });
});

describe("tagCreateFailureCopy", () => {
  it("gives a 409 its naming sentence", () => {
    const err = new TagCreateError({
      status: 409,
      code: "name_taken",
      message: "tags: name already in use",
    });
    expect(tagCreateFailureCopy(err)).toMatch(/already exists/);
  });

  it("reads a 403 as a permission rule, never a generic failure", () => {
    const err = new TagCreateError({ status: 403, message: "forbidden" });
    const copy = tagCreateFailureCopy(err);
    expect(copy).toMatch(/editor role/);
    expect(copy).not.toMatch(/forbidden/);
  });

  it("falls back to the server sentence, then to a stock one", () => {
    expect(
      tagCreateFailureCopy(
        new TagCreateError({ status: 400, message: "name exceeds 64 characters" }),
      ),
    ).toBe("name exceeds 64 characters");
    expect(tagCreateFailureCopy(undefined)).toBe("Couldn't create the tag.");
  });
});

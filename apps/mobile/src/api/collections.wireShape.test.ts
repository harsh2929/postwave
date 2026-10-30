// SPDX-License-Identifier: AGPL-3.0-only
//
// A collection detail body with no id is a response this client cannot read,
// not an empty collection and not a network blip. fetchCollectionDetail
// already refused it; this pins that the refusal carries the wire-shape code,
// so the detail screen says "update the app" rather than "Something went
// wrong loading this", and keeps its own sentence.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errorPresentation } from "@/lib/errorCopy";
import { WireShapeError } from "@/lib/wireShapeError";

import { fetchCollectionDetail } from "./collections";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("./request", () => ({ rawRequest }));

beforeEach(() => rawRequest.mockReset());

describe("fetchCollectionDetail: an unreadable 2xx body", () => {
  it("is a WireShapeError with its own sentence, rendered as 'update the app'", async () => {
    rawRequest.mockResolvedValue({
      data: { name: "Store regions", collection_type: "lookup", data: [] },
      error: null,
    });
    const err = await fetchCollectionDetail(" c/1 ").catch((e: unknown) => e);
    expect(rawRequest).toHaveBeenCalledWith("GET", "/api/v1/collections/c%2F1");
    expect(err).toBeInstanceOf(WireShapeError);
    expect(err).toMatchObject({
      code: "wire_shape",
      message: "The server returned a collection this app cannot read.",
    });
    expect(errorPresentation(err)).toEqual({
      message:
        "Moosewave sent a response this version of the app can't read. If this keeps happening, update the app.",
      retryable: true,
    });
  });

  it("control: a body with an id is a collection", async () => {
    rawRequest.mockResolvedValue({
      data: { id: "c1", name: "Store regions", data: [{ region: "EU" }] },
      error: null,
    });
    await expect(fetchCollectionDetail("c1")).resolves.toMatchObject({
      id: "c1",
      name: "Store regions",
      rowCount: 1,
      rows: [{ region: "EU" }],
    });
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// A signed-ingest register the app cannot read says so, whichever layer of
// the body failed. The envelope check already threw a WireShapeError; the row
// and uniqueness checks a few lines below threw bare Errors, so one parser
// gave two answers. The row check matters most: it refuses any key outside
// ROW_KEYS, so ONE additive server field on a row during a rolling deploy
// lands there, and that is the drift the wire-shape copy exists for.
//
// Each case keeps the parser's own sentence (the sibling ingestSecrets.test.ts
// pins those by substring) and adds the code errorCopy reads.
import { describe, expect, it } from "vitest";

import { errorPresentation } from "./errorCopy";
import { parseIngestSecrets } from "./ingestSecrets";
import { WireShapeError } from "./wireShapeError";

const WIRE_SHAPE_COPY = {
  message:
    "Moosewave sent a response this version of the app can't read. If this keeps happening, update the app.",
  retryable: true,
};

const ROW = {
  key_id: "3f9c1a7e5b0d42a8be61c07d29f4ab53",
  label: "Shopify",
  created_at: "2026-08-30T10:00:00Z",
  identity_projection_status: "ready",
  identity_projection_updated_at: "2026-08-30T10:01:00Z",
};

function refusal(payload: unknown): unknown {
  try {
    parseIngestSecrets(payload);
  } catch (err) {
    return err;
  }
  return new Error("parseIngestSecrets accepted a body it should refuse");
}

describe("parseIngestSecrets: every refused body is a wire-shape failure", () => {
  it("a new server field on a row reads as 'update the app', not as a loading blip", () => {
    const err = refusal({
      items: [{ ...ROW, rotated_at: "2026-09-01T00:00:00Z" }],
    });
    expect(err).toBeInstanceOf(WireShapeError);
    expect(err).toMatchObject({
      code: "wire_shape",
      message: "The signed-ingest key register contained an invalid row.",
    });
    expect(errorPresentation(err)).toEqual(WIRE_SHAPE_COPY);
    expect(errorPresentation(err, { online: false })).toEqual(WIRE_SHAPE_COPY);
  });

  it("a row that is not an object is the same failure", () => {
    expect(refusal({ items: [ROW.key_id] })).toMatchObject({
      name: "WireShapeError",
      code: "wire_shape",
      message: "The signed-ingest key register contained an invalid row.",
    });
  });

  it("a register listing one key twice is the same failure", () => {
    const err = refusal({ items: [ROW, { ...ROW, label: "Shopify (copy)" }] });
    expect(err).toMatchObject({
      name: "WireShapeError",
      code: "wire_shape",
      message: "The signed-ingest key register contained duplicate IDs.",
    });
    expect(errorPresentation(err)).toEqual(WIRE_SHAPE_COPY);
  });

  it("control: the same row without the drift still parses", () => {
    expect(parseIngestSecrets({ items: [ROW] }).items).toEqual([
      {
        keyId: ROW.key_id,
        label: "Shopify",
        createdAt: ROW.created_at,
        revokedAt: null,
        identityProjectionStatus: "ready",
        identityProjectionErrorCode: null,
        identityProjectionUpdatedAt: ROW.identity_projection_updated_at,
      },
    ]);
  });
});

// A draft checkpoint must never enter the offline outbox.
//
// A checkpoint PUT is an OPTIMISTICALLY VERSIONED write: the body carries the
// version the draft was built on, and the server refuses anything else
// (editorcheckpoint.go, `WHERE editor_checkpoints.version = $6`). Parked in the
// encrypted journal and replayed minutes or hours later, it necessarily carries
// a version the server has moved past — a guaranteed 409 arriving with no
// editor open to resolve it, and a stale draft landing on newer work if that
// refusal were ever relaxed.
//
// Desktop has no `requireOnline` flag to lean on the way web's client does: the
// journal is governed by an allowlist in offline-store. So the guarantee has to
// be asserted against that allowlist, and asserted for the DELETE and the whole
// path family too — not just the one method the campaign editor happens to call
// today.

import { describe, expect, it } from "vitest";

import { checkpointPath } from "../../lib/editor-checkpoint-api";
import { isQueueableMutation } from "../../lib/offline-store";

const PATH = checkpointPath("campaign", "cam_1");

describe("checkpoint writes are never queueable", () => {
  it("keeps the campaign checkpoint PUT out of the journal", () => {
    expect(PATH).toBe("/api/v1/editor/checkpoints/campaign/cam_1");
    expect(
      isQueueableMutation("PUT", PATH!, { content: { subject: "x" }, version: 3 }),
    ).toBe(false);
  });

  it("keeps every checkpoint verb and entity out of the journal", () => {
    // ONLINE_ONLY_PATTERNS is consulted before the safe-mutation allowlist, so
    // this holds even if `/api/v1/editor/checkpoints/...` is ever added there.
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const entity of ["campaign", "template", "segment"]) {
        expect(
          isQueueableMutation(
            method,
            `/api/v1/editor/checkpoints/${entity}/entity-1`,
            { content: {}, version: 1 },
          ),
        ).toBe(false);
      }
    }
  });

  it("still queues the campaign edit the checkpoint sits beside", () => {
    // A guard that made everything unqueueable would pass this file and quietly
    // break offline campaign editing, so the control case is pinned here.
    expect(
      isQueueableMutation("PATCH", "/api/v1/campaigns/cam_1", {
        subject: "offline edit",
      }),
    ).toBe(true);
  });
});

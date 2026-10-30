import { describe, expect, it } from "vitest";

import type { OfflineMutation } from "../../lib/offline-store";
import {
  queuedSubscriberPatches,
  reconcileSubscriberPage,
  subscriberQueuedPatch,
} from "../../pages/subscribers/subscriber-live-reconciliation";

function mutation(overrides: Partial<OfflineMutation> = {}): OfflineMutation {
  return {
    id: "queue-1",
    method: "PATCH",
    path: "/api/v1/subscribers/subscriber-1",
    body: { status: "disabled", tags: ["reviewed"] },
    idempotencyKey: "idem-1",
    queuedAt: "2026-07-19T00:00:00.000Z",
    attempts: 0,
    status: "pending",
    resource: "subscribers",
    ...overrides,
  };
}

describe("subscriber live reconciliation", () => {
  it("projects only bounded directory fields from exact subscriber PATCHes", () => {
    expect(
      subscriberQueuedPatch(
        mutation({
          path: "/api/v1/subscribers/subscriber%2D1?ignored=true",
          body: {
            email: "local@example.test",
            tags: ["vip"],
            tenant_id: "must-not-project",
            version: '"must-not-project"',
            tags_invalid: [1],
          },
        }),
      ),
    ).toEqual({
      queueId: "queue-1",
      subscriberId: "subscriber-1",
      patch: { email: "local@example.test", tags: ["vip"] },
    });
    expect(subscriberQueuedPatch(mutation({ method: "DELETE" }))).toBeNull();
    expect(
      subscriberQueuedPatch(
        mutation({ path: "/api/v1/subscribers/subscriber-1/emails" }),
      ),
    ).toBeNull();
  });

  it("folds unresolved journal entries in FIFO order", () => {
    const patches = queuedSubscriberPatches([
      mutation({ id: "queue-1", body: { status: "disabled" } }),
      mutation({
        id: "queue-2",
        body: { status: "blocklisted", tags: ["latest"] },
      }),
    ]);
    expect(patches.get("subscriber-1")).toEqual({
      status: "blocklisted",
      tags: ["latest"],
    });
  });

  it("does not let an older fetch overwrite or resurrect a local mutation", () => {
    const result = reconcileSubscriberPage({
      serverRows: [
        { id: "subscriber-1", email: "old@example.test", status: "enabled" },
        {
          id: "subscriber-2",
          email: "removed@example.test",
          status: "enabled",
        },
        { id: "subscriber-3", email: "server@example.test", status: "enabled" },
      ],
      currentRows: [
        {
          id: "subscriber-1",
          email: "new@example.test",
          status: "disabled",
          version: '"subscriber:subscriber-1:v2"',
        },
      ],
      requestMutationRevision: 4,
      localMarkers: new Map([
        ["subscriber-1", { revision: 5, present: true }],
        ["subscriber-2", { revision: 6, present: false }],
      ]),
      queuedPatches: new Map([
        ["subscriber-3", { status: "disabled", tags: ["pending"] }],
      ]),
    });

    expect(result.crossedMutationBoundary).toBe(true);
    expect(result.rows).toEqual([
      {
        id: "subscriber-1",
        email: "new@example.test",
        status: "disabled",
        version: '"subscriber:subscriber-1:v2"',
      },
      {
        id: "subscriber-3",
        email: "server@example.test",
        status: "disabled",
        tags: ["pending"],
      },
    ]);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
const version = '"subscriber:s1:v1"';

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("subscriber suppression status truth", () => {
  it("requires an exact parent revision and confirms the fresh suppression revision", async () => {
    const { suppressSubscriber } = await import("@/lib/subscribers-api");
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 204,
        headers: { ETag: '"subscriber:s1:v2"' },
      }),
    );

    await suppressSubscriber("s1", {
      expectedVersion: version,
      idempotencyKey: "subscriber-detail:suppress-0001",
    });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get("If-Match")).toBe(version);
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe(
      "subscriber-detail:suppress-0001",
    );
  });

  it("does not send a suppression request without that exact revision", async () => {
    const { suppressSubscriber } = await import("@/lib/subscribers-api");
    await expect(suppressSubscriber("s1", {})).rejects.toThrow(
      "Reload this subscriber",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves the server truth that removal never re-enables status", async () => {
    const { unsuppressSubscriber } = await import("@/lib/subscribers-api");
    fetchMock.mockResolvedValueOnce(
      Response.json({
        ok: true,
        deleted: true,
        subscriber_status_changed: false,
        reviewed_resubscribe_required: true,
      }),
    );

    await expect(
      unsuppressSubscriber("s1", "ADA@EXAMPLE.COM", {
        idempotencyKey: "subscriber-detail:removal-0001",
      }),
    ).resolves.toEqual({
      ok: true,
      deleted: true,
      subscriber_status_changed: false,
      reviewed_resubscribe_required: true,
    });
    expect(fetchMock.mock.calls[0]![0]).toContain(
      "/deliverability/suppressions/ada%40example.com",
    );
  });

  it("rejects a response that claims implicit subscriber reactivation", async () => {
    const { unsuppressSubscriber } = await import("@/lib/subscribers-api");
    fetchMock.mockResolvedValueOnce(
      Response.json({
        ok: true,
        deleted: true,
        subscriber_status_changed: true,
      }),
    );
    await expect(unsuppressSubscriber("s1", "ada@example.com")).rejects.toThrow(
      "invalid removal result",
    );
  });
});

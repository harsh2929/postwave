// SPDX-License-Identifier: AGPL-3.0-only
//
// The public archive routes advertise a 60-second freshness window. That
// window has to land on a cache layer that is actually reachable: the root
// layout's connection() call rules out the Full Route Cache, and api.get
// pins server-side requests to `cache: "no-store"` unless the caller says
// otherwise. Both public archive reads must therefore opt into the Data
// Cache explicitly — without it, every view of a newsletter-linked issue is
// a fresh render plus two upstream calls.
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: { get: mocks.get },
}));

const { fetchArchiveIndex, fetchArchiveIssue } = await import(
  "@/lib/archive-api"
);

interface ArchiveRequestInit extends RequestInit {
  next?: { revalidate?: number | false };
}

function optionsOfLastCall(): ArchiveRequestInit {
  const call = mocks.get.mock.calls.at(-1);
  return (call?.[1] ?? {}) as ArchiveRequestInit;
}

describe("public archive reads", () => {
  it("caches the issue detail read for 60 seconds", async () => {
    mocks.get.mockResolvedValue({ slug: "x", subject: "x", htmlBody: "" });
    await fetchArchiveIssue("acme", "spring-update");

    const opts = optionsOfLastCall();
    expect(opts.next?.revalidate).toBe(60);
    // `no-store` (api.get's server-side default) and a revalidate window are
    // mutually exclusive in Next — the caller has to name the cache mode too
    // or the window is silently discarded.
    expect(opts.cache).toBe("force-cache");
    // Still unauthenticated: a cached response must never carry a session.
    expect(opts.credentials).toBe("omit");
  });

  it("caches the index read for 60 seconds", async () => {
    mocks.get.mockResolvedValue({ items: [] });
    await fetchArchiveIndex("acme", { limit: 50 });

    const opts = optionsOfLastCall();
    expect(opts.next?.revalidate).toBe(60);
    expect(opts.cache).toBe("force-cache");
    expect(opts.credentials).toBe("omit");
  });
});

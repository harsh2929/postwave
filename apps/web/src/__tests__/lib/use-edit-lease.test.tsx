// @vitest-environment happy-dom
//
// The client half of the single-writer editing lease.
//
// The server rule was enforced on eight write paths and held by NOBODY — no
// client ever acquired one, so `campaign_edit_leases` stayed empty in
// production and every check passed trivially. A mechanism nothing invokes
// protects nothing, which is the failure this ledger keeps catching and which
// the lease work itself committed twice before this.
//
// These drive the real hook through React's own lifecycle, because the property
// that matters is not "the hook computes the right state" but "mounting the
// editor takes the lease, and leaving releases it".

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { post, del } = vi.hoisted(() => ({ post: vi.fn(), del: vi.fn() }));

vi.mock("@/lib/api", () => ({
  api: { post, delete: del },
  ApiError: class extends Error {
    constructor(
      message: string,
      public readonly status: number,
      public readonly body?: unknown,
    ) {
      super(message);
    }
  },
}));

const { useEditLease } = await import("../../lib/use-edit-lease");
const { ApiError } = await import("@/lib/api");

let container: HTMLDivElement;
let root: Root;
let latest: ReturnType<typeof useEditLease> | undefined;

function Probe({ id }: { id: string | undefined }) {
  latest = useEditLease(id);
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  post.mockResolvedValue({});
  del.mockResolvedValue({});
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  latest = undefined;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function mount(id: string | undefined) {
  await act(async () => {
    root.render(<Probe id={id} />);
  });
}

describe("acquiring on mount", () => {
  it("takes the lease when the editor opens", async () => {
    await mount("camp-1");
    expect(post, "opening the editor did not take a lease").toHaveBeenCalledWith(
      "/api/v1/campaigns/camp-1/edit-lease",
    );
    expect(latest?.held).toBe(true);
    expect(latest?.blockedBy).toBeNull();
  });

  it("does nothing without a campaign id", async () => {
    await mount(undefined);
    expect(post).not.toHaveBeenCalled();
  });

  it("percent-encodes the id rather than interpolating it raw", async () => {
    await mount("a/b?c");
    expect(post).toHaveBeenCalledWith("/api/v1/campaigns/a%2Fb%3Fc/edit-lease");
  });
});

describe("when someone else holds it", () => {
  it("reports the holder rather than a bare failure", async () => {
    post.mockRejectedValueOnce(
      new ApiError("held", 409, {
        error: { code: "edit_lease_held", holder: { label: "ada@example.test" } },
      }),
    );
    await mount("camp-1");

    expect(latest?.held).toBe(false);
    expect(latest?.blockedBy?.label).toBe("ada@example.test");
  });

  it("leaves the editor usable when the lease call FAILS for another reason", async () => {
    // Offline, or a 500. The server still enforces the rule, and refusing to
    // let someone type because a lease call failed is a worse outcome than the
    // collision it guards against.
    post.mockRejectedValueOnce(new ApiError("boom", 500, {}));
    await mount("camp-1");

    expect(latest?.blockedBy, "a transport failure was reported as a person").toBeNull();
    expect(latest?.checking).toBe(false);
  });
});

describe("renewing and releasing", () => {
  it("renews well inside the TTL", async () => {
    // A third of the two-minute TTL: two renewals must fail before the lease
    // lapses mid-edit and hands the campaign to someone else while the first
    // person is still typing.
    await mount("camp-1");
    expect(post).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(40_000);
    });
    expect(post).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(40_000);
    });
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("releases when the editor closes", async () => {
    await mount("camp-1");
    await act(async () => root.unmount());

    expect(del, "leaving the editor did not release the lease, so the next "
      + "editor waits out the full TTL").toHaveBeenCalledWith(
      "/api/v1/campaigns/camp-1/edit-lease",
    );
  });

  it("stops renewing once closed", async () => {
    await mount("camp-1");
    const before = post.mock.calls.length;
    await act(async () => root.unmount());

    await act(async () => {
      vi.advanceTimersByTime(200_000);
    });
    expect(post.mock.calls.length,
      "a closed editor kept renewing, holding a campaign nobody is editing",
    ).toBe(before);
  });
});

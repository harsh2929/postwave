import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const track = vi.hoisted(() => vi.fn());
const revalidateSession = vi.hoisted(() => vi.fn(async () => undefined));

// eslint-disable-next-line import/first
import { setMfaRequiredObserver } from "./auth";

// eslint-disable-next-line import/first
import { createMfaAwareFetch, createUpgradeAwareFetch } from "./sdkClient";
// eslint-disable-next-line import/first
import {
  clearUpgradeRequirement,
  getUpgradeRequirement,
} from "@/lib/upgradeRequired";

vi.mock("@/store/auth", () => ({
  useAuthStore: {
    getState: vi.fn(() => ({ mode: null, revalidateSession })),
  },
}));
vi.mock("@/lib/telemetry", () => ({ track }));

describe("SDK MFA response interception", () => {
  const observer = vi.fn(async () => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    setMfaRequiredObserver(observer);
  });

  afterEach(() => {
    setMfaRequiredObserver(null);
  });

  it("reports a nested mfa_required envelope and leaves the body readable", async () => {
    const body = JSON.stringify({
      error: { code: "mfa_required", message: "step up" },
    });
    const fetch = createMfaAwareFetch(
      vi.fn(
        async () =>
          new Response(body, {
            status: 403,
            headers: { "content-type": "application/json" },
          }),
      ),
      "https://api.example.com/gateway",
    );

    const response = await fetch(
      "https://api.example.com/gateway/api/v1/campaigns",
    );

    expect(observer).toHaveBeenCalledWith({
      baseUrl: "https://api.example.com/gateway",
      code: "mfa_required",
      status: 403,
    });
    await expect(response.text()).resolves.toBe(body);
  });

  it("does not report unrelated forbidden responses", async () => {
    const fetch = createMfaAwareFetch(
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: "insufficient_scope" } }),
            { status: 403 },
          ),
      ),
    );

    await fetch("https://api.example.com/api/v1/admin");

    expect(observer).not.toHaveBeenCalled();
  });

  it("does not buffer an error body declared above the safety limit", async () => {
    const response = new Response("{}", {
      status: 403,
      headers: { "content-length": String(70 * 1024) },
    });
    const clone = vi.spyOn(response, "clone");
    const fetch = createMfaAwareFetch(vi.fn(async () => response));

    await fetch("https://api.example.com/api/v1/admin");

    expect(clone).not.toHaveBeenCalled();
    expect(observer).not.toHaveBeenCalled();
  });

  it("records structural API availability without URL or response content", async () => {
    const fetch = createMfaAwareFetch(
      vi.fn(
        async () => new Response("private customer failure", { status: 503 }),
      ),
    );

    await fetch("https://api.example.com/subscribers/reader@example.com", {
      method: "POST",
    });

    expect(track).toHaveBeenCalledWith(
      "mobile.api_availability",
      expect.objectContaining({
        outcome: "failure",
        error_code: "server",
        method: "POST",
        status_code: 503,
        duration_ms: expect.any(Number),
      }),
    );
    expect(JSON.stringify(track.mock.calls)).not.toContain(
      "reader@example.com",
    );
    expect(JSON.stringify(track.mock.calls)).not.toContain(
      "private customer failure",
    );
  });

  it("classifies a thrown transport failure without recording its exception", async () => {
    const fetch = createMfaAwareFetch(
      vi.fn(async () => {
        throw new Error("reader@example.com secret network response");
      }),
    );

    await expect(fetch("https://api.example.com/private")).rejects.toThrow();
    expect(track).toHaveBeenCalledWith(
      "mobile.api_availability",
      expect.objectContaining({ outcome: "failure", error_code: "network" }),
    );
    expect(JSON.stringify(track.mock.calls)).not.toContain(
      "reader@example.com",
    );
  });
});

describe("SDK expired-session interception", () => {
  beforeEach(() => {
    revalidateSession.mockClear();
  });

  async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("revalidates on a 401 no_session and leaves the body readable", async () => {
    const body = JSON.stringify({ error: { code: "no_session" } });
    const fetch = createMfaAwareFetch(
      vi.fn(async () => new Response(body, { status: 401 })),
    );

    const response = await fetch("https://api.example.com/api/v1/campaigns");
    await flush();

    expect(revalidateSession).toHaveBeenCalledTimes(1);
    await expect(response.text()).resolves.toBe(body);
  });

  it("revalidates on a bare 401 with no envelope at all", async () => {
    const fetch = createMfaAwareFetch(
      vi.fn(async () => new Response("", { status: 401 })),
    );
    await fetch("https://api.example.com/api/v1/campaigns");
    await flush();
    expect(revalidateSession).toHaveBeenCalledTimes(1);
  });

  it("does NOT sign the app out for a per-resource 401 with its own code", async () => {
    const fetch = createMfaAwareFetch(
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "bad_signature" } }), {
            status: 401,
          }),
      ),
    );
    await fetch("https://api.example.com/api/v1/webhooks");
    await flush();
    expect(revalidateSession).not.toHaveBeenCalled();
  });

  it("coalesces a wall of concurrent 401s into one revalidation", async () => {
    const fetch = createMfaAwareFetch(
      vi.fn(async () => new Response("", { status: 401 })),
    );
    await Promise.all(
      Array.from({ length: 8 }, () =>
        fetch("https://api.example.com/api/v1/campaigns"),
      ),
    );
    await flush();
    expect(revalidateSession).toHaveBeenCalledTimes(1);
  });

  it("ignores every other status", async () => {
    const fetch = createMfaAwareFetch(
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    await fetch("https://api.example.com/api/v1/campaigns");
    await flush();
    expect(revalidateSession).not.toHaveBeenCalled();
  });
});

describe("SDK 426 upgrade-required interception (NATIVE#3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearUpgradeRequirement();
  });

  afterEach(() => {
    clearUpgradeRequirement();
  });

  const problem = JSON.stringify({
    code: "upgrade_required",
    detail: "This build is no longer supported.",
    min_version: "2.1.0",
    current_version: "1.9.0",
    client: "mobile",
    request_id: "req_01HZY",
  });

  it("records the requirement and leaves the body readable", async () => {
    const fetch = createMfaAwareFetch(
      vi.fn(async () => new Response(problem, { status: 426 })),
    );
    const response = await fetch("https://api.example.com/api/v1/campaigns");
    expect(getUpgradeRequirement()).toMatchObject({
      minVersion: "2.1.0",
      currentVersion: "1.9.0",
      requestId: "req_01HZY",
    });
    await expect(response.text()).resolves.toBe(problem);
  });

  it("also fires on the API-KEY transport, which had no interceptor at all", async () => {
    const fetch = createUpgradeAwareFetch(
      vi.fn(async () => new Response(problem, { status: 426 })),
    );
    await fetch("https://api.example.com/api/v1/campaigns");
    expect(getUpgradeRequirement()?.minVersion).toBe("2.1.0");
  });

  it("ignores a 426 that is not an upgrade_required document", async () => {
    // A captive portal or proxy must never be able to lock a user out.
    const fetch = createMfaAwareFetch(
      vi.fn(async () => new Response("<html>proxy</html>", { status: 426 })),
    );
    await fetch("https://api.example.com/api/v1/campaigns");
    expect(getUpgradeRequirement()).toBeNull();
  });

  it("ignores an oversized 426 body", async () => {
    const fetch = createMfaAwareFetch(
      vi.fn(
        async () =>
          new Response("x".repeat(9000), {
            status: 426,
            headers: { "content-length": "9000" },
          }),
      ),
    );
    await fetch("https://api.example.com/api/v1/campaigns");
    expect(getUpgradeRequirement()).toBeNull();
  });
});

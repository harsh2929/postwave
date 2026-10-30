// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiAuth, NATIVE_CLIENT_HEADERS } from "../../lib/api-client";
import { resetApiIdentityTransitionForTests } from "../../lib/api-identity-transition";

beforeEach(() => {
  resetApiIdentityTransitionForTests();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("desktop device-session auth API", () => {
  it("starts only a session grant and polls with the memory-held device code", async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit) => {
        const path = new URL(String(input)).pathname;
        calls.push({ path, init });
        const requestBody = JSON.parse(String(init.body)) as {
          action?: string;
        };
        const body = path.endsWith("/start")
          ? {
              device_code: "secret-device-code",
              user_code: "ABCD-EFGH",
              grant_kind: "session",
              remember: false,
              verification_uri: "https://app.moosewave.com/cli/auth",
              verification_uri_complete:
                "https://app.moosewave.com/cli/auth?user_code=ABCD-EFGH",
              expires_in: 600,
              interval: 5,
            }
          : requestBody.action === "cancel"
            ? { ok: true, grant_kind: "session" }
            : requestBody.action === "confirm"
              ? {
                  grant_kind: "session",
                  session: true,
                  confirmed: true,
                  confirmation_required: false,
                  remember: false,
                  tenant_id: "tenant-1",
                  email: "alice@example.test",
                  expires_in: 43_200,
                }
              : {
                  grant_kind: "session",
                  session: true,
                  confirmation_required: true,
                  confirmation_expires_in: 120,
                  remember: false,
                  tenant_id: "tenant-1",
                  email: "alice@example.test",
                  expires_in: 43_200,
                };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const controller = new AbortController();
    const started = await apiAuth.startDeviceSessionGrant(controller.signal);
    expect(started.error).toBeUndefined();
    const token = await apiAuth.pollDeviceSessionGrant(
      "secret-device-code",
      controller.signal,
    );
    expect(token.data?.session).toBe(true);
    expect(token.data?.confirmation_required).toBe(true);
    const confirmed = await apiAuth.confirmDeviceSessionGrant(
      "secret-device-code",
      controller.signal,
    );
    expect(confirmed.data?.confirmed).toBe(true);
    const cancelled = await apiAuth.cancelDeviceSessionGrant(
      "secret-device-code",
      controller.signal,
    );
    expect(cancelled.data?.ok).toBe(true);

    expect(calls.map(({ path }) => path)).toEqual([
      "/api/v1/auth/cli/device/start",
      "/api/v1/auth/cli/device/token",
      "/api/v1/auth/cli/device/token",
      "/api/v1/auth/cli/device/token",
    ]);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      grant_kind: "session",
      remember: false,
    });
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      device_code: "secret-device-code",
    });
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({
      device_code: "secret-device-code",
      action: "confirm",
    });
    expect(JSON.parse(String(calls[3]?.init.body))).toEqual({
      device_code: "secret-device-code",
      action: "cancel",
    });
    for (const { init } of calls) {
      expect(init.credentials).toBe("include");
      expect(init.cache).toBe("no-store");
      expect(new Headers(init.headers).get("X-Postwave-Client")).toBe(
        NATIVE_CLIENT_HEADERS["X-Postwave-Client"],
      );
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("preserves RFC 8628 poll codes for the controller state machine", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: "authorization_pending",
                message: "waiting for approval",
              },
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            },
          ),
      ),
    );

    const result = await apiAuth.pollDeviceSessionGrant("memory-only-secret");

    expect(result.error?.status).toBe(400);
    expect(result.error?.code).toBe("authorization_pending");
  });

  it("uses explicit inspect, approve, and deny actions for approvers", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(
          JSON.stringify({
            ok: true,
            grant_kind: "session",
            account: {
              email: "alice@example.test",
              workspace_name: "Acme",
              workspace_slug: "acme",
            },
            device: {
              device_label: "Moosewave Desktop on Windows",
              device_type: "desktop",
              device_os: "Windows",
              device_client: "Moosewave Desktop",
            },
            remember: false,
            expires_in: 540,
            consent_token: "opaque-consent-token",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );

    await apiAuth.inspectDeviceGrant("ABCD-EFGH");
    await apiAuth.approveDeviceGrant("ABCD-EFGH", "opaque-consent-token");
    await apiAuth.denyDeviceGrant("ABCD-EFGH", "opaque-consent-token");

    expect(bodies).toEqual([
      { user_code: "ABCD-EFGH", action: "inspect" },
      {
        user_code: "ABCD-EFGH",
        action: "approve",
        consent_token: "opaque-consent-token",
      },
      {
        user_code: "ABCD-EFGH",
        action: "deny",
        consent_token: "opaque-consent-token",
      },
    ]);
  });

  it("aborts an in-flight poll without reporting a timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            if (init.signal?.aborted) {
              reject(new DOMException("cancelled", "AbortError"));
              return;
            }
            init.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("cancelled", "AbortError")),
              { once: true },
            );
          }),
      ),
    );
    const controller = new AbortController();
    const pending = apiAuth.pollDeviceSessionGrant(
      "memory-only-secret",
      controller.signal,
    );

    controller.abort();
    const result = await pending;

    expect(result.error?.code).toBe("aborted");
    expect(result.error?.kind).toBe("network");
  });
});

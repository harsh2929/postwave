import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class<T> {
    onmessage: (message: T) => void;
    constructor(onmessage: (message: T) => void) {
      this.onmessage = onmessage;
    }
  },
}));

import { tauriApi } from "../lib/tauri";

describe("native renderer secret boundary", () => {
  beforeEach(() => {
    h.invoke.mockReset();
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  });

  it("exposes no generic secret read/write/delete facade", () => {
    expect(tauriApi).not.toHaveProperty("readSecret");
    expect(tauriApi).not.toHaveProperty("storeSecret");
    expect(tauriApi).not.toHaveProperty("deleteSecret");

    const main = readFileSync(
      new URL("../../src-tauri/src/main.rs", import.meta.url),
      "utf8",
    );
    expect(main).not.toContain("commands::read_secret");
    expect(main).not.toContain("commands::store_secret");
    expect(main).not.toContain("commands::delete_secret");
  });

  it("returns capability metadata, never a configured bearer", async () => {
    h.invoke.mockResolvedValueOnce({
      configured: true,
      baseUrl: "https://api.moosewave.com",
      credentialFingerprint: "a".repeat(64),
      legacyReentryRequired: false,
    });
    const status = await tauriApi.configureApiBroker(
      "https://api.moosewave.com",
      "pw_super_secret",
      false,
    );
    expect(status).toEqual({
      configured: true,
      baseUrl: "https://api.moosewave.com",
      credentialFingerprint: "a".repeat(64),
      legacyReentryRequired: false,
    });
    expect(JSON.stringify(status)).not.toContain("pw_super_secret");
    expect(status).not.toHaveProperty("bearer");
    expect(status).not.toHaveProperty("apiKey");
  });

  it("cannot broker to another origin or smuggle renderer authorization", async () => {
    h.invoke.mockResolvedValueOnce({
      configured: true,
      baseUrl: "https://api.moosewave.com",
      credentialFingerprint: "b".repeat(64),
      legacyReentryRequired: false,
    });
    await tauriApi.configureApiBroker(
      "https://api.moosewave.com",
      "pw_bound",
      false,
    );
    h.invoke.mockClear();

    await expect(
      tauriApi.fetchWithApiBroker("https://attacker.example/api/v1/me"),
    ).resolves.toBeNull();
    await expect(
      tauriApi.fetchWithApiBroker("https://api.moosewave.com/api/v1/me", {
        headers: { Authorization: "Bearer renderer-value" },
      }),
    ).resolves.toBeNull();
    expect(h.invoke).not.toHaveBeenCalled();

    let streamChannels:
      | {
          onEvent: {
            onmessage: (event: number[] | { event: "complete" }) => void;
          };
        }
      | undefined;
    h.invoke.mockImplementationOnce(async (_command, rawArgs) => {
      streamChannels = rawArgs as typeof streamChannels;
      return {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
      };
    });
    const response = await tauriApi.fetchWithApiBroker(
      "https://api.moosewave.com/api/v1/me",
      {
        headers: {
          Accept: "application/json",
          "X-Postwave-Client": "renderer-value",
        },
      },
    );
    const body = response?.text();
    streamChannels?.onEvent.onmessage([123, 125]);
    streamChannels?.onEvent.onmessage({ event: "complete" });
    expect(await body).toBe("{}");
    const [command, args] = h.invoke.mock.calls[0] as [
      string,
      {
        request: { headers: Record<string, string>; url: string };
      },
    ];
    expect(command).toBe("api_broker_stream_request");
    expect(args.request.url).toBe("https://api.moosewave.com/api/v1/me");
    expect(args.request.headers).toEqual({ accept: "application/json" });
    expect(args.request.headers).not.toHaveProperty("authorization");
    expect(args.request.headers).not.toHaveProperty("x-postwave-client");
  });

  it("keeps native session cookies behind the IPC boundary", async () => {
    h.invoke.mockResolvedValueOnce({ baseUrl: "https://api.moosewave.com" });
    await tauriApi.initializeSessionBroker("https://api.moosewave.com");
    h.invoke.mockClear();

    let streamChannels:
      | {
          onEvent: {
            onmessage: (event: number[] | { event: "complete" }) => void;
          };
        }
      | undefined;
    h.invoke.mockImplementationOnce(async (_command, rawArgs) => {
      streamChannels = rawArgs as typeof streamChannels;
      return {
        status: 200,
        statusText: "OK",
        // Defense in depth: even a regressed native allowlist must not make a
        // cookie readable through the Response surfaced to application code.
        headers: {
          "content-type": "application/json",
          "set-cookie": "pw_session=must-never-reach-js",
        },
      };
    });
    const response = await tauriApi.fetchWithSessionBroker(
      "https://api.moosewave.com/api/v1/auth/me",
      {
        headers: {
          Accept: "application/json",
          "X-Postwave-Client": "renderer-value",
        },
      },
    );
    const body = response?.text();
    streamChannels?.onEvent.onmessage([123, 125]);
    streamChannels?.onEvent.onmessage({ event: "complete" });
    expect(await body).toBe("{}");
    expect(response?.headers.get("set-cookie")).toBeNull();

    const [command, args] = h.invoke.mock.calls[0] as [
      string,
      {
        request: { headers: Record<string, string>; url: string };
      },
    ];
    expect(command).toBe("session_broker_stream_request");
    expect(args.request.url).toBe("https://api.moosewave.com/api/v1/auth/me");
    expect(args.request.headers).toEqual({ accept: "application/json" });
    expect(JSON.stringify(args)).not.toContain("pw_session");
  });

  it("partitions session dispatch by the initialized server", async () => {
    h.invoke.mockResolvedValueOnce({ baseUrl: "https://api-a.example" });
    await tauriApi.initializeSessionBroker("https://api-a.example");
    h.invoke.mockClear();

    await expect(
      tauriApi.fetchWithSessionBroker("https://api-b.example/api/v1/auth/me"),
    ).resolves.toBeNull();
    await expect(
      tauriApi.fetchWithSessionBroker("https://api-a.example/not-api"),
    ).resolves.toBeNull();
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("delegates vault encryption without exposing its AES key", async () => {
    h.invoke.mockResolvedValueOnce(
      '{"alg":"AES-GCM","iv":"nonce","data":"ciphertext"}',
    );
    const envelope = await tauriApi.sealVaultString("sensitive cache value");
    expect(envelope).not.toContain("sensitive cache value");
    expect(tauriApi).not.toHaveProperty("getVaultKey");
    expect(h.invoke).toHaveBeenCalledWith("vault_seal", {
      plaintext: "sensitive cache value",
    });
  });

  it("uses the narrow native setup probe for a new custom API origin", async () => {
    h.invoke.mockResolvedValueOnce({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: [123, 125],
    });
    const response = await tauriApi.probeApiConnection(
      "https://self-hosted.example/gateway",
      "https://self-hosted.example/gateway/api/v1/api-keys/me",
      "pw_key_being_entered",
    );
    expect(response.status).toBe(200);
    expect(h.invoke).toHaveBeenCalledWith("api_broker_probe", {
      request: {
        baseUrl: "https://self-hosted.example/gateway",
        url: "https://self-hosted.example/gateway/api/v1/api-keys/me",
        apiKey: "pw_key_being_entered",
        timeoutMs: 5_000,
      },
    });
  });
});

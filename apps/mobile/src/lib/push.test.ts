/** Unit tests for the privacy-safe mobile push lifecycle. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  secure,
  deviceState,
  authState,
  getPermissionsAsync,
  requestPermissionsAsync,
  getExpoPushTokenAsync,
  setNotificationCategoryAsync,
  registerDevice,
  revokeDevice,
  getClientMock,
  revokePossession,
  setPushTokenMock,
  clearPushTokenMock,
} = vi.hoisted(() => ({
  secure: new Map<string, string>(),
  deviceState: { isDevice: false },
  authState: {
    baseUrl: null as string | null,
    mode: null as "session" | null,
    authenticated: false,
    account: "signed-out",
  },
  getPermissionsAsync: vi.fn(async () => ({ granted: false })),
  requestPermissionsAsync: vi.fn(async () => ({ granted: false })),
  getExpoPushTokenAsync: vi.fn(async () => ({ data: null as string | null })),
  setNotificationCategoryAsync: vi.fn(
    async (_category: string, _actions: unknown[]) => ({}),
  ),
  registerDevice: vi.fn(),
  revokeDevice: vi.fn(),
  getClientMock: vi.fn(),
  revokePossession: vi.fn(),
  setPushTokenMock: vi.fn(),
  clearPushTokenMock: vi.fn(),
}));
const track = vi.hoisted(() => vi.fn());

vi.mock("expo-notifications", () => ({
  setNotificationHandler: vi.fn(),
  setNotificationCategoryAsync,
  setNotificationChannelAsync: vi.fn(async () => ({})),
  getPermissionsAsync,
  requestPermissionsAsync,
  getExpoPushTokenAsync,
  getLastNotificationResponseAsync: vi.fn(async () => null),
  AndroidImportance: { DEFAULT: 3 },
}));
vi.mock("expo-device", () => ({
  get isDevice() {
    return deviceState.isDevice;
  },
}));
vi.mock("expo-constants", () => ({
  default: { easConfig: undefined, expoConfig: { extra: {} } },
}));
vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "device-only",
  getItemAsync: vi.fn(async (key: string) => secure.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    secure.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    secure.delete(key);
  }),
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
// push.ts reaches the SDK factory DIRECTLY rather than through the eager
// api/client barrel (NATIVE#58), so the mock follows it there.
vi.mock("@/api/sdkClient", () => ({ getClient: getClientMock }));
vi.mock("@/lib/config", () => ({ BUILD_PROFILE: "development" }));
vi.mock("@/lib/telemetry", () => ({ track }));
vi.mock("@postwave/sdk", () => ({
  PostwaveClient: class {
    mobilePush = { revokePossession };
  },
}));
vi.mock("@/store/auth", () => ({
  useAuthStore: {
    getState: vi.fn(() => ({
      baseUrl: authState.baseUrl,
      mode: authState.mode,
      account: authState.account,
      isAuthenticated: () => authState.authenticated,
    })),
  },
  setPushToken: setPushTokenMock,
  clearPushToken: clearPushTokenMock,
}));

// eslint-disable-next-line import/first
import {
  parseNotificationAction,
  registerForPushNotifications,
  registerForPushNotificationsIfGranted,
  registerNotificationCategories,
  retryPendingPushRevocation,
  unregisterPushNotifications,
  unregisterPushThenSignOut,
} from "./push";

function response(
  data: unknown,
  actionIdentifier = "expo.modules.notifications.actions.DEFAULT",
) {
  return {
    actionIdentifier,
    notification: {
      request: { content: { data: data as Record<string, unknown> } },
    },
  } as never;
}

beforeEach(() => {
  secure.clear();
  vi.clearAllMocks();
  deviceState.isDevice = false;
  authState.baseUrl = null;
  authState.mode = null;
  authState.authenticated = false;
  authState.account = "signed-out";
  getPermissionsAsync.mockResolvedValue({ granted: false });
  requestPermissionsAsync.mockResolvedValue({ granted: false });
  getExpoPushTokenAsync.mockResolvedValue({ data: null });
  registerDevice.mockResolvedValue({
    registered: true,
    delivery_enabled: true,
  });
  revokeDevice.mockResolvedValue({ registered: false });
  revokePossession.mockResolvedValue({ registered: false });
  getClientMock.mockImplementation(() => ({
    baseUrl: authState.baseUrl,
    client: {
      mobilePush: {
        register: registerDevice,
        revoke: revokeDevice,
      },
    },
  }));
  vi.stubGlobal("crypto", {
    getRandomValues: (array: Uint8Array) => {
      array.fill(0xab);
      return array;
    },
  });
});

describe("push device lifecycle", () => {
  it("records a structural unavailable result without exposing a token", async () => {
    await expect(registerForPushNotifications()).resolves.toBeNull();
    expect(track).toHaveBeenCalledWith(
      "mobile.push_registration_completed",
      expect.objectContaining({
        source: "settings",
        outcome: "unavailable",
        duration_ms: expect.any(Number),
      }),
    );
    expect(JSON.stringify(track.mock.calls)).not.toContain("ExponentPushToken");
  });

  it("clears the local registration before signing out when no server row exists", async () => {
    const order: string[] = [];
    clearPushTokenMock.mockImplementationOnce(async () => {
      order.push("push");
    });

    await unregisterPushThenSignOut(async () => {
      order.push("auth");
    });

    expect(order).toEqual(["push", "auth"]);
  });

  it("does not mint or register a token when the permission request is denied", async () => {
    deviceState.isDevice = true;
    getPermissionsAsync.mockResolvedValue({ granted: false });
    requestPermissionsAsync.mockResolvedValue({ granted: false });

    await expect(registerForPushNotifications()).resolves.toBeNull();

    expect(requestPermissionsAsync).toHaveBeenCalledOnce();
    expect(getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(registerDevice).not.toHaveBeenCalled();
  });

  it("registers only after permission is granted and server durability is confirmed", async () => {
    configureSignedInDevice("https://api.postwave.test", "account-a");
    getPermissionsAsync.mockResolvedValue({ granted: false });
    requestPermissionsAsync.mockResolvedValue({ granted: true });
    getExpoPushTokenAsync.mockResolvedValue({
      data: "ExpoPushToken[permission-granted]",
    });

    await expect(registerForPushNotifications()).resolves.toBe(
      "ExpoPushToken[permission-granted]",
    );

    expect(registerDevice).toHaveBeenCalledWith(
      expect.objectContaining({
        device_key: "ab".repeat(32),
        expo_push_token: "ExpoPushToken[permission-granted]",
        platform: "ios",
      }),
    );
    expect(setPushTokenMock).toHaveBeenCalledWith(
      "ExpoPushToken[permission-granted]",
    );
  });

  it("leaves local registration off when the server registration fails", async () => {
    configureSignedInDevice("https://api.postwave.test", "account-a");
    getPermissionsAsync.mockResolvedValue({ granted: true });
    getExpoPushTokenAsync.mockResolvedValue({
      data: "ExpoPushToken[server-failure]",
    });
    registerDevice.mockRejectedValueOnce(new Error("server unavailable"));

    await expect(registerForPushNotifications()).rejects.toThrow(
      "server unavailable",
    );
    expect(setPushTokenMock).not.toHaveBeenCalled();
  });

  it("rotates Expo tokens and account claims with one stable installation key", async () => {
    configureSignedInDevice("https://api.postwave.test", "account-a");
    getPermissionsAsync.mockResolvedValue({ granted: true });
    getExpoPushTokenAsync
      .mockResolvedValueOnce({ data: "ExpoPushToken[token-a]" })
      .mockResolvedValueOnce({ data: "ExpoPushToken[token-b]" });

    await registerForPushNotificationsIfGranted();
    authState.account = "account-b";
    await registerForPushNotificationsIfGranted();

    expect(registerDevice).toHaveBeenCalledTimes(2);
    const first = registerDevice.mock.calls[0]?.[0] as Record<string, string>;
    const second = registerDevice.mock.calls[1]?.[0] as Record<string, string>;
    expect(first.device_key).toBe(second.device_key);
    expect(first.expo_push_token).toBe("ExpoPushToken[token-a]");
    expect(second.expo_push_token).toBe("ExpoPushToken[token-b]");
  });

  it("supersedes a failed same-origin revoke after a successful new claim", async () => {
    configureSignedInDevice("https://api.postwave.test", "account-b");
    seedDeviceKey();
    seedPendingRevocations([
      pending("https://api.postwave.test", "ab".repeat(32)),
    ]);
    getPermissionsAsync.mockResolvedValue({ granted: true });
    getExpoPushTokenAsync.mockResolvedValue({
      data: "ExpoPushToken[same-origin]",
    });
    revokePossession.mockRejectedValueOnce(new Error("offline"));

    await registerForPushNotificationsIfGranted();

    expect(registerDevice).toHaveBeenCalledOnce();
    expect(readPendingJournal()).toEqual([]);
  });

  it("retains failed cross-origin cleanup after registering the current origin", async () => {
    configureSignedInDevice("https://new-api.postwave.test", "account-b");
    seedDeviceKey();
    seedPendingRevocations([
      pending("https://old-api.postwave.test", "ab".repeat(32)),
    ]);
    getPermissionsAsync.mockResolvedValue({ granted: true });
    getExpoPushTokenAsync.mockResolvedValue({
      data: "ExpoPushToken[cross-origin]",
    });
    revokePossession.mockRejectedValueOnce(new Error("old origin offline"));

    await registerForPushNotificationsIfGranted();

    expect(readPendingJournal()).toEqual([
      expect.objectContaining({ baseUrl: "https://old-api.postwave.test" }),
    ]);
  });

  it("journals logout failure, signs out, and later clears it by possession", async () => {
    configureSignedInDevice("https://api.postwave.test", "account-a");
    seedDeviceKey();
    revokeDevice.mockRejectedValueOnce(new Error("offline"));
    const signOut = vi.fn(async () => undefined);

    await expect(unregisterPushThenSignOut(signOut)).rejects.toThrow("offline");

    expect(signOut).toHaveBeenCalledOnce();
    expect(clearPushTokenMock).toHaveBeenCalled();
    expect(readPendingJournal()).toEqual([
      expect.objectContaining({ baseUrl: "https://api.postwave.test" }),
    ]);

    revokePossession.mockResolvedValueOnce({ registered: false });
    await expect(retryPendingPushRevocation()).resolves.toBe(true);
    expect(readPendingJournal()).toEqual([]);
  });

  it("removes only the current-origin journal entry after explicit success", async () => {
    configureSignedInDevice("https://api.postwave.test", "account-a");
    seedDeviceKey();
    seedPendingRevocations([
      pending("https://old-api.postwave.test", "ab".repeat(32)),
      pending("https://api.postwave.test", "ab".repeat(32)),
    ]);

    await unregisterPushNotifications();

    expect(readPendingJournal()).toEqual([
      expect.objectContaining({ baseUrl: "https://old-api.postwave.test" }),
    ]);
  });

  it("requires unlock authentication and foreground confirmation for decisions", async () => {
    await registerNotificationCategories();
    const approval = setNotificationCategoryAsync.mock.calls.find(
      ([category]) => category === "approval",
    );
    expect(approval).toBeDefined();
    const actions = approval?.[1] as {
      options?: Record<string, boolean>;
    }[];
    expect(actions).toHaveLength(2);
    for (const action of actions) {
      expect(action.options).toMatchObject({
        isAuthenticationRequired: true,
        opensAppToForeground: true,
      });
    }

    const security = setNotificationCategoryAsync.mock.calls.find(
      ([category]) => category === "security",
    );
    expect(security).toBeDefined();
    const securityActions = security?.[1] as {
      identifier: string;
      options?: Record<string, boolean>;
    }[];
    expect(securityActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ identifier: "revoke_session" }),
        expect.objectContaining({ identifier: "view" }),
      ]),
    );
    const revoke = securityActions.find(
      (action) => action.identifier === "revoke_session",
    );
    expect(revoke?.options).toMatchObject({
      isAuthenticationRequired: true,
      isDestructive: true,
      opensAppToForeground: true,
    });
  });
});

function configureSignedInDevice(baseUrl: string, account: string): void {
  deviceState.isDevice = true;
  authState.baseUrl = baseUrl;
  authState.mode = "session";
  authState.authenticated = true;
  authState.account = account;
}

function seedDeviceKey(): void {
  secure.set("postwave.push_device_key.v1", "ab".repeat(32));
}

function pending(baseUrl: string, deviceKey: string) {
  return { baseUrl, deviceKey, createdAt: Date.now() };
}

function seedPendingRevocations(records: ReturnType<typeof pending>[]): void {
  secure.set("postwave.push_pending_revoke.v1", JSON.stringify(records));
}

function readPendingJournal(): unknown[] {
  const raw = secure.get("postwave.push_pending_revoke.v1");
  return raw ? (JSON.parse(raw) as unknown[]) : [];
}

describe("parseNotificationAction", () => {
  it("returns null for empty or malformed responses", () => {
    expect(parseNotificationAction(null)).toBeNull();
    expect(parseNotificationAction(undefined)).toBeNull();
    expect(parseNotificationAction(response(null))).toBeNull();
    expect(parseNotificationAction(response("nope"))).toBeNull();
  });

  it("reads only minimal top-level event and entity identifiers", () => {
    expect(
      parseNotificationAction(
        response(
          { event_type: "approval.requested", entity_id: "apr_1" },
          "approve",
        ),
      ),
    ).toEqual({
      actionIdentifier: "approve",
      eventType: "approval.requested",
      entityId: "apr_1",
    });
  });

  it("never promotes a legacy nested customer body into an action", () => {
    const out = parseNotificationAction(
      response({
        body: JSON.stringify({
          event_type: "approval.requested",
          entity_id: "attacker-selected-id",
          body: { email: "customer@example.test" },
        }),
      }),
    );
    expect(out).toEqual({
      actionIdentifier: expect.any(String),
      eventType: "",
      entityId: "",
    });
  });

  it("drops oversized entity ids", () => {
    const out = parseNotificationAction(
      response({
        event_type: "subscriber.bounced",
        entity_id: "x".repeat(300),
      }),
    );
    expect(out?.entityId).toBe("");
  });
});

import { describe, expect, it } from "vitest";

import {
  NEW_DEVICE_SIGN_IN_EVENT,
  PUSH_ACTION_REVOKE_SESSION,
  securitySessionRevokeGate,
  securitySessionRevokeTarget,
} from "./pushSecuritySession";

// base64.RawURLEncoding.EncodeToString([]byte("0123456789abcdef"))
const SESSION_ID = "MDEyMzQ1Njc4OWFiY2RlZg";

function action(overrides: Partial<{
  actionIdentifier: string;
  eventType: string;
  entityId: string;
}> = {}) {
  return {
    actionIdentifier: PUSH_ACTION_REVOKE_SESSION,
    eventType: NEW_DEVICE_SIGN_IN_EVENT,
    entityId: SESSION_ID,
    ...overrides,
  };
}

describe("securitySessionRevokeTarget", () => {
  it("admits only the exact new-device event's canonical session id", () => {
    expect(securitySessionRevokeTarget(action())).toBe(SESSION_ID);
  });

  it("cannot turn another event or action into session revocation", () => {
    expect(
      securitySessionRevokeTarget(action({ eventType: "approval.requested" })),
    ).toBeNull();
    expect(
      securitySessionRevokeTarget(action({ actionIdentifier: "view" })),
    ).toBeNull();
  });

  it("rejects blank, path-shaped, wrong-length, and non-canonical ids", () => {
    for (const entityId of [
      "",
      "../logout-all",
      "session-1",
      `${SESSION_ID.slice(0, -1)}B`,
      `${SESSION_ID}A`,
    ]) {
      expect(securitySessionRevokeTarget(action({ entityId }))).toBeNull();
    }
  });
});

describe("securitySessionRevokeGate", () => {
  it("allows a validated online cookie session", () => {
    expect(
      securitySessionRevokeGate({
        mode: "session",
        canUseOnlineServices: true,
        sessionValidation: "validated_online",
        retryable: false,
      }),
    ).toBe("confirm");
  });

  it("defers a cold-start response while its cookie is being checked", () => {
    expect(
      securitySessionRevokeGate({
        mode: "session",
        canUseOnlineServices: false,
        sessionValidation: "checking",
        retryable: true,
      }),
    ).toBe("retry_later");
  });

  it("never authorizes cached/offline or API-key state", () => {
    expect(
      securitySessionRevokeGate({
        mode: "session",
        canUseOnlineServices: false,
        sessionValidation: "offline_cached",
        retryable: false,
      }),
    ).toBe("offline");
    expect(
      securitySessionRevokeGate({
        mode: "api_key",
        canUseOnlineServices: true,
        sessionValidation: "none",
        retryable: false,
      }),
    ).toBe("session_required");
  });
});

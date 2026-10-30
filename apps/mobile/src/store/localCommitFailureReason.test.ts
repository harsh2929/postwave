/**
 * The classifier that names WHY a server-accepted session was torn down locally.
 *
 * This exists because the wire showed `login 200, /auth/me 200, logout 204` with
 * no explanation anywhere. signInSession cancels the server session when its
 * local transaction fails -- correct, since a cookie with no local record is a
 * half-signed-in state -- but it recorded nothing, and the caller's generic
 * `profile_load_failed` actively misdirected: the server HAD returned a profile.
 *
 * The assertions that carry weight are the PRIVACY ones. This value goes to
 * telemetry, and the underlying messages can carry a keychain path or a
 * SecureStore key name.
 */
import { describe, expect, it } from "vitest";

import { AuthSessionStateError, localCommitFailureReason } from "./authErrors";

describe("localCommitFailureReason", () => {
  it("keeps a code the thrower already classified", () => {
    expect(
      localCommitFailureReason(
        new AuthSessionStateError("invalid_session_profile", "bad profile"),
      ),
    ).toBe("invalid_session_profile");
  });

  it("names the storage layer when SecureStore is the failing step", () => {
    // The case actually suspected on the simulator: expo-secure-store is
    // 55.0.15 against an expected ~55.0.17.
    for (const message of [
      "SecureStore: could not write value",
      "Keychain error -34018",
      "SecItemAdd failed",
    ]) {
      expect(localCommitFailureReason(new Error(message))).toBe(
        "secure_store_write",
      );
    }
  });

  it("separates a full disk and a timeout from an unknown failure", () => {
    expect(localCommitFailureReason(new Error("quota exceeded"))).toBe(
      "storage_full",
    );
    expect(localCommitFailureReason(new Error("operation timed out"))).toBe(
      "storage_timeout",
    );
    expect(localCommitFailureReason(new Error("something else entirely"))).toBe(
      "unknown_local_commit",
    );
  });

  it("NEVER forwards the message, a path, or a key name", () => {
    // A reason string is a telemetry property. Leaking the message would put a
    // keychain path and a SecureStore key into an analytics pipeline.
    const hostile = new Error(
      "SecureStore write failed for key pw.session.token at /var/mobile/Keychain/db",
    );
    const reason = localCommitFailureReason(hostile);
    expect(reason).toBe("secure_store_write");
    expect(reason).not.toContain("pw.session.token");
    expect(reason).not.toContain("/var/mobile");
    expect(reason).not.toContain(" ");
  });

  it("does not throw on a non-Error value", () => {
    // A rejected promise can carry anything.
    expect(localCommitFailureReason("plain string")).toBe(
      "unknown_local_commit",
    );
    expect(localCommitFailureReason(null)).toBe("unknown_local_commit");
    expect(localCommitFailureReason({ weird: true })).toBe(
      "unknown_local_commit",
    );
  });
});

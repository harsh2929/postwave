/**
 * lib/trustedDeviceRevoke.ts — retire THIS phone's "remember this device"
 * credential together with the app lock that was its precondition.
 *
 * `RememberDeviceOptIn` only offers trust while the app lock is ON: on an
 * unlocked handset a 180-day MFA bypass is strictly worse than the password it
 * supplements. A trust record (the pw_device_trust cookie) deliberately
 * outlives both the session and a sign-out, so anything that turns the lock
 * OFF has to retire it too — otherwise the phone keeps the credential and
 * drops the one condition it was granted under. Two places turn it off:
 *
 *   - the lock screen's sign-out escape hatch (`BiometricGate`), which ignores
 *     the outcome — a failure must not strand someone on a lock screen they
 *     came there to escape, and the server's trust TTL is the backstop;
 *   - the App lock switch in Settings (`DeviceProtectionSection`), which tells
 *     the user when the phone can still skip a second factor.
 *
 * Only THIS device's record, never `revokeAllTrustedDevices`: turning off the
 * lock is a statement about the handset in the user's hand, not a reason to
 * re-impose 2FA on the laptop they left at the office. The revoke needs the
 * session cookie, so callers run it before any sign-out teardown.
 *
 * A leaf module on purpose. It must NOT live in `api/trustedDevices`: tests
 * mock that module wholesale, and a call made from inside it would reach the
 * real transport instead of the mock. Exactly two awaits (list, revoke), which
 * the gate's sign-out ordering tests count on.
 */
import { listTrustedDevices, revokeTrustedDevice } from "@/api/trustedDevices";

/**
 * - `revoked`: this phone's record is gone (including "already gone").
 * - `none`: there was nothing to retire — no workspace, or never remembered.
 * - `failed`: this phone may still hold a live trust record.
 */
export type ThisDeviceTrustOutcome = "revoked" | "none" | "failed";

/** Never rejects: every failure, thrown or enveloped, is `"failed"`. */
export async function revokeThisDeviceTrust(
  baseUrl: string | null | undefined,
): Promise<ThisDeviceTrustOutcome> {
  if (!baseUrl) return "none";
  try {
    const listed = await listTrustedDevices(baseUrl);
    if (listed.error || !listed.data) return "failed";
    const current = listed.data.devices.find((device) => device.current);
    if (!current) return "none";
    const res = await revokeTrustedDevice(baseUrl, current.id);
    if (!res.error) return "revoked";
    // 404 is also what the server returns for an id that is not ours, so the
    // only honest reading is "it is not there any more" (as useTrustedDevices
    // reads it) — which is the state this call exists to reach.
    return res.error.status === 404 ? "revoked" : "failed";
  } catch {
    // Offline, or the transport threw before an envelope existed.
    return "failed";
  }
}

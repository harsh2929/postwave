import { type ReactElement, useCallback, useEffect, useState } from "react";

import {
  apiAuth,
  type AuthPasskeyCredential,
  type AuthSessionInfo,
  type AuthTrustedDevice,
} from "../../lib/api-client";

// Account security on desktop: where you are signed in, what may skip your MFA,
// and what can sign in as you.
//
// All three endpoints were mounted, manifested and in the OpenAPI spec long
// before this existed, and desktop called none of them — a desktop user could
// not end a session on a lost machine, could not audit their own MFA bypasses,
// and could not remove a passkey. Nothing failed, because "no client calls this"
// is invisible to route auth, which proves a request is authorised and never
// that anyone makes it. scripts/check-identity-surface-parity.mjs now fails the
// build if that recurs, and it refuses to be satisfied by an API method no
// screen calls.

/** Absolute date; the server sends RFC 3339. Invalid input renders as a dash. */
function formatWhen(value: string | undefined): string {
  if (!value) return "—";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "—";
  return at.toLocaleString();
}

/**
 * "Never used" is a fact worth showing plainly.
 *
 * The alternative — falling back to a zero date — renders as a 1970 or year-1
 * timestamp, which reads as real data and makes a device look ancient rather
 * than unused.
 */
function formatLastUsed(value: string | undefined): string {
  if (!value) return "Not used yet";
  return formatWhen(value);
}

/**
 * The device name. Server-derived, rendered verbatim.
 *
 * Deliberately NOT re-parsed from the user agent here: web, desktop and mobile
 * each hand-rolling a parser is how one machine ends up with three different
 * names in three places, and the server already did it once.
 */
function deviceName(
  row: { device_label?: string; device_type?: string; device_os?: string },
  fallback?: string,
): string {
  if (row.device_label) return row.device_label;
  const parts = [row.device_type, row.device_os].filter(Boolean);
  if (parts.length > 0) return parts.join(" · ");
  return fallback ?? "Unknown device";
}

type Confirmer = (message: string) => Promise<boolean> | boolean;

export interface AccountSecuritySectionProps {
  /** Injected so tests do not depend on a real window.confirm. */
  confirm?: Confirmer;
}

export function AccountSecuritySection({
  confirm,
}: AccountSecuritySectionProps = {}): ReactElement {
  const ask: Confirmer =
    confirm ?? ((message: string) => window.confirm(message));

  const [sessions, setSessions] = useState<AuthSessionInfo[] | null>(null);
  const [devices, setDevices] = useState<AuthTrustedDevice[] | null>(null);
  const [devicePolicyAllowed, setDevicePolicyAllowed] = useState(true);
  const [passkeys, setPasskeys] = useState<AuthPasskeyCredential[] | null>(null);
  const [status, setStatus] = useState<string>("");

  const loadSessions = useCallback(async () => {
    const res = await apiAuth.listSessions();
    if (res.error || !res.data) {
      // Empty, not null: "Loading…" forever is indistinguishable from a slow
      // network, and this is a security screen where "I see nothing" must not
      // be mistaken for "there is nothing".
      setSessions([]);
      setStatus("Could not load your sessions. This list may be incomplete.");
      return;
    }
    setSessions(res.data.sessions ?? []);
  }, []);

  const loadTrustedDevices = useCallback(async () => {
    const res = await apiAuth.listTrustedDevices();
    if (res.error || !res.data) return;
    {
      setDevices(res.data.trusted_devices ?? []);
      // `allowed` is the workspace POLICY, not a reason to hide the list. A
      // user must still be able to see and revoke a bypass that policy has
      // since forbidden — hiding it would strand an active credential.
      setDevicePolicyAllowed(res.data.allowed !== false);
    }
  }, []);

  const loadPasskeys = useCallback(async () => {
    const res = await apiAuth.listPasskeys();
    if (res.error || !res.data) return;
    setPasskeys(res.data.items ?? []);
  }, []);

  useEffect(() => {
    void loadSessions();
    void loadTrustedDevices();
    void loadPasskeys();
  }, [loadSessions, loadTrustedDevices, loadPasskeys]);

  const revokeSession = async (row: AuthSessionInfo) => {
    if (row.current) return; // defence in depth; the UI renders no control
    if (!(await ask(`Sign out ${deviceName(row, row.user_agent)}?`))) return;
    const res = await apiAuth.revokeSession(row.id);
    if (res.error) {
      // Silence after a confirmed destructive action reads as success. A user
      // who believes a lost laptop was signed out, and is wrong, is worse off
      // than one who was told it failed.
      setStatus("Could not sign that session out. It still has access.");
      return;
    }
    setStatus("Session signed out.");
    await loadSessions();
  };

  const logoutOthers = async () => {
    if (!(await ask("Sign out every other session?"))) return;
    const res = await apiAuth.logoutAllOtherSessions();
    if (res.error || !res.data) {
      setStatus("Could not sign the other sessions out. They still have access.");
      return;
    }
    {
      // The server's count, verbatim. Recomputing it from the list we happen to
      // hold would report a number that was never true.
      setStatus(`Signed out ${res.data.revoked_count} session(s).`);
      await loadSessions();
    }
  };

  const revokeDevice = async (row: AuthTrustedDevice) => {
    if (!(await ask(`Stop trusting ${deviceName(row)}? It will need MFA again.`)))
      return;
    const res = await apiAuth.revokeTrustedDevice(row.id);
    if (res.error) {
      setStatus("Could not revoke that device. It can still skip MFA.");
      return;
    }
    setStatus("Device will require MFA at next sign-in.");
    await loadTrustedDevices();
  };

  const revokeAllDevices = async () => {
    if (!(await ask("Require MFA on every device at next sign-in?"))) return;
    const res = await apiAuth.revokeAllTrustedDevices();
    if (res.error || !res.data) {
      setStatus("Could not revoke the trusted devices. They can still skip MFA.");
      return;
    }
    {
      setStatus(`Revoked ${res.data.revoked_count} trusted device(s).`);
      await loadTrustedDevices();
    }
  };

  const deletePasskey = async (row: AuthPasskeyCredential) => {
    if (!(await ask(`Delete passkey "${row.name ?? "Unnamed"}"?`))) return;
    const res = await apiAuth.deletePasskey(row.id);
    if (res.error) {
      setStatus("Could not delete that passkey. It can still sign in.");
      return;
    }
    setStatus("Passkey deleted.");
    await loadPasskeys();
  };

  const renamePasskey = async (row: AuthPasskeyCredential, name: string) => {
    const next = name.trim();
    if (!next || next === row.name) return;
    const res = await apiAuth.renamePasskey(row.id, next);
    if (!res.error) await loadPasskeys();
  };

  return (
    <div data-testid="account-security">
      {status ? <p role="status">{status}</p> : null}

      <section aria-labelledby="sessions-heading">
        <h3 id="sessions-heading">Active sessions</h3>
        {sessions === null ? (
          <p>Loading sessions…</p>
        ) : sessions.length === 0 ? (
          <p>No active sessions.</p>
        ) : (
          <ul>
            {sessions.map((row) => (
              <li key={row.id}>
                <span>{deviceName(row, row.user_agent)}</span>
                <span>{row.current ? "This device" : formatWhen(row.last_seen_at)}</span>
                {/* No control on the current session: revoking it from a list
                    is indistinguishable from the app crashing. */}
                {row.current ? null : (
                  <button type="button" onClick={() => void revokeSession(row)}>
                    Sign out
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <button type="button" onClick={() => void logoutOthers()}>
          Sign out all other sessions
        </button>
      </section>

      <section aria-labelledby="trusted-heading">
        <h3 id="trusted-heading">Trusted devices</h3>
        <p>These devices skip multi-factor authentication when you sign in.</p>
        {!devicePolicyAllowed ? (
          <p role="note">
            Your workspace no longer allows new trusted devices. Existing ones
            are listed below and can still be revoked.
          </p>
        ) : null}
        {devices === null ? (
          <p>Loading devices…</p>
        ) : devices.length === 0 ? (
          <p>No trusted devices.</p>
        ) : (
          <ul>
            {devices.map((row) => (
              <li key={row.id}>
                <span>{deviceName(row)}</span>
                <span>{formatLastUsed(row.last_used_at)}</span>
                <button type="button" onClick={() => void revokeDevice(row)}>
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
        <button type="button" onClick={() => void revokeAllDevices()}>
          Revoke all trusted devices
        </button>
      </section>

      <section aria-labelledby="passkeys-heading">
        <h3 id="passkeys-heading">Passkeys</h3>
        {passkeys === null ? (
          <p>Loading passkeys…</p>
        ) : passkeys.length === 0 ? (
          <p>No passkeys registered.</p>
        ) : (
          <ul>
            {passkeys.map((row) => (
              <li key={row.id}>
                <input
                  aria-label={`Passkey name for ${row.name ?? row.id}`}
                  defaultValue={row.name ?? ""}
                  onBlur={(e) => void renamePasskey(row, e.currentTarget.value)}
                />
                <span>{formatLastUsed(row.last_used_at)}</span>
                <button type="button" onClick={() => void deletePasskey(row)}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
        {/* Enrollment is deliberately absent. The API's RPOrigins is a single
            entry derived from POSTWAVE_PUBLIC_BASE_URL and this webview's
            origin is tauri://localhost, so a ceremony started here cannot
            validate. Adding that origin would let ANY locally-running
            application complete a ceremony for a Moosewave account — the fix
            would make security worse than the gap. */}
        <p>
          Passkeys are added from the web dashboard, under Settings → Security.
        </p>
      </section>
    </div>
  );
}

export default AccountSecuritySection;

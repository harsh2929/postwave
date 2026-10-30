// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { SecuritySettings } from "@/lib/security-api";

// The platform default session lifetime (auth.DefaultSessionLifetime, 30 days).
// The runtime shortens a session only when the stored cap is positive AND
// already shorter than this (auth.deviceSessionLifetimeTx), so a value outside
// 1…43200 caps nothing.
const SESSION_MINUTES_MAX = 43_200;

type SecurityPolicySettingsCardProps = {
  loading: boolean;
  saving: boolean;
  dirty: boolean;
  settings: SecuritySettings;
  onPatch: (patch: Partial<SecuritySettings>) => void;
  onSave: () => void;
  unavailable?: boolean;
};

export function SecurityPolicySettingsCard({
  loading,
  saving,
  dirty,
  settings,
  onPatch,
  onSave,
  unavailable = false,
}: SecurityPolicySettingsCardProps) {
  const sessionMinutes =
    settings.session_max_minutes == null
      ? ""
      : String(settings.session_max_minutes);
  // The PUT handler stores this number verbatim — it validates scopes and SSO
  // but never the timeout — so 0, a negative, a fraction, or anything past the
  // platform lifetime saves cleanly, reloads into this field, and is then
  // ignored by the only consumer. That is the same silent divergence the SSO
  // note above exists to prevent: a screen echoing back a policy nothing
  // enforces. Refuse the value here rather than let it be persisted.
  const sessionInvalid =
    settings.session_max_minutes != null &&
    (!Number.isInteger(settings.session_max_minutes) ||
      settings.session_max_minutes < 1 ||
      settings.session_max_minutes > SESSION_MINUTES_MAX);
  const hasStoredSSO =
    (settings.sso_provider ?? "").trim() !== "" ||
    (settings.sso_metadata_url ?? "").trim() !== "";

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Two-factor authentication policy</CardTitle>
          {/* This described an authentication model this deployment does not
              have. It read "Moosewave delegates login to your IdP ... Moosewave
              rejects sessions whose IdP assertion does not include an MFA
              claim", which told an operator on the security page that their
              workspace was federated and that these switches inspected IdP
              assertions. Neither is true: there is no SAML/SSO sign-in path in
              the product at all (see the SSO card below, which says so), and the
              gate reads Moosewave's own TOTP enrolment —
              internal/middleware/mfa_gate.go:101 calls hasConfirmedTOTPForUser
              and there is no assertion handling anywhere in internal/auth or
              internal/middleware. Getting this wrong is worse than a cosmetic
              copy bug: someone deciding whether their 2FA requirement is
              satisfied needs to know WHICH system is enforcing it. */}
          <CardDescription>
            Moosewave enforces these itself, with its own authenticator-app
            (TOTP) enrolment — sign-in is <em>not</em> delegated to an identity
            provider in this deployment. When enabled, Moosewave requires a
            confirmed TOTP factor and challenges the session before allowing
            protected actions.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-start gap-3">
            <Checkbox
              checked={settings.require_2fa_for_admins}
              disabled={loading || saving || unavailable}
              onChange={(event) =>
                onPatch({ require_2fa_for_admins: event.target.checked })
              }
              className="mt-1"
            />
            <span>
              <span className="font-medium">Require 2FA for admins</span>
              <span className="block text-xs text-muted-foreground">
                Owners and admins must enrol an authenticator app in Moosewave.
                Recommended.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-3">
            <Checkbox
              checked={settings.require_2fa_for_all}
              disabled={loading || saving || unavailable}
              onChange={(event) =>
                onPatch({ require_2fa_for_all: event.target.checked })
              }
              className="mt-1"
            />
            <span>
              <span className="font-medium">Require 2FA for all members</span>
              <span className="block text-xs text-muted-foreground">
                Everyone in the workspace, including marketers and viewers.
              </span>
            </span>
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Trusted-device policy</CardTitle>
          <CardDescription>
            Control whether members may create a standing MFA bypass on a
            device. Existing bypasses remain visible and revocable when this is
            turned off.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <label className="flex items-start gap-3">
            <Checkbox
              checked={settings.allow_trusted_devices !== false}
              disabled={loading || saving || unavailable}
              onChange={(event) =>
                onPatch({ allow_trusted_devices: event.target.checked })
              }
              className="mt-1"
            />
            <span>
              <span className="font-medium">Allow trusted devices</span>
              <span className="block text-xs text-muted-foreground">
                Members can choose an approved duration at sign-in and skip TOTP
                on that device until the trust expires or is revoked.
              </span>
            </span>
          </label>
        </CardContent>
      </Card>

      {/* SETC-038 / SETC-039: legacy values are rendered and preserved in the
          full-replace payload, but cannot be edited into a configuration the
          runtime does not enforce. The one supported transition is clearing
          both legacy values so stored state can be brought back to reality. */}
      <Card>
        <CardHeader>
          <CardTitle>Single sign-on &amp; sessions</CardTitle>
          <CardDescription>
            How long an authenticated session may last before re-login is
            required. Single sign-on is stored here but is not available in this
            deployment.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Say it before the inputs, not after a failed save.
              Nothing consumes sso_provider / sso_metadata_url: there is no ACS
              route, no SAML handler in apps/api, and scim.SAMLJITProvision has
              zero callers. The API refuses a NEW value with 503
              sso_not_available (internal/handlers/security.go), but a value
              saved before that gate existed still loads into these inputs — and
              a filled-in "SSO provider" box next to two settings that ARE
              enforced (2FA policy, session timeout) reads as protection the
              workspace does not have. */}
          <p
            role="note"
            className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-muted-foreground"
          >
            <strong className="font-medium text-foreground">
              SSO is not enforced.
            </strong>{" "}
            Sign-in is not delegated to an identity provider anywhere in this
            deployment — everyone signs in with their Moosewave credentials,
            whatever these two fields say. Saving a new provider is refused;
            these fields are read-only. Legacy values can only be cleared.
          </p>
          <div className="space-y-2">
            <Label htmlFor="sso-provider">SSO provider</Label>
            <Input
              id="sso-provider"
              value={settings.sso_provider ?? ""}
              disabled={loading || saving || unavailable}
              readOnly
              aria-describedby="sso-runtime-hold"
              placeholder="Not available in this deployment"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sso-metadata">SAML metadata URL</Label>
            <Input
              id="sso-metadata"
              type="url"
              value={settings.sso_metadata_url ?? ""}
              disabled={loading || saving || unavailable}
              readOnly
              aria-describedby="sso-runtime-hold"
              placeholder="Not available in this deployment"
            />
          </div>
          <div id="sso-runtime-hold" className="space-y-2">
            {hasStoredSSO ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={loading || saving || unavailable}
                  onClick={() =>
                    onPatch({ sso_provider: "", sso_metadata_url: "" })
                  }
                >
                  Clear stored SSO values
                </Button>
                <p className="text-xs text-muted-foreground">
                  This stages both legacy values for removal. Select Save
                  security settings to persist the change.
                </p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                No SSO configuration is stored. Provider setup remains
                unavailable.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="session-timeout">Session timeout (minutes)</Label>
            <Input
              id="session-timeout"
              type="number"
              min={1}
              max={SESSION_MINUTES_MAX}
              step={1}
              value={sessionMinutes}
              disabled={loading || saving || unavailable}
              aria-invalid={sessionInvalid}
              aria-describedby="session-timeout-help"
              placeholder="Leave blank for the platform default"
              onChange={(e) => {
                const raw = e.target.value.trim();
                onPatch({
                  session_max_minutes: raw === "" ? null : Number(raw),
                });
              }}
            />
            <p
              id="session-timeout-help"
              role={sessionInvalid ? "alert" : undefined}
              className={
                sessionInvalid
                  ? "text-xs text-destructive"
                  : "text-xs text-muted-foreground"
              }
            >
              {sessionInvalid
                ? `Enter a whole number of minutes from 1 to ${SESSION_MINUTES_MAX.toLocaleString()} (30 days), or leave it blank. Anything else is stored but never applied, so sessions would run at the full default lifetime.`
                : "Sessions are capped at this many minutes. Blank uses the platform default."}
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button
          type="button"
          onClick={onSave}
          disabled={
            loading || saving || unavailable || !dirty || sessionInvalid
          }
        >
          {saving ? "Saving…" : "Save security settings"}
        </Button>
      </div>
      {unavailable ? (
        <p role="note" className="text-sm text-muted-foreground">
          Reconnect before changing workspace security policy. Security writes
          are never queued for later replay.
        </p>
      ) : null}
    </>
  );
}

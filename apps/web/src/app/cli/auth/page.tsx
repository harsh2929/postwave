// SPDX-License-Identifier: AGPL-3.0-only
//
// Consent surface for both CLI login transports:
//   - loopback + PKCE (`port`, `state`, `code_challenge`) keeps its original
//     API-key flow;
//   - RFC 8628 device grants (`user_code`) are inspected read-only before any
//     mutation, then receive an explicit approve or deny decision. The server
//     decides whether the grant creates a CLI API key or a browser session.
"use client";

import {
  Clock3,
  Laptop,
  ShieldCheck,
  Terminal,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";

import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiError, api } from "@/lib/api";
import {
  decideDeviceGrant,
  inspectDeviceGrant,
  isCompleteDeviceUserCode,
  normalizeDeviceUserCode,
  type DeviceGrantDetails,
} from "@/lib/device-login";
import { asRoute } from "@/lib/typed-routes";

type DevicePhase =
  | "entry"
  | "inspecting"
  | "consent"
  | "deciding"
  | "done"
  | "needs_login"
  | "needs_mfa"
  | "error";

type LoopbackPhase =
  | "consent"
  | "authorizing"
  | "done"
  | "needs_login"
  | "error";

const SCOPE_LABELS: Readonly<Record<string, string>> = {
  "read:subscribers": "Read subscribers",
  "write:subscribers": "Create and update subscribers",
  "read:campaigns": "Read campaigns",
  "write:campaigns": "Create and update campaigns",
  "read:reports": "Read reports",
  "send:transactional": "Send transactional email",
};

function CliAuthInner() {
  const params = useSearchParams();
  const loopbackRequestPresent =
    params.has("port") || params.has("state") || params.has("code_challenge");
  const deviceMode = params.has("user_code") || !loopbackRequestPresent;

  return deviceMode ? (
    <DeviceGrantApproval initialCode={params.get("user_code") ?? ""} />
  ) : (
    <LoopbackCliApproval
      port={Number(params.get("port"))}
      state={params.get("state") ?? ""}
      codeChallenge={params.get("code_challenge") ?? ""}
      method={params.get("challenge_method") ?? "S256"}
    />
  );
}

function DeviceGrantApproval({ initialCode }: { initialCode: string }) {
  const [phase, setPhase] = useState<DevicePhase>("entry");
  const [deviceCode, setDeviceCode] = useState(() =>
    normalizeDeviceUserCode(initialCode),
  );
  const [details, setDetails] = useState<DeviceGrantDetails | null>(null);
  const [message, setMessage] = useState("");
  const [decision, setDecision] = useState<"approve" | "deny" | null>(null);

  const returnPath = useMemo(
    () =>
      isCompleteDeviceUserCode(deviceCode)
        ? `/cli/auth?user_code=${encodeURIComponent(deviceCode)}`
        : "/cli/auth",
    [deviceCode],
  );
  const loginHref = `/login?next=${encodeURIComponent(returnPath)}`;
  const mfaHref = `/totp-challenge?next=${encodeURIComponent(returnPath)}`;

  const review = useCallback(
    async (code = deviceCode) => {
      if (!isCompleteDeviceUserCode(code)) return;
      setPhase("inspecting");
      setMessage("");
      setDetails(null);
      try {
        const inspected = await inspectDeviceGrant(code);
        setDetails(inspected);
        setPhase("consent");
      } catch (error) {
        handleDeviceGrantError(error, setPhase, setMessage);
      }
    },
    [deviceCode],
  );

  useEffect(() => {
    const initial = normalizeDeviceUserCode(initialCode);
    if (isCompleteDeviceUserCode(initial)) void review(initial);
    // The URL-provided code is inspected once. `review` also depends on the
    // editable input, which must not cause another network call by itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCode]);

  async function decide(action: "approve" | "deny") {
    if (!details) return;
    setDecision(action);
    setPhase("deciding");
    setMessage("");
    try {
      const decided = await decideDeviceGrant(
        deviceCode,
        action,
        details.consentToken,
      );
      // The response repeats the authoritative kind/device disclosure. Keep
      // it for the final confirmation and fail closed on a kind swap.
      if (decided.grantKind !== details.grantKind) {
        throw new Error("The device request changed. Start again.");
      }
      setDetails(decided);
      setPhase("done");
    } catch (error) {
      setDecision(null);
      if (error instanceof ApiError && error.code === "consent_required") {
        // The two-minute inspect proof expired or the approving session/
        // workspace changed. Re-read the authoritative request and require a
        // fresh human decision instead of misreporting the code as consumed.
        await review(deviceCode);
        return;
      }
      handleDeviceGrantError(error, setPhase, setMessage);
    }
  }

  const heading =
    details?.grantKind === "session"
      ? "Approve sign-in?"
      : details?.grantKind === "api_key"
        ? "Authorize the Moosewave CLI"
        : "Review a device request";

  return (
    <ConsentShell heading={heading}>
      {phase === "entry" ? (
        <DeviceCodeEntry
          code={deviceCode}
          onChange={(value) => {
            setDeviceCode(normalizeDeviceUserCode(value));
            setDetails(null);
            setMessage("");
          }}
          onReview={() => void review()}
        />
      ) : phase === "inspecting" ? (
        <StatusMessage>Checking the device request…</StatusMessage>
      ) : phase === "needs_login" ? (
        <>
          <p className="text-sm text-muted-foreground">
            Sign in to the Moosewave dashboard, then return here to review the
            request. Signing in does not approve it.
          </p>
          <Button asChild className="mt-5">
            <Link href={asRoute(loginHref)}>Go to sign in</Link>
          </Button>
        </>
      ) : phase === "needs_mfa" ? (
        <>
          <p className="text-sm text-muted-foreground">
            Complete your workspace&apos;s two-factor challenge before approving
            this request.
          </p>
          <Button asChild className="mt-5">
            <Link href={asRoute(mfaHref)}>
              Continue to two-factor authentication
            </Link>
          </Button>
        </>
      ) : phase === "error" ? (
        <>
          <p className="text-sm text-destructive" role="alert">
            {message}
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={() => void review()}
              disabled={!isCompleteDeviceUserCode(deviceCode)}
            >
              Try again
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setDetails(null);
                setMessage("");
                setPhase("entry");
              }}
            >
              Enter another code
            </Button>
          </div>
        </>
      ) : phase === "done" && details ? (
        <DecisionComplete details={details} decision={decision ?? "deny"} />
      ) : details ? (
        <DeviceConsent
          details={details}
          userCode={deviceCode}
          deciding={phase === "deciding"}
          decision={decision}
          mfaHref={mfaHref}
          onApprove={() => void decide("approve")}
          onDeny={() => void decide("deny")}
          onBack={() => {
            setDetails(null);
            setDecision(null);
            setPhase("entry");
          }}
        />
      ) : null}
    </ConsentShell>
  );
}

function DeviceCodeEntry({
  code,
  onChange,
  onReview,
}: {
  code: string;
  onChange: (value: string) => void;
  onReview: () => void;
}) {
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        onReview();
      }}
    >
      <p className="text-sm text-muted-foreground">
        Enter the matching code shown on the device asking to sign in.
        You&apos;ll review what it is requesting before anything is approved.
      </p>
      <div className="space-y-1.5">
        <label
          htmlFor="device-user-code"
          className="text-sm font-medium text-foreground"
        >
          Device code
        </label>
        <input
          id="device-user-code"
          value={code}
          onChange={(event) => onChange(event.target.value)}
          autoFocus
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          inputMode="text"
          placeholder="ABCD-EFGH"
          className="h-11 w-full rounded-md border border-input bg-background px-3 text-center font-mono text-lg uppercase tracking-[0.2em] text-foreground"
        />
      </div>
      <Button type="submit" disabled={!isCompleteDeviceUserCode(code)}>
        Review request
      </Button>
    </form>
  );
}

function DeviceConsent({
  details,
  userCode,
  deciding,
  decision,
  mfaHref,
  onApprove,
  onDeny,
  onBack,
}: {
  details: DeviceGrantDetails;
  userCode: string;
  deciding: boolean;
  decision: "approve" | "deny" | null;
  mfaHref: string;
  onApprove: () => void;
  onDeny: () => void;
  onBack: () => void;
}) {
  const isSession = details.grantKind === "session";
  const metadata = Array.from(
    new Set(
      [details.device.client, details.device.os, details.device.type].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  ).join(" · ");

  return (
    <>
      <p className="text-sm text-muted-foreground">
        {isSession
          ? "This device is asking to sign in to your Moosewave workspace."
          : "The Moosewave CLI on this device is requesting an API key for your workspace."}
      </p>

      <div className="mt-5 rounded-lg border bg-muted/20 p-4">
        <div className="flex items-start gap-3">
          {isSession ? (
            <Laptop
              className="mt-0.5 size-5 text-muted-foreground"
              aria-hidden
            />
          ) : (
            <Terminal
              className="mt-0.5 size-5 text-muted-foreground"
              aria-hidden
            />
          )}
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Reported requesting device
            </p>
            <p className="break-words font-medium text-foreground">
              {details.device.label}
            </p>
            {metadata ? (
              <p className="mt-0.5 text-xs text-muted-foreground">{metadata}</p>
            ) : null}
            <p className="mt-1 text-xs text-muted-foreground">
              Device details are self-reported. Trust the matching code and
              approve only if you started this request.
            </p>
            <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <span>Matching code</span>
              <code className="font-semibold tracking-[0.14em] text-foreground">
                {userCode}
              </code>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-md border px-3 py-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {details.account.workspaceName ??
            details.account.workspaceSlug ??
            "Current workspace"}
        </span>
        <span aria-hidden> · </span>
        <span className="break-all">{details.account.email}</span>
      </div>

      {isSession ? (
        <div className="mt-4 flex gap-2 rounded-md border border-info/40 bg-info-subtle p-3 text-xs text-info">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>
            {details.remember
              ? "This device requested a persistent session. Approve only on a device you trust."
              : "This creates a short browser session. The new device must still satisfy your workspace's security policy."}
          </p>
        </div>
      ) : (
        <ul className="mt-4 space-y-1.5" aria-label="Requested CLI permissions">
          {details.scopes.map((scope) => (
            <li
              key={scope}
              className="flex items-center gap-2 text-sm text-foreground"
            >
              <span
                className="size-1.5 rounded-full bg-emerald-500"
                aria-hidden
              />
              {SCOPE_LABELS[scope] ?? scope}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-foreground">
        <TriangleAlert
          className="mt-0.5 size-4 shrink-0 text-amber-600"
          aria-hidden
        />
        <p>
          Approve only if you started this request and the code matches the one
          on the other device. A QR code can be forwarded by an attacker.
        </p>
      </div>

      <div className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock3 className="size-3.5" aria-hidden />
        Request expires in {formatDuration(details.expiresIn)}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        {details.requiresMfa ? (
          <Button asChild>
            <Link href={asRoute(mfaHref)}>
              Verify with two-factor authentication
            </Link>
          </Button>
        ) : (
          <Button type="button" onClick={onApprove} disabled={deciding}>
            {deciding && decision === "approve"
              ? "Approving…"
              : isSession
                ? "Approve sign-in"
                : "Authorize API key"}
          </Button>
        )}
        <Button
          type="button"
          variant="destructive"
          onClick={onDeny}
          disabled={deciding}
        >
          {deciding && decision === "deny" ? "Denying…" : "Deny request"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={onBack}
          disabled={deciding}
        >
          Back
        </Button>
      </div>
    </>
  );
}

function DecisionComplete({
  details,
  decision,
}: {
  details: DeviceGrantDetails;
  decision: "approve" | "deny";
}) {
  if (decision === "deny") {
    return (
      <StatusMessage>
        Request denied. No{" "}
        {details.grantKind === "session" ? "session" : "API key"} was created.
      </StatusMessage>
    );
  }
  return (
    <StatusMessage>
      {details.grantKind === "session"
        ? "Sign-in approved. Return to the other device; it will finish automatically."
        : "CLI access authorized. Return to your terminal; it will finish automatically."}
    </StatusMessage>
  );
}

function LoopbackCliApproval({
  port,
  state,
  codeChallenge,
  method,
}: {
  port: number;
  state: string;
  codeChallenge: string;
  method: string;
}) {
  const [phase, setPhase] = useState<LoopbackPhase>("consent");
  const [message, setMessage] = useState("");
  const requestValid =
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65535 &&
    state.length >= 16 &&
    codeChallenge.length >= 32 &&
    method === "S256";

  const returnPath = requestValid
    ? `/cli/auth?${new URLSearchParams({
        port: String(port),
        state,
        code_challenge: codeChallenge,
        challenge_method: method,
      }).toString()}`
    : "/cli/auth";

  async function authorize() {
    setPhase("authorizing");
    try {
      const response = await api.post<{ code: string }>(
        "/api/v1/auth/cli/authorize",
        {
          state,
          code_challenge: codeChallenge,
          challenge_method: method,
          port,
        },
        { requireOnline: true, cache: "no-store", maxAttempts: 1 },
      );
      const url = new URL(`http://127.0.0.1:${port}/callback`);
      url.searchParams.set("code", response.code);
      url.searchParams.set("state", state);
      setPhase("done");
      window.location.href = url.toString();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setPhase("needs_login");
        return;
      }
      setPhase("error");
      setMessage(
        "Could not authorize the CLI. Re-run postwave login and try again.",
      );
    }
  }

  return (
    <ConsentShell heading="Authorize the Moosewave CLI">
      {!requestValid ? (
        <p className="text-sm text-destructive-emphasis">
          Invalid or missing CLI authorization request. Re-run{" "}
          <code className="rounded bg-muted px-1">postwave login</code> from
          your terminal.
        </p>
      ) : phase === "needs_login" ? (
        <>
          <p className="text-sm text-muted-foreground">
            Sign in to the Moosewave dashboard first, then return to approve this
            request.
          </p>
          <Button asChild className="mt-5">
            <Link href={`/login?next=${encodeURIComponent(returnPath)}`}>
              Go to sign in
            </Link>
          </Button>
        </>
      ) : phase === "error" ? (
        <p className="text-sm text-destructive-emphasis" role="alert">
          {message}
        </p>
      ) : phase === "done" ? (
        <StatusMessage>
          Authorized. Returning to your terminal — you can close this tab.
        </StatusMessage>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            The Moosewave CLI on this machine is requesting an API key for your
            workspace.
          </p>
          <ul className="mt-4 space-y-1.5">
            {[
              "Read & write subscribers",
              "Read & write campaigns",
              "Read reports",
              "Send transactional email",
            ].map((scope) => (
              <li
                key={scope}
                className="flex items-center gap-2 text-sm text-foreground"
              >
                <span
                  className="size-1.5 rounded-full bg-emerald-500"
                  aria-hidden
                />
                {scope}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-muted-foreground">
            Only authorize if you just ran{" "}
            <code className="rounded bg-muted px-1">postwave login</code>. The
            key is delivered straight to your terminal.
          </p>
          <div className="mt-6 flex items-center gap-3">
            <Button
              type="button"
              onClick={() => void authorize()}
              disabled={phase === "authorizing"}
            >
              {phase === "authorizing" ? "Authorizing…" : "Authorize"}
            </Button>
            <Button asChild variant="ghost">
              <Link href="/app">Cancel</Link>
            </Button>
          </div>
        </>
      )}
    </ConsentShell>
  );
}

function ConsentShell({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <AuthShell skipLabel="device request review">
      <Card>
        <CardHeader>
          <div className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-primary">
            <Terminal className="size-3.5" aria-hidden />
            Secure device approval
          </div>
          <CardTitle as="h1">{heading}</CardTitle>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </AuthShell>
  );
}

function StatusMessage({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex items-start gap-2 text-sm text-muted-foreground"
      role="status"
    >
      <ShieldCheck
        className="mt-0.5 size-4 shrink-0 text-emerald-600"
        aria-hidden
      />
      <p>{children}</p>
    </div>
  );
}

function handleDeviceGrantError(
  error: unknown,
  setPhase: (phase: DevicePhase) => void,
  setMessage: (message: string) => void,
) {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      setPhase("needs_login");
      return;
    }
    if (error.status === 403 && error.code === "mfa_required") {
      setPhase("needs_mfa");
      return;
    }
    if (error.code === "insufficient_role") {
      setMessage("Your workspace role cannot authorize this CLI credential.");
      setPhase("error");
      return;
    }
    if (error.status === 400) {
      setMessage("That code is invalid, expired, or was already decided.");
      setPhase("error");
      return;
    }
    if (error.status === 429) {
      setMessage("Too many attempts. Wait a moment, then try again.");
      setPhase("error");
      return;
    }
  }
  setMessage(
    error instanceof Error &&
      error.message.startsWith("The device request changed")
      ? error.message
      : "Could not load the device request. Check your connection and try again.",
  );
  setPhase("error");
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export default function CliAuthPage() {
  return (
    <Suspense
      fallback={
        <AuthShell skipLabel="device request review">
          <Card>
            <CardHeader>
              <CardTitle as="h1">Review a device request</CardTitle>
            </CardHeader>
            <CardContent>
              <div
                className="flex items-center gap-3 text-sm text-muted-foreground"
                role="status"
                aria-busy="true"
              >
                <span className="size-5 animate-spin rounded-full border-2 border-muted border-t-primary" />
                Loading secure request…
              </div>
            </CardContent>
          </Card>
        </AuthShell>
      }
    >
      <CliAuthInner />
    </Suspense>
  );
}

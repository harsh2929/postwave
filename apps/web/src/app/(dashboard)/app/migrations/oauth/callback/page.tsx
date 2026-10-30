// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { ArrowLeft, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";

import {
  FreshAdminAuthorityError,
  verifyFreshAdminAuthority,
} from "@/lib/admin-mutation-authority";
import { effectiveAuthRole, whoami, type MeResponse } from "@/lib/auth-api";
import { completeOAuth } from "@/lib/migration-api";
import { migrationOAuthReturnPath } from "@/lib/migration-oauth-return";
import { qk, STALE } from "@/lib/query-keys";
import { roleCanWrite } from "@/lib/use-admin-gate";
import {
  MIGRATION_SOURCE_PLATFORMS,
  SOURCE_LABELS,
  type SourcePlatform,
} from "@/lib/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageShell } from "@/components/dashboard/page-shell";

function isSource(s: string | null): s is SourcePlatform {
  return (
    s !== null && (MIGRATION_SOURCE_PLATFORMS as readonly string[]).includes(s)
  );
}

// Map the machine error codes an OAuth provider can return on the callback URL
// to human-readable copy, so the failure screen never shows a bare
// `access_denied` (MIGR-007).
const OAUTH_ERROR_COPY: Record<string, string> = {
  access_denied:
    "You declined access, or the provider blocked it. Approve access to continue the migration.",
  invalid_scope:
    "The requested permissions weren't granted. Reconnect and approve every requested scope.",
  invalid_request:
    "The provider rejected the authorization request. Start the connection again.",
  unauthorized_client:
    "This app isn't authorized for that account. Check the connected app and retry.",
  unsupported_response_type:
    "The provider couldn't complete this authorization flow. Start the connection again.",
  server_error:
    "The provider hit a temporary error. Wait a moment and try connecting again.",
  temporarily_unavailable:
    "The provider is temporarily unavailable. Wait a moment and try connecting again.",
  consent_required:
    "The provider needs you to grant consent. Reconnect to approve.",
  login_required:
    "The provider needs you to sign in again. Reconnect to continue.",
  interaction_required:
    "The provider needs another sign-in step. Reconnect to continue.",
};

function humanizeOAuthError(code: string): string {
  return OAUTH_ERROR_COPY[code] ?? `The provider returned an error: ${code}.`;
}

// PENDING_TTL is how stale the start-handler marker can be before
// we refuse the callback. Keep this aligned with the server state TTL;
// anything older is either an abandoned flow that got
// resumed, or an attacker replaying an old callback URL.
const PENDING_TTL = 15 * 60 * 1000;
const PENDING_CLOCK_SKEW_MS = 60 * 1000;

// consumePendingOAuth validates the sessionStorage marker the start handler
// wrote, then removes it only for a successfully matched principal. Authority
// failures and identity/source mismatches leave it available to the principal
// that actually started the flow. The server-side state check remains the
// primary single-use defense.
interface PendingOAuthResult {
  ok: boolean;
  reason?: string;
  jobId?: string;
  returnStep?: "review" | "detail";
  desktopReturn?: boolean;
}

function consumePendingOAuth(
  source: SourcePlatform,
  identity: MeResponse,
): PendingOAuthResult {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem("postwave:oauth-pending");
  } catch {
    return { ok: true }; // sessionStorage unavailable — fall back to server check
  }
  if (!raw)
    return { ok: false, reason: "no pending OAuth flow on this device" };
  try {
    const parsed = JSON.parse(raw) as {
      source?: string;
      startedAt?: number;
      jobId?: string;
      returnStep?: string;
      desktopReturn?: boolean;
      tenantId?: string;
      userId?: string;
      effectiveRole?: string;
      viewerMode?: boolean;
    };
    if (parsed.source !== source) {
      return {
        ok: false,
        reason: "callback source does not match the started flow",
      };
    }
    const now = Date.now();
    if (
      typeof parsed.startedAt !== "number" ||
      !Number.isFinite(parsed.startedAt) ||
      parsed.startedAt < now - PENDING_TTL ||
      parsed.startedAt > now + PENDING_CLOCK_SKEW_MS
    ) {
      try {
        sessionStorage.removeItem("postwave:oauth-pending");
      } catch {
        // The server-side state remains authoritative when storage fails.
      }
      return { ok: false, reason: "OAuth flow expired — please restart" };
    }
    if (
      parsed.tenantId !== identity.tenant_id ||
      parsed.userId !== identity.user_id ||
      parsed.effectiveRole !== effectiveAuthRole(identity) ||
      parsed.viewerMode !== (identity.viewer_mode === true)
    ) {
      return {
        ok: false,
        reason:
          "the workspace identity no longer matches the account that started this OAuth flow",
      };
    }
    try {
      sessionStorage.removeItem("postwave:oauth-pending");
    } catch {
      // The tenant-bound server state remains the primary single-use guard.
    }
    return {
      ok: true,
      ...(typeof parsed.jobId === "string" && parsed.jobId
        ? { jobId: parsed.jobId }
        : {}),
      ...(parsed.returnStep === "review" || parsed.returnStep === "detail"
        ? { returnStep: parsed.returnStep }
        : {}),
      ...(parsed.desktopReturn === true ? { desktopReturn: true } : {}),
    };
  } catch {
    try {
      sessionStorage.removeItem("postwave:oauth-pending");
    } catch {
      // The server-side state remains authoritative when storage fails.
    }
    return { ok: false, reason: "OAuth pending marker malformed" };
  }
}

export default function OAuthCallbackPage() {
  return (
    <Suspense fallback={<OAuthCallbackLoading />}>
      <OAuthCallbackContent />
    </Suspense>
  );
}

function OAuthCallbackContent() {
  const identityQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
    retry: false,
  });
  const identity = identityQuery.data ?? null;
  const role = identity ? effectiveAuthRole(identity) : null;
  const canAdmin = Boolean(
    identityQuery.isSuccess &&
    identity &&
    identity.viewer_mode !== true &&
    roleCanWrite(role),
  );

  if (identityQuery.isPending) return <OAuthCallbackLoading />;
  if (identityQuery.isError || !identity) {
    return (
      <OAuthCallbackAccessState
        title="Couldn’t verify migration access"
        description={
          identityQuery.error instanceof Error
            ? identityQuery.error.message
            : "Moosewave could not verify your current workspace identity."
        }
        retrying={identityQuery.isFetching}
        onRetry={() => void identityQuery.refetch()}
      />
    );
  }
  if (!canAdmin) {
    return (
      <OAuthCallbackAccessState
        title="Owner or admin access required"
        description={
          identity.viewer_mode
            ? "Viewer mode is active. Exit viewer mode, then reopen this callback to finish the migration connection. The pending OAuth marker has not been consumed."
            : `Your effective ${role ?? "unknown"} role cannot complete workspace migrations. Ask an owner or admin to reopen this callback. The pending OAuth marker has not been consumed.`
        }
      />
    );
  }

  const authorityKey = [
    identity.tenant_id,
    identity.user_id,
    role,
    identity.viewer_mode === true ? "viewer" : "member",
  ].join("\u0000");
  return (
    <AuthorizedOAuthCallback
      key={authorityKey}
      identity={identity}
      authorityKey={authorityKey}
    />
  );
}

function AuthorizedOAuthCallback({
  identity,
  authorityKey,
}: {
  identity: MeResponse;
  authorityKey: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [authorityFailure, setAuthorityFailure] = useState<{
    title: string;
    description: string;
  } | null>(null);
  const [authorityAttempt, setAuthorityAttempt] = useState(0);
  // React Strict Mode replays effects in development. Consuming the one-time
  // session marker twice would turn a valid callback into a false replay
  // rejection, so the callback transaction starts at most once per mount.
  const startedRef = useRef(false);
  const operationRef = useRef<AbortController | null>(null);
  // The parent keys this component by every authority-relevant identity field.
  // Keep the matching object stable within that key so an equivalent auth
  // background refresh cannot restart a callback after its marker is consumed.
  const expectedIdentityRef = useRef(identity);
  const routerRef = useRef(router);
  const callbackIntentRef = useRef(
    Object.freeze({
      code: params.get("code"),
      state: params.get("state"),
      source: params.get("source"),
      oauthError: params.get("error"),
    }),
  );
  const rawSource = callbackIntentRef.current.source;
  const retrySource = isSource(rawSource) ? rawSource : null;

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const controller = new AbortController();
    operationRef.current = controller;
    const cleanup = () => {
      controller.abort();
      startedRef.current = false;
      if (operationRef.current === controller) operationRef.current = null;
    };
    const rawIntent = callbackIntentRef.current;

    if (rawIntent.oauthError) {
      setError(humanizeOAuthError(rawIntent.oauthError));
      return cleanup;
    }
    const { code, state, source } = rawIntent;
    if (!code || !state || !isSource(source)) {
      setError("Missing OAuth parameters in callback URL.");
      return cleanup;
    }
    const intent = Object.freeze({ code, state, source });
    const expectedIdentity = expectedIdentityRef.current;
    void (async () => {
      try {
        await verifyFreshAdminAuthority(expectedIdentity, controller.signal);
        controller.signal.throwIfAborted();
      } catch (authorityError) {
        if (controller.signal.aborted) return;
        if (authorityError instanceof FreshAdminAuthorityError) {
          const freshRole = effectiveAuthRole(authorityError.freshIdentity);
          const freshCanAdmin =
            authorityError.freshIdentity.viewer_mode !== true &&
            roleCanWrite(freshRole);
          setAuthorityFailure({
            title: freshCanAdmin
              ? "Workspace identity changed"
              : "Owner or admin access required",
            description: freshCanAdmin
              ? "Your current workspace or user no longer matches the account that opened this callback. The pending OAuth marker has not been consumed; return to migrations and reopen the connection for the current workspace."
              : authorityError.freshIdentity.viewer_mode
                ? "Viewer mode is now active. Exit viewer mode, then retry this access check. The pending OAuth marker has not been consumed."
                : `Your effective ${freshRole ?? "unknown"} role cannot complete workspace migrations. Ask an owner or admin to restore access, then retry. The pending OAuth marker has not been consumed.`,
          });
        } else {
          setAuthorityFailure({
            title: "Couldn’t reverify migration access",
            description: `${
              authorityError instanceof Error
                ? authorityError.message
                : "Moosewave could not verify your current workspace identity."
            } The pending OAuth marker has not been consumed.`,
          });
        }
        return;
      }
      try {
        // Consume only after the online authority check succeeds. Auth errors,
        // viewer mode, and stale-principal failures leave this single-use
        // marker available for an authorized retry.
        const pending = consumePendingOAuth(intent.source, expectedIdentity);
        if (!pending.ok) {
          throw new Error(`OAuth callback rejected: ${pending.reason}`);
        }
        const { job_id } = await completeOAuth(
          intent.source,
          intent.code,
          intent.state,
          controller.signal,
        );
        controller.signal.throwIfAborted();
        if (pending.jobId && pending.jobId !== job_id) {
          throw new Error(
            "OAuth reconnect returned a different migration job. Restart the reconnect from the migration page.",
          );
        }
        toast.success("Connected", {
          description: pending.desktopReturn
            ? "Return to the desktop app to choose audiences."
            : "Inspecting your account next.",
        });
        routerRef.current.replace(
          migrationOAuthReturnPath(
            intent.source,
            job_id,
            pending.returnStep,
            pending.desktopReturn === true,
          ),
        );
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(
          err instanceof Error ? err.message : "OAuth completion failed",
        );
      }
    })();
    return cleanup;
  }, [authorityAttempt, authorityKey]);

  if (authorityFailure) {
    return (
      <OAuthCallbackAccessState
        title={authorityFailure.title}
        description={authorityFailure.description}
        onRetry={() => {
          setAuthorityFailure(null);
          setAuthorityAttempt((attempt) => attempt + 1);
        }}
      />
    );
  }

  if (error) {
    return <OAuthCallbackFailure error={error} retrySource={retrySource} />;
  }

  return <OAuthCallbackLoading />;
}

function OAuthCallbackAccessState({
  title,
  description,
  retrying = false,
  onRetry,
}: {
  title: string;
  description: string;
  retrying?: boolean;
  onRetry?: () => void;
}) {
  return (
    <PageShell className="max-w-xl">
      <header className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">
          Migration connection
        </p>
        <h1 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
          {title}
        </h1>
        <p className="text-sm leading-6 text-muted-foreground">{description}</p>
      </header>
      <div className="flex flex-col gap-2 sm:flex-row">
        {onRetry ? (
          <Button type="button" onClick={onRetry} loading={retrying}>
            {retrying ? "Retrying…" : "Retry access check"}
          </Button>
        ) : null}
        <Button asChild variant={onRetry ? "ghost" : "outline"}>
          <Link href="/app/migrations">
            <ArrowLeft className="h-4 w-4" /> Back to migrations
          </Link>
        </Button>
      </div>
    </PageShell>
  );
}

function OAuthCallbackFailure({
  error,
  retrySource,
}: {
  error: string;
  retrySource: SourcePlatform | null;
}) {
  return (
    <PageShell className="max-w-xl [&_[data-slot=button]]:min-h-11 [&_[data-slot=button]]:min-w-11 sm:[&_[data-slot=button]]:min-h-9 sm:[&_[data-slot=button]]:min-w-0">
      <header className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">
          Migration connection
        </p>
        <h1 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
          Connection needs attention
        </h1>
        <p className="text-sm leading-6 text-muted-foreground">
          No migration started. Resolve the provider response, then begin the
          connection again from Moosewave.
        </p>
      </header>
      <Alert variant="destructive">
        <AlertTitle>Couldn&apos;t finish connecting</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {retrySource ? (
          <Button asChild>
            <Link href={`/app/migrations/new/${retrySource}`}>
              <RotateCcw className="h-4 w-4" /> Try connecting{" "}
              {SOURCE_LABELS[retrySource]} again
            </Link>
          </Button>
        ) : null}
        <Button asChild variant={retrySource ? "ghost" : "default"}>
          <Link href="/app/migrations">
            <ArrowLeft className="h-4 w-4" /> Back to migrations
          </Link>
        </Button>
      </div>
    </PageShell>
  );
}

function OAuthCallbackLoading() {
  return (
    <PageShell className="max-w-xl">
      <Card
        role="status"
        aria-live="polite"
        aria-busy="true"
        className="overflow-hidden rounded-2xl"
      >
        <CardHeader>
          <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Loader2
              className="h-5 w-5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          </div>
          <CardTitle
            as="h1"
            className="font-display text-2xl leading-tight sm:text-3xl"
          >
            Finishing connection…
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm leading-6 text-muted-foreground">
          Don&apos;t close this tab — we&apos;ll redirect you in a moment.
        </CardContent>
      </Card>
    </PageShell>
  );
}

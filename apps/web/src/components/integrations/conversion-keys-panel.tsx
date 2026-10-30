// SPDX-License-Identifier: AGPL-3.0-only
//
// Conversion-tracking key management. Web previously had no key lifecycle UI;
// desktop did. Lets an admin mint a key (plaintext shown once) and revoke it.
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { KeyRound } from "lucide-react";
import { toast } from "sonner";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { CopyTextButton } from "@/components/copy-text-button";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import {
  effectiveAuthRole,
  whoami,
  whoamiFresh,
  type MeResponse,
} from "@/lib/auth-api";
import {
  conversionTrackingKeyLabelError,
  conversionsApi,
  type TrackingKey,
} from "@/lib/conversions-api";
import { newUUIDv7 } from "@/lib/http-fetch";
import { base, qk, STALE } from "@/lib/query-keys";
import { roleCanWrite, useAdminGate } from "@/lib/use-admin-gate";
import { AdminGateNotice } from "@/components/admin-gate-notice";

function fmtDate(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function keysErrorMessage(e: unknown): string {
  if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
    return "You need admin access to manage tracking keys.";
  }
  return e instanceof Error ? e.message : "Failed to load keys";
}

export function ConversionKeysPanel() {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [keyStored, setKeyStored] = useState(false);
  const [confirmAbandon, setConfirmAbandon] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<TrackingKey | null>(null);
  const createAttemptRef = useRef<{ label: string; key: string } | null>(null);
  const revokeAttemptsRef = useRef(new Map<string, string>());
  // Minting + revoking tracking keys is server-gated to admins/owners. Hide
  // the controls for read-only roles so they don't get a 403.
  const adminGate = useAdminGate();
  const { canWrite } = adminGate;

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const role = meQuery.data ? effectiveAuthRole(meQuery.data) : null;
  const integrationsBaseKey = useMemo(
    () => base("integrations", tenantId, role),
    [role, tenantId],
  );
  const keysKey = useMemo(
    () => [...integrationsBaseKey, "conversion-keys"] as const,
    [integrationsBaseKey],
  );
  const keysQuery = useQuery({
    queryKey: keysKey,
    queryFn: ({ signal }) =>
      conversionsApi.listKeys({ expectedTenantId: tenantId, signal }),
    enabled: meQuery.isSuccess && canWrite,
    staleTime: STALE.list,
  });
  const keys = Array.isArray(keysQuery.data) ? keysQuery.data : [];
  const loading =
    meQuery.isLoading || (canWrite && keysQuery.isPending && !keysQuery.data);
  const error =
    (canWrite && keysQuery.error) || meQuery.error
      ? keysErrorMessage(keysQuery.error ?? meQuery.error)
      : null;

  useEffect(() => {
    if (!plaintext) return;
    const protectSecret = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectSecret);
    return () => window.removeEventListener("beforeunload", protectSecret);
  }, [plaintext]);

  const invalidateKeys = (): Promise<void> =>
    queryClient
      .invalidateQueries({
        queryKey: keysKey,
        exact: false,
      })
      .then(() => undefined);

  async function verifyAuthority(identity: MeResponse): Promise<void> {
    const fresh = await whoamiFresh();
    if (
      fresh.tenant_id !== identity.tenant_id ||
      fresh.user_id !== identity.user_id
    ) {
      throw new Error(
        "Workspace identity changed. Reload before changing tracking keys.",
      );
    }
    if (!roleCanWrite(effectiveAuthRole(fresh))) {
      throw new Error("An owner or admin role is required.");
    }
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!meQuery.data || plaintext) return;
    const normalizedLabel = label.trim();
    const labelError = conversionTrackingKeyLabelError(normalizedLabel);
    if (labelError) {
      setOperationError(labelError);
      return;
    }
    if (createAttemptRef.current?.label !== normalizedLabel) {
      createAttemptRef.current = {
        label: normalizedLabel,
        key: newUUIDv7(),
      };
    }
    const attempt = createAttemptRef.current;
    if (!attempt) {
      setOperationError("Could not establish a stable key request ID.");
      return;
    }
    setCreating(true);
    setOperationError(null);
    try {
      await verifyAuthority(meQuery.data);
      const res = await conversionsApi.createKey(normalizedLabel, {
        expectedTenantId: tenantId,
        idempotencyKey: attempt.key,
      });
      createAttemptRef.current = null;
      setPlaintext(res.plaintext);
      setKeyStored(false);
      setLabel("");
      queryClient.setQueryData<TrackingKey[]>(keysKey, (current) => [
        res.key,
        ...(current ?? []),
      ]);
      toast.success("Tracking key created");
      void invalidateKeys().catch(() => {
        toast.warning(
          "The key was created, but the register refresh failed. The one-time full key remains available below.",
        );
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Create failed";
      setOperationError(message);
      toast.error(message);
    } finally {
      setCreating(false);
    }
  }

  async function onRevoke(id: string): Promise<void> {
    if (!meQuery.data) throw new Error("Workspace identity is unavailable.");
    const idempotencyKey = revokeAttemptsRef.current.get(id) ?? newUUIDv7();
    revokeAttemptsRef.current.set(id, idempotencyKey);
    await verifyAuthority(meQuery.data);
    await conversionsApi.revokeKey(id, { idempotencyKey });
    revokeAttemptsRef.current.delete(id);
    queryClient.setQueryData<TrackingKey[]>(keysKey, (current) =>
      (current ?? []).map((key) =>
        key.id === id ? { ...key, revoked_at: new Date().toISOString() } : key,
      ),
    );
    toast.success("Key revoked");
    void invalidateKeys().catch(() => {
      toast.warning(
        "The key was revoked, but the register refresh failed. The local row is marked revoked.",
      );
    });
  }

  return (
    <section
      className="mt-8 border-t border-border pt-6"
      data-testid="conversion-keys"
    >
      <div className="mb-4">
        <h2 className="text-lg font-semibold">
          Publishable conversion tracking keys
        </h2>
        <p className="text-xs text-muted-foreground mt-1">
          Low-trust routing credentials for browser or server telemetry. They do
          not create an HMAC signature and must never be reused as a signing
          secret. Use Trusted server conversion ingest below for authoritative
          feeds.
        </p>
      </div>

      {plaintext && (
        <div
          className="mb-4 rounded-lg border border-warning/40 bg-warning/10 p-3"
          role="status"
        >
          <div className="text-xs font-medium text-warning-emphasis mb-1">
            Copy this key now — it won&apos;t be shown again.
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <code className="min-w-0 flex-1 break-all rounded border border-border bg-background px-2 py-2 font-mono text-xs">
              {plaintext}
            </code>
            <CopyTextButton
              value={plaintext}
              size="sm"
              className="w-full sm:w-auto"
            />
          </div>
          <label className="mt-3 flex items-start gap-2 text-xs leading-5">
            <Checkbox
              checked={keyStored}
              onChange={(event) => setKeyStored(event.target.checked)}
            />
            <span>
              I saved this full publishable key in the integration&apos;s
              deployment configuration.
            </span>
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!keyStored}
              onClick={() => {
                setPlaintext(null);
                setKeyStored(false);
              }}
            >
              Acknowledge and hide
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setConfirmAbandon(true)}
            >
              Abandon shown key
            </Button>
          </div>
        </div>
      )}

      <AdminGateNotice
        gate={adminGate}
        className="mb-4"
        readOnlyMessage="You have read-only access. Ask a workspace admin to mint or revoke tracking keys."
      />

      {canWrite ? (
        <form
          onSubmit={onCreate}
          className="flex flex-wrap items-end gap-2 mb-4"
        >
          <div className="flex-1 min-w-[12rem]">
            <label
              htmlFor="conversion-key-label"
              className="block text-sm text-muted-foreground mb-1"
            >
              New key label
            </label>
            <input
              id="conversion-key-label"
              value={label}
              maxLength={120}
              disabled={creating || plaintext !== null}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Storefront checkout"
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm"
            />
          </div>
          <Button
            type="submit"
            disabled={!label.trim() || creating || plaintext !== null}
            loading={creating}
            className="w-full sm:w-auto"
          >
            {creating ? "Creating…" : "Create key"}
          </Button>
        </form>
      ) : null}

      {operationError ? (
        <p
          role="alert"
          className="mb-3 rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
        >
          {operationError}
        </p>
      ) : null}

      {error && (
        <div
          className="mb-3 flex flex-col items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive-emphasis"
          role="alert"
        >
          <span>{error}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void meQuery.refetch();
              void keysQuery.refetch();
            }}
          >
            Retry
          </Button>
        </div>
      )}
      {loading && (
        <div className="space-y-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      )}
      {/*
        A failed register read leaves `keys` empty. Rendering the empty state
        under the error banner would invite an admin to mint a duplicate key
        into a register they were never able to read.
      */}
      {!loading && canWrite && !error && keys.length === 0 && (
        <EmptyState
          icon={KeyRound}
          title="No tracking keys yet"
          description="Mint a publishable routing key for low-trust conversion telemetry. It is not a signed-ingest HMAC secret; the full value is shown only in its creation response."
        />
      )}

      <div className="space-y-2">
        {keys.map((k) => {
          const revoked = Boolean(k.revoked_at);
          return (
            <div
              key={k.id}
              className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="break-words text-sm font-medium">
                    {k.label}
                  </span>
                  {revoked && (
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-destructive/15 text-destructive-emphasis">
                      revoked
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground mt-1 font-mono">
                  {k.prefix}… · created {fmtDate(k.created_at)}
                </div>
              </div>
              {!revoked && canWrite && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={creating || plaintext !== null}
                  onClick={() => setRevokeTarget(k)}
                  className="w-full shrink-0 text-destructive hover:text-destructive sm:w-auto"
                >
                  Revoke
                </Button>
              )}
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(next) => {
          if (!next) setRevokeTarget(null);
        }}
        title="Revoke this tracking key?"
        description={
          revokeTarget
            ? `Telemetry submitted with “${revokeTarget.label}” will be rejected immediately. This publishable key does not sign events. Revocation cannot be undone.`
            : ""
        }
        confirmLabel="Revoke key"
        onConfirm={async () => {
          if (revokeTarget) await onRevoke(revokeTarget.id);
          setRevokeTarget(null);
        }}
      />
      <ConfirmDialog
        open={confirmAbandon}
        onOpenChange={setConfirmAbandon}
        title="Abandon the one-time key?"
        description="The full key will be removed from browser memory and cannot be shown again. The key itself remains active until you revoke it."
        confirmLabel="Abandon shown key"
        confirmationToken="ABANDON"
        onConfirm={() => {
          setPlaintext(null);
          setKeyStored(false);
        }}
      />
    </section>
  );
}

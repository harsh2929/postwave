// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiErrorMessage } from "@/lib/api";
import {
  effectiveAuthRole,
  whoamiFresh,
  type MeResponse,
} from "@/lib/auth-api";
import { roleCanWrite } from "@/lib/use-admin-gate";
import {
  retainVerifyAddressAttemptKey,
  verifyAddress,
  type VerificationAddressResult,
} from "@/lib/verification-api";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function VerifyAddressPanel({
  identity,
  queryKeyBase,
}: {
  identity: MeResponse;
  queryKeyBase: readonly unknown[];
}) {
  const queryClient = useQueryClient();
  const canWrite =
    !identity.viewer_mode && roleCanWrite(effectiveAuthRole(identity));
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VerificationAddressResult | null>(null);
  const attempt = useRef<{ email: string; key: string } | null>(null);
  const normalized = email.trim().toLowerCase();
  const valid = normalized.length <= 254 && EMAIL_RE.test(normalized);

  async function run() {
    if (!canWrite || !valid || pending) return;
    setPending(true);
    setError(null);
    setResult(null);
    try {
      const fresh = await whoamiFresh();
      if (
        fresh.tenant_id !== identity.tenant_id ||
        fresh.user_id !== identity.user_id ||
        fresh.viewer_mode ||
        !roleCanWrite(effectiveAuthRole(fresh))
      ) {
        throw new Error(
          "Workspace or write authority changed. Refresh before spending verification credits.",
        );
      }
      if (!attempt.current || attempt.current.email !== normalized) {
        if (typeof globalThis.crypto?.randomUUID !== "function") {
          throw new Error(
            "Secure request identity is unavailable. No verification was started.",
          );
        }
        attempt.current = { email: normalized, key: crypto.randomUUID() };
      }
      const verified = await verifyAddress(normalized, attempt.current.key);
      attempt.current = null;
      setResult(verified);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [...queryKeyBase, "credits"] }),
        queryClient.invalidateQueries({ queryKey: [...queryKeyBase, "cache"] }),
      ]);
    } catch (caught) {
      if (!retainVerifyAddressAttemptKey(caught)) attempt.current = null;
      setError(
        apiErrorMessage(caught, "Could not verify this address safely."),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="v-single" className="rounded-lg border p-4 sm:p-6">
      <h2 id="v-single" className="text-base font-medium">Verify one address</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Runs the configured provider chain and may consume one credit. An uncertain retry reuses the same billing identity.
      </p>
      <Input
        aria-label="Address to verify"
        type="email"
        value={email}
        maxLength={254}
        disabled={!canWrite || pending}
        onChange={(event) => {
          setEmail(event.target.value);
          setError(null);
          setResult(null);
          if (attempt.current?.email !== event.target.value.trim().toLowerCase()) {
            attempt.current = null;
          }
        }}
        className="mt-3 max-w-md"
      />
      <Button
        type="button"
        className="mt-3"
        disabled={!canWrite || !valid || pending}
        loading={pending}
        onClick={() => void run()}
      >
        {pending
          ? "Verifying…"
          : attempt.current?.email === normalized
            ? "Retry same verification"
            : "Verify address"}
      </Button>
      {!canWrite ? (
        // Names the role the gate actually admits. `roleCanWrite` is owner/admin
        // only — the same bar the jobs panel on this page applies to spending
        // credits — so telling a blocked editor they need "editor access"
        // described the role they already hold and left them no next step.
        <p className="mt-2 text-sm text-muted-foreground">
          Owner or admin access outside viewer mode is required because this action can spend provider credits.
        </p>
      ) : null}
      <div aria-live="polite" aria-busy={pending}>
        {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
        {result ? (
          <div className="mt-3 text-sm">
            <p className="font-medium">{result.email}: {result.status.replaceAll("_", " ")}</p>
            <p className="text-muted-foreground">
              {result.sub_status ? `${result.sub_status.replaceAll("_", " ")} · ` : ""}
              {result.cached ? "cached result; no new provider verification" : result.billable ? "provider credit consumed" : "no provider credit consumed"}
            </p>
            {result.did_you_mean ? <p>Did you mean {result.did_you_mean}?</p> : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

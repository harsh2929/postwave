// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * SupportProviderConnectDialog — desktop parity platform-91
 * (apps/desktop/src/pages/integrations/NativeProviderConnectModals.tsx
 * SupportConnectModal).
 *
 * Reads the static support-provider catalog to confirm the catalog entry is
 * a reported provider, then renders the connect verb the way desktop does:
 * while SUPPORT_INTEGRATION_RUNTIME_AVAILABLE is false no credential field
 * is shown, the submit is disabled with the hold reason, and no create,
 * ingest, sync, backfill, pause, disconnect, or run-history request is
 * sent. When the flag is lifted the same dialog exposes the connection form
 * and posts to the mounted POST /api/v1/support-integrations.
 */
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiErrorMessage } from "@/lib/api";
import { STALE } from "@/lib/query-keys";
import {
  SUPPORT_INTEGRATION_RUNTIME_AVAILABLE,
  SUPPORT_INTEGRATION_RUNTIME_HOLD_CODE,
  SUPPORT_INTEGRATION_RUNTIME_HOLD_MESSAGE,
  SUPPORT_PROVIDER_INGRESS_HOLD_CODE,
} from "@/lib/support-integration-operational-availability";
import {
  connectSupportIntegration,
  listSupportProviders,
} from "@/lib/support-integrations-api";

export function SupportProviderConnectDialog({
  item,
  open,
  onOpenChange,
  onConnected,
}: {
  /** The catalog row the operator opened (slug is the provider key). */
  item: { slug: string; name: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected?: () => void | Promise<void>;
}) {
  const holdId = useId();
  const nameId = useId();
  const credentialsId = useId();
  const [name, setName] = useState("");
  const [credentialsRef, setCredentialsRef] = useState("");
  const [busy, setBusy] = useState(false);

  // The provider catalog is static server metadata (provenance
  // tenant_bound:false), so its key carries no tenant or role segment.
  const providers = useQuery({
    queryKey: ["support-providers", "static-catalog"] as const,
    queryFn: ({ signal }) => listSupportProviders(signal),
    enabled: open,
    staleTime: STALE.reference,
    retry: false,
  });
  const rows = Array.isArray(providers.data) ? providers.data : [];
  const spec = rows.find((candidate) => candidate.key === item.slug) ?? null;
  const available = SUPPORT_INTEGRATION_RUNTIME_AVAILABLE;
  const canSubmit = available && spec !== null && !busy;

  async function submit() {
    if (!canSubmit || !spec) return;
    setBusy(true);
    try {
      await connectSupportIntegration({
        provider: spec.key,
        name: name.trim() || spec.name,
        credentials_ref: credentialsRef,
        settings: {},
      });
      toast.success(`${spec.name} connection saved`);
      await onConnected?.();
      onOpenChange(false);
    } catch (e) {
      toast.error(apiErrorMessage(e, `${spec.name} could not be connected`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent closeDisabled={busy}>
        <DialogHeader>
          <DialogTitle>
            {available
              ? `Connect ${spec?.name ?? item.name}`
              : "Support integration runtime held"}
          </DialogTitle>
          <DialogDescription>
            Catalog entry: {item.name}.{" "}
            {available
              ? "Save a support-provider connection reference."
              : "Credentials and provider lifecycle actions are not available in this release."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          {providers.isPending ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading the static support-provider catalog…
            </p>
          ) : null}
          {!providers.isPending && !spec ? (
            <Alert variant="destructive">
              <AlertTitle>Provider not reported</AlertTitle>
              <AlertDescription>
                {providers.isError
                  ? apiErrorMessage(
                      providers.error,
                      "Support provider setup couldn't be loaded. Check your connection and retry.",
                    )
                  : `${item.name} is not present in the reported support-provider catalog.`}{" "}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void providers.refetch()}
                >
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          {spec ? (
            <p role="status" className="text-sm text-muted-foreground">
              Reported provider: <strong>{spec.name}</strong>. This label is
              static catalog metadata, not proof of a connection or enabled
              runtime.
            </p>
          ) : null}
          {available ? (
            <>
              <Label htmlFor={nameId}>Connection name</Label>
              <Input
                id={nameId}
                value={name}
                maxLength={200}
                placeholder={spec?.name ?? item.name}
                onChange={(e) => setName(e.target.value)}
              />
              <Label htmlFor={credentialsId}>Credentials reference</Label>
              <Input
                id={credentialsId}
                value={credentialsRef}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setCredentialsRef(e.target.value)}
              />
            </>
          ) : (
            <Alert variant="warning" role="note" id={holdId}>
              <AlertTitle>{SUPPORT_INTEGRATION_RUNTIME_HOLD_MESSAGE}</AlertTitle>
              <AlertDescription>
                No credential field is shown and no create, ingest, sync,
                backfill, pause, disconnect, or run-history request will be
                sent. Admin/provider hold code:{" "}
                <code>{SUPPORT_INTEGRATION_RUNTIME_HOLD_CODE}</code>. Public
                callback ingress is separately held with{" "}
                <code>{SUPPORT_PROVIDER_INGRESS_HOLD_CODE}</code>.
              </AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
          <Button
            type="button"
            disabled={!canSubmit}
            aria-describedby={available ? undefined : holdId}
            title={available ? undefined : SUPPORT_INTEGRATION_RUNTIME_HOLD_MESSAGE}
            onClick={submit}
          >
            {available ? (busy ? "Connecting…" : "Connect") : "Connect — unavailable"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Eye, EyeOff, KeyRound, RefreshCw, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiErrorMessage } from "@/lib/api";
import type { MeResponse } from "@/lib/auth-api";
import { copyToClipboard } from "@/lib/clipboard";
import {
  endpointMetadata,
  getInboundEmailEndpointStrict,
  inboundEndpointUrl,
  newInboundRouteOperationKey,
  rotateInboundEmailEndpointStrict,
  type InboundEmailEndpoint,
  type InboundEmailEndpointReveal,
} from "@/lib/inbound-routes-admin-api";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";
import { verifyFreshInboundRouteAdmin } from "./inbound-route-authority";

function formatDate(value?: string) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function InboundEndpointPanel({
  me,
  queryScope,
}: {
  me: MeResponse;
  queryScope: readonly unknown[];
}) {
  const qc = useQueryClient();
  const key = [...queryScope, "inbound-email-endpoint"] as const;
  const endpoint = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      getInboundEmailEndpointStrict({ tenantId: me.tenant_id, signal }),
    retry: false,
  });
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [reveal, setReveal] = useState<InboundEmailEndpointReveal | null>(null);
  const rotateRef = useRef(false);
  const attemptRef = useRef<{
    fingerprint: string;
    key: string;
  } | null>(null);
  useUnsavedChangesGuard(rotating);

  async function rotate() {
    if (rotateRef.current) return;
    rotateRef.current = true;
    setRotating(true);
    const controller = new AbortController();
    try {
      await verifyFreshInboundRouteAdmin(me, controller.signal);
      let fresh = endpoint.data ?? null;
      if (!attemptRef.current) {
        fresh = await getInboundEmailEndpointStrict({
          tenantId: me.tenant_id,
          signal: controller.signal,
        });
        if (JSON.stringify(fresh) !== JSON.stringify(endpoint.data ?? null))
          throw new Error(
            "The endpoint metadata changed on the server. Nothing was rotated; refresh and review it.",
          );
        controller.signal.throwIfAborted();
        const fingerprint = JSON.stringify(fresh);
        attemptRef.current = {
          fingerprint,
          key: newInboundRouteOperationKey("inbound-endpoint-rotate"),
        };
      }
      // Once a request has been attempted, replay its exact operation key
      // before comparing metadata again. The first request may have committed
      // and lost its response; only the idempotent replay can recover the
      // shown-once secret receipt.
      const receipt = await rotateInboundEmailEndpointStrict({
        tenantId: me.tenant_id,
        idempotencyKey: attemptRef.current!.key,
      });
      attemptRef.current = null;
      qc.setQueryData<InboundEmailEndpoint | null>(key, endpointMetadata(receipt));
      setReveal(receipt);
      setConfirmRotate(false);
      toast.success(fresh ? "Signing secret rotated" : "Inbound endpoint created");
    } finally {
      controller.abort();
      rotateRef.current = false;
      setRotating(false);
    }
  }

  return (
    <section aria-labelledby="inbound-endpoint-heading" className="space-y-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="inbound-endpoint-heading" className="text-lg font-semibold">
            Signed inbound endpoint
          </h2>
          <p className="text-sm text-muted-foreground">
            HMAC-SHA256 authenticates timestamped raw requests. Metadata reads
            never return the plaintext signing secret.
          </p>
        </div>
        {endpoint.isSuccess ? (
          <Button
            variant={endpoint.data ? "destructive" : "default"}
            disabled={rotating || Boolean(reveal)}
            onClick={() => setConfirmRotate(true)}
          >
            <KeyRound aria-hidden className="size-4" />
            {endpoint.data ? "Rotate secret" : "Create endpoint"}
          </Button>
        ) : null}
      </div>

      {endpoint.isPending ? (
        <p role="status" className="py-6 text-sm text-muted-foreground">
          Loading endpoint metadata…
        </p>
      ) : endpoint.isError ? (
        <div role="alert" className="space-y-3 rounded-md border border-destructive p-4">
          <p>{apiErrorMessage(endpoint.error, "Endpoint metadata could not be loaded")}</p>
          <Button variant="outline" onClick={() => void endpoint.refetch()}>
            <RefreshCw aria-hidden className="size-4" /> Retry
          </Button>
        </div>
      ) : endpoint.data ? (
        <EndpointMetadata endpoint={endpoint.data} />
      ) : (
        <div className="rounded-md border p-5 text-sm">
          <p className="font-medium">No endpoint is provisioned.</p>
          <p className="mt-1 text-muted-foreground">
            This verified absence means inbound traffic cannot authenticate until
            an administrator creates an endpoint and stores its shown-once secret.
          </p>
        </div>
      )}

      <ConfirmDialog
        open={confirmRotate}
        onOpenChange={setConfirmRotate}
        title={endpoint.data ? "Rotate inbound signing secret?" : "Create inbound endpoint?"}
        description={
          endpoint.data
            ? "The current signing secret stops working immediately after the server confirms rotation. The replacement is shown once. Type the endpoint slug to continue."
            : "Provisioning creates an active endpoint and a plaintext secret shown once. Type CREATE to continue."
        }
        confirmationToken={endpoint.data?.slug ?? "CREATE"}
        confirmLabel={endpoint.data ? "Rotate secret" : "Create endpoint"}
        onConfirm={rotate}
      />

      {reveal ? (
        <EndpointSecretReveal
          reveal={reveal}
          onHandled={() => {
            setReveal((current) => {
              if (current) current.secret = "";
              return null;
            });
          }}
        />
      ) : null}
    </section>
  );
}

function EndpointMetadata({ endpoint }: { endpoint: InboundEmailEndpoint }) {
  const [copying, setCopying] = useState(false);
  const url = inboundEndpointUrl(endpoint.slug);
  async function copyUrl() {
    if (copying) return;
    setCopying(true);
    try {
      const result = await copyToClipboard(url);
      if (result !== "copied") throw new Error("Clipboard access was unavailable.");
      toast.success("Inbound endpoint URL copied");
    } catch (cause) {
      toast.error(apiErrorMessage(cause, "Endpoint URL could not be copied"));
    } finally {
      setCopying(false);
    }
  }
  return (
    <div className="space-y-3">
      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">Secret status</dt>
          <dd>
            {endpoint.rotationRequired
              ? "Rotation required"
              : endpoint.secretConfigured
                ? "Configured · not retrievable"
                : "Not configured"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Last rotated</dt>
          <dd>{formatDate(endpoint.secretRotatedAt)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Created</dt>
          <dd>{formatDate(endpoint.createdAt)}</dd>
        </div>
      </dl>
      <div>
        <p className="text-xs text-muted-foreground">Ingest URL</p>
        <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-center">
          <code className="min-w-0 flex-1 break-all rounded-md border bg-muted/30 p-2 text-xs">
            {url}
          </code>
          <Button variant="outline" disabled={copying} onClick={() => void copyUrl()}>
            <Copy aria-hidden className="size-4" /> {copying ? "Copying…" : "Copy URL"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function EndpointSecretReveal({
  reveal,
  onHandled,
}: {
  reveal: InboundEmailEndpointReveal;
  onHandled: () => void;
}) {
  const [show, setShow] = useState(false);
  const [stored, setStored] = useState(false);
  const [copying, setCopying] = useState(false);
  const [abandon, setAbandon] = useState(false);
  const copyingRef = useRef(false);
  useUnsavedChangesGuard(true);

  async function copySecret() {
    if (copyingRef.current) return;
    copyingRef.current = true;
    setCopying(true);
    try {
      const result = await copyToClipboard(reveal.secret);
      if (result !== "copied") throw new Error("Clipboard access was unavailable.");
      toast.success("Signing secret copied. Store it now and clear your clipboard.");
    } catch (cause) {
      toast.error(apiErrorMessage(cause, "Signing secret could not be copied"));
    } finally {
      copyingRef.current = false;
      setCopying(false);
    }
  }

  return (
    <>
      <Dialog open onOpenChange={() => toast.warning("Store or explicitly abandon the shown-once secret before closing.")}>
        <DialogContent
          closeDisabled
          className="max-w-2xl"
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Store this signing secret now</DialogTitle>
            <DialogDescription>
              This plaintext is shown once and is not placed in the query cache.
              It cannot be retrieved after this handoff closes.
            </DialogDescription>
          </DialogHeader>
          <div role="status" className="space-y-3 rounded-md border border-warning/50 bg-warning/10 p-4">
            <div className="flex gap-2 text-sm">
              <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              <p>
                Update the signing proxy immediately. If this was a rotation,
                requests signed with the previous value now fail authentication.
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <code className="min-w-0 flex-1 break-all rounded-md border bg-background p-3 text-xs">
                {show ? reveal.secret : "••••••••••••••••••••••••••••••••"}
              </code>
              <Button variant="outline" onClick={() => setShow((current) => !current)}>
                {show ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
                {show ? "Hide" : "Show"}
              </Button>
              <Button disabled={copying} onClick={() => void copySecret()}>
                <Copy aria-hidden className="size-4" /> {copying ? "Copying…" : "Copy"}
              </Button>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={stored}
                onChange={(event) => setStored(event.target.checked)}
              />
              <span>I stored this full secret in an approved secret manager.</span>
            </label>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAbandon(true)}>
              Abandon reveal
            </Button>
            <Button disabled={!stored || copying} onClick={onHandled}>
              Acknowledge and clear
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={abandon}
        onOpenChange={setAbandon}
        title="Abandon the one-time secret?"
        description="The active secret remains in force, but this plaintext cannot be retrieved after it is cleared. Type the endpoint slug to abandon it explicitly."
        confirmationToken={reveal.slug}
        confirmLabel="Abandon reveal"
        onConfirm={onHandled}
      />
    </>
  );
}

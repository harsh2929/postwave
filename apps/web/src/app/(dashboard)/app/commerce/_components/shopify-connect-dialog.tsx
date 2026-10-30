// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Connect Shopify via OAuth.
 *
 * The server mints the authorization link (GET /commerce/shopify/oauth/start),
 * and the browser opens it — but only after the same safety check desktop
 * applies: https, no embedded credentials, and a host that is the shop itself
 * or Shopify's own domain. A link that fails the check is refused and no tab
 * is opened; the server's refusal (a malformed shop, missing credentials) is
 * rendered in its own words.
 *
 * The OAuth return lands on the server's public callback, not on this page,
 * so "handling the return" here means letting the reader confirm the outcome:
 * Refresh stores re-reads the connected integrations and the panel on the
 * Integrations page.
 */

import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";

import { humanizeStatus } from "@/components/mailchimp-parity/product-panel-primitives";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { commerceApi } from "@/lib/commerce-api";
import {
  normalizeShopifyDomain,
  verifiedShopifyAuthorizationUrl,
} from "@/lib/commerce-catalog-helpers";
import { STALE } from "@/lib/query-keys";

import {
  commerceKeys,
  type CommerceAdminOperation,
  type CommerceWorkspaceContext,
} from "./commerce-context";
import { FieldError, FieldHint } from "./commerce-primitives";

export const SHOPIFY_SAFETY_CHECK_FAILED =
  "The authorization destination failed the Shopify safety check. No browser tab was opened.";

export function ShopifyConnectDialog({
  ctx,
  onClose,
}: {
  ctx: CommerceWorkspaceContext;
  onClose: () => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [shopInput, setShopInput] = useState("");
  const [shopError, setShopError] = useState<string | null>(null);

  const integrationsQuery = useQuery({
    queryKey: commerceKeys.integrations(ctx.scopeKey),
    queryFn: commerceApi.integrations,
    enabled: ctx.ready,
    staleTime: STALE.list,
  });
  const stores = Array.isArray(integrationsQuery.data)
    ? integrationsQuery.data
    : [];

  const start = useMutation({
    mutationFn: async ({
      shop,
      operation,
    }: {
      shop: string;
      operation: CommerceAdminOperation;
    }) => {
      let response: Awaited<ReturnType<typeof commerceApi.startShopifyOAuth>>;
      try {
        await ctx.authorizeAdminOperation(operation);
        response = await commerceApi.startShopifyOAuth(shop, {
          signal: operation.controller.signal,
        });
      } finally {
        ctx.finishAdminOperation(operation);
      }
      const url =
        typeof response?.authorize_url === "string"
          ? response.authorize_url
          : "";
      if (!url) {
        throw new Error(
          "The server didn't return an authorize URL. No browser tab was opened.",
        );
      }
      const verified = verifiedShopifyAuthorizationUrl(url, shop);
      if (!verified) throw new Error(SHOPIFY_SAFETY_CHECK_FAILED);
      return { shop, url: verified };
    },
    onSuccess: ({ url }) => {
      window.open(url, "_blank", "noopener");
    },
  });
  const pending = start.isPending;
  const opened = start.data ?? null;

  const submit = () => {
    if (pending) return;
    const shop = normalizeShopifyDomain(shopInput);
    if (!shop) {
      setShopError(
        "Enter the store's *.myshopify.com domain, without a scheme, path, or port.",
      );
      return;
    }
    setShopError(null);
    const operation = ctx.beginAdminOperation();
    if (!operation) return;
    start.mutate({ shop, operation });
  };
  const refreshStores = () => {
    void queryClient.invalidateQueries({
      queryKey: commerceKeys.integrations(ctx.scopeKey),
    });
    void queryClient.invalidateQueries({ queryKey: ctx.integrationsScopeKey });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent
        closeDisabled={pending}
        aria-busy={pending}
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Connect Shopify</DialogTitle>
          <DialogDescription>
            Moosewave asks the server for an authorization link for this store,
            checks that it points at Shopify or the store itself, and opens it
            in a new tab. Nothing is connected until you approve the app in
            Shopify and Shopify calls back.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {start.isError ? (
            <Alert variant="destructive">
              <AlertDescription>
                {apiErrorMessage(
                  start.error,
                  "Shopify authorization could not be started.",
                )}
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-shop`}>Store domain</Label>
            <Input
              id={`${id}-shop`}
              value={shopInput}
              onChange={(event) => {
                setShopInput(event.target.value);
                setShopError(null);
              }}
              placeholder="my-store.myshopify.com"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={253}
              required
              disabled={pending}
              aria-invalid={shopError ? true : undefined}
              aria-describedby={
                shopError ? `${id}-shop-error` : `${id}-shop-hint`
              }
            />
            <FieldError id={`${id}-shop-error`} message={shopError} />
            <FieldHint id={`${id}-shop-hint`}>
              The *.myshopify.com domain of the store. The server refuses any
              other host.
            </FieldHint>
          </div>

          {opened ? (
            <div
              role="status"
              className="space-y-2 rounded-md border border-success/40 bg-success-subtle/40 p-3 text-sm"
            >
              <p>
                Authorization link ready for{" "}
                <span className="font-mono">{opened.shop}</span>. Approve the
                app in Shopify, then choose Refresh stores to see it here. If
                your browser did not open a tab, use the link below.
              </p>
              <a
                href={opened.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
              >
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                Open the authorization link
              </a>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <p className="text-xs font-medium">
              Connected stores ({stores.length.toLocaleString()})
            </p>
            {integrationsQuery.isError ? (
              <p className="text-xs text-destructive-emphasis" role="alert">
                {apiErrorMessage(
                  integrationsQuery.error,
                  "Connected stores could not be loaded.",
                )}
              </p>
            ) : stores.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {integrationsQuery.isPending
                  ? "Loading connected stores…"
                  : "No store is connected yet."}
              </p>
            ) : (
              <ul className="space-y-1 text-xs">
                {stores.map((store) => (
                  <li key={store.id} className="flex flex-wrap gap-x-2">
                    <span className="break-all font-mono">
                      {store.shop_domain || store.id}
                    </span>
                    <span className="text-muted-foreground">
                      {store.provider} ·{" "}
                      {store.status ? humanizeStatus(store.status) : "Unknown"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={pending}
            >
              Close
            </Button>
            {opened ? (
              <Button
                type="button"
                variant="outline"
                onClick={refreshStores}
                loading={integrationsQuery.isFetching}
              >
                Refresh stores
              </Button>
            ) : null}
            <Button type="submit" loading={pending}>
              {pending ? "Starting…" : "Open Shopify authorization"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

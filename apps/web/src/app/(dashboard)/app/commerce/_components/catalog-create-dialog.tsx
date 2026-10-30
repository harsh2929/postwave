// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Commerce → Catalogs → "New catalog".
 *
 * Connected-store catalog create. Split from catalogs-tab.tsx so the form
 * only loads once an admin opens it; the tab mounts it on demand.
 */

import { useId, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

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
import { Select } from "@/components/ui/select";
import { commerceApi, type CommerceCatalogInput } from "@/lib/commerce-api";
import { STALE } from "@/lib/query-keys";

import {
  commerceKeys,
  type CommerceAdminOperation,
  type CommerceWorkspaceContext,
} from "./commerce-context";
import {
  commerceFailureMessage,
  DiscardDraftDialog,
  FieldError,
  FieldHint,
  useDraftCloseGuard,
} from "./commerce-primitives";

type CatalogField = "name" | "currency" | "integration";

export function CatalogCreateDialog({
  ctx,
  onClose,
  onCreated,
}: {
  ctx: CommerceWorkspaceContext;
  onClose: () => void;
  onCreated: () => void;
}) {
  const id = useId();
  const integrationsQuery = useQuery({
    queryKey: commerceKeys.integrations(ctx.scopeKey),
    queryFn: commerceApi.integrations,
    enabled: ctx.ready,
    staleTime: STALE.list,
  });
  const integrations = Array.isArray(integrationsQuery.data)
    ? integrationsQuery.data
    : null;
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [integrationChoice, setIntegrationChoice] = useState("");
  const [fieldError, setFieldError] = useState<{
    field: CatalogField;
    message: string;
  } | null>(null);
  const integrationId = integrationChoice || integrations?.[0]?.id || "";

  const create = useMutation({
    mutationFn: async ({
      input,
      operation,
    }: {
      input: CommerceCatalogInput;
      operation: CommerceAdminOperation;
    }) => {
      try {
        await ctx.authorizeAdminOperation(operation);
        return await commerceApi.createCatalog(input, {
          signal: operation.controller.signal,
          idempotencyKey: operation.idempotencyKey,
        });
      } finally {
        ctx.finishAdminOperation(operation);
      }
    },
    onSuccess: (created, { input }) => {
      toast.success(`Catalog "${created?.name || input.name}" created`);
      onCreated();
      onClose();
    },
  });
  const pending = create.isPending;
  const dirty = Boolean(name || currency !== "USD" || integrationChoice);
  const guard = useDraftCloseGuard({
    dirty,
    pending,
    onDiscard: () => {
      setName("");
      setCurrency("USD");
      setIntegrationChoice("");
      setFieldError(null);
      create.reset();
    },
    onClose,
  });

  const submit = () => {
    if (pending) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setFieldError({ field: "name", message: "Catalog name is required." });
      return;
    }
    const normalizedCurrency = currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/u.test(normalizedCurrency)) {
      setFieldError({
        field: "currency",
        message: "Default currency must be a three-letter ISO 4217 code.",
      });
      return;
    }
    if (!integrationId) {
      setFieldError({
        field: "integration",
        message: "Choose a connected store for this catalog.",
      });
      return;
    }
    setFieldError(null);
    const operation = ctx.beginAdminOperation();
    if (!operation) return;
    create.mutate({
      operation,
      input: {
        name: trimmed,
        source_type: "integration",
        integration_id: integrationId,
        default_currency: normalizedCurrency,
      },
    });
  };
  const errorFor = (field: CatalogField) =>
    fieldError?.field === field ? fieldError.message : null;

  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) guard.requestClose();
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
            <DialogTitle>New catalog</DialogTitle>
            <DialogDescription>
              Create an import-ready catalog owned by one connected store.
              Manual and remote-feed catalog sources are not available on this
              server.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            {create.isError ? (
              <Alert variant="destructive">
                <AlertDescription>
                  {commerceFailureMessage(create.error)}
                </AlertDescription>
              </Alert>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input
                id={`${id}-name`}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  if (fieldError?.field === "name") setFieldError(null);
                }}
                placeholder="e.g. Spring collection"
                maxLength={160}
                required
                disabled={pending}
                aria-invalid={errorFor("name") ? true : undefined}
                aria-describedby={
                  errorFor("name") ? `${id}-name-error` : undefined
                }
              />
              <FieldError id={`${id}-name-error`} message={errorFor("name")} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-source`}>Source</Label>
                <Select
                  id={`${id}-source`}
                  value="integration"
                  disabled
                  aria-describedby={`${id}-source-hint`}
                  onChange={() => undefined}
                >
                  <option value="integration">Connected store</option>
                </Select>
                <FieldHint id={`${id}-source-hint`}>
                  Connected store is the only create path with a complete import
                  contract on this server.
                </FieldHint>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-currency`}>Default currency</Label>
                <Input
                  id={`${id}-currency`}
                  value={currency}
                  onChange={(event) => {
                    setCurrency(event.target.value.toUpperCase());
                    if (fieldError?.field === "currency") setFieldError(null);
                  }}
                  placeholder="USD"
                  minLength={3}
                  maxLength={3}
                  autoCapitalize="characters"
                  spellCheck={false}
                  disabled={pending}
                  aria-invalid={errorFor("currency") ? true : undefined}
                  aria-describedby={
                    errorFor("currency")
                      ? `${id}-currency-error`
                      : `${id}-currency-hint`
                  }
                />
                <FieldError
                  id={`${id}-currency-error`}
                  message={errorFor("currency")}
                />
                <FieldHint id={`${id}-currency-hint`}>
                  Three-letter ISO 4217 code, such as USD, EUR, or INR.
                </FieldHint>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-integration`}>Connected store</Label>
              <Select
                id={`${id}-integration`}
                value={integrationId}
                onChange={(event) => {
                  setIntegrationChoice(event.target.value);
                  if (fieldError?.field === "integration") setFieldError(null);
                }}
                disabled={pending || integrations === null}
                aria-invalid={errorFor("integration") ? true : undefined}
                aria-describedby={
                  errorFor("integration")
                    ? `${id}-integration-error`
                    : `${id}-integration-hint`
                }
              >
                {integrations === null ? (
                  <option value="">
                    {integrationsQuery.isError
                      ? "Connected stores could not be loaded"
                      : "Loading connected stores…"}
                  </option>
                ) : integrations.length === 0 ? (
                  <option value="">No connected store is available</option>
                ) : (
                  integrations.map((integration) => (
                    <option key={integration.id} value={integration.id}>
                      {integration.shop_domain || integration.provider} ·{" "}
                      {integration.provider}
                    </option>
                  ))
                )}
              </Select>
              <FieldError
                id={`${id}-integration-error`}
                message={errorFor("integration")}
              />
              <FieldHint id={`${id}-integration-hint`}>
                The catalog keeps this exact store as its product-import owner.
              </FieldHint>
              {integrationsQuery.isError ? (
                <p className="text-xs text-destructive-emphasis" role="alert">
                  {commerceFailureMessage(integrationsQuery.error)}
                </p>
              ) : integrations !== null && integrations.length === 0 ? (
                <p className="text-xs text-muted-foreground" role="status">
                  Connect a store first (Connect Shopify above, or the
                  Integrations page). No unsupported manual catalog will be
                  created.
                </p>
              ) : null}
            </div>
            <p
              role="status"
              aria-live="polite"
              className="text-xs text-muted-foreground"
            >
              {pending
                ? "Creating the catalog. Fields and dismissal stay locked until the request finishes."
                : "Nothing is created until you choose Create catalog."}
            </p>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={guard.requestClose}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button type="submit" loading={pending}>
                {pending ? "Creating…" : "Create catalog"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <DiscardDraftDialog
        open={guard.discardOpen}
        title="Discard product catalog draft?"
        description="The catalog name, connected store, and currency will be cleared. Nothing has been created."
        onConfirm={guard.discardAndClose}
        onKeepEditing={guard.keepEditing}
      />
    </>
  );
}

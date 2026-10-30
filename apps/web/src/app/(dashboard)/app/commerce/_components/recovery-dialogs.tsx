// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Create dialogs for the Recovery tab.
 *
 *   - CartLinkCreateDialog: POST …/cart-recovery-links (an upsert on the
 *     source cart id).
 *   - ProductSubscriptionDialog: POST …/products/{product_id}/back-in-stock-
 *     subscriptions or …/price-drop-watchers — the create routes are nested
 *     under the product, so the product id becomes part of the path.
 *
 * Every dialog validates before any request, renders a refusal in the
 * server's words, and guards a dirty close the way the catalog dialogs do.
 * Nothing here sends a message: a link or subscription is a record an
 * automation may later act on.
 */

import { useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
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
import {
  commerceApi,
  type CommerceBackInStockSubscription,
  type CommerceBackInStockSubscriptionInput,
  type CommerceCartRecoveryLinkInput,
  type CommercePriceDropWatcher,
  type CommercePriceDropWatcherInput,
} from "@/lib/commerce-api";
import {
  parseTargetPriceCents,
  verifiedHttpsUrl,
} from "@/lib/commerce-lifecycle-helpers";

import {
  commerceFailureMessage,
  DiscardDraftDialog,
  FieldError,
  FieldHint,
  useDraftCloseGuard,
} from "./commerce-primitives";
import type {
  CommerceAdminOperation,
  CommerceWorkspaceContext,
} from "./commerce-context";

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/u;

function lockedDialogProps(pending: boolean) {
  return {
    closeDisabled: pending,
    "aria-busy": pending,
    onEscapeKeyDown: (event: Event) => {
      if (pending) event.preventDefault();
    },
    onPointerDownOutside: (event: Event) => {
      if (pending) event.preventDefault();
    },
  };
}

/* ---------- cart-recovery link ---------- */

type CartField = "cart" | "url" | "email";

export function CartLinkCreateDialog({
  ctx,
  integrationId,
  onClose,
  onCreated,
}: {
  ctx: CommerceWorkspaceContext;
  integrationId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const id = useId();
  const [cartId, setCartId] = useState("");
  const [url, setUrl] = useState("");
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<{
    field: CartField;
    message: string;
  } | null>(null);

  const save = useMutation({
    mutationFn: async ({
      input,
      operation,
    }: {
      input: CommerceCartRecoveryLinkInput;
      operation: CommerceAdminOperation;
    }) => {
      try {
        await ctx.authorizeAdminOperation(operation);
        return await commerceApi.upsertCartRecoveryLink(integrationId, input, {
          signal: operation.controller.signal,
          idempotencyKey: operation.idempotencyKey,
        });
      } finally {
        ctx.finishAdminOperation(operation);
      }
    },
    onSuccess: () => {
      toast.success("Cart-recovery link saved");
      onCreated();
      onClose();
    },
  });
  const pending = save.isPending;
  const dirty = Boolean(cartId || url || email);
  const guard = useDraftCloseGuard({
    dirty,
    pending,
    onDiscard: () => {
      setCartId("");
      setUrl("");
      setEmail("");
      setFieldError(null);
      save.reset();
    },
    onClose,
  });

  const submit = () => {
    if (pending) return;
    const sourceCartId = cartId.trim();
    if (!sourceCartId) {
      setFieldError({ field: "cart", message: "Source cart ID is required." });
      return;
    }
    const recoveryUrl = verifiedHttpsUrl(url);
    if (!recoveryUrl) {
      setFieldError({
        field: "url",
        message:
          "Enter a valid HTTPS recovery URL without embedded username or password credentials.",
      });
      return;
    }
    const customerEmail = email.trim().toLowerCase();
    if (customerEmail && !EMAIL_SHAPE.test(customerEmail)) {
      setFieldError({
        field: "email",
        message: "Enter a valid customer email address, or leave it blank.",
      });
      return;
    }
    setFieldError(null);
    const operation = ctx.beginAdminOperation();
    if (!operation) return;
    save.mutate({
      operation,
      input: {
        source_cart_id: sourceCartId,
        recovery_url: recoveryUrl,
        ...(customerEmail ? { customer_email: customerEmail } : {}),
      },
    });
  };
  const errorFor = (field: CartField) =>
    fieldError?.field === field ? fieldError.message : null;
  const clearIf = (field: CartField) => {
    if (fieldError?.field === field) setFieldError(null);
  };

  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) guard.requestClose();
        }}
      >
        <DialogContent {...lockedDialogProps(pending)}>
          <DialogHeader>
            <DialogTitle>New cart-recovery link</DialogTitle>
            <DialogDescription>
              Upserts on the cart id — re-registering the same cart updates the
              link. Automations insert it into abandoned-cart sends; saving one
              here sends nothing.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            {save.isError ? (
              <Alert variant="destructive">
                <AlertDescription>
                  {commerceFailureMessage(save.error)}
                </AlertDescription>
              </Alert>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-cart`}>Source cart ID</Label>
              <Input
                id={`${id}-cart`}
                value={cartId}
                onChange={(event) => {
                  setCartId(event.target.value);
                  clearIf("cart");
                }}
                placeholder="cart_123"
                maxLength={256}
                required
                disabled={pending}
                autoCapitalize="none"
                spellCheck={false}
                aria-invalid={errorFor("cart") ? true : undefined}
                aria-describedby={
                  errorFor("cart") ? `${id}-cart-error` : undefined
                }
              />
              <FieldError id={`${id}-cart-error`} message={errorFor("cart")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-url`}>Recovery URL</Label>
              <Input
                id={`${id}-url`}
                type="url"
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  clearIf("url");
                }}
                placeholder="https://store.example.com/cart/restore?token=…"
                maxLength={4096}
                required
                disabled={pending}
                autoCapitalize="none"
                spellCheck={false}
                aria-invalid={errorFor("url") ? true : undefined}
                aria-describedby={
                  errorFor("url") ? `${id}-url-error` : `${id}-url-hint`
                }
              />
              <FieldError id={`${id}-url-error`} message={errorFor("url")} />
              <FieldHint id={`${id}-url-hint`}>
                HTTPS only. The query may carry a recovery token, so the list
                shows only the origin.
              </FieldHint>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-email`}>Customer email (optional)</Label>
              <Input
                id={`${id}-email`}
                type="email"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  clearIf("email");
                }}
                placeholder="customer@example.com"
                maxLength={320}
                disabled={pending}
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                aria-invalid={errorFor("email") ? true : undefined}
                aria-describedby={
                  errorFor("email") ? `${id}-email-error` : undefined
                }
              />
              <FieldError
                id={`${id}-email-error`}
                message={errorFor("email")}
              />
            </div>
            <p
              role="status"
              aria-live="polite"
              className="text-xs text-muted-foreground"
            >
              {pending
                ? "Saving the link. Fields and dismissal stay locked until the request finishes."
                : "Nothing is saved until you choose Save link."}
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
                {pending ? "Saving…" : "Save link"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <DiscardDraftDialog
        open={guard.discardOpen}
        title="Discard cart-recovery link draft?"
        description="The source cart ID, recovery URL, and optional customer email will be cleared. Nothing has been saved."
        onConfirm={guard.discardAndClose}
        onKeepEditing={guard.keepEditing}
      />
    </>
  );
}

/* ---------- back-in-stock subscription / price-drop watcher ---------- */

export type ProductSubscriptionKind = "back-in-stock" | "price-drop";

type SubscriptionField = "product" | "email" | "target" | "currency";

interface SubscriptionVars {
  productId: string;
  base: CommerceBackInStockSubscriptionInput;
  priceRule?: Pick<
    CommercePriceDropWatcherInput,
    "target_price_cents" | "currency"
  >;
}

export function ProductSubscriptionDialog({
  ctx,
  kind,
  integrationId,
  onClose,
  onCreated,
}: {
  ctx: CommerceWorkspaceContext;
  kind: ProductSubscriptionKind;
  integrationId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const id = useId();
  const [productId, setProductId] = useState("");
  const [email, setEmail] = useState("");
  const [variantId, setVariantId] = useState("");
  const [targetPrice, setTargetPrice] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [fieldError, setFieldError] = useState<{
    field: SubscriptionField;
    message: string;
  } | null>(null);

  const label =
    kind === "back-in-stock"
      ? "Back-in-stock subscription"
      : "Price-drop watcher";
  const verb = kind === "back-in-stock" ? "subscription" : "watcher";

  // The two create routes answer with different records; the dialog only ever
  // reports that one was created, so the union is the honest result type.
  const create = useMutation<
    CommerceBackInStockSubscription | CommercePriceDropWatcher,
    Error,
    { operation: CommerceAdminOperation; vars: SubscriptionVars }
  >({
    mutationFn: async ({ operation, vars }) => {
      try {
        await ctx.authorizeAdminOperation(operation);
        const options = {
          signal: operation.controller.signal,
          idempotencyKey: operation.idempotencyKey,
        };
        return kind === "back-in-stock"
          ? await commerceApi.createBackInStockSubscription(
              integrationId,
              vars.productId,
              vars.base,
              options,
            )
          : await commerceApi.createPriceDropWatcher(
              integrationId,
              vars.productId,
              {
                ...vars.base,
                ...vars.priceRule,
              },
              options,
            );
      } finally {
        ctx.finishAdminOperation(operation);
      }
    },
    onSuccess: () => {
      toast.success(`${label} created`);
      onCreated();
      onClose();
    },
  });
  const pending = create.isPending;
  const dirty = Boolean(
    productId || email || variantId || targetPrice || currency !== "USD",
  );
  const guard = useDraftCloseGuard({
    dirty,
    pending,
    onDiscard: () => {
      setProductId("");
      setEmail("");
      setVariantId("");
      setTargetPrice("");
      setCurrency("USD");
      setFieldError(null);
      create.reset();
    },
    onClose,
  });

  const submit = () => {
    if (pending) return;
    const product = productId.trim();
    if (!product) {
      setFieldError({
        field: "product",
        message:
          "Product ID is required. Copy the full ID from the store's product records.",
      });
      return;
    }
    const subscriberEmail = email.trim().toLowerCase();
    if (!EMAIL_SHAPE.test(subscriberEmail)) {
      setFieldError({
        field: "email",
        message: "Enter a valid subscriber email address.",
      });
      return;
    }
    let priceRule: SubscriptionVars["priceRule"];
    if (kind === "price-drop") {
      const parsed = parseTargetPriceCents(targetPrice);
      if (!parsed.ok) {
        setFieldError({ field: "target", message: parsed.error });
        return;
      }
      const normalizedCurrency = currency.trim().toUpperCase();
      if (!/^[A-Z]{3}$/u.test(normalizedCurrency)) {
        setFieldError({
          field: "currency",
          message: "Currency must be a three-letter ISO 4217 code.",
        });
        return;
      }
      priceRule = {
        target_price_cents: parsed.cents,
        currency: normalizedCurrency,
      };
    }
    setFieldError(null);
    const variant = variantId.trim();
    const operation = ctx.beginAdminOperation();
    if (!operation) return;
    create.mutate({
      operation,
      vars: {
        productId: product,
        base: {
          subscriber_email: subscriberEmail,
          ...(variant ? { variant_id: variant } : {}),
        },
        ...(priceRule ? { priceRule } : {}),
      },
    });
  };
  const errorFor = (field: SubscriptionField) =>
    fieldError?.field === field ? fieldError.message : null;
  const clearIf = (field: SubscriptionField) => {
    if (fieldError?.field === field) setFieldError(null);
  };

  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) guard.requestClose();
        }}
      >
        <DialogContent {...lockedDialogProps(pending)}>
          <DialogHeader>
            <DialogTitle>
              {kind === "back-in-stock"
                ? "New back-in-stock subscription"
                : "New price-drop watcher"}
            </DialogTitle>
            <DialogDescription>
              Created against a synced product. Copy complete product and
              variant IDs from the store&apos;s product records. The lifecycle
              evaluator decides when it becomes eligible; creating one here
              sends nothing.
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
              <Label htmlFor={`${id}-product`}>Product ID</Label>
              <Input
                id={`${id}-product`}
                value={productId}
                onChange={(event) => {
                  setProductId(event.target.value);
                  clearIf("product");
                }}
                placeholder="prd_…"
                maxLength={256}
                required
                disabled={pending}
                autoCapitalize="none"
                spellCheck={false}
                aria-invalid={errorFor("product") ? true : undefined}
                aria-describedby={
                  errorFor("product") ? `${id}-product-error` : undefined
                }
              />
              <FieldError
                id={`${id}-product-error`}
                message={errorFor("product")}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-email`}>Subscriber email</Label>
                <Input
                  id={`${id}-email`}
                  type="email"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    clearIf("email");
                  }}
                  placeholder="customer@example.com"
                  maxLength={320}
                  required
                  disabled={pending}
                  autoComplete="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-invalid={errorFor("email") ? true : undefined}
                  aria-describedby={
                    errorFor("email") ? `${id}-email-error` : undefined
                  }
                />
                <FieldError
                  id={`${id}-email-error`}
                  message={errorFor("email")}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-variant`}>Variant ID (optional)</Label>
                <Input
                  id={`${id}-variant`}
                  value={variantId}
                  onChange={(event) => setVariantId(event.target.value)}
                  placeholder="var_…"
                  maxLength={256}
                  disabled={pending}
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-describedby={`${id}-variant-hint`}
                />
                <FieldHint id={`${id}-variant-hint`}>
                  Leave blank to watch the product at product level.
                </FieldHint>
              </div>
            </div>
            {kind === "price-drop" ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor={`${id}-target`}>Target price</Label>
                  <Input
                    id={`${id}-target`}
                    type="number"
                    min={0.01}
                    // `any`, not 0.01: the browser's step check would refuse a
                    // valid amount with a generic bubble, and the two-decimal
                    // rule is `parseTargetPriceCents`'s to state in the
                    // field's own sentence.
                    step="any"
                    inputMode="decimal"
                    value={targetPrice}
                    onChange={(event) => {
                      setTargetPrice(event.target.value);
                      clearIf("target");
                    }}
                    placeholder="39.00"
                    required
                    disabled={pending}
                    aria-invalid={errorFor("target") ? true : undefined}
                    aria-describedby={
                      errorFor("target")
                        ? `${id}-target-error`
                        : `${id}-target-hint`
                    }
                  />
                  <FieldError
                    id={`${id}-target-error`}
                    message={errorFor("target")}
                  />
                  <FieldHint id={`${id}-target-hint`}>
                    The customer-facing amount in {currency || "the currency"},
                    not integer cents.
                  </FieldHint>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${id}-currency`}>Currency</Label>
                  <Input
                    id={`${id}-currency`}
                    value={currency}
                    onChange={(event) => {
                      setCurrency(event.target.value.toUpperCase().slice(0, 3));
                      clearIf("currency");
                    }}
                    placeholder="USD"
                    minLength={3}
                    maxLength={3}
                    required
                    disabled={pending}
                    autoCapitalize="characters"
                    spellCheck={false}
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
                    Three-letter ISO 4217 code for the target amount.
                  </FieldHint>
                </div>
              </div>
            ) : null}
            <p
              role="status"
              aria-live="polite"
              className="text-xs text-muted-foreground"
            >
              {pending
                ? `Creating the ${label.toLowerCase()}. Fields and dismissal stay locked until the request finishes.`
                : `Nothing is created until you choose Create ${verb}.`}
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
                {pending ? "Creating…" : `Create ${verb}`}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <DiscardDraftDialog
        open={guard.discardOpen}
        title={`Discard ${label.toLowerCase()} draft?`}
        description="The product, subscriber, variant, and price-rule fields will be cleared. Nothing has been created."
        onConfirm={guard.discardAndClose}
        onKeepEditing={guard.keepEditing}
      />
    </>
  );
}

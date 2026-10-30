// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * The three dialogs the outbound-destinations page opens:
 *
 *  - ReceiverPresetDialog — pick a receiver, then POST /api/v1/outbound-webhooks.
 *  - OutboundWebhookEditDialog — PATCH /api/v1/outbound-webhooks/{id}.
 *  - SigningMaterialDialog — the shown-once view for the material a create or a
 *    rotate returns. Its value is held by the caller and dropped on dismissal;
 *    nothing re-renders it, because the server cannot answer with it again.
 */

import { useEffect, useId, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { apiErrorMessage } from "@/lib/api";
import type { MeResponse } from "@/lib/auth-api";
import { copyToClipboard } from "@/lib/clipboard";
import { exactPrincipalKey } from "@/lib/exact-principal";
import { newUUIDv7 } from "@/lib/http-fetch";
import { confirmFreshOutboundWebhookAdmin } from "@/lib/outbound-webhook-authority";
import {
  createOutboundWebhook,
  OUTBOUND_WEBHOOK_EVENTS,
  OUTBOUND_WEBHOOK_SIGNING_ALGORITHMS,
  updateOutboundWebhook,
  type OutboundWebhookCreateResponse,
  type OutboundWebhookRecord,
  type OutboundWebhookSigningAlgorithm,
  type OutboundWebhookUpdateInput,
} from "@/lib/outbound-webhooks-api";
import {
  buildReceiverAuthConfig,
  createReceiverAuthDraft,
  ReceiverAuthFields,
  validateReceiverAuthDraft,
  type ReceiverAuthDraft,
} from "./receiver-auth-fields";
import {
  deliveryPolicyDraftFromWebhook,
  DeliveryPolicyFields,
  deliveryPolicyEquals,
  deliveryPolicyTransform,
  emptyDeliveryPolicyDraft,
  validateDeliveryPolicyDraft,
  type DeliveryPolicyDraft,
} from "./delivery-policy-fields";
import {
  DEFAULT_RECEIVER_PRESET,
  RECEIVER_PRESET_NAMES,
  RECEIVER_PRESETS,
} from "./receiver-presets";

export const ALL_EVENTS: string[] = [...OUTBOUND_WEBHOOK_EVENTS];

interface DialogOperation<T> {
  controller: AbortController;
  idempotencyKey: string;
  openedIdentity: MeResponse;
  payload: T;
  principalKey: string;
}

function signingAlgorithmLabel(
  algorithm: OutboundWebhookSigningAlgorithm,
): string {
  switch (algorithm) {
    case "hmac_sha256":
      return "HMAC-SHA256 (shared secret)";
    case "ecdsa_p256":
      return "ECDSA P-256 (public key verification)";
    case "ed25519":
      return "Ed25519 (public key verification)";
  }
}

/** Drop topics outside the canonical catalogue rather than send a rejected request. */
export function canonicalPresetEvents(events: readonly string[]): string[] {
  const allowed = new Set<string>(OUTBOUND_WEBHOOK_EVENTS);
  return [...new Set(events.filter((event) => allowed.has(event)))];
}

function EventCheckboxes({
  topics,
  selected,
  onToggle,
  idPrefix,
}: {
  topics: string[];
  selected: ReadonlySet<string>;
  onToggle: (topic: string) => void;
  idPrefix: string;
}) {
  return (
    <div className="space-y-2">
      <span className="text-sm font-medium">Subscribe to these events</span>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {topics.map((topic) => (
          <div key={topic} className="flex items-center gap-2">
            <Checkbox
              id={`${idPrefix}-${topic}`}
              checked={selected.has(topic)}
              onChange={() => onToggle(topic)}
            />
            <Label
              htmlFor={`${idPrefix}-${topic}`}
              className="font-mono text-xs font-normal"
            >
              {topic}
            </Label>
          </div>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Create                                                                      */
/* -------------------------------------------------------------------------- */

export function ReceiverPresetDialog({
  identity,
  onClose,
  onCreated,
}: {
  identity: MeResponse;
  onClose: () => void;
  onCreated: (response: OutboundWebhookCreateResponse) => void;
}) {
  const id = useId();
  const [presetName, setPresetName] = useState(DEFAULT_RECEIVER_PRESET);
  const preset =
    RECEIVER_PRESETS[presetName] ?? RECEIVER_PRESETS[DEFAULT_RECEIVER_PRESET];
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState(preset.description);
  const [algorithm, setAlgorithm] =
    useState<OutboundWebhookSigningAlgorithm>("hmac_sha256");
  const [events, setEvents] = useState<Set<string>>(
    () => new Set(canonicalPresetEvents(preset.defaultEvents)),
  );
  const [authDraft, setAuthDraft] = useState<ReceiverAuthDraft>(() =>
    createReceiverAuthDraft("none"),
  );
  const [policy, setPolicy] = useState<DeliveryPolicyDraft>(
    emptyDeliveryPolicyDraft,
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const principalKey = exactPrincipalKey(identity);
  const principalKeyRef = useRef(principalKey);
  principalKeyRef.current = principalKey;
  const operationRef = useRef<DialogOperation<
    Parameters<typeof createOutboundWebhook>[0]
  > | null>(null);

  useEffect(() => {
    const scopedPrincipal = principalKey;
    return () => {
      const operation = operationRef.current;
      if (operation?.principalKey === scopedPrincipal) {
        operation.controller.abort();
        operationRef.current = null;
      }
    };
  }, [principalKey]);

  const create = useMutation({
    mutationKey: ["outbound-webhooks", principalKey, "create"],
    mutationFn: async (
      operation: DialogOperation<Parameters<typeof createOutboundWebhook>[0]>,
    ) => {
      await confirmFreshOutboundWebhookAdmin(
        operation.openedIdentity,
        operation.controller.signal,
      );
      const response = await createOutboundWebhook(operation.payload, {
        signal: operation.controller.signal,
        idempotencyKey: operation.idempotencyKey,
      });
      if (principalKeyRef.current !== operation.principalKey) {
        throw new Error(
          "Workspace identity changed while the destination was being created. Refresh before trying again.",
        );
      }
      return response;
    },
    onSuccess: (response, operation) => {
      if (principalKeyRef.current !== operation.principalKey) return;
      toast.success("Destination created");
      onCreated(response);
    },
    onSettled: (_data, _error, operation) => {
      if (operationRef.current === operation) operationRef.current = null;
    },
  });
  const pending = create.isPending;

  function choosePreset(name: string) {
    const next = RECEIVER_PRESETS[name];
    if (!next) return;
    setPresetName(name);
    setDescription(next.description);
    setEvents(new Set(canonicalPresetEvents(next.defaultEvents)));
    setFormError(null);
  }

  function submit() {
    if (pending) return;
    const trimmed = url.trim();
    if (!trimmed) {
      setFormError("Enter the HTTPS URL that will receive deliveries.");
      return;
    }
    if (events.size === 0) {
      setFormError("Select at least one event to subscribe to.");
      return;
    }
    const receiverAuthError = validateReceiverAuthDraft(authDraft);
    if (receiverAuthError) {
      setAuthError(receiverAuthError);
      return;
    }
    const policyError = validateDeliveryPolicyDraft(policy);
    if (policyError) {
      setFormError(`Delivery policy: ${policyError}`);
      return;
    }
    const authConfig = buildReceiverAuthConfig(authDraft);
    const transformTemplate = deliveryPolicyTransform(policy);
    setAuthError(null);
    setFormError(null);
    if (operationRef.current) return;
    const payload: Parameters<typeof createOutboundWebhook>[0] = {
      url: trimmed,
      description: description.trim() || preset.description,
      events: [...events],
      algorithm,
      ...(authConfig ? { auth_config: authConfig } : {}),
      ...(policy.filterExpression.trim()
        ? { filter_expression: policy.filterExpression.trim() }
        : {}),
      ...(transformTemplate ? { transform_template: transformTemplate } : {}),
    };
    const operation: DialogOperation<typeof payload> = {
      controller: new AbortController(),
      idempotencyKey: newUUIDv7(),
      openedIdentity: identity,
      payload,
      principalKey,
    };
    operationRef.current = operation;
    create.mutate(operation);
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent
        className="max-w-2xl"
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
          <DialogTitle>New outbound destination</DialogTitle>
          <DialogDescription>{preset.helpText}</DialogDescription>
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
                {apiErrorMessage(
                  create.error,
                  "The destination was not created.",
                )}
              </AlertDescription>
            </Alert>
          ) : null}
          {formError ? (
            <Alert variant="destructive">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor={`${id}-preset`}>Receiver</Label>
            <Select
              id={`${id}-preset`}
              value={presetName}
              disabled={pending}
              onChange={(event) => choosePreset(event.target.value)}
            >
              {RECEIVER_PRESET_NAMES.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`${id}-url`}>Receiver URL</Label>
            <Input
              id={`${id}-url`}
              type="url"
              value={url}
              disabled={pending}
              placeholder={preset.urlPlaceholder}
              autoComplete="off"
              onChange={(event) => {
                setUrl(event.target.value);
                if (formError) setFormError(null);
              }}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`${id}-description`}>Description</Label>
            <Input
              id={`${id}-description`}
              value={description}
              disabled={pending}
              maxLength={512}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`${id}-algorithm`}>Signing algorithm</Label>
            <Select
              id={`${id}-algorithm`}
              value={algorithm}
              disabled={pending}
              onChange={(event) =>
                setAlgorithm(
                  event.target.value as OutboundWebhookSigningAlgorithm,
                )
              }
            >
              {OUTBOUND_WEBHOOK_SIGNING_ALGORITHMS.map((value) => (
                <option key={value} value={value}>
                  {signingAlgorithmLabel(value)}
                </option>
              ))}
            </Select>
            <p className="text-xs text-muted-foreground">
              HMAC returns a shared secret once. The asymmetric algorithms
              return a public verification key and keep the private half here.
            </p>
          </div>

          <EventCheckboxes
            idPrefix={`${id}-event`}
            topics={ALL_EVENTS}
            selected={events}
            onToggle={(topic) =>
              setEvents((current) => {
                const next = new Set(current);
                if (next.has(topic)) next.delete(topic);
                else next.add(topic);
                return next;
              })
            }
          />

          <ReceiverAuthFields
            draft={authDraft}
            onChange={(next) => {
              setAuthDraft(next);
              if (authError) setAuthError(null);
            }}
            disabled={pending}
            error={authError}
          />

          <DeliveryPolicyFields
            value={policy}
            onChange={setPolicy}
            disabled={pending}
          />

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Create destination
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Edit                                                                        */
/* -------------------------------------------------------------------------- */

export function OutboundWebhookEditDialog({
  identity,
  webhook,
  onClose,
  onSaved,
}: {
  identity: MeResponse;
  webhook: OutboundWebhookRecord;
  onClose: () => void;
  onSaved: () => void;
}) {
  const id = useId();
  // Reads answer with a display projection that hides path and query, so the
  // URL field starts EMPTY: submitting the redacted address would replace a
  // working destination with a truncated one.
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState(webhook.description ?? "");
  const [events, setEvents] = useState<Set<string>>(
    () => new Set(Array.isArray(webhook.events) ? webhook.events : []),
  );
  const [authDraft, setAuthDraft] = useState<ReceiverAuthDraft>(() =>
    createReceiverAuthDraft("preserve"),
  );
  const [policy, setPolicy] = useState<DeliveryPolicyDraft>(() =>
    deliveryPolicyDraftFromWebhook(webhook),
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const principalKey = exactPrincipalKey(identity);
  const principalKeyRef = useRef(principalKey);
  principalKeyRef.current = principalKey;
  const operationRef =
    useRef<DialogOperation<OutboundWebhookUpdateInput> | null>(null);

  useEffect(() => {
    const scopedPrincipal = principalKey;
    return () => {
      const operation = operationRef.current;
      if (operation?.principalKey === scopedPrincipal) {
        operation.controller.abort();
        operationRef.current = null;
      }
    };
  }, [principalKey]);

  const baselineEvents = Array.isArray(webhook.events) ? webhook.events : [];
  const baselinePolicy = deliveryPolicyDraftFromWebhook(webhook);

  const save = useMutation({
    mutationKey: ["outbound-webhooks", principalKey, webhook.id, "update"],
    mutationFn: async (
      operation: DialogOperation<OutboundWebhookUpdateInput>,
    ) => {
      await confirmFreshOutboundWebhookAdmin(
        operation.openedIdentity,
        operation.controller.signal,
      );
      const saved = await updateOutboundWebhook(webhook.id, operation.payload, {
        signal: operation.controller.signal,
        idempotencyKey: operation.idempotencyKey,
      });
      if (principalKeyRef.current !== operation.principalKey) {
        throw new Error(
          "Workspace identity changed while the destination was being updated. Refresh before trying again.",
        );
      }
      return saved;
    },
    onSuccess: (_saved, operation) => {
      if (principalKeyRef.current !== operation.principalKey) return;
      toast.success("Destination updated");
      onSaved();
    },
    onSettled: (_data, _error, operation) => {
      if (operationRef.current === operation) operationRef.current = null;
    },
  });
  const pending = save.isPending;

  // Out-of-catalogue topics this destination already carries stay visible and
  // toggleable; editing the subscription must never silently drop one.
  const topics = [...new Set([...ALL_EVENTS, ...baselineEvents])];

  function submit() {
    if (pending) return;
    if (events.size === 0) {
      setFormError("Select at least one event to subscribe to.");
      return;
    }
    const receiverAuthError = validateReceiverAuthDraft(authDraft);
    if (receiverAuthError) {
      setAuthError(receiverAuthError);
      return;
    }
    const policyError = validateDeliveryPolicyDraft(policy);
    if (policyError) {
      setFormError(`Delivery policy: ${policyError}`);
      return;
    }
    const authConfig = buildReceiverAuthConfig(authDraft);
    const patch: OutboundWebhookUpdateInput = {
      description: description.trim(),
      events: [...events],
    };
    const trimmed = url.trim();
    if (trimmed) patch.url = trimmed;
    if (authConfig !== undefined) patch.auth_config = authConfig;
    if (!deliveryPolicyEquals(policy, baselinePolicy)) {
      patch.filter_expression = policy.filterExpression.trim() || null;
      patch.transform_template = deliveryPolicyTransform(policy);
    }
    setAuthError(null);
    setFormError(null);
    if (operationRef.current) return;
    const operation: DialogOperation<OutboundWebhookUpdateInput> = {
      controller: new AbortController(),
      idempotencyKey: newUUIDv7(),
      openedIdentity: identity,
      payload: patch,
      principalKey,
    };
    operationRef.current = operation;
    save.mutate(operation);
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent
        className="max-w-2xl"
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
          <DialogTitle>Edit outbound destination</DialogTitle>
          <DialogDescription>
            Leave the URL blank to keep the stored destination. The address
            shown in the list hides its path and query, so it cannot be
            resubmitted as a replacement.
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
                {apiErrorMessage(
                  save.error,
                  "The destination was not updated.",
                )}
              </AlertDescription>
            </Alert>
          ) : null}
          {formError ? (
            <Alert variant="destructive">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor={`${id}-url`}>Replacement URL (optional)</Label>
            <Input
              id={`${id}-url`}
              type="url"
              value={url}
              disabled={pending}
              autoComplete="off"
              placeholder={webhook.url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`${id}-description`}>Description</Label>
            <Input
              id={`${id}-description`}
              value={description}
              disabled={pending}
              maxLength={512}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          <EventCheckboxes
            idPrefix={`${id}-event`}
            topics={topics}
            selected={events}
            onToggle={(topic) =>
              setEvents((current) => {
                const next = new Set(current);
                if (next.has(topic)) next.delete(topic);
                else next.add(topic);
                return next;
              })
            }
          />

          <ReceiverAuthFields
            draft={authDraft}
            onChange={(next) => {
              setAuthDraft(next);
              if (authError) setAuthError(null);
            }}
            metadata={webhook.auth_config}
            allowPreserve
            disabled={pending}
            error={authError}
          />

          <DeliveryPolicyFields
            value={policy}
            onChange={setPolicy}
            disabled={pending}
          />

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Save destination
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Shown-once signing material                                                 */
/* -------------------------------------------------------------------------- */

export interface RevealedMaterial {
  reason: "created" | "rotated";
  response: OutboundWebhookCreateResponse;
}

function CopyValue({ value, label }: { value: string; label: string }) {
  const [status, setStatus] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <pre
        tabIndex={0}
        role="region"
        aria-label={label}
        className="overflow-x-auto rounded-md border bg-muted/40 p-3 text-xs"
      >
        <code>{value}</code>
      </pre>
      <div className="flex items-center gap-3">
        <Button
          type="button"
          size="sm"
          onClick={() => {
            void copyToClipboard(value).then((result) => {
              setStatus(
                result === "copied"
                  ? `${label} copied to the clipboard.`
                  : result === "unavailable"
                    ? "This browser did not offer a clipboard. Select the value and copy it manually."
                    : "The clipboard write was rejected. Select the value and copy it manually.",
              );
            });
          }}
        >
          Copy {label.toLowerCase()}
        </Button>
        <span className="text-xs text-muted-foreground" role="status">
          {status}
        </span>
      </div>
    </div>
  );
}

export function SigningMaterialDialog({
  revealed,
  onDismiss,
}: {
  revealed: RevealedMaterial;
  onDismiss: () => void;
}) {
  const helpId = useId();
  const [stored, setStored] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const { response, reason } = revealed;
  const algorithm = response.webhook?.signing_algorithm;
  const requiresSecretStorage = algorithm === "hmac_sha256";
  const canDismiss = !requiresSecretStorage || stored;
  const publicKey =
    response.public_key_pem ?? response.webhook?.signing_public_key;

  useEffect(() => {
    setStored(false);
  }, [reason, response.webhook?.id]);

  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (open) return;
          if (canDismiss) onDismiss();
          else setConfirmDiscard(true);
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {reason === "rotated"
                ? "Signing material rotated"
                : "Destination created"}
            </DialogTitle>
            <DialogDescription>
              {requiresSecretStorage
                ? "Copy the shared secret now. It is encrypted at rest and cannot be retrieved again."
                : "Configure the receiver with this public verification key. Moosewave retains the private signing key server-side."}
            </DialogDescription>
          </DialogHeader>

          {requiresSecretStorage ? (
            response.signing_secret ? (
              <CopyValue
                value={response.signing_secret}
                label="Shared signing secret"
              />
            ) : (
              <Alert variant="destructive">
                <AlertDescription>
                  The server did not return the one-time shared secret. Keep
                  this dialog open and contact support.
                </AlertDescription>
              </Alert>
            )
          ) : publicKey ? (
            <CopyValue value={publicKey} label="Public verification key" />
          ) : (
            <Alert variant="destructive">
              <AlertDescription>
                The server did not return the public verification key. Refresh
                the destination list or contact support.
              </AlertDescription>
            </Alert>
          )}

          {reason === "rotated" ? (
            <p className="text-sm text-muted-foreground">
              The previous key stays valid during the server&apos;s 24-hour
              dual-signing grace window. Update every verifier before it
              expires.
            </p>
          ) : null}

          {requiresSecretStorage ? (
            <div className="space-y-2">
              <div className="flex items-start gap-2">
                <Checkbox
                  id={`${helpId}-stored`}
                  className="mt-1"
                  checked={stored}
                  disabled={!response.signing_secret}
                  onChange={(event) => setStored(event.target.checked)}
                />
                <Label
                  htmlFor={`${helpId}-stored`}
                  className="text-sm font-normal"
                >
                  I stored the shared signing secret in an approved secret
                  manager and understand it cannot be shown again.
                </Label>
              </div>
              {!stored ? (
                <p id={helpId} className="text-xs text-muted-foreground">
                  Confirm secure storage before dismissing this one-time secret.
                </p>
              ) : null}
            </div>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              disabled={!canDismiss}
              aria-describedby={canDismiss ? undefined : helpId}
              onClick={onDismiss}
            >
              {requiresSecretStorage ? "I've stored it securely" : "Done"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmDiscard && requiresSecretStorage}
        onOpenChange={(open) => {
          if (!open) setConfirmDiscard(false);
        }}
        title="Discard the shown signing material?"
        description="This shared secret cannot be recovered. You will need to rotate the destination again before relying on it."
        confirmLabel="Discard shown secret"
        cancelLabel="Keep it open"
        onConfirm={() => {
          setConfirmDiscard(false);
          onDismiss();
        }}
      />
    </>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";

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
import type {
  InboundRoute,
  InboundRouteActionDraft,
  InboundRouteActionKind,
  InboundRouteDraft,
} from "@/lib/inbound-routes-admin-api";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";

export type InboundRouteEditorState =
  | { mode: "create" }
  | { mode: "edit"; route: InboundRoute };

interface ActionDraft extends InboundRouteActionDraft {
  uid: string;
  hasStoredHmacSecret: boolean;
}

const ACTION_LABELS: Array<{
  kind: InboundRouteActionKind;
  label: string;
}> = [
  { kind: "tag", label: "Tag" },
  { kind: "automation_trigger", label: "Trigger automation" },
  { kind: "webhook", label: "Webhook" },
  { kind: "forward", label: "Forward" },
  { kind: "store_only", label: "Store only" },
];

function initialActions(state: InboundRouteEditorState): ActionDraft[] {
  if (state.mode === "create") return [];
  return state.route.actions.map((action, index) => ({
    uid: `stored-${index}-${action.kind}`,
    kind: action.kind,
    ...(action.tag ? { tag: action.tag } : {}),
    ...(action.eventType ? { eventType: action.eventType } : {}),
    ...(action.url ? { url: action.url } : {}),
    ...(action.to ? { to: action.to } : {}),
    ...(Object.keys(action.extra).length ? { extra: action.extra } : {}),
    hmacSecret: "",
    hasStoredHmacSecret: action.hasStoredHmacSecret,
    ...(action.hasStoredHmacSecret
      ? { preserveHmacFromIndex: action.sourceIndex }
      : {}),
    removeStoredHmac: false,
  }));
}

function initialDraft(state: InboundRouteEditorState) {
  if (state.mode === "create")
    return {
      name: "",
      priority: "100",
      stopOnMatch: true,
      enabled: false,
      recipient: "*",
      subjectPrefix: "",
      fromDomain: "",
      retryMax: "0",
      retryBackoff: "2",
    };
  const route = state.route;
  return {
    name: route.name,
    priority: String(route.priority),
    stopOnMatch: route.stopOnMatch,
    enabled: route.enabled,
    recipient: route.matchRecipient,
    subjectPrefix: route.matchSubjectPrefix,
    fromDomain: route.matchFromDomain,
    retryMax: String(route.actionRetryMax),
    retryBackoff: String(route.actionRetryBackoffSeconds),
  };
}

export function InboundRouteEditor({
  "aria-label": ariaLabel = "Inbound route configuration",
  state,
  onClose,
  onSave,
}: {
  "aria-label"?: string;
  state: InboundRouteEditorState;
  onClose: () => void;
  onSave: (draft: InboundRouteDraft) => Promise<void>;
}) {
  const id = useId();
  const [route, setRoute] = useState(() => initialDraft(state));
  const [actions, setActions] = useState<ActionDraft[]>(() =>
    initialActions(state),
  );
  const [dirty, setDirty] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const actionCounter = useRef(0);
  const hmacBytes = useRef(new Map<string, Uint8Array>());
  const errorRef = useRef<HTMLDivElement>(null);

  useUnsavedChangesGuard(dirty || saving);

  function zeroHmac(uid?: string) {
    if (uid) {
      hmacBytes.current.get(uid)?.fill(0);
      hmacBytes.current.delete(uid);
      return;
    }
    for (const value of hmacBytes.current.values()) value.fill(0);
    hmacBytes.current.clear();
  }

  useEffect(
    () => () => {
      for (const value of hmacBytes.current.values()) value.fill(0);
      hmacBytes.current.clear();
    },
    [],
  );
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  function changeRoute(next: Partial<typeof route>) {
    setRoute((current) => ({ ...current, ...next }));
    setDirty(true);
    setError(null);
  }

  function updateAction(uid: string, patch: Partial<ActionDraft>) {
    setActions((current) =>
      current.map((action) =>
        action.uid === uid ? { ...action, ...patch } : action,
      ),
    );
    setDirty(true);
    setError(null);
  }

  function setHmac(uid: string, value: string) {
    zeroHmac(uid);
    if (value) hmacBytes.current.set(uid, new TextEncoder().encode(value));
    updateAction(uid, { hmacSecret: value, removeStoredHmac: false });
  }

  function addAction() {
    actionCounter.current += 1;
    setActions((current) => [
      ...current,
      {
        uid: `new-${actionCounter.current}`,
        kind: "tag",
        tag: "",
        hasStoredHmacSecret: false,
      },
    ]);
    setDirty(true);
  }

  function removeAction(uid: string) {
    zeroHmac(uid);
    setActions((current) => current.filter((action) => action.uid !== uid));
    setDirty(true);
  }

  function moveAction(index: number, direction: -1 | 1) {
    setActions((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
    setDirty(true);
  }

  function clearAndClose() {
    zeroHmac();
    setActions((current) =>
      current.map((action) => ({ ...action, hmacSecret: "" })),
    );
    setRoute((current) => ({
      ...current,
      name: "",
      recipient: "",
      subjectPrefix: "",
      fromDomain: "",
    }));
    setDirty(false);
    setDiscardOpen(false);
    onClose();
  }

  function requestClose() {
    if (savingRef.current) return;
    if (dirty) setDiscardOpen(true);
    else clearAndClose();
  }

  function build(): InboundRouteDraft {
    return {
      name: route.name,
      priority: Number(route.priority),
      stopOnMatch: route.stopOnMatch,
      enabled: route.enabled,
      matchRecipient: route.recipient,
      matchSubjectPrefix: route.subjectPrefix,
      matchFromDomain: route.fromDomain,
      actions: actions.map(
        ({ uid: _uid, hasStoredHmacSecret: _stored, ...action }) => {
          void _uid;
          void _stored;
          return action;
        },
      ),
      actionRetryMax: Number(route.retryMax),
      actionRetryBackoffSeconds: Number(route.retryBackoff),
    };
  }

  async function save() {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await onSave(build());
      clearAndClose();
    } catch (cause) {
      setError(apiErrorMessage(cause, "The inbound route could not be saved"));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && requestClose()}>
        <DialogContent
          closeDisabled={saving}
          className="max-h-[90vh] max-w-4xl overflow-y-auto"
          onEscapeKeyDown={(event) =>
            savingRef.current && event.preventDefault()
          }
          onPointerDownOutside={(event) =>
            savingRef.current && event.preventDefault()
          }
        >
          <form
            aria-label={ariaLabel}
            className="space-y-5"
            autoComplete="off"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {state.mode === "create"
                  ? "Create inbound route"
                  : `Edit ${state.route.name || "inbound route"}`}
              </DialogTitle>
              <DialogDescription>
                Matcher changes affect future inbound mail. Actions execute in
                the order shown; a newly created route starts disabled unless
                you explicitly enable it here.
              </DialogDescription>
            </DialogHeader>

            <fieldset
              disabled={saving}
              aria-label="Inbound route fields"
              className="space-y-5"
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id={`${id}-name`} label="Name">
                  <Input
                    id={`${id}-name`}
                    required
                    maxLength={120}
                    value={route.name}
                    onChange={(event) =>
                      changeRoute({ name: event.target.value })
                    }
                  />
                </Field>
                <Field id={`${id}-priority`} label="Priority (0–10,000)">
                  <Input
                    id={`${id}-priority`}
                    type="number"
                    min={0}
                    max={10000}
                    step={1}
                    required
                    value={route.priority}
                    onChange={(event) =>
                      changeRoute({ priority: event.target.value })
                    }
                  />
                </Field>
                <Field id={`${id}-recipient`} label="Recipient glob">
                  <Input
                    id={`${id}-recipient`}
                    required
                    maxLength={320}
                    value={route.recipient}
                    onChange={(event) =>
                      changeRoute({ recipient: event.target.value })
                    }
                    placeholder="support@*"
                  />
                </Field>
                <Field id={`${id}-subject`} label="Subject prefix (optional)">
                  <Input
                    id={`${id}-subject`}
                    maxLength={255}
                    value={route.subjectPrefix}
                    onChange={(event) =>
                      changeRoute({ subjectPrefix: event.target.value })
                    }
                  />
                </Field>
                <Field id={`${id}-domain`} label="Sender domain (optional)">
                  <Input
                    id={`${id}-domain`}
                    maxLength={253}
                    value={route.fromDomain}
                    onChange={(event) =>
                      changeRoute({ fromDomain: event.target.value })
                    }
                    placeholder="example.com"
                  />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field id={`${id}-retries`} label="Extra retries (0–5)">
                    <Input
                      id={`${id}-retries`}
                      type="number"
                      min={0}
                      max={5}
                      step={1}
                      required
                      value={route.retryMax}
                      onChange={(event) =>
                        changeRoute({ retryMax: event.target.value })
                      }
                    />
                  </Field>
                  <Field id={`${id}-backoff`} label="Backoff seconds (0–60)">
                    <Input
                      id={`${id}-backoff`}
                      type="number"
                      min={0}
                      max={60}
                      step={1}
                      required
                      value={route.retryBackoff}
                      onChange={(event) =>
                        changeRoute({ retryBackoff: event.target.value })
                      }
                    />
                  </Field>
                </div>
              </div>

              <div className="flex flex-wrap gap-5 rounded-md border p-3 text-sm">
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={route.stopOnMatch}
                    onChange={(event) =>
                      changeRoute({ stopOnMatch: event.target.checked })
                    }
                  />
                  Stop evaluating after this enabled route matches
                </label>
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={route.enabled}
                    onChange={(event) =>
                      changeRoute({ enabled: event.target.checked })
                    }
                  />
                  Enabled for future inbound mail
                </label>
              </div>

              <section
                aria-labelledby={`${id}-actions-heading`}
                className="space-y-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 id={`${id}-actions-heading`} className="font-medium">
                      Ordered actions
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      Failures are recorded by the backend but do not stop later
                      actions.
                    </p>
                  </div>
                  <Button type="button" variant="outline" onClick={addAction}>
                    <Plus aria-hidden className="size-4" /> Add action
                  </Button>
                </div>
                {actions.length === 0 ? (
                  <p className="rounded-md border p-4 text-sm text-muted-foreground">
                    No actions. Matching mail is stored without another side
                    effect.
                  </p>
                ) : (
                  <ol className="space-y-3">
                    {actions.map((action, index) => (
                      <ActionEditor
                        key={action.uid}
                        id={`${id}-action-${index}`}
                        action={action}
                        index={index}
                        total={actions.length}
                        onChange={(patch) => updateAction(action.uid, patch)}
                        onHmacChange={(value) => setHmac(action.uid, value)}
                        onRemove={() => removeAction(action.uid)}
                        onMove={(direction) => moveAction(index, direction)}
                        onKindChange={(kind) => {
                          zeroHmac(action.uid);
                          updateAction(action.uid, {
                            kind,
                            tag: "",
                            eventType: "",
                            url: "",
                            to: "",
                            hmacSecret: "",
                            preserveHmacFromIndex: undefined,
                            hasStoredHmacSecret: false,
                            removeStoredHmac: false,
                          });
                        }}
                      />
                    ))}
                  </ol>
                )}
              </section>
            </fieldset>

            {error ? (
              <div
                ref={errorRef}
                role="alert"
                tabIndex={-1}
                className="rounded-md border border-destructive p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {error}
              </div>
            ) : null}

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={saving}
                onClick={requestClose}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saving} loading={saving}>
                {saving
                  ? "Saving…"
                  : state.mode === "create"
                    ? "Create route"
                    : "Save changes"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="Discard inbound route draft?"
        description="Every unsaved matcher and action change will be cleared. Newly entered HMAC plaintext is removed from the local draft. Type DISCARD to continue."
        confirmationToken="DISCARD"
        confirmLabel="Discard draft"
        onConfirm={clearAndClose}
      />
    </>
  );
}

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

function ActionEditor({
  id,
  action,
  index,
  total,
  onChange,
  onHmacChange,
  onRemove,
  onMove,
  onKindChange,
}: {
  id: string;
  action: ActionDraft;
  index: number;
  total: number;
  onChange: (patch: Partial<ActionDraft>) => void;
  onHmacChange: (value: string) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
  onKindChange: (kind: InboundRouteActionKind) => void;
}) {
  return (
    <li className="space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <Field id={`${id}-kind`} label={`Action ${index + 1} of ${total}`}>
          <Select
            id={`${id}-kind`}
            value={action.kind}
            onChange={(event) =>
              onKindChange(event.target.value as InboundRouteActionKind)
            }
          >
            {ACTION_LABELS.map((option) => (
              <option key={option.kind} value={option.kind}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex gap-1">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={index === 0}
            aria-label={`Move action ${index + 1} earlier`}
            onClick={() => onMove(-1)}
          >
            <ArrowUp aria-hidden className="size-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={index === total - 1}
            aria-label={`Move action ${index + 1} later`}
            onClick={() => onMove(1)}
          >
            <ArrowDown aria-hidden className="size-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={`Remove action ${index + 1}`}
            onClick={onRemove}
          >
            <Trash2 aria-hidden className="size-4" />
          </Button>
        </div>
      </div>

      {action.kind === "tag" ? (
        <Field id={`${id}-tag`} label="Tag">
          <Input
            id={`${id}-tag`}
            required
            maxLength={256}
            value={action.tag ?? ""}
            onChange={(event) => onChange({ tag: event.target.value })}
          />
        </Field>
      ) : null}
      {action.kind === "automation_trigger" ? (
        <Field id={`${id}-event`} label="Automation event type">
          <Input
            id={`${id}-event`}
            required
            maxLength={256}
            value={action.eventType ?? ""}
            onChange={(event) => onChange({ eventType: event.target.value })}
          />
        </Field>
      ) : null}
      {action.kind === "webhook" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={`${id}-url`} label="Webhook URL">
            <Input
              id={`${id}-url`}
              type="url"
              required
              maxLength={2048}
              value={action.url ?? ""}
              onChange={(event) => onChange({ url: event.target.value })}
            />
          </Field>
          <Field id={`${id}-hmac`} label="HMAC signing secret (optional)">
            <Input
              id={`${id}-hmac`}
              type="password"
              maxLength={4096}
              autoComplete="new-password"
              spellCheck={false}
              disabled={action.removeStoredHmac}
              value={action.hmacSecret ?? ""}
              placeholder={
                action.hasStoredHmacSecret
                  ? "Leave blank to keep stored secret"
                  : "Leave blank for unsigned requests"
              }
              onChange={(event) => onHmacChange(event.target.value)}
            />
          </Field>
          {action.hasStoredHmacSecret ? (
            <label className="flex items-center gap-2 text-xs sm:col-span-2">
              <Checkbox
                checked={Boolean(action.removeStoredHmac)}
                onChange={(event) => {
                  onHmacChange("");
                  onChange({ removeStoredHmac: event.target.checked });
                }}
              />
              Remove the stored HMAC secret when this route is saved
            </label>
          ) : null}
          <p className="text-xs text-muted-foreground sm:col-span-2">
            HTTP is accepted by the mounted contract, but HTTPS should be used
            in production. The server applies its SSRF-safe transport at
            execution.
          </p>
        </div>
      ) : null}
      {action.kind === "forward" ? (
        <Field id={`${id}-to`} label="Forward to">
          <Input
            id={`${id}-to`}
            type="email"
            required
            maxLength={320}
            value={action.to ?? ""}
            onChange={(event) => onChange({ to: event.target.value })}
          />
        </Field>
      ) : null}
      {action.kind === "store_only" ? (
        <p className="text-xs text-muted-foreground">
          Store the inbound email without another action.
        </p>
      ) : null}
    </li>
  );
}

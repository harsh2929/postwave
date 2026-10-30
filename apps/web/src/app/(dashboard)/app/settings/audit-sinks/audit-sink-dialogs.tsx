// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import type { RefObject } from "react";

import { OcsfMappingInfo } from "@/components/settings/ocsf-mapping-info";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  SINK_FIELD_SPECS,
  type OutputFormat,
  type ScheduleCadence,
  type SinkKind,
  type WebhookFormat,
} from "@/lib/audit-sinks-api";
import {
  OPTIONAL_SINK_KEYS,
  humanizeKey,
  type SinkFormValue,
} from "./sink-form";

const SINK_KINDS: SinkKind[] = [
  "s3",
  "datadog",
  "splunk",
  "http",
  "archive",
  "snowflake_shareback",
  "otlp_logs",
];

// Advanced kinds use nested configuration the form cannot safely construct.
const CREATABLE_KINDS: SinkKind[] = SINK_KINDS.filter(
  (kind) =>
    SINK_FIELD_SPECS[kind].config.length > 0 ||
    SINK_FIELD_SPECS[kind].credentials.length > 0,
);
const OUTPUT_FORMATS: OutputFormat[] = ["postwave_native", "ocsf_1_8"];
const WEBHOOK_FORMATS: WebhookFormat[] = [
  "postwave_v1",
  "standard_webhooks",
];
const CADENCES: ScheduleCadence[] = ["weekly", "monthly"];
const DIALOG_CLASS =
  "max-w-lg [&_button]:min-h-11 [&_input]:min-h-11 [&_input]:text-base [&_select]:min-h-11 [&_select]:text-base sm:[&_button]:min-h-0 sm:[&_input]:min-h-0 sm:[&_input]:text-sm sm:[&_select]:min-h-0 sm:[&_select]:text-sm";

interface ProtectedDialogProps {
  saving: boolean;
  savingRef: RefObject<boolean>;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onOpenChange: (open: boolean) => void;
}

interface SinkFormProps {
  value: SinkFormValue;
  onChange: (next: SinkFormValue) => void;
  isEdit: boolean;
  disabled?: boolean;
  errorId?: string;
}

function SinkForm({
  value,
  onChange,
  isEdit,
  disabled = false,
  errorId,
}: SinkFormProps) {
  const spec = SINK_FIELD_SPECS[value.kind];
  const patch = (next: Partial<SinkFormValue>) =>
    onChange({ ...value, ...next });

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="sink-name" className="mb-1 block text-muted-foreground">
          Name
        </Label>
        <Input
          id="sink-name"
          value={value.name}
          disabled={disabled}
          aria-describedby={errorId}
          onChange={(event) => patch({ name: event.target.value })}
          placeholder="Prod SIEM"
          maxLength={120}
        />
      </div>
      <div>
        <Label htmlFor="sink-kind" className="mb-1 block text-muted-foreground">
          Kind
        </Label>
        <Select
          id="sink-kind"
          value={value.kind}
          disabled={isEdit || disabled}
          aria-disabled={isEdit || disabled}
          onChange={(event) =>
            patch({
              kind: event.target.value as SinkKind,
              config: {},
              credentials: {},
            })
          }
        >
          {(isEdit ? [value.kind] : CREATABLE_KINDS).map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </Select>
        {isEdit ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Kind can&apos;t be changed. Delete and re-create to switch.
          </p>
        ) : null}
      </div>

      {spec.config.length > 0 ? (
        <div className="space-y-2">
          {spec.config.map((key) => (
            <div key={key}>
              <Label
                htmlFor={`sink-config-${key}`}
                className="mb-1 block text-muted-foreground"
              >
                {humanizeKey(key)}
                {OPTIONAL_SINK_KEYS.has(key) ? " (optional)" : ""}
              </Label>
              <Input
                id={`sink-config-${key}`}
                value={value.config[key] ?? ""}
                disabled={disabled}
                onChange={(event) =>
                  patch({
                    config: { ...value.config, [key]: event.target.value },
                  })
                }
              />
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          This kind uses advanced nested configuration not editable here yet —
          create it via the API, then manage enable/disable and format here.
        </p>
      )}

      {spec.credentials.length > 0 ? (
        <div className="space-y-2">
          {spec.credentials.map((key) => (
            <div key={key}>
              <Label
                htmlFor={`sink-cred-${key}`}
                className="mb-1 block text-muted-foreground"
              >
                {humanizeKey(key)}
                {OPTIONAL_SINK_KEYS.has(key) ? " (optional)" : ""}
              </Label>
              <Input
                id={`sink-cred-${key}`}
                type="password"
                autoComplete="new-password"
                value={value.credentials[key] ?? ""}
                disabled={disabled}
                onChange={(event) =>
                  patch({
                    credentials: {
                      ...value.credentials,
                      [key]: event.target.value,
                    },
                  })
                }
                placeholder={isEdit ? "•••••• (unchanged)" : ""}
              />
            </div>
          ))}
          {isEdit ? (
            <p className="text-xs text-muted-foreground">
              Leave <strong>all</strong> credential fields blank to keep the
              stored secrets. To change any credential you must re-enter the
              complete set — saving replaces the entire credential envelope.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label
            htmlFor="sink-output"
            className="mb-1 block text-muted-foreground"
          >
            Output format
          </Label>
          <Select
            id="sink-output"
            value={value.outputFormat}
            disabled={disabled}
            onChange={(event) =>
              patch({ outputFormat: event.target.value as OutputFormat })
            }
          >
            {OUTPUT_FORMATS.map((format) => (
              <option key={format} value={format}>
                {format}
              </option>
            ))}
          </Select>
        </div>
        {value.kind === "http" ? (
          <div>
            <Label
              htmlFor="sink-webhook"
              className="mb-1 block text-muted-foreground"
            >
              Webhook signature
            </Label>
            <Select
              id="sink-webhook"
              value={value.webhookFormat}
              disabled={disabled}
              onChange={(event) =>
                patch({ webhookFormat: event.target.value as WebhookFormat })
              }
            >
              {WEBHOOK_FORMATS.map((format) => (
                <option key={format} value={format}>
                  {format}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
      </div>
      <OcsfMappingInfo format={value.outputFormat} />
    </div>
  );
}

function protectedContentProps({
  savingRef,
  returnFocusRef,
}: Pick<ProtectedDialogProps, "savingRef" | "returnFocusRef">) {
  return {
    onEscapeKeyDown: (event: Event) => {
      if (savingRef.current) event.preventDefault();
    },
    onPointerDownOutside: (event: Event) => {
      if (savingRef.current) event.preventDefault();
    },
    onCloseAutoFocus: (event: Event) => {
      if (!returnFocusRef.current) return;
      event.preventDefault();
      returnFocusRef.current.focus();
    },
  };
}

export function CreateSinkDialog({
  saving,
  savingRef,
  returnFocusRef,
  onOpenChange,
  form,
  error,
  testReceipt,
  errorRef,
  tested,
  onFormChange,
  onTest,
  onSubmit,
}: ProtectedDialogProps & {
  form: SinkFormValue;
  error: string | null;
  testReceipt: string | null;
  errorRef: RefObject<HTMLParagraphElement | null>;
  tested: boolean;
  onFormChange: (next: SinkFormValue) => void;
  onTest: () => Promise<void>;
  onSubmit: () => Promise<void>;
}) {
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        aria-busy={saving}
        closeDisabled={saving}
        className={DIALOG_CLASS}
        {...protectedContentProps({ savingRef, returnFocusRef })}
      >
        <DialogHeader>
          <DialogTitle>Add streaming sink</DialogTitle>
          <DialogDescription>
            Credentials are encrypted and never shown again.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onSubmit();
          }}
        >
          <SinkForm
            value={form}
            onChange={onFormChange}
            isEdit={false}
            disabled={saving}
            errorId={error ? "create-sink-error" : undefined}
          />
          {error ? (
            <p
              ref={errorRef}
              id="create-sink-error"
              role="alert"
              tabIndex={-1}
              className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {error}
            </p>
          ) : testReceipt ? (
            <p
              role="status"
              className="mt-4 rounded-md border border-success/30 bg-success/10 p-3 text-sm text-success-emphasis"
            >
              {testReceipt}
            </p>
          ) : null}
          <DialogFooter className="mt-4">
            <DialogClose asChild>
              <Button type="button" variant="ghost" disabled={saving}>
                Cancel
              </Button>
            </DialogClose>
            <ConfirmDialog
              title="Send a sink canary?"
              description="This sends one real audit test event to the unsaved destination using the entered write-only credentials. It does not create the sink."
              confirmLabel="Send canary"
              onConfirm={onTest}
              trigger={
                <Button type="button" variant="outline" disabled={saving}>
                  {saving ? "Testing…" : "Test delivery"}
                </Button>
              }
            />
            <Button
              type="submit"
              disabled={saving || !tested}
              loading={saving}
            >
              {saving ? "Creating…" : "Create sink"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function EditSinkDialog({
  saving,
  savingRef,
  returnFocusRef,
  onOpenChange,
  form,
  error,
  errorRef,
  unchanged,
  onFormChange,
  onSubmit,
}: ProtectedDialogProps & {
  form: SinkFormValue;
  error: string | null;
  errorRef: RefObject<HTMLParagraphElement | null>;
  unchanged: boolean;
  onFormChange: (next: SinkFormValue) => void;
  onSubmit: () => Promise<void>;
}) {
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        aria-busy={saving}
        closeDisabled={saving}
        className={DIALOG_CLASS}
        {...protectedContentProps({ savingRef, returnFocusRef })}
      >
        <DialogHeader>
          <DialogTitle>Edit sink</DialogTitle>
          <DialogDescription>
            Leave credentials blank to keep the stored secret.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onSubmit();
          }}
        >
          <SinkForm
            value={form}
            onChange={onFormChange}
            isEdit
            disabled={saving}
            errorId={error ? "edit-sink-error" : undefined}
          />
          {error ? (
            <p
              ref={errorRef}
              id="edit-sink-error"
              role="alert"
              tabIndex={-1}
              className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {error}
            </p>
          ) : unchanged ? (
            <p className="mt-4 text-sm text-muted-foreground" role="status">
              Change a field to enable saving.
            </p>
          ) : null}
          <DialogFooter className="mt-4">
            <DialogClose asChild>
              <Button type="button" variant="ghost" disabled={saving}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              disabled={saving || unchanged}
              loading={saving}
            >
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CreateScheduleDialog({
  saving,
  savingRef,
  returnFocusRef,
  onOpenChange,
  cadence,
  recipients,
  error,
  errorRef,
  onCadenceChange,
  onRecipientsChange,
  onSubmit,
}: ProtectedDialogProps & {
  cadence: ScheduleCadence;
  recipients: string;
  error: string | null;
  errorRef: RefObject<HTMLParagraphElement | null>;
  onCadenceChange: (cadence: ScheduleCadence) => void;
  onRecipientsChange: (recipients: string) => void;
  onSubmit: () => Promise<void>;
}) {
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        aria-busy={saving}
        closeDisabled={saving}
        className={DIALOG_CLASS}
        {...protectedContentProps({ savingRef, returnFocusRef })}
      >
        <DialogHeader>
          <DialogTitle>Add export schedule</DialogTitle>
          <DialogDescription>
            A signed export is emailed on this cadence.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onSubmit();
          }}
        >
          <div className="space-y-4">
            <div>
              <Label
                htmlFor="sched-cadence"
                className="mb-1 block text-muted-foreground"
              >
                Cadence
              </Label>
              <Select
                id="sched-cadence"
                value={cadence}
                disabled={saving}
                onChange={(event) =>
                  onCadenceChange(event.target.value as ScheduleCadence)
                }
              >
                {CADENCES.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {candidate}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label
                htmlFor="sched-recipients"
                className="mb-1 block text-muted-foreground"
              >
                Recipients
              </Label>
              <Input
                id="sched-recipients"
                value={recipients}
                disabled={saving}
                aria-describedby={
                  error
                    ? "schedule-recipient-help schedule-create-error"
                    : "schedule-recipient-help"
                }
                onChange={(event) => onRecipientsChange(event.target.value)}
                placeholder="compliance@acme.com, security@acme.com"
              />
              <p
                id="schedule-recipient-help"
                className="mt-1 text-xs text-muted-foreground"
              >
                Comma-separated. Up to 20 addresses.
              </p>
            </div>
          </div>
          {error ? (
            <p
              ref={errorRef}
              id="schedule-create-error"
              role="alert"
              tabIndex={-1}
              className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {error}
            </p>
          ) : null}
          <DialogFooter className="mt-4">
            <DialogClose asChild>
              <Button type="button" variant="ghost" disabled={saving}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={saving} loading={saving}>
              {saving ? "Creating…" : "Create schedule"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

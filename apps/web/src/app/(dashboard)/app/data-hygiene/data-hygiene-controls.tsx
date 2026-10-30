// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, RotateCcw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { apiErrorMessage } from "@/lib/api";
import {
  IDENTIFIER_TRANSFORM_PHONE_REGIONS,
  previewIdentifierTransforms,
  updateDeduplicationSettings,
  updateIdentifierTransforms,
  updatePiiFields,
  type DeduplicationSettings,
  type IdentifierTransformPreviewResult,
  type IdentifierTransforms,
  type PiiConfig,
  type PiiFieldSensitivity,
} from "@/lib/data-hygiene-api";

interface WriteGateProps {
  canWrite: boolean;
  permissionKnown: boolean;
  runAdmin: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<T>;
}

function writeGateMessage(permissionKnown: boolean): string {
  return permissionKnown
    ? "Only workspace owners and admins can change this policy."
    : "Permissions could not be verified, so editing is disabled.";
}

function sameTransforms(
  left: IdentifierTransforms,
  right: IdentifierTransforms,
): boolean {
  return (
    left.email_normalize_dots === right.email_normalize_dots &&
    left.email_normalize_plus === right.email_normalize_plus &&
    left.phone_e164_format === right.phone_e164_format &&
    left.phone_default_region === right.phone_default_region
  );
}

export function IdentifierTransformsEditor({
  value,
  canWrite,
  permissionKnown,
  resetVersion,
  onSaved,
  onDirtyChange,
  runAdmin,
}: WriteGateProps & {
  value: IdentifierTransforms;
  resetVersion: number;
  onSaved: (value: IdentifierTransforms) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [persisted, setPersisted] = useState(value);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [previewEmail, setPreviewEmail] = useState("J.o.h.n+promo@Gmail.com");
  const [previewPhone, setPreviewPhone] = useState("(202) 555-0147");
  const [preview, setPreview] =
    useState<IdentifierTransformPreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const previewingRef = useRef(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const dirty = !sameTransforms(persisted, draft);

  useEffect(() => {
    setPersisted(value);
    setDraft(value);
    setActionError(null);
    setSuccess(null);
  }, [resetVersion, value]);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  function change<K extends keyof IdentifierTransforms>(
    key: K,
    next: IdentifierTransforms[K],
  ) {
    if (!canWrite || savingRef.current) return;
    setDraft((current) => ({ ...current, [key]: next }));
    setActionError(null);
    setSuccess(null);
    setPreview(null);
    setPreviewError(null);
  }

  async function save() {
    if (!canWrite || !dirty || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setActionError(null);
    setSuccess(null);
    try {
      const frozen = { ...draft };
      const saved = await runAdmin((signal) =>
        updateIdentifierTransforms(frozen, {
          signal,
          requireOnline: true,
          maxAttempts: 1,
        }),
      );
      setPersisted(saved);
      setDraft(saved);
      onSaved(saved);
      setSuccess(
        "Identifier transforms saved. New ingests will use this policy.",
      );
    } catch (cause) {
      setActionError(
        apiErrorMessage(cause, "Could not save identifier transforms."),
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function runPreview() {
    if (previewingRef.current) return;
    previewingRef.current = true;
    setPreviewing(true);
    setPreviewError(null);
    setPreview(null);
    try {
      setPreview(
        await previewIdentifierTransforms({
          email: previewEmail,
          custom_fields: previewPhone ? { phone: previewPhone } : {},
          overrides: draft,
        }),
      );
    } catch (cause) {
      setPreviewError(
        apiErrorMessage(cause, "Could not generate the identifier preview."),
      );
    } finally {
      previewingRef.current = false;
      setPreviewing(false);
    }
  }

  return (
    <div className="space-y-4">
      <fieldset className="space-y-3" disabled={!canWrite || saving}>
        <legend className="sr-only">Identifier normalization policy</legend>
        <TransformCheckbox
          id="normalize-email-dots"
          label="Ignore dots in email local-parts"
          description="Treats j.o.h.n@example.com and john@example.com as the same address. The domain is never changed."
          checked={draft.email_normalize_dots}
          disabled={!canWrite || saving}
          onChange={(checked) => change("email_normalize_dots", checked)}
        />
        <TransformCheckbox
          id="normalize-email-plus"
          label="Ignore +tags in email local-parts"
          description="Treats john+promo@example.com and john@example.com as the same address."
          checked={draft.email_normalize_plus}
          disabled={!canWrite || saving}
          onChange={(checked) => change("email_normalize_plus", checked)}
        />
        <TransformCheckbox
          id="normalize-phone-e164"
          label="Store phone identifiers as E.164"
          description="Normalizes recognized phone fields to an international +country-code form at ingest."
          checked={draft.phone_e164_format}
          disabled={!canWrite || saving}
          onChange={(checked) => change("phone_e164_format", checked)}
        />
        <div className="grid gap-2 rounded-xl border bg-muted/20 p-3.5 sm:grid-cols-[minmax(0,1fr)_18rem] sm:items-center">
          <div>
            <Label htmlFor="phone-default-region">Phone default region</Label>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Used only for national-format numbers without a country code.
            </p>
          </div>
          <Select
            id="phone-default-region"
            value={draft.phone_default_region}
            disabled={!canWrite || saving || !draft.phone_e164_format}
            onChange={(event) =>
              change("phone_default_region", event.target.value)
            }
          >
            {IDENTIFIER_TRANSFORM_PHONE_REGIONS.map((region) => (
              <option key={region.value || "none"} value={region.value}>
                {region.label}
              </option>
            ))}
          </Select>
        </div>
      </fieldset>

      {!canWrite ? (
        <p className="text-sm leading-5 text-muted-foreground">
          {writeGateMessage(permissionKnown)}
        </p>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {dirty ? <Badge variant="warning">Unsaved changes</Badge> : null}
          <Button
            type="button"
            variant="ghost"
            disabled={!dirty || saving}
            onClick={() => {
              setDraft(persisted);
              setActionError(null);
              setSuccess(null);
            }}
          >
            <RotateCcw aria-hidden="true" />
            Reset
          </Button>
          <Button
            type="button"
            disabled={!dirty || saving}
            loading={saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save transforms"}
          </Button>
        </div>
      )}
      {actionError ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm"
        >
          {actionError}
        </p>
      ) : null}
      {success ? (
        <p role="status" className="text-sm text-success-emphasis">
          {success}
        </p>
      ) : null}

      <div className="space-y-3 rounded-xl border bg-muted/20 p-3.5">
        <div>
          <p className="text-sm font-semibold">Dry-run preview</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Uses the draft policy without changing or storing a subscriber.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="transform-preview-email">Sample email</Label>
            <Input
              id="transform-preview-email"
              value={previewEmail}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setPreviewEmail(event.target.value);
                setPreview(null);
                setPreviewError(null);
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="transform-preview-phone">Sample phone</Label>
            <Input
              id="transform-preview-phone"
              value={previewPhone}
              autoComplete="off"
              onChange={(event) => {
                setPreviewPhone(event.target.value);
                setPreview(null);
                setPreviewError(null);
              }}
            />
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          loading={previewing}
          disabled={
            previewing || (!previewEmail.trim() && !previewPhone.trim())
          }
          onClick={() => void runPreview()}
        >
          {previewing ? "Previewing…" : "Preview changes"}
        </Button>
        {previewError ? (
          <p
            role="alert"
            className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm"
          >
            {previewError}
          </p>
        ) : null}
        {preview ? (
          <dl
            className="grid gap-2 sm:grid-cols-2"
            aria-label="Identifier transform preview"
          >
            <PreviewResult
              label="Email"
              input={preview.email_input}
              output={preview.email_output}
              changed={preview.email_changed}
            />
            {preview.phones.length > 0 ? (
              preview.phones.map((phone) => (
                <PreviewResult
                  key={phone.key}
                  label={`Phone · ${phone.key}`}
                  input={phone.input}
                  output={phone.output}
                  changed={phone.changed}
                />
              ))
            ) : (
              <div className="rounded-lg border bg-background p-3">
                <dt className="text-xs font-medium text-muted-foreground">
                  Phone
                </dt>
                <dd className="mt-1 text-sm">No phone field was returned.</dd>
              </div>
            )}
          </dl>
        ) : null}
      </div>

      <p className="text-xs leading-5 text-muted-foreground">
        Changes apply to new ingests only; existing subscriber rows are not
        rewritten.
      </p>
    </div>
  );
}

function TransformCheckbox({
  id,
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border bg-muted/20 p-3.5">
      <div className="min-w-0">
        <Label htmlFor={id}>{label}</Label>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {description}
        </p>
      </div>
      <Checkbox
        id={id}
        className="mt-1 shrink-0"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </div>
  );
}

function PreviewResult({
  label,
  input,
  output,
  changed,
}: {
  label: string;
  input: string;
  output: string;
  changed: boolean;
}) {
  return (
    <div className="min-w-0 rounded-lg border bg-background p-3">
      <dt className="flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
        {label}
        <Badge variant={changed ? "info" : "outline"}>
          {changed ? "Changed" : "Unchanged"}
        </Badge>
      </dt>
      <dd className="mt-2 min-w-0 break-all font-mono text-xs leading-5">
        {input || "(empty)"}
        <span className="mx-2" aria-hidden="true">
          →
        </span>
        {output || "(empty)"}
      </dd>
    </div>
  );
}

export function DeduplicationThresholdEditor({
  value,
  canWrite,
  permissionKnown,
  resetVersion,
  onSaved,
  onDirtyChange,
  runAdmin,
}: WriteGateProps & {
  value: DeduplicationSettings;
  resetVersion: number;
  onSaved: (value: DeduplicationSettings) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [persisted, setPersisted] = useState(value.merge_confidence_threshold);
  const [draft, setDraft] = useState(value.merge_confidence_threshold);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const thresholdInputRef = useRef<HTMLInputElement>(null);
  const dirty = draft !== persisted;
  const inOperatorBand = persisted >= 0.8 && persisted <= 1;

  useEffect(() => {
    setPersisted(value.merge_confidence_threshold);
    setDraft(value.merge_confidence_threshold);
    setActionError(null);
    setSuccess(null);
  }, [resetVersion, value.merge_confidence_threshold]);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  async function save() {
    if (!canWrite || !dirty || savingRef.current || !inOperatorBand) return;
    savingRef.current = true;
    setSaving(true);
    setActionError(null);
    setSuccess(null);
    try {
      const frozen = draft;
      const saved = await runAdmin((signal) =>
        updateDeduplicationSettings(frozen, {
          signal,
          requireOnline: true,
          maxAttempts: 1,
        }),
      );
      setPersisted(saved.merge_confidence_threshold);
      setDraft(saved.merge_confidence_threshold);
      onSaved(saved);
      setSuccess("Deduplication threshold saved.");
    } catch (cause) {
      const message = apiErrorMessage(
        cause,
        "Could not save the deduplication threshold.",
      );
      setActionError(message);
      throw new Error(message);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  if (!inOperatorBand) {
    return (
      <p
        role="alert"
        className="rounded-lg border border-warning/25 bg-warning-subtle p-3 text-sm leading-5 text-warning-emphasis"
      >
        The current threshold is outside the mounted operator range of 80–100%.
        It remains visible above, but editing is held until an owner or admin
        resolves it through a compatible client.
      </p>
    );
  }

  return (
    <div className="mt-4 space-y-3 rounded-xl border bg-muted/20 p-3.5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Label htmlFor="dedupe-threshold">Merge threshold</Label>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Mounted operator range: 80–100%. Lower values merge more broadly.
          </p>
        </div>
        <output
          htmlFor="dedupe-threshold"
          className="text-lg font-semibold tabular-nums"
        >
          {(draft * 100).toFixed(0)}%
        </output>
      </div>
      <Input
        ref={thresholdInputRef}
        id="dedupe-threshold"
        type="range"
        min={80}
        max={100}
        step={1}
        value={Math.round(draft * 100)}
        disabled={!canWrite || saving}
        aria-valuetext={`${(draft * 100).toFixed(0)} percent`}
        onChange={(event) => {
          if (!canWrite || savingRef.current) return;
          setDraft(Number(event.target.value) / 100);
          setActionError(null);
          setSuccess(null);
        }}
      />
      {draft < persisted ? (
        <p className="text-sm leading-5 text-warning-emphasis">
          This lowers the bar and can merge more distinct people into one
          record.
        </p>
      ) : null}
      {!canWrite ? (
        <p className="text-sm leading-5 text-muted-foreground">
          {writeGateMessage(permissionKnown)}
        </p>
      ) : (
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={!dirty || saving}
            onClick={() => {
              setDraft(persisted);
              setActionError(null);
              setSuccess(null);
            }}
          >
            <RotateCcw aria-hidden="true" />
            Reset
          </Button>
          <ConfirmDialog
            title="Change the merge threshold?"
            description={
              <>
                Change the workspace threshold from{" "}
                {(persisted * 100).toFixed(0)}%{" to "}
                {(draft * 100).toFixed(0)}%? This changes which duplicate pairs
                qualify for destructive merging.
              </>
            }
            confirmLabel="Save threshold"
            onConfirm={save}
            fallbackFocusRef={thresholdInputRef}
            trigger={
              <Button type="button" disabled={!dirty || saving}>
                Save threshold
              </Button>
            }
          />
        </div>
      )}
      {actionError ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm"
        >
          {actionError}
        </p>
      ) : null}
      {success ? (
        <p role="status" className="text-sm text-success-emphasis">
          {success}
        </p>
      ) : null}
    </div>
  );
}

export function PiiFieldsEditor({
  value,
  canWrite,
  permissionKnown,
  onSaved,
  runAdmin,
}: WriteGateProps & {
  value: PiiConfig;
  onSaved: (value: PiiConfig) => void;
}) {
  const [savingField, setSavingField] = useState<string | null>(null);
  const savingRef = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const fieldListRef = useRef<HTMLUListElement>(null);
  const fields = useMemo(() => {
    const byName = new Map<string, PiiFieldSensitivity>();
    for (const field of value.fields) byName.set(field.field_name, field);
    for (const builtIn of value.built_in_fields) {
      byName.set(builtIn, {
        field_name: builtIn,
        sensitive: true,
        built_in: true,
      });
    }
    return [...byName.values()].sort(
      (left, right) =>
        Number(right.built_in) - Number(left.built_in) ||
        left.field_name.localeCompare(right.field_name),
    );
  }, [value]);

  async function setSensitive(field: PiiFieldSensitivity, sensitive: boolean) {
    if (
      !canWrite ||
      field.built_in ||
      value.built_in_fields.includes(field.field_name) ||
      savingRef.current
    ) {
      return;
    }
    savingRef.current = true;
    setSavingField(field.field_name);
    setActionError(null);
    setSuccess(null);
    try {
      const frozen = [{ field_name: field.field_name, sensitive }];
      const saved = await runAdmin((signal) =>
        updatePiiFields(frozen, {
          signal,
          requireOnline: true,
          maxAttempts: 1,
        }),
      );
      onSaved(saved);
      setSuccess(
        sensitive
          ? `${field.field_name} is now masked from AI models.`
          : `${field.field_name} is now allowed in AI prompts.`,
      );
    } catch (cause) {
      const message = apiErrorMessage(
        cause,
        "Could not update the personal-data field.",
      );
      setActionError(message);
      throw new Error(message);
    } finally {
      savingRef.current = false;
      setSavingField(null);
    }
  }

  return (
    <div className="mt-4 space-y-3">
      {fields.length === 0 ? (
        <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
          No personal-data fields were reported by this workspace.
        </p>
      ) : (
        <ul
          ref={fieldListRef}
          tabIndex={-1}
          className="divide-y rounded-xl border"
          aria-label="Personal data fields"
        >
          {fields.map((field) => {
            const masked = field.built_in || field.sensitive;
            const stateUnknown = !field.built_in && field.sensitive === null;
            const busy = savingField === field.field_name;
            return (
              <li
                key={field.field_name}
                className="flex min-w-0 flex-col gap-3 p-3.5 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="break-all font-mono text-sm font-medium">
                      {field.field_name}
                    </span>
                    {field.built_in ? (
                      <Badge variant="info">Built-in</Badge>
                    ) : null}
                    <Badge
                      variant={
                        stateUnknown
                          ? "warning"
                          : masked
                            ? "success"
                            : "warning"
                      }
                    >
                      {stateUnknown
                        ? "State not reported"
                        : masked
                          ? "Masked"
                          : "Visible to AI"}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {field.built_in
                      ? "Always tokenized; this built-in identifier cannot be exposed."
                      : stateUnknown
                        ? "The server did not report whether this field is masked; no unprotected state is being inferred."
                        : masked
                          ? "Tokenized before its value reaches an AI model."
                          : "Raw values may be included in generated AI prompts."}
                  </p>
                </div>
                {field.built_in ? (
                  <Button type="button" variant="outline" disabled>
                    <EyeOff aria-hidden="true" />
                    Locked masked
                  </Button>
                ) : canWrite ? (
                  masked ? (
                    <ConfirmDialog
                      title={`Allow ${field.field_name} in AI prompts?`}
                      description="This reduces privacy protection: future AI prompts may contain the field's raw value instead of an opaque token."
                      confirmLabel="Allow raw values"
                      onConfirm={() => setSensitive(field, false)}
                      fallbackFocusRef={fieldListRef}
                      trigger={
                        <Button
                          type="button"
                          variant="outline"
                          disabled={savingField !== null}
                          loading={busy}
                        >
                          <Eye aria-hidden="true" />
                          Allow in AI
                        </Button>
                      }
                    />
                  ) : (
                    <Button
                      type="button"
                      disabled={savingField !== null}
                      loading={busy}
                      onClick={() => {
                        void setSensitive(field, true).catch(() => undefined);
                      }}
                    >
                      <EyeOff aria-hidden="true" />
                      Mask from AI
                    </Button>
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {!canWrite ? (
        <p className="text-sm leading-5 text-muted-foreground">
          {writeGateMessage(permissionKnown)}
        </p>
      ) : null}
      {actionError ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm"
        >
          {actionError}
        </p>
      ) : null}
      {success ? (
        <p role="status" className="text-sm text-success-emphasis">
          {success}
        </p>
      ) : null}
      <p className="text-xs leading-5 text-muted-foreground">
        Tokenized-prompt auditing is recorded in server logs; this API exposes
        no client-facing audit toggle.
      </p>
    </div>
  );
}

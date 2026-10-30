// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Per-subscriber data on the drill-down — the sections desktop's slide-over
 * shows beside the profile (parity rows audience-69/70/71/83):
 *
 *   ListMembershipsPanel   the lists this contact is on; add / remove
 *   CustomFieldValuesPanel stored custom-field values; typed edit, classified,
 *                          remove-with-confirm (PATCH custom_fields, If-Match)
 *   MergeFieldValuesPanel  audience (merge) field values; typed edit / clear
 *   CustomObjectLinksPanel custom-object records linked to the profile;
 *                          link, relabel, unlink-with-confirm
 *
 * Every write needs subscriber write authority (editor+, not view-as); a
 * viewer sees the data and the reason the controls are withheld. A server
 * refusal renders the server's own sentence.
 */
import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Link2, Pencil, Plus, Trash2, X } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
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
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage, isApiError } from "@/lib/api";
import { invalidateMembership } from "@/lib/audience-invalidation";
import { listCustomFields, type CustomField } from "@/lib/custom-fields-api";
import {
  listCustomObjectRecords,
  listCustomObjectTypes,
} from "@/lib/custom-objects-api";
import { listAudienceCatalogue } from "@/lib/lists-api";
import { base, qk, STALE } from "@/lib/query-keys";
import {
  reauthorizeSubscriberMutation,
  type SubscriberAuthority,
} from "@/lib/subscriber-authority";
import {
  addSubscriberToList,
  getSubscriberMergeFieldValues,
  linkSubscriberObject,
  listMergeFieldSchema,
  listSubscriberListMemberships,
  listSubscriberObjectLinks,
  MAX_MERGE_FIELD_VALUE_LENGTH,
  MAX_RELATIONSHIP_LENGTH,
  mergeFieldValueProblem,
  patchSubscriberMergeFieldValues,
  removeSubscriberFromList,
  setSubscriberCustomFieldValue,
  unlinkSubscriberObject,
  updateSubscriberObjectLink,
  type CustomFieldStoredValue,
  type MergeFieldDefinition,
  type SubscriberListMembership,
  type SubscriberObjectLink,
} from "@/lib/subscriber-detail-api";
import {
  isExactSubscriberVersion,
  type Subscriber,
} from "@/lib/subscribers-api";

/* ================================ shared ================================= */

const STALE_REVISION = [409, 412, 428];

function PanelError({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis"
    >
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{message}</span>
      {onRetry ? (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

function MutationError({ message }: { message: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (message) ref.current?.focus();
  }, [message]);
  if (!message) return null;
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis [overflow-wrap:anywhere]"
    >
      {message}
    </div>
  );
}

function ReadOnlyReason({ id, children }: { id: string; children: string }) {
  return (
    <p id={id} role="status" className="text-xs text-muted-foreground">
      {children}
    </p>
  );
}

function failureMessage(err: unknown, fallback: string): string {
  return apiErrorMessage(err, fallback);
}

/** The page's own record key (page.tsx derives it the same way). */
function subscriberRecordKey(tenantId: string, role: string | null, id: string) {
  return [...qk.subscriber(tenantId, role, id), "record"] as const;
}

/* ============================ List memberships =========================== */

export function ListMembershipsPanel({
  id,
  email,
  tenantId,
  role,
  authority,
}: {
  id: string;
  email: string;
  tenantId: string;
  role: string | null;
  authority: SubscriberAuthority | null;
}) {
  const queryClient = useQueryClient();
  const reasonId = useId();
  const pickerId = useId();
  const [selected, setSelected] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const addingRef = useRef(false);

  const membershipsKey = useMemo(
    () => [...qk.subscriber(tenantId, role, id), "list-memberships"] as const,
    [id, role, tenantId],
  );
  const memberships = useQuery({
    queryKey: membershipsKey,
    queryFn: ({ signal }) => listSubscriberListMemberships(id, signal),
    staleTime: STALE.detail,
  });
  // The catalogue only feeds the Add picker, so a viewer never loads it.
  const catalogue = useQuery({
    queryKey: qk.lists(tenantId, role, { view: "subscriber-membership-picker" }),
    queryFn: ({ signal }) => listAudienceCatalogue("", signal),
    enabled: authority !== null,
    staleTime: STALE.list,
  });

  useEffect(() => {
    setSelected("");
    setError(null);
    setNotice(null);
  }, [id]);

  const items = useMemo(
    () => (Array.isArray(memberships.data) ? memberships.data : []),
    [memberships.data],
  );
  const catalogueRows = useMemo(
    () => (Array.isArray(catalogue.data) ? catalogue.data : []),
    [catalogue.data],
  );
  const addable = useMemo(() => {
    const memberIds = new Set(items.map((item) => item.id.toLowerCase()));
    const memberNames = new Set(
      items.map((item) => item.name.trim().toLowerCase()),
    );
    return catalogueRows.filter(
      (row) =>
        !(row.postwave_uuid && memberIds.has(row.postwave_uuid)) &&
        !memberNames.has(row.name.trim().toLowerCase()),
    );
  }, [catalogueRows, items]);

  // This profile (its chips, record and timeline) and the list side: the
  // target list's members table and counts.
  const refresh = () =>
    invalidateMembership(queryClient, tenantId, role, { subscriberIds: [id] });

  const add = async () => {
    const row = addable.find((candidate) => String(candidate.id) === selected);
    if (!row || !authority || addingRef.current) return;
    addingRef.current = true;
    setAdding(true);
    setError(null);
    setNotice(null);
    try {
      await reauthorizeSubscriberMutation(authority);
      const receipt = await addSubscriberToList(
        row.postwave_uuid ?? String(row.id),
        id,
      );
      setSelected("");
      await refresh();
      if (receipt.added === 1) {
        toast.success(`Added to ${row.name}.`);
      } else {
        const message = `${row.name} did not add this subscriber: the server skipped them (already a member, or not matched in this workspace).`;
        setNotice(message);
        toast.info(message);
      }
    } catch (err) {
      const message = failureMessage(
        err,
        "Could not add to the list. No membership change was confirmed.",
      );
      setError(message);
      toast.error(message);
    } finally {
      addingRef.current = false;
      setAdding(false);
    }
  };

  const remove = async (membership: SubscriberListMembership) => {
    if (!authority) {
      throw new Error("Viewer access cannot change list memberships.");
    }
    setError(null);
    setNotice(null);
    try {
      await reauthorizeSubscriberMutation(authority);
      await removeSubscriberFromList(membership.id, id);
    } catch (err) {
      const message = failureMessage(
        err,
        "Could not remove from the list. No membership change was confirmed.",
      );
      toast.error(message);
      throw new Error(message);
    }
    await refresh();
    toast.success(`Removed from ${membership.name || "the list"}.`);
  };

  return (
    <section aria-labelledby={`${pickerId}-heading`} className="space-y-3">
      <h3 id={`${pickerId}-heading`} className="text-sm font-medium">
        Lists
      </h3>
      {memberships.isLoading ? (
        <Skeleton className="h-6 w-48" />
      ) : memberships.error ? (
        <PanelError
          message={failureMessage(
            memberships.error,
            "Could not load list memberships.",
          )}
          onRetry={() => void memberships.refetch()}
        />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Not a member of any list.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-1.5" aria-label="List memberships">
          {items.map((membership) => {
            const name = membership.name || "Unnamed list";
            return (
              <li
                key={membership.id}
                data-testid="subscriber-list-membership"
                className="inline-flex items-center gap-1 rounded-full border bg-card px-2.5 py-0.5 text-xs"
              >
                <span>{name}</span>
                {authority ? (
                  <ConfirmDialog
                    trigger={
                      <button
                        type="button"
                        aria-label={`Remove from ${name}`}
                        disabled={adding}
                        className="text-muted-foreground hover:text-destructive disabled:opacity-50"
                      >
                        <X className="h-3 w-3" aria-hidden="true" />
                      </button>
                    }
                    title={`Remove from ${name}?`}
                    description={`${email} stops receiving campaigns sent to ${name}. Their subscriber record, consent and other list memberships are unchanged, and you can add them back later.`}
                    confirmLabel="Remove from list"
                    onConfirm={() => remove(membership)}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {authority ? (
        <div className="space-y-2">
          {catalogue.isLoading ? (
            <p role="status" className="text-xs text-muted-foreground">
              Loading lists…
            </p>
          ) : catalogue.error ? (
            <PanelError
              message={failureMessage(
                catalogue.error,
                "Could not load the lists to add to.",
              )}
              onRetry={() => void catalogue.refetch()}
            />
          ) : addable.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {catalogueRows.length === 0
                ? "No lists exist yet."
                : "This subscriber is already on every list."}
            </p>
          ) : (
            <div className="flex max-w-md flex-col gap-2 sm:flex-row sm:items-end">
              <div className="grid flex-1 gap-1.5">
                <Label htmlFor={pickerId}>Add to list</Label>
                <Select
                  id={pickerId}
                  value={selected}
                  disabled={adding}
                  onChange={(event) => setSelected(event.target.value)}
                >
                  <option value="">Choose a list…</option>
                  {addable.map((row) => (
                    <option key={row.id} value={String(row.id)}>
                      {row.name}
                    </option>
                  ))}
                </Select>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!selected || adding}
                onClick={() => void add()}
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                {adding ? "Adding…" : "Add"}
              </Button>
            </div>
          )}
        </div>
      ) : (
        <ReadOnlyReason id={reasonId}>
          Viewer access can inspect list memberships but cannot add or remove
          them.
        </ReadOnlyReason>
      )}
      {notice ? (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      ) : null}
      <MutationError message={error} />
    </section>
  );
}

/* ========================== Custom-field values ========================== */

const CLASSIFICATION_BADGES: Record<
  string,
  {
    label: string;
    variant: "destructive" | "warning" | "info" | "outline";
    tip: string;
  }
> = {
  pii: {
    label: "PII",
    variant: "destructive",
    tip: "Personally identifiable information — masking / export policy applies",
  },
  phi: {
    label: "PHI",
    variant: "warning",
    tip: "Protected health information — heightened handling policy applies",
  },
  pci: {
    label: "PCI",
    variant: "warning",
    tip: "Payment-card data — PCI-DSS handling policy applies",
  },
  sensitive: {
    label: "Sensitive",
    variant: "info",
    tip: "Sensitive attribute — restricted handling policy applies",
  },
  business: {
    label: "Business",
    variant: "outline",
    tip: "Business attribute — non-personal data",
  },
};

function classificationOf(definition: CustomField | undefined) {
  const raw = definition?.config?.data_classification?.trim().toLowerCase();
  if (raw && CLASSIFICATION_BADGES[raw]) return raw;
  return definition?.config?.pii_flag ? "pii" : null;
}

/** An enum field's allowed values; anything but a string array is none. */
function enumOptions(definition: CustomField | undefined): string[] {
  const options = definition?.config?.options;
  return Array.isArray(options)
    ? options.filter((option): option is string => typeof option === "string")
    : [];
}

/** Runtime field type — the server knows more than the web type union. */
function fieldType(definition: CustomField | undefined): string {
  return typeof definition?.type === "string" ? definition.type : "string";
}

const EDITABLE_TYPES = new Set([
  "string",
  "number",
  "boolean",
  "date",
  "enum",
  "email",
  "url",
  "phone",
  "region",
]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/\S+$/i;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isCalendarDate(value: string): boolean {
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const at = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  return (
    at.getUTCFullYear() === Number(match[1]) &&
    at.getUTCMonth() === Number(match[2]) - 1 &&
    at.getUTCDate() === Number(match[3])
  );
}

function displayCustomFieldValue(
  definition: CustomField | undefined,
  value: unknown,
): string {
  if (value === null || value === undefined || value === "") return "Not set";
  if (fieldType(definition) === "boolean" || typeof value === "boolean") {
    return value === true || value === "true" ? "True" : "False";
  }
  if (typeof value === "object") {
    try {
      const text = JSON.stringify(value);
      return text.length > 240 ? `${text.slice(0, 240)}…` : text;
    } catch {
      return "Structured value unavailable";
    }
  }
  const text = String(value);
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

function formatProblem(
  definition: CustomField | undefined,
  value: unknown,
): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const type = fieldType(definition);
  if (type === "email" && !EMAIL_RE.test(value.trim())) {
    return "Doesn't look like an email address";
  }
  if (type === "url" && !URL_RE.test(value.trim())) {
    return "Doesn't look like an http(s) URL";
  }
  if (type === "enum") {
    const options = enumOptions(definition);
    if (options.length > 0 && !options.includes(value)) {
      return "Not one of the allowed values";
    }
  }
  return null;
}

/** The typed value to store for an edited box, or the reason it can't be. */
export function customFieldInputValue(
  definition: CustomField,
  raw: string,
): { value: CustomFieldStoredValue } | { error: string } {
  const text = raw.trim();
  if (!text) {
    return { error: "Enter a value, or use Remove to clear this field." };
  }
  switch (fieldType(definition)) {
    case "number": {
      const parsed = Number(text);
      return Number.isFinite(parsed)
        ? { value: parsed }
        : { error: `${definition.label} must be a number.` };
    }
    case "boolean":
      return text === "true" || text === "false"
        ? { value: text === "true" }
        : { error: `${definition.label} must be true or false.` };
    case "date":
      return isCalendarDate(text)
        ? { value: text }
        : { error: `${definition.label} must be a date (YYYY-MM-DD).` };
    case "enum": {
      const options = enumOptions(definition);
      return options.length === 0 || options.includes(text)
        ? { value: text }
        : { error: `${definition.label} must be one of the allowed values.` };
    }
    case "email":
      return EMAIL_RE.test(text)
        ? { value: text }
        : { error: `${definition.label} must be a valid email address.` };
    case "url":
      return URL_RE.test(text)
        ? { value: text }
        : { error: `${definition.label} must be an http(s) URL.` };
    default:
      return { value: text };
  }
}

function draftOf(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return "";
  return String(value);
}

function TypedCustomFieldInput({
  definition,
  id,
  value,
  disabled,
  onChange,
}: {
  definition: CustomField;
  id: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const type = fieldType(definition);
  if (type === "boolean") {
    return (
      <Select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Choose…</option>
        <option value="true">True</option>
        <option value="false">False</option>
      </Select>
    );
  }
  const options = enumOptions(definition);
  if (type === "enum" && options.length > 0) {
    return (
      <Select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Choose…</option>
        {value && !options.includes(value) ? (
          <option value={value}>{`Current (not allowed): ${value}`}</option>
        ) : null}
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </Select>
    );
  }
  const inputType =
    type === "number"
      ? "number"
      : type === "date"
        ? "date"
        : type === "email"
          ? "email"
          : type === "url"
            ? "url"
            : type === "phone"
              ? "tel"
              : "text";
  return (
    <Input
      id={id}
      type={inputType}
      step={type === "number" ? "any" : undefined}
      value={value}
      disabled={disabled}
      maxLength={inputType === "number" || inputType === "date" ? undefined : 1024}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function CustomFieldValuesPanel({
  id,
  record,
  email,
  tenantId,
  role,
  authority,
  onRecordRefetch,
}: {
  /** The route id — the page keys its record query by it. */
  id: string;
  record: Subscriber | undefined;
  email: string;
  tenantId: string;
  role: string | null;
  authority: SubscriberAuthority | null;
  onRecordRefetch: () => void;
}) {
  const queryClient = useQueryClient();
  const reasonId = useId();
  const fieldPrefix = useId();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);

  const definitions = useQuery({
    queryKey: base("custom-fields", tenantId, role),
    queryFn: ({ signal }) => listCustomFields(signal),
    staleTime: STALE.list,
  });

  const subscriberId = record?.id ?? null;
  useEffect(() => {
    setEditing(null);
    setDraft("");
    setError(null);
  }, [subscriberId]);

  if (!record || !subscriberId) {
    return (
      <p className="text-sm text-muted-foreground">
        The subscriber record must load before custom fields can be shown.
      </p>
    );
  }

  const byKey = new Map<string, CustomField>(
    (Array.isArray(definitions.data) ? definitions.data : []).map(
      (definition) => [definition.key, definition],
    ),
  );
  const stored = record.custom_fields ?? {};
  // Every defined field (so an empty one can be set) plus any ad-hoc key an
  // import or the API stored without a definition.
  const keys = [
    ...byKey.keys(),
    ...Object.keys(stored).filter((key) => !byKey.has(key)),
  ];
  const versionReady = isExactSubscriberVersion(record.version, subscriberId);
  const blockedReason =
    authority === null
      ? "Viewer access can inspect custom fields but cannot change them."
      : !versionReady
        ? "Reload this subscriber to obtain the latest revision before changing custom fields."
        : null;

  const fail = (err: unknown, fallback: string): string => {
    if (isApiError(err) && STALE_REVISION.includes(err.status)) {
      onRecordRefetch();
      return "This subscriber changed while you were reviewing it. The profile was reloaded; review the current value and try again.";
    }
    return failureMessage(err, fallback);
  };

  const commit = async (
    key: string,
    value: CustomFieldStoredValue,
  ): Promise<void> => {
    if (!authority) throw new Error("Viewer access cannot change custom fields.");
    await reauthorizeSubscriberMutation(authority);
    const updated = await setSubscriberCustomFieldValue(record, key, value);
    queryClient.setQueryData(subscriberRecordKey(tenantId, role, id), updated);
    onRecordRefetch();
  };

  const save = async (definition: CustomField) => {
    if (savingRef.current || blockedReason) return;
    const parsed = customFieldInputValue(definition, draft);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await commit(definition.key, parsed.value);
      setEditing(null);
      toast.success(`${definition.label || definition.key} updated.`);
    } catch (err) {
      const message = fail(
        err,
        "The custom field could not be saved. The stored value is unchanged.",
      );
      setError(message);
      toast.error(message);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const remove = async (key: string, label: string) => {
    setError(null);
    try {
      await commit(key, null);
    } catch (err) {
      const message = fail(
        err,
        "The value could not be removed. The stored value is unchanged.",
      );
      toast.error(message);
      throw new Error(message);
    }
    if (editing === key) setEditing(null);
    toast.success(`Removed ${label}.`);
  };

  return (
    <section aria-labelledby={`${fieldPrefix}-heading`} className="space-y-3">
      <div>
        <h3 id={`${fieldPrefix}-heading`} className="text-sm font-medium">
          Custom fields
        </h3>
        <p className="text-xs text-muted-foreground">
          Values are checked against each field&apos;s type when saved.
          Classified fields carry the masking and export policy shown on their
          badge.
        </p>
      </div>
      {definitions.error ? (
        <PanelError
          message={failureMessage(
            definitions.error,
            "Could not load custom-field definitions; values are shown without their types.",
          )}
          onRetry={() => void definitions.refetch()}
        />
      ) : null}
      {definitions.isLoading ? (
        <Skeleton className="h-10 w-full" />
      ) : keys.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No custom fields are defined and none are stored for this subscriber.
        </p>
      ) : (
        <ul className="divide-y rounded-md border bg-card">
          {keys.map((key) => {
            const definition = byKey.get(key);
            const label = definition?.label || key;
            const value = stored[key];
            const hasValue = Object.hasOwn(stored, key) && value !== null;
            const classification = classificationOf(definition);
            const badge = classification
              ? CLASSIFICATION_BADGES[classification]
              : null;
            const problem = formatProblem(definition, value);
            const type = fieldType(definition);
            const editable =
              definition !== undefined &&
              EDITABLE_TYPES.has(type) &&
              (value === null ||
                value === undefined ||
                typeof value !== "object");
            const inputId = `${fieldPrefix}-${key}`;
            const isEditing = editing === key;
            return (
              <li
                key={key}
                data-testid="subscriber-custom-field"
                className="space-y-2 p-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5 text-sm">
                      <span className="font-medium">{label}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {key}
                      </span>
                      <Badge variant="outline">
                        {definition ? type : "undefined field"}
                      </Badge>
                      {badge ? (
                        <Badge
                          variant={badge.variant}
                          title={badge.tip}
                          aria-label={`Data classification: ${badge.label}`}
                        >
                          {badge.label}
                        </Badge>
                      ) : null}
                    </div>
                    {!isEditing ? (
                      <p
                        className={
                          hasValue
                            ? "text-sm [overflow-wrap:anywhere]"
                            : "text-sm text-muted-foreground"
                        }
                      >
                        {displayCustomFieldValue(definition, value)}
                      </p>
                    ) : null}
                    {problem && !isEditing ? (
                      <p className="text-xs text-warning-emphasis">
                        {problem}
                      </p>
                    ) : null}
                  </div>
                  {authority && !isEditing ? (
                    <div className="flex shrink-0 gap-1">
                      {editable ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={saving || blockedReason !== null}
                          aria-describedby={
                            blockedReason ? reasonId : undefined
                          }
                          aria-label={`Edit ${label}`}
                          onClick={() => {
                            setEditing(key);
                            setDraft(draftOf(value));
                            setError(null);
                          }}
                        >
                          <Pencil className="h-4 w-4" aria-hidden="true" />
                          Edit
                        </Button>
                      ) : null}
                      {hasValue ? (
                        <ConfirmDialog
                          trigger={
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={saving || blockedReason !== null}
                              aria-describedby={
                                blockedReason ? reasonId : undefined
                              }
                              aria-label={`Remove ${label}`}
                            >
                              <Trash2 className="h-4 w-4" aria-hidden="true" />
                              Remove
                            </Button>
                          }
                          title={`Remove ${label}?`}
                          description={`This deletes the stored ${definition ? type : "custom"} value${badge ? ` classified as ${badge.label}` : ""} from ${email}. Segments, personalization and exports that read ${key} will see it as empty. Attribute history keeps the old value for audit.`}
                          confirmLabel="Remove value"
                          onConfirm={() => remove(key, label)}
                        />
                      ) : null}
                    </div>
                  ) : null}
                </div>
                {isEditing && definition ? (
                  <form
                    className="flex flex-col gap-2 sm:flex-row sm:items-end"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void save(definition);
                    }}
                  >
                    <div className="grid flex-1 gap-1.5">
                      <Label htmlFor={inputId}>{label}</Label>
                      <TypedCustomFieldInput
                        definition={definition}
                        id={inputId}
                        value={draft}
                        disabled={saving}
                        onChange={(next) => {
                          setDraft(next);
                          if (error) setError(null);
                        }}
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button type="submit" size="sm" disabled={saving}>
                        {saving ? "Saving…" : "Save"}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={saving}
                        onClick={() => {
                          setEditing(null);
                          setError(null);
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {blockedReason ? (
        <ReadOnlyReason id={reasonId}>{blockedReason}</ReadOnlyReason>
      ) : null}
      <MutationError message={error} />
    </section>
  );
}

/* ============================== Merge fields ============================= */

function MergeFieldInput({
  definition,
  id,
  value,
  disabled,
  invalid,
  onChange,
}: {
  definition: MergeFieldDefinition;
  id: string;
  value: string;
  disabled: boolean;
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  if (definition.type === "boolean") {
    return (
      <Select
        id={id}
        value={value}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Not set</option>
        {value && value !== "true" && value !== "false" ? (
          <option value={value}>{`Unsupported value: ${value}`}</option>
        ) : null}
        <option value="true">True</option>
        <option value="false">False</option>
      </Select>
    );
  }
  const inputType =
    definition.type === "number"
      ? "number"
      : definition.type === "date"
        ? "date"
        : definition.type === "phone"
          ? "tel"
          : "text";
  return (
    <Input
      id={id}
      type={inputType}
      step={inputType === "number" ? "any" : undefined}
      value={value}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      maxLength={
        inputType === "text" || inputType === "tel"
          ? MAX_MERGE_FIELD_VALUE_LENGTH
          : undefined
      }
      placeholder={definition.default_value || undefined}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function MergeFieldValuesPanel({
  id,
  tenantId,
  role,
  authority,
}: {
  id: string;
  tenantId: string;
  role: string | null;
  authority: SubscriberAuthority | null;
}) {
  const queryClient = useQueryClient();
  const reasonId = useId();
  const fieldPrefix = useId();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);

  const valuesKey = useMemo(
    () => [...qk.subscriber(tenantId, role, id), "merge-fields"] as const,
    [id, role, tenantId],
  );
  const schema = useQuery({
    queryKey: base("merge-field-schema", tenantId, role),
    queryFn: ({ signal }) => listMergeFieldSchema(signal),
    staleTime: STALE.list,
  });
  const values = useQuery({
    queryKey: valuesKey,
    queryFn: ({ signal }) => getSubscriberMergeFieldValues(id, signal),
    staleTime: STALE.detail,
  });

  useEffect(() => {
    setDrafts({});
    setError(null);
  }, [id]);

  const patch = async (
    definition: MergeFieldDefinition,
    next: string,
  ): Promise<void> => {
    if (!authority) {
      throw new Error("Viewer access cannot change audience fields.");
    }
    await reauthorizeSubscriberMutation(authority);
    const result = await patchSubscriberMergeFieldValues(id, {
      [definition.key]: next,
    });
    queryClient.setQueryData(valuesKey, result);
    setDrafts((current) => {
      const copy = { ...current };
      delete copy[definition.key];
      return copy;
    });
  };

  const save = async (definition: MergeFieldDefinition, next: string) => {
    if (savingRef.current) return;
    const problem = mergeFieldValueProblem(definition, next);
    if (problem) {
      setError(problem);
      return;
    }
    savingRef.current = true;
    setSaving(definition.key);
    setError(null);
    try {
      await patch(definition, next.trim());
      toast.success(`${definition.label || definition.key} updated.`);
    } catch (err) {
      const message = failureMessage(
        err,
        "The audience field could not be saved. The stored value is unchanged.",
      );
      setError(message);
      toast.error(message);
    } finally {
      savingRef.current = false;
      setSaving(null);
    }
  };

  const clear = async (definition: MergeFieldDefinition) => {
    setError(null);
    try {
      await patch(definition, "");
    } catch (err) {
      const message = failureMessage(
        err,
        "The audience field could not be cleared. The stored value is unchanged.",
      );
      toast.error(message);
      throw new Error(message);
    }
    toast.success(`${definition.label || definition.key} cleared.`);
  };

  const schemaRows = Array.isArray(schema.data) ? schema.data : [];
  const loadError = schema.error ?? values.error;
  return (
    <section aria-labelledby={`${fieldPrefix}-heading`} className="space-y-3">
      <div>
        <h3 id={`${fieldPrefix}-heading`} className="text-sm font-medium">
          Audience (merge) fields
        </h3>
        <p className="text-xs text-muted-foreground">
          The values personalization tags like *|FNAME|* render for this
          subscriber. An empty field falls back to its default.
        </p>
      </div>
      {schema.isLoading || values.isLoading ? (
        <Skeleton className="h-10 w-full" />
      ) : loadError ? (
        <PanelError
          message={failureMessage(loadError, "Could not load audience fields.")}
          onRetry={() => {
            void schema.refetch();
            void values.refetch();
          }}
        />
      ) : schemaRows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No audience fields are defined for this workspace.
        </p>
      ) : (
        <ul className="divide-y rounded-md border bg-card">
          {schemaRows.map((definition) => {
            const current = values.data?.values[definition.key] ?? "";
            const draft = drafts[definition.key] ?? current;
            const dirty = draft.trim() !== current;
            const problem = dirty
              ? mergeFieldValueProblem(definition, draft)
              : null;
            const inputId = `${fieldPrefix}-${definition.key}`;
            const busy = saving === definition.key;
            const clearable =
              current !== "" &&
              current !== definition.default_value &&
              !definition.required;
            return (
              <li
                key={definition.key}
                data-testid="subscriber-merge-field"
                className="space-y-2 p-3"
              >
                <div className="flex flex-wrap items-center gap-1.5 text-sm">
                  <Label htmlFor={inputId} className="font-medium">
                    {definition.label || definition.key}
                  </Label>
                  <span className="font-mono text-xs text-muted-foreground">
                    {`*|${definition.key}|*`}
                  </span>
                  <Badge variant="outline">{definition.type}</Badge>
                  {definition.required ? (
                    <Badge variant="secondary">Required</Badge>
                  ) : null}
                </div>
                <form
                  className="flex flex-col gap-2 sm:flex-row sm:items-start"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (dirty) void save(definition, draft);
                  }}
                >
                  <div className="flex-1">
                    <MergeFieldInput
                      definition={definition}
                      id={inputId}
                      value={draft}
                      disabled={!authority || saving !== null}
                      invalid={problem !== null}
                      onChange={(next) =>
                        setDrafts((existing) => ({
                          ...existing,
                          [definition.key]: next,
                        }))
                      }
                    />
                    {problem ? (
                      <p className="mt-1 text-xs text-destructive-emphasis">
                        {problem}
                      </p>
                    ) : null}
                  </div>
                  {authority ? (
                    <div className="flex gap-2">
                      <Button
                        type="submit"
                        size="sm"
                        variant="outline"
                        disabled={!dirty || problem !== null || saving !== null}
                        aria-label={`Save ${definition.label || definition.key}`}
                      >
                        {busy ? "Saving…" : "Save"}
                      </Button>
                      {clearable ? (
                        <ConfirmDialog
                          trigger={
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              disabled={saving !== null}
                              aria-label={`Clear ${definition.label || definition.key}`}
                            >
                              Clear
                            </Button>
                          }
                          title={`Clear ${definition.label || definition.key}?`}
                          description={
                            definition.default_value
                              ? `The stored value "${current}" is removed; *|${definition.key}|* renders the default "${definition.default_value}" for this subscriber from now on.`
                              : `The stored value "${current}" is removed; *|${definition.key}|* renders empty for this subscriber from now on.`
                          }
                          confirmLabel="Clear value"
                          onConfirm={() => clear(definition)}
                        />
                      ) : null}
                    </div>
                  ) : null}
                </form>
              </li>
            );
          })}
        </ul>
      )}
      {!authority ? (
        <ReadOnlyReason id={reasonId}>
          Viewer access can inspect audience fields but cannot change them.
        </ReadOnlyReason>
      ) : null}
      <MutationError message={error} />
    </section>
  );
}

/* ========================== Custom-object links ========================== */

function propertyPreview(
  properties: Record<string, unknown> | undefined,
): Array<[string, string]> {
  if (!properties) return [];
  return Object.entries(properties)
    .slice(0, 6)
    .map(([key, value]) => {
      let text: string;
      if (value === null || value === undefined) text = "—";
      else if (typeof value === "object") {
        try {
          text = JSON.stringify(value);
        } catch {
          text = "Value could not be displayed";
        }
      } else text = String(value);
      return [key, text.length > 120 ? `${text.slice(0, 120)}…` : text];
    });
}

function linkName(link: SubscriberObjectLink): string {
  return link.externalId || link.objectRecordId;
}

export function CustomObjectLinksPanel({
  id,
  email,
  tenantId,
  role,
  authority,
}: {
  id: string;
  email: string;
  tenantId: string;
  role: string | null;
  authority: SubscriberAuthority | null;
}) {
  const queryClient = useQueryClient();
  const reasonId = useId();
  const headingId = useId();
  const relationshipId = useId();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [relationship, setRelationship] = useState("");
  const [saving, setSaving] = useState(false);
  const [linkerOpen, setLinkerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);

  const linksKey = useMemo(
    () =>
      [...qk.subscriber(tenantId, role, id), "custom-object-links"] as const,
    [id, role, tenantId],
  );
  const links = useQuery({
    queryKey: linksKey,
    queryFn: ({ signal }) => listSubscriberObjectLinks(id, signal),
    staleTime: STALE.detail,
  });

  useEffect(() => {
    setEditingId(null);
    setLinkerOpen(false);
    setError(null);
  }, [id]);

  const grouped = useMemo(() => {
    const map = new Map<
      string,
      { label: string; rows: SubscriberObjectLink[] }
    >();
    for (const link of Array.isArray(links.data) ? links.data : []) {
      const key = link.objectTypeId || link.objectTypeKey || "unknown";
      const existing = map.get(key);
      if (existing) existing.rows.push(link);
      else
        map.set(key, {
          label: link.objectTypeLabel || link.objectTypeKey || "Custom object",
          rows: [link],
        });
    }
    return Array.from(map.entries());
  }, [links.data]);

  const saveRelationship = async (link: SubscriberObjectLink) => {
    if (!authority || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await reauthorizeSubscriberMutation(authority);
      await updateSubscriberObjectLink(id, link.id, { relationship });
      setEditingId(null);
      await queryClient.invalidateQueries({ queryKey: linksKey });
      toast.success("Relationship updated.");
    } catch (err) {
      const message = failureMessage(
        err,
        "The relationship could not be updated. The link is unchanged.",
      );
      setError(message);
      toast.error(message);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const unlink = async (link: SubscriberObjectLink) => {
    if (!authority) {
      throw new Error("Viewer access cannot unlink custom-object records.");
    }
    setError(null);
    try {
      await reauthorizeSubscriberMutation(authority);
      await unlinkSubscriberObject(id, link.id);
    } catch (err) {
      const message = failureMessage(
        err,
        "The record could not be unlinked. The link is unchanged.",
      );
      toast.error(message);
      throw new Error(message);
    }
    if (editingId === link.id) setEditingId(null);
    await queryClient.invalidateQueries({ queryKey: linksKey });
    toast.success(`Unlinked ${linkName(link)}.`);
  };

  const unavailable = isApiError(links.error) && links.error.status === 404;

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 id={headingId} className="text-sm font-medium">
            Custom objects
          </h3>
          <p className="text-xs text-muted-foreground">
            Records linked to this profile. Templates read them through{" "}
            <span className="font-mono">custom_objects</span>.{" "}
            <Link
              href="/app/custom-objects"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Manage custom objects
            </Link>
          </p>
        </div>
        {authority && !unavailable ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving}
            aria-haspopup="dialog"
            onClick={() => setLinkerOpen(true)}
          >
            <Link2 className="h-4 w-4" aria-hidden="true" />
            Link a record
          </Button>
        ) : null}
      </div>

      {links.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : unavailable ? (
        <p className="text-sm text-muted-foreground">
          Custom-object links are not available on this deployment.
        </p>
      ) : links.error ? (
        <PanelError
          message={failureMessage(
            links.error,
            "Could not load linked custom-object records.",
          )}
          onRetry={() => void links.refetch()}
        />
      ) : grouped.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No custom-object records are linked to this subscriber.
        </p>
      ) : (
        <div className="space-y-4">
          {grouped.map(([typeKey, group]) => (
            <div key={typeKey} className="space-y-2">
              <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {group.label} ({group.rows.length})
              </h4>
              <ul className="space-y-2">
                {group.rows.map((link) => {
                  const name = linkName(link);
                  const editing = editingId === link.id;
                  const properties = propertyPreview(link.properties);
                  return (
                    <li
                      key={link.id}
                      data-testid="subscriber-custom-object-link"
                      className="space-y-2 rounded-md border bg-card p-3 text-sm"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="font-medium [overflow-wrap:anywhere]">
                            {name}
                          </span>
                          <Badge variant="secondary">
                            {link.relationship || "related"}
                          </Badge>
                        </div>
                        {authority && !editing ? (
                          <div className="flex shrink-0 gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={saving}
                              aria-label={`Edit relationship for ${name}`}
                              onClick={() => {
                                setEditingId(link.id);
                                setRelationship(link.relationship || "");
                                setError(null);
                              }}
                            >
                              <Pencil className="h-4 w-4" aria-hidden="true" />
                              Edit
                            </Button>
                            <ConfirmDialog
                              trigger={
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  disabled={saving}
                                  aria-label={`Unlink ${name}`}
                                >
                                  <Trash2
                                    className="h-4 w-4"
                                    aria-hidden="true"
                                  />
                                  Unlink
                                </Button>
                              }
                              title={`Unlink ${name}?`}
                              description={`Removes the "${link.relationship || "related"}" link between ${email} and this ${group.label} record. Templates stop seeing it for this subscriber. The record itself is not deleted.`}
                              confirmLabel="Unlink record"
                              onConfirm={() => unlink(link)}
                            />
                          </div>
                        ) : null}
                      </div>
                      {editing ? (
                        <form
                          className="flex flex-col gap-2 sm:flex-row sm:items-end"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void saveRelationship(link);
                          }}
                        >
                          <div className="grid flex-1 gap-1.5">
                            <Label htmlFor={`${relationshipId}-${link.id}`}>
                              Relationship label
                            </Label>
                            <Input
                              id={`${relationshipId}-${link.id}`}
                              value={relationship}
                              placeholder="related"
                              maxLength={MAX_RELATIONSHIP_LENGTH}
                              disabled={saving}
                              onChange={(event) =>
                                setRelationship(event.target.value)
                              }
                            />
                          </div>
                          <div className="flex gap-2">
                            <Button type="submit" size="sm" disabled={saving}>
                              {saving ? "Saving…" : "Save"}
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={saving}
                              onClick={() => setEditingId(null)}
                            >
                              Cancel
                            </Button>
                          </div>
                        </form>
                      ) : properties.length > 0 ? (
                        <dl className="grid grid-cols-1 gap-x-3 gap-y-1 text-xs sm:grid-cols-2">
                          {properties.map(([key, value]) => (
                            <div key={key} className="min-w-0">
                              <dt className="text-muted-foreground [overflow-wrap:anywhere]">
                                {key}
                              </dt>
                              <dd className="font-mono [overflow-wrap:anywhere]">
                                {value}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
      {!authority ? (
        <ReadOnlyReason id={reasonId}>
          Viewer access can inspect linked records but cannot link, relabel, or
          unlink them.
        </ReadOnlyReason>
      ) : null}
      <MutationError message={error} />
      {linkerOpen && authority ? (
        <LinkRecordDialog
          subscriberId={id}
          tenantId={tenantId}
          role={role}
          authority={authority}
          onOpenChange={setLinkerOpen}
          onLinked={async () => {
            setLinkerOpen(false);
            await queryClient.invalidateQueries({ queryKey: linksKey });
          }}
        />
      ) : null}
    </section>
  );
}

function LinkRecordDialog({
  subscriberId,
  tenantId,
  role,
  authority,
  onOpenChange,
  onLinked,
}: {
  subscriberId: string;
  tenantId: string;
  role: string | null;
  authority: SubscriberAuthority;
  onOpenChange: (open: boolean) => void;
  onLinked: () => Promise<void>;
}) {
  const fieldPrefix = useId();
  const [typeId, setTypeId] = useState("");
  const [recordId, setRecordId] = useState("");
  const [relationship, setRelationship] = useState("related");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  const types = useQuery({
    queryKey: base("custom-object-types", tenantId, role),
    queryFn: ({ signal }) =>
      listCustomObjectTypes({ tenantId: authority.tenantId, signal }),
    staleTime: STALE.list,
  });
  const records = useQuery({
    queryKey: [...base("custom-object-records", tenantId, role), typeId],
    queryFn: ({ signal }) =>
      listCustomObjectRecords({
        tenantId: authority.tenantId,
        typeId,
        limit: 100,
        signal,
      }),
    enabled: typeId !== "",
    staleTime: STALE.list,
  });

  const typeRows = useMemo(
    () => (Array.isArray(types.data) ? types.data : []),
    [types.data],
  );
  const recordRows = useMemo(
    () =>
      Array.isArray(records.data?.items) ? records.data.items : [],
    [records.data],
  );
  useEffect(() => {
    if (!typeId && typeRows[0]) setTypeId(typeRows[0].id);
  }, [typeId, typeRows]);
  useEffect(() => {
    setRecordId(recordRows[0]?.id ?? "");
  }, [recordRows]);

  const submit = async () => {
    if (!recordId || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await reauthorizeSubscriberMutation(authority);
      const link = await linkSubscriberObject(subscriberId, {
        objectRecordId: recordId,
        relationship,
      });
      toast.success(`Linked ${link.externalId || "the record"}.`);
      await onLinked();
    } catch (err) {
      const message = failureMessage(
        err,
        "The record could not be linked. No link was created.",
      );
      setError(message);
      toast.error(message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && busyRef.current) return;
        onOpenChange(next);
      }}
    >
      <DialogContent aria-busy={busy} className="max-w-md">
        <DialogHeader>
          <DialogTitle>Link a record</DialogTitle>
          <DialogDescription>
            Linking creates a relationship between this subscriber and a
            custom-object record. It does not modify or copy the record.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {types.isLoading ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading object types…
            </p>
          ) : types.error ? (
            <PanelError
              message={failureMessage(
                types.error,
                "Could not load custom-object types.",
              )}
              onRetry={() => void types.refetch()}
            />
          ) : typeRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No custom-object types are defined yet.{" "}
              <Link
                href="/app/custom-objects"
                className="underline underline-offset-2"
              >
                Create one in Custom objects
              </Link>
              .
            </p>
          ) : (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor={`${fieldPrefix}-type`}>Object type</Label>
                <Select
                  id={`${fieldPrefix}-type`}
                  value={typeId}
                  disabled={busy}
                  onChange={(event) => {
                    setTypeId(event.target.value);
                    setRecordId("");
                  }}
                >
                  {typeRows.map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${fieldPrefix}-record`}>Record</Label>
                {records.error ? (
                  <PanelError
                    message={failureMessage(
                      records.error,
                      "Could not load records for this type.",
                    )}
                    onRetry={() => void records.refetch()}
                  />
                ) : (
                  <Select
                    id={`${fieldPrefix}-record`}
                    value={recordId}
                    disabled={busy || recordRows.length === 0}
                    onChange={(event) => setRecordId(event.target.value)}
                  >
                    {records.isLoading ? (
                      <option value="">Loading…</option>
                    ) : recordRows.length === 0 ? (
                      <option value="">No records for this type</option>
                    ) : (
                      recordRows.map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.externalId || row.id}
                        </option>
                      ))
                    )}
                  </Select>
                )}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${fieldPrefix}-relationship`}>
                  Relationship
                </Label>
                <Input
                  id={`${fieldPrefix}-relationship`}
                  value={relationship}
                  placeholder="related"
                  maxLength={MAX_RELATIONSHIP_LENGTH}
                  disabled={busy}
                  onChange={(event) => setRelationship(event.target.value)}
                />
              </div>
            </>
          )}
          <MutationError message={error} />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy || !recordId}>
              {busy ? "Linking…" : "Link record"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

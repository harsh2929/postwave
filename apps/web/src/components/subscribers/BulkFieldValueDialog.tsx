// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { PenLine } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { apiErrorMessage } from "@/lib/api";
import { listCustomFields, type CustomField } from "@/lib/custom-fields-api";
import { STALE } from "@/lib/query-keys";
import {
  reauthorizeSubscriberMutation,
  type SubscriberAuthority,
} from "@/lib/subscriber-authority";
import {
  BULK_MERGE_FIELDS,
  bulkSetCustomFieldValue,
  bulkUpdateMergeFieldValue,
  type BulkFieldValue,
  type BulkMergeFieldKey,
  type DirectoryBulkResult,
} from "@/lib/subscriber-directory-api";

import { useDirectoryIdentity } from "./directory-context";

type FieldKind = "string" | "number" | "boolean" | "date" | "enum" | "unsupported";

function kindOf(field: CustomField | undefined): FieldKind {
  const type = String(field?.type ?? "string");
  if (type === "number" || type === "boolean" || type === "date") return type;
  if (type === "enum") return "enum";
  if (type === "array" || type === "object") return "unsupported";
  return "string";
}

/** Coerce the typed input to the JSON value the field's type stores. */
export function coerceBulkValue(
  kind: FieldKind,
  raw: string,
): { ok: true; value: BulkFieldValue } | { ok: false; message: string } {
  const trimmed = raw.trim();
  switch (kind) {
    case "number": {
      const value = Number(trimmed);
      return trimmed && Number.isFinite(value)
        ? { ok: true, value }
        : { ok: false, message: "Enter a number." };
    }
    case "boolean":
      return trimmed === "true" || trimmed === "false"
        ? { ok: true, value: trimmed === "true" }
        : { ok: false, message: "Choose true or false." };
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) && Number.isFinite(Date.parse(trimmed))
        ? { ok: true, value: trimmed }
        : { ok: false, message: "Enter a date (YYYY-MM-DD)." };
    case "unsupported":
      return { ok: false, message: "List and object fields are set per subscriber, not in bulk." };
    default:
      return trimmed
        ? { ok: true, value: trimmed }
        : { ok: false, message: "Enter a value." };
  }
}

/**
 * Set ONE custom field (or merge field) to one value on every selected
 * subscriber. The request carries only `{subscriber_ids, key, value}`; the
 * server merges that single key into each row, so no other field on any row is
 * touched — unlike a profile PATCH, whose `custom_fields` map is a full replace.
 */
export function BulkFieldValueDialog({
  mode,
  count,
  resolveIds,
  canAdmin,
  authority,
  onDone,
}: {
  mode: "custom" | "merge";
  /** Number of subscribers the action will target (for the copy). */
  count: number;
  /** Resolve the concrete subscriber ids at submit time. */
  resolveIds: () => Promise<string[]>;
  canAdmin: boolean;
  authority?: SubscriberAuthority | null;
  onDone?: (result: DirectoryBulkResult) => void;
}) {
  const identity = useDirectoryIdentity();
  const idPrefix = useId();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [raw, setRaw] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fields = useQuery({
    queryKey: [...identity.subscribersKey, "bulk-custom-field-defs"],
    queryFn: ({ signal }) => listCustomFields(signal),
    enabled: open && mode === "custom" && identity.ready,
    staleTime: STALE.list,
  });

  useEffect(() => {
    if (!open) return;
    setKey(mode === "merge" ? BULK_MERGE_FIELDS[0].key : "");
    setRaw("");
    setError(null);
  }, [mode, open]);

  const definitions = Array.isArray(fields.data) ? fields.data : [];
  const definition = definitions.find((field) => field.key === key);
  const kind: FieldKind = mode === "merge" ? "string" : kindOf(definition);
  const label =
    mode === "merge"
      ? (BULK_MERGE_FIELDS.find((field) => field.key === key)?.label ?? key)
      : (definition?.label || key);
  const coerced = coerceBulkValue(kind, raw);
  const noun = `${count.toLocaleString()} subscriber${count === 1 ? "" : "s"}`;
  const withheld = !canAdmin
    ? "Only an owner or admin can change fields in bulk."
    : count === 0
      ? "Select subscribers first."
      : null;
  const blocked = withheld ?? (!key ? "Choose a field." : coerced.ok ? null : coerced.message);
  const title = mode === "merge" ? "Set a merge field" : "Set a custom field";

  const run = async () => {
    if (blocked || !coerced.ok) return;
    setError(null);
    try {
      if (authority) await reauthorizeSubscriberMutation(authority);
      const ids = await resolveIds();
      const result =
        mode === "merge"
          ? await bulkUpdateMergeFieldValue(ids, key as BulkMergeFieldKey, String(coerced.value))
          : await bulkSetCustomFieldValue(ids, key, coerced.value);
      toast.success(`Set ${label} on ${result.affected.toLocaleString()} subscribers.`);
      onDone?.(result);
      setOpen(false);
    } catch (err) {
      const message = apiErrorMessage(err, `Could not set ${label}.`);
      setError(message);
      throw err;
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!blocked) setConfirming(true);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled={Boolean(withheld)}
            title={withheld ?? undefined}
          >
            <PenLine aria-hidden className="h-4 w-4" />
            {mode === "merge" ? "Merge field…" : "Custom field…"}
          </Button>
        </DialogTrigger>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              Applies one value to {noun}. Every other field on those
              subscribers stays as it is.
            </DialogDescription>
          </DialogHeader>
          <form className="grid gap-3" onSubmit={submit} noValidate>
            <div className="grid gap-1.5">
              <Label htmlFor={`${idPrefix}-key`}>Field</Label>
              <Select
                id={`${idPrefix}-key`}
                value={key}
                onChange={(event) => {
                  setKey(event.target.value);
                  setRaw("");
                }}
              >
                {mode === "merge" ? (
                  BULK_MERGE_FIELDS.map((field) => (
                    <option key={field.key} value={field.key}>
                      {field.label} ({field.key})
                    </option>
                  ))
                ) : (
                  <>
                    <option value="">
                      {fields.isPending
                        ? "Loading fields…"
                        : fields.isError
                          ? "Fields unavailable"
                          : definitions.length === 0
                            ? "No custom fields defined"
                            : "Choose a field…"}
                    </option>
                    {definitions.map((field) => (
                      <option key={field.key} value={field.key}>
                        {field.label || field.key} · {String(field.type)}
                      </option>
                    ))}
                  </>
                )}
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${idPrefix}-value`}>Value</Label>
              {kind === "boolean" ? (
                <Select
                  id={`${idPrefix}-value`}
                  value={raw}
                  onChange={(event) => setRaw(event.target.value)}
                >
                  <option value="">Choose…</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </Select>
              ) : kind === "enum" && definition?.config?.options?.length ? (
                <Select
                  id={`${idPrefix}-value`}
                  value={raw}
                  onChange={(event) => setRaw(event.target.value)}
                >
                  <option value="">Choose…</option>
                  {definition.config.options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  id={`${idPrefix}-value`}
                  type={kind === "number" ? "number" : kind === "date" ? "date" : "text"}
                  value={raw}
                  maxLength={4096}
                  disabled={kind === "unsupported"}
                  onChange={(event) => setRaw(event.target.value)}
                />
              )}
            </div>
            {fields.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {apiErrorMessage(fields.error, "Could not load custom fields.")}
              </p>
            ) : null}
            {blocked && key ? (
              <p className="text-xs text-muted-foreground">{blocked}</p>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={Boolean(blocked)}>
                Review
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Set ${label} on ${noun}?`}
        description={`Each subscriber's ${label} becomes “${coerced.ok ? String(coerced.value) : ""}”, overwriting any value it has now. This cannot be undone in bulk. Other fields are not changed.`}
        confirmLabel={`Set on ${noun}`}
        onConfirm={run}
      />
    </>
  );
}

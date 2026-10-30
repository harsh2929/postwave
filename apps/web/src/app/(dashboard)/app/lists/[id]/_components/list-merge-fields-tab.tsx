// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Merge fields (audience-98): list-scoped typed slots templates reference as
 * {{ merge_fields.TAG }}. Rows are keyed by `tag` — there is no id on the
 * wire — so PATCH/DELETE address the row by tag and the tag is locked once a
 * field exists. Writes ride the write:subscribers scope (editor and up) and
 * re-read identity immediately before sending. Closing a dirty editor asks
 * before discarding (the "draft guard").
 */
import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Braces, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
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
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiErrorMessage } from "@/lib/api";
import { newWriteKey } from "@/lib/audience-admin-api";
import { whoamiFresh, type MeResponse } from "@/lib/auth-api";
import {
  createMergeField,
  deleteMergeField,
  listMergeFields,
  MERGE_FIELD_NAME_MAX,
  MERGE_FIELD_TAG_MAX,
  MERGE_FIELD_TYPES,
  updateMergeField,
  type AudienceList,
  type ListMergeField,
  type MergeFieldInput,
  type MergeFieldType,
} from "@/lib/lists-api";
import { listKeys, STALE, type RoleKey } from "@/lib/query-keys";

import { LoadFailure, Pending } from "./tab-chrome";
import {
  assertWriteIdentity,
  MERGE_FIELD_REASON,
  MERGE_FIELD_ROLES,
} from "./write-identity";

const TYPE_HINTS: Record<MergeFieldType, string> = {
  text: "Single-line string",
  number: "Integer or decimal",
  date: "ISO 8601 date",
  email: "Validated email address",
  phone: "E.164 format recommended",
  address: "Multi-line postal address",
};

interface Draft {
  tag: string;
  name: string;
  type: MergeFieldType;
  required: boolean;
  default: string;
  help_text: string;
}

const EMPTY: Draft = {
  tag: "",
  name: "",
  type: "text",
  required: false,
  default: "",
  help_text: "",
};

function draftFrom(f: ListMergeField): Draft {
  return {
    tag: f.tag,
    name: f.name,
    type: f.type,
    required: f.required,
    default: f.default ?? "",
    help_text: f.help_text ?? "",
  };
}

function draftsEqual(a: Draft, b: Draft): boolean {
  return (
    a.tag === b.tag &&
    a.name === b.name &&
    a.type === b.type &&
    a.required === b.required &&
    a.default === b.default &&
    a.help_text === b.help_text
  );
}

/** "First name" → "FIRST_NAME", clamped to the server's 10-char cap. */
export function suggestTag(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, "_")
    .replace(/^[^A-Z]+/u, "")
    .replace(/_+$/u, "")
    .slice(0, MERGE_FIELD_TAG_MAX)
    .replace(/_+$/u, "");
}

export function ListMergeFieldsTab({
  list,
  me,
  tenantId,
  roleKey,
  canWrite,
}: {
  list: AudienceList;
  me: MeResponse | undefined;
  tenantId: string;
  roleKey: RoleKey;
  canWrite: boolean;
}) {
  const qc = useQueryClient();
  const reasonId = useId();
  const fields = useQuery({
    queryKey: listKeys.mergeFields(tenantId, roleKey, list.id),
    queryFn: ({ signal }) => listMergeFields(list.id, signal),
    staleTime: STALE.detail,
  });
  const [editor, setEditor] = useState<{
    session: number;
    open: boolean;
    editing: ListMergeField | null;
  }>({ session: 0, open: false, editing: null });
  const [removeTarget, setRemoveTarget] = useState<ListMergeField | null>(null);

  function openEditor(editing: ListMergeField | null): void {
    setEditor((e) => ({ session: e.session + 1, open: true, editing }));
  }

  async function refresh(): Promise<void> {
    await qc.invalidateQueries({
      queryKey: listKeys.mergeFields(tenantId, roleKey, list.id),
    });
  }

  /** Thrown errors render inside the confirm with the server's sentence. */
  async function confirmRemove(): Promise<void> {
    if (!removeTarget || !me) return;
    assertWriteIdentity(
      me,
      await whoamiFresh(),
      MERGE_FIELD_ROLES,
      MERGE_FIELD_REASON,
    );
    await deleteMergeField(
      list.id,
      removeTarget.tag,
      newWriteKey("list-merge-field-delete"),
    );
    toast.success(`Merge field ${removeTarget.tag} removed from ${list.name}`);
    await refresh();
    setRemoveTarget(null);
  }

  const rows = Array.isArray(fields.data) ? fields.data : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          Custom fields attached to members of{" "}
          <span className="font-medium text-foreground">{list.name}</span>.
          Templates reference them by tag as{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            {"{{ merge_fields.TAG }}"}
          </code>
          .
        </p>
        <Button
          type="button"
          disabled={!canWrite}
          aria-describedby={canWrite ? undefined : reasonId}
          onClick={() => openEditor(null)}
        >
          <Plus aria-hidden className="size-4" /> Add field
        </Button>
      </div>
      {!canWrite ? (
        <p id={reasonId} className="text-xs text-muted-foreground">
          {MERGE_FIELD_REASON}
        </p>
      ) : null}

      {fields.isPending ? (
        <Pending label="Loading merge fields" />
      ) : fields.isError ? (
        <LoadFailure
          what="Merge fields"
          error={fields.error}
          busy={fields.isFetching}
          onRetry={() => void fields.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Braces}
          title="No merge fields yet"
          description="Add fields like FNAME, COMPANY or RENEWAL to personalise sends to this list."
        />
      ) : (
        <TableContainer aria-label={`${list.name} merge fields`}>
          <Table className="min-w-[720px]">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Tag</TableHead>
                <TableHead scope="col">Name</TableHead>
                <TableHead scope="col">Type</TableHead>
                <TableHead scope="col">Required</TableHead>
                <TableHead scope="col">Default</TableHead>
                <TableHead scope="col">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((f) => (
                <TableRow key={f.tag}>
                  <TableCell>
                    <code
                      className="font-mono text-xs"
                      title={`{{ merge_fields.${f.tag} }}`}
                    >
                      {f.tag}
                    </code>
                  </TableCell>
                  <TableCell className="max-w-[240px] truncate" title={f.name}>
                    {f.name}
                    {f.help_text ? (
                      <span
                        className="block truncate text-xs text-muted-foreground"
                        title={f.help_text}
                      >
                        {f.help_text}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {f.type}
                  </TableCell>
                  <TableCell>
                    {f.required ? (
                      <Badge variant="warning">Required</Badge>
                    ) : (
                      <span className="text-muted-foreground">Optional</span>
                    )}
                  </TableCell>
                  <TableCell
                    className="max-w-[160px] truncate text-muted-foreground"
                    title={f.default}
                  >
                    {f.default || "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="inline-flex gap-1">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={!canWrite}
                        aria-describedby={canWrite ? undefined : reasonId}
                        aria-label={`Edit ${f.tag}`}
                        onClick={() => openEditor(f)}
                      >
                        <Pencil aria-hidden className="size-4" /> Edit
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        disabled={!canWrite}
                        aria-describedby={canWrite ? undefined : reasonId}
                        aria-label={`Delete ${f.tag}`}
                        onClick={() => setRemoveTarget(f)}
                      >
                        <Trash2 aria-hidden className="size-4" /> Delete
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <MergeFieldEditor
        key={`${editor.session}-${editor.editing?.tag ?? "new"}`}
        open={editor.open}
        editing={editor.editing}
        list={list}
        me={me}
        onClose={() => setEditor((e) => ({ ...e, open: false }))}
        onSaved={refresh}
      />

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(v) => !v && setRemoveTarget(null)}
        title="Delete merge field?"
        description={
          removeTarget
            ? `Merge field "${removeTarget.name}" (${removeTarget.tag}) will be removed from ${list.name}. Templates that reference {{ merge_fields.${removeTarget.tag} }} render empty until you update them.`
            : ""
        }
        confirmLabel="Delete field"
        onConfirm={confirmRemove}
      />
    </div>
  );
}

function MergeFieldEditor({
  open,
  editing,
  list,
  me,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: ListMergeField | null;
  list: AudienceList;
  me: MeResponse | undefined;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const ids = useId();
  // Keyed by the parent per open/target, so state initialises from props and
  // a background refetch can never reset an in-progress draft.
  const [baseline] = useState<Draft>(() =>
    editing ? draftFrom(editing) : EMPTY,
  );
  const [draft, setDraft] = useState<Draft>(baseline);
  const [tagTouched, setTagTouched] = useState(editing !== null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const dirty = !draftsEqual(draft, baseline);

  function requestClose(): void {
    if (saving) return;
    if (dirty) setDiscardOpen(true);
    else onClose();
  }

  async function save(): Promise<void> {
    if (saving || !me) return;
    setSaving(true);
    setError(null);
    try {
      assertWriteIdentity(
        me,
        await whoamiFresh(),
        MERGE_FIELD_ROLES,
        MERGE_FIELD_REASON,
      );
      const input: MergeFieldInput = {
        tag: draft.tag,
        type: draft.type,
        name: draft.name,
        required: draft.required,
        default: draft.default,
        help_text: draft.help_text,
      };
      const saved = editing
        ? await updateMergeField(
            list.id,
            editing.tag,
            input,
            newWriteKey("list-merge-field-update"),
          )
        : await createMergeField(
            list.id,
            input,
            newWriteKey("list-merge-field-create"),
          );
      toast.success(
        editing
          ? `Merge field ${saved.tag} updated`
          : `Merge field ${saved.tag} added to ${list.name}`,
      );
      await onSaved();
      if (!mounted.current) return;
      onClose();
    } catch (e) {
      if (mounted.current)
        setError(apiErrorMessage(e, "Merge field could not be saved"));
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => !v && requestClose()}>
        <DialogContent
          closeDisabled={saving}
          onEscapeKeyDown={(e) => saving && e.preventDefault()}
          onPointerDownOutside={(e) => saving && e.preventDefault()}
        >
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {editing
                  ? `Edit ${editing.tag}`
                  : `Add merge field to ${list.name}`}
              </DialogTitle>
              <DialogDescription>
                Merge fields define typed slots that templates and forms can
                reference.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-1.5">
              <Label htmlFor={`${ids}-name`}>Name</Label>
              <Input
                id={`${ids}-name`}
                maxLength={MERGE_FIELD_NAME_MAX}
                placeholder="First name"
                value={draft.name}
                disabled={saving}
                onChange={(e) => {
                  const name = e.target.value;
                  setDraft((d) => ({
                    ...d,
                    name,
                    tag: !editing && !tagTouched ? suggestTag(name) : d.tag,
                  }));
                }}
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor={`${ids}-tag`}>Tag</Label>
              <Input
                id={`${ids}-tag`}
                className="font-mono uppercase"
                maxLength={MERGE_FIELD_TAG_MAX}
                placeholder="FNAME"
                value={draft.tag}
                disabled={saving || editing !== null}
                spellCheck={false}
                autoCapitalize="characters"
                onChange={(e) => {
                  setTagTouched(true);
                  setDraft((d) => ({
                    ...d,
                    tag: e.target.value.toUpperCase(),
                  }));
                }}
              />
              <p className="text-xs text-muted-foreground">
                {editing
                  ? "Tags identify the field on the wire and cannot be renamed."
                  : `Uppercase letters, digits and underscores, starting with a letter, max ${MERGE_FIELD_TAG_MAX} characters.`}
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor={`${ids}-type`}>Type</Label>
                <Select
                  id={`${ids}-type`}
                  value={draft.type}
                  disabled={saving}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      type: e.target.value as MergeFieldType,
                    }))
                  }
                >
                  {MERGE_FIELD_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t} — {TYPE_HINTS[t]}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${ids}-default`}>Default value</Label>
                <Input
                  id={`${ids}-default`}
                  placeholder="(optional)"
                  value={draft.default}
                  disabled={saving}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, default: e.target.value }))
                  }
                />
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor={`${ids}-help`}>Help text</Label>
              <Input
                id={`${ids}-help`}
                placeholder="Shown inline on forms (optional)"
                value={draft.help_text}
                disabled={saving}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, help_text: e.target.value }))
                }
              />
            </div>

            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draft.required}
                disabled={saving}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, required: e.target.checked }))
                }
              />
              Required — forms must collect this field
            </label>

            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={requestClose}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                loading={saving}
                disabled={saving || !draft.name.trim() || !draft.tag.trim()}
              >
                {saving ? "Saving…" : editing ? "Save changes" : "Add field"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={discardOpen}
        onOpenChange={(v) => !v && setDiscardOpen(false)}
        title={
          editing
            ? "Discard merge-field changes?"
            : "Discard merge-field draft?"
        }
        description={
          editing
            ? "The unsaved name, type, default, help text or requirement changes will be lost."
            : "The merge-field name, tag, type and default in this draft will be lost."
        }
        confirmLabel="Discard"
        onConfirm={() => {
          setDiscardOpen(false);
          onClose();
        }}
      />
    </>
  );
}

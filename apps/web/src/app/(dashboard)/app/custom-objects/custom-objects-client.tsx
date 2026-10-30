// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Boxes,
  ChevronDown,
  ChevronRight,
  Database,
  Eye,
  FileJson2,
  Layers3,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { PageShell } from "@/components/dashboard/page-shell";
import {
  GovernanceEmpty,
  GovernanceError,
  GovernanceLoading,
  GovernanceMetrics,
  GovernancePageHeader,
  GovernanceSection,
} from "@/components/governance/governance-ui";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
  DialogTrigger,
} from "@/components/ui/dialog";
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
import { Textarea } from "@/components/ui/textarea";
import { effectiveAuthRole, whoami, type MeResponse } from "@/lib/auth-api";
import { ApiError, apiErrorMessage } from "@/lib/api";
import {
  createCustomObjectType,
  customObjectViolations,
  deleteCustomObjectRecord,
  deleteCustomObjectType,
  getCustomObjectRecord,
  getCustomObjectType,
  listCustomObjectRecords,
  listCustomObjectTypes,
  searchCustomObjectRecords,
  updateCustomObjectType,
  upsertCustomObjectRecord,
  type CustomObjectAdminAuthority,
  type CustomObjectRecord,
  type CustomObjectRecordPage,
  type CustomObjectStatus,
  type CustomObjectType,
  type CustomObjectViolation,
} from "@/lib/custom-objects-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { newUUIDv7 } from "@/lib/http-fetch";
import { base, STALE } from "@/lib/query-keys";

class CustomObjectStaleError extends Error {
  constructor(subject: "type" | "record") {
    super(
      `This ${subject} changed after you opened it. The latest data has been reloaded; review it before trying again.`,
    );
    this.name = "CustomObjectStaleError";
  }
}

function isAdminMe(me: MeResponse): boolean {
  const role = effectiveAuthRole(me);
  return !me.viewer_mode && (role === "owner" || role === "admin");
}

function authorityFromMe(me: MeResponse): CustomObjectAdminAuthority | null {
  const role = effectiveAuthRole(me);
  if (me.viewer_mode || (role !== "owner" && role !== "admin")) return null;
  return { tenantId: me.tenant_id, userId: me.user_id, role };
}

async function reauthorize(
  expected: CustomObjectAdminAuthority,
): Promise<CustomObjectAdminAuthority> {
  const current = await whoami();
  const authority = authorityFromMe(current);
  if (
    !authority ||
    authority.tenantId !== expected.tenantId ||
    authority.userId !== expected.userId
  ) {
    throw new Error(
      "Your workspace, account, or effective role changed. Refresh before making this change.",
    );
  }
  return authority;
}

async function reauthorizeType(
  expected: CustomObjectAdminAuthority,
  loaded: CustomObjectType,
): Promise<{
  authority: CustomObjectAdminAuthority;
  current: CustomObjectType;
}> {
  const authority = await reauthorize(expected);
  const current = await getCustomObjectType({
    tenantId: authority.tenantId,
    id: loaded.id,
  });
  if (
    current.version !== loaded.version ||
    current.key !== loaded.key ||
    current.primaryKey !== loaded.primaryKey
  ) {
    throw new CustomObjectStaleError("type");
  }
  return { authority, current };
}

async function reauthorizeRecord(
  expected: CustomObjectAdminAuthority,
  loadedType: CustomObjectType,
  loadedRecord: CustomObjectRecord,
): Promise<{
  authority: CustomObjectAdminAuthority;
  current: CustomObjectRecord;
}> {
  const { authority } = await reauthorizeType(expected, loadedType);
  const current = await getCustomObjectRecord({
    tenantId: authority.tenantId,
    id: loadedRecord.id,
    expectedTypeId: loadedType.id,
  });
  if (
    current.version !== loadedRecord.version ||
    current.externalId !== loadedRecord.externalId
  ) {
    throw new CustomObjectStaleError("record");
  }
  return { authority, current };
}

function mutationError(error: unknown, fallback: string): string {
  if (
    error instanceof CustomObjectStaleError ||
    (error instanceof ApiError &&
      (error.status === 409 || error.status === 412))
  ) {
    return error instanceof CustomObjectStaleError
      ? error.message
      : "This item changed after you opened it. The latest data has been reloaded; review it before trying again.";
  }
  return apiErrorMessage(error, fallback);
}

function parseJSONObject(text: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function statusVariant(status: CustomObjectStatus) {
  if (status === "active") return "success" as const;
  if (status === "deprecated") return "warning" as const;
  return "outline" as const;
}

function displayDate(value: string): string {
  return formatWireTimestamp(value, "Not reported");
}

export function CustomObjectsClient() {
  const queryClient = useQueryClient();
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [expandedTypeId, setExpandedTypeId] = useState<string | null>(null);
  const meQuery = useQuery({
    queryKey: ["whoami"],
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const role = meQuery.data ? effectiveAuthRole(meQuery.data) : null;
  const keyBase = useMemo(
    () => base("custom-objects", meQuery.data?.tenant_id ?? "anon", role),
    [meQuery.data?.tenant_id, role],
  );
  const types = useQuery({
    queryKey: [...keyBase, "types"],
    queryFn: ({ signal }) =>
      listCustomObjectTypes({
        tenantId: meQuery.data?.tenant_id ?? "",
        signal,
      }),
    enabled: meQuery.isSuccess,
    staleTime: STALE.reference,
  });

  const rows = Array.isArray(types.data) ? types.data : [];
  const authority = meQuery.data ? authorityFromMe(meQuery.data) : null;
  const active = rows.filter((item) => item.status === "active").length;
  const unavailable = rows.filter((item) => item.status === "disabled").length;

  async function refreshVerified() {
    setRefreshError(null);
    const previous = meQuery.data;
    const identity = await meQuery.refetch();
    if (identity.error || !identity.data) {
      setRefreshError(
        "Identity could not be re-verified. Existing data is still shown and no object request was made.",
      );
      return;
    }
    if (
      previous &&
      (identity.data.user_id !== previous.user_id ||
        identity.data.tenant_id !== previous.tenant_id)
    ) {
      await queryClient.invalidateQueries({ queryKey: ["custom-objects"] });
      setRefreshError(
        "The active account or workspace changed. Data is being loaded for the new context.",
      );
      return;
    }
    const refreshed = await types.refetch();
    if (refreshed.error) {
      setRefreshError(
        "The latest object data could not be fetched. The last verified result remains visible.",
      );
    }
  }

  async function refreshTypesAfterMutation() {
    await types.refetch();
  }

  return (
    <PageShell className="max-w-6xl [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9">
      <GovernancePageHeader
        icon={Boxes}
        eyebrow="Data model"
        title="Custom objects"
        description="Define versioned schemas and safely manage orders, bookings, tickets, and other workspace records that do not belong on a subscriber."
        refreshLabel="Verify and refresh"
        refreshing={types.isFetching || meQuery.isFetching}
        onRefresh={() => void refreshVerified()}
      />

      {refreshError ? (
        <Alert variant="warning" role="status">
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>Refresh needs attention</AlertTitle>
          <AlertDescription>{refreshError}</AlertDescription>
        </Alert>
      ) : null}

      {meQuery.isPending ? (
        <GovernanceSection
          icon={ShieldCheck}
          title="Verifying access"
          description="Object data is requested only after the active workspace is verified."
        >
          <GovernanceLoading label="Verifying workspace access…" rows={3} />
        </GovernanceSection>
      ) : meQuery.isError || !meQuery.data ? (
        <GovernanceSection
          icon={ShieldCheck}
          title="Workspace access"
          description="No custom-object data was requested because identity verification failed."
        >
          <GovernanceError
            message="Could not verify the active account and workspace."
            retrying={meQuery.isFetching}
            onRetry={() => void meQuery.refetch()}
          />
        </GovernanceSection>
      ) : (
        <>
          {!isAdminMe(meQuery.data) ? (
            <Alert>
              <Eye aria-hidden="true" className="h-4 w-4" />
              <AlertTitle>Read-only access</AlertTitle>
              <AlertDescription>
                Your effective role can inspect schemas and records. An owner or
                administrator outside viewer mode is required to create, edit,
                or delete them.
              </AlertDescription>
            </Alert>
          ) : null}

          {types.data ? (
            <GovernanceMetrics
              items={[
                {
                  label: "Object types",
                  value: rows.length.toLocaleString(),
                  detail: "Versioned schema definitions",
                },
                {
                  label: "Active",
                  value: active.toLocaleString(),
                  detail: "Available for record writes",
                },
                {
                  label: "Disabled",
                  value: unavailable.toLocaleString(),
                  detail: "Record writes are blocked",
                },
              ]}
            />
          ) : null}

          <GovernanceSection
            icon={Layers3}
            title="Object types"
            description="Keys and primary fields stay immutable; schema, label, and lifecycle state use conflict-safe version updates."
          >
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs leading-5 text-muted-foreground">
                Destructive actions require the immutable key or external ID to
                be typed exactly.
              </p>
              {authority ? (
                <TypeEditorDialog
                  authority={authority}
                  onSaved={refreshTypesAfterMutation}
                  trigger={
                    <Button type="button">
                      <Plus aria-hidden="true" />
                      New object type
                    </Button>
                  }
                />
              ) : null}
            </div>

            {types.isPending ? (
              <GovernanceLoading
                label="Loading custom object types…"
                rows={4}
              />
            ) : types.isError && !types.data ? (
              <GovernanceError
                message="Could not load custom object types. No empty data model is being inferred."
                retrying={types.isFetching}
                onRetry={() => void types.refetch()}
              />
            ) : rows.length === 0 ? (
              <GovernanceEmpty>
                No custom object types defined. Owners and administrators can
                create the first versioned schema with the button above.
              </GovernanceEmpty>
            ) : (
              <div className="space-y-3">
                {types.isRefetchError ? (
                  <Alert variant="warning" role="status">
                    <AlertTriangle aria-hidden="true" className="h-4 w-4" />
                    <AlertTitle>Showing the last verified result</AlertTitle>
                    <AlertDescription>
                      A background refresh failed. Existing rows were preserved.
                    </AlertDescription>
                  </Alert>
                ) : null}
                {rows.map((type) => {
                  const expanded = expandedTypeId === type.id;
                  return (
                    <article
                      key={type.id}
                      className="rounded-xl border bg-card"
                    >
                      <div className="flex flex-col gap-4 p-4 sm:p-5">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <h3 className="break-words font-semibold">
                                {type.label}
                              </h3>
                              <Badge variant={statusVariant(type.status)}>
                                {type.status}
                              </Badge>
                              <Badge variant="secondary">v{type.version}</Badge>
                            </div>
                            <code className="mt-1 block break-all text-xs text-muted-foreground">
                              {type.key}
                            </code>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <JSONInspectDialog
                              title={`${type.label} schema`}
                              description="Read-only JSON Schema currently enforced for record writes."
                              value={type.schema}
                              triggerLabel="View schema"
                            />
                            {authority ? (
                              <TypeEditorDialog
                                key={`${type.id}:${type.version}`}
                                authority={authority}
                                current={type}
                                onSaved={refreshTypesAfterMutation}
                                trigger={
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                  >
                                    <Pencil aria-hidden="true" />
                                    Edit
                                  </Button>
                                }
                              />
                            ) : null}
                            {authority ? (
                              <ConfirmDialog
                                trigger={
                                  <Button
                                    type="button"
                                    variant="destructive"
                                    size="sm"
                                  >
                                    <Trash2 aria-hidden="true" />
                                    Delete
                                  </Button>
                                }
                                title={`Delete ${type.label}?`}
                                description={
                                  <span>
                                    This permanently deletes the type, every
                                    record, and every subscriber link. Type the
                                    immutable key to confirm the cascade.
                                  </span>
                                }
                                confirmationToken={type.key}
                                confirmLabel="Delete type and records"
                                onConfirm={async () => {
                                  try {
                                    const verified = await reauthorizeType(
                                      authority,
                                      type,
                                    );
                                    await deleteCustomObjectType({
                                      ...verified,
                                      confirmationKey: type.key,
                                      idempotencyKey: newUUIDv7(),
                                    });
                                    if (expandedTypeId === type.id) {
                                      setExpandedTypeId(null);
                                    }
                                    toast.success(
                                      "Custom object type deleted.",
                                    );
                                    await refreshTypesAfterMutation();
                                  } catch (error) {
                                    await refreshTypesAfterMutation();
                                    throw new Error(
                                      mutationError(
                                        error,
                                        "Could not delete the custom object type.",
                                      ),
                                    );
                                  }
                                }}
                              />
                            ) : null}
                          </div>
                        </div>

                        <dl className="grid gap-2 text-sm sm:grid-cols-3">
                          <div className="rounded-lg bg-muted/35 p-3">
                            <dt className="text-xs text-muted-foreground">
                              Primary key
                            </dt>
                            <dd className="mt-1 break-all font-mono">
                              {type.primaryKey}
                            </dd>
                          </div>
                          <div className="rounded-lg bg-muted/35 p-3">
                            <dt className="text-xs text-muted-foreground">
                              Schema fields
                            </dt>
                            <dd className="mt-1">
                              {schemaFieldSummary(type.schema)}
                            </dd>
                          </div>
                          <div className="rounded-lg bg-muted/35 p-3">
                            <dt className="text-xs text-muted-foreground">
                              Last updated
                            </dt>
                            <dd className="mt-1">
                              {displayDate(type.updatedAt)}
                            </dd>
                          </div>
                        </dl>

                        <Button
                          type="button"
                          variant="outline"
                          className="w-full justify-between"
                          aria-expanded={expanded}
                          aria-controls={`records-${type.id}`}
                          onClick={() =>
                            setExpandedTypeId((current) =>
                              current === type.id ? null : type.id,
                            )
                          }
                        >
                          <span className="flex items-center gap-2">
                            <Database aria-hidden="true" />
                            {expanded ? "Hide records" : "Browse records"}
                          </span>
                          {expanded ? (
                            <ChevronDown aria-hidden="true" />
                          ) : (
                            <ChevronRight aria-hidden="true" />
                          )}
                        </Button>
                      </div>

                      {expanded ? (
                        <div
                          id={`records-${type.id}`}
                          className="border-t bg-muted/10 p-4 sm:p-5"
                        >
                          <RecordBrowser authority={authority} type={type} />
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            )}
          </GovernanceSection>
        </>
      )}
    </PageShell>
  );
}

function schemaFieldSummary(schema: Record<string, unknown>): string {
  const properties = schema.properties;
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  ) {
    return "No declared fields";
  }
  const keys = Object.keys(properties);
  if (keys.length === 0) return "No declared fields";
  const shown = keys.slice(0, 3).join(", ");
  return keys.length > 3 ? `${shown} +${keys.length - 3}` : shown;
}

function TypeEditorDialog({
  authority,
  current,
  trigger,
  onSaved,
}: {
  authority: CustomObjectAdminAuthority;
  current?: CustomObjectType;
  trigger: ReactNode;
  onSaved: () => Promise<void>;
}) {
  const prefix = useId();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(current?.key ?? "");
  const [label, setLabel] = useState(current?.label ?? "");
  const [primaryKey, setPrimaryKey] = useState(
    current?.primaryKey ?? "external_id",
  );
  const [status, setStatus] = useState<CustomObjectStatus>(
    current?.status ?? "active",
  );
  const [schema, setSchema] = useState(
    JSON.stringify(
      current?.schema ?? { type: "object", properties: {} },
      null,
      2,
    ),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [violations, setViolations] = useState<CustomObjectViolation[]>([]);
  const pendingRef = useRef(false);
  const idempotencyRef = useRef<string | null>(null);

  function reset() {
    setKey(current?.key ?? "");
    setLabel(current?.label ?? "");
    setPrimaryKey(current?.primaryKey ?? "external_id");
    setStatus(current?.status ?? "active");
    setSchema(
      JSON.stringify(
        current?.schema ?? { type: "object", properties: {} },
        null,
        2,
      ),
    );
    setError(null);
    setViolations([]);
    idempotencyRef.current = null;
  }

  function revise(action: () => void) {
    action();
    setError(null);
    setViolations([]);
    idempotencyRef.current = null;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pendingRef.current) return;
    setError(null);
    setViolations([]);
    let parsedSchema: Record<string, unknown>;
    try {
      parsedSchema = parseJSONObject(schema, "Schema");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Schema is invalid.");
      return;
    }
    pendingRef.current = true;
    setPending(true);
    idempotencyRef.current ??= newUUIDv7();
    try {
      if (current) {
        const verified = await reauthorizeType(authority, current);
        await updateCustomObjectType({
          ...verified,
          label,
          schema: parsedSchema,
          status,
          idempotencyKey: idempotencyRef.current,
        });
        toast.success("Custom object type updated.");
      } else {
        const verified = await reauthorize(authority);
        await createCustomObjectType({
          authority: verified,
          key,
          label,
          primaryKey,
          schema: parsedSchema,
          idempotencyKey: idempotencyRef.current,
        });
        toast.success("Custom object type created.");
      }
      idempotencyRef.current = null;
      await onSaved();
      setOpen(false);
      reset();
    } catch (cause) {
      const safeViolations = customObjectViolations(cause);
      setViolations(safeViolations);
      setError(
        safeViolations.length
          ? "The schema or submitted fields did not pass validation."
          : mutationError(
              cause,
              current
                ? "Could not update the custom object type."
                : "Could not create the custom object type.",
            ),
      );
      await onSaved();
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && pendingRef.current) return;
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        closeDisabled={pending}
        aria-busy={pending}
        className="max-w-2xl"
      >
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>
              {current ? `Edit ${current.label}` : "New custom object type"}
            </DialogTitle>
            <DialogDescription>
              {current
                ? "This exact version will be replaced. Keys and primary fields remain immutable."
                : "Choose immutable identifiers carefully; downstream flows and segments may depend on them."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor={`${prefix}-key`}>Type key</Label>
                <Input
                  id={`${prefix}-key`}
                  value={key}
                  disabled={pending || Boolean(current)}
                  maxLength={64}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="support_ticket"
                  onChange={(event) => revise(() => setKey(event.target.value))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${prefix}-primary`}>Primary key</Label>
                <Input
                  id={`${prefix}-primary`}
                  value={primaryKey}
                  disabled={pending || Boolean(current)}
                  maxLength={96}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(event) =>
                    revise(() => setPrimaryKey(event.target.value))
                  }
                />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor={`${prefix}-label`}>Display label</Label>
                <Input
                  id={`${prefix}-label`}
                  value={label}
                  disabled={pending}
                  maxLength={256}
                  placeholder="Support ticket"
                  onChange={(event) =>
                    revise(() => setLabel(event.target.value))
                  }
                />
              </div>
              {current ? (
                <div className="space-y-2">
                  <Label htmlFor={`${prefix}-status`}>Lifecycle status</Label>
                  <Select
                    id={`${prefix}-status`}
                    value={status}
                    disabled={pending}
                    onChange={(event) =>
                      revise(() =>
                        setStatus(event.target.value as CustomObjectStatus),
                      )
                    }
                  >
                    <option value="active">Active</option>
                    <option value="deprecated">Deprecated</option>
                    <option value="disabled">Disabled</option>
                  </Select>
                </div>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${prefix}-schema`}>JSON Schema</Label>
              <Textarea
                id={`${prefix}-schema`}
                value={schema}
                disabled={pending}
                className="min-h-64 font-mono text-xs"
                spellCheck={false}
                aria-invalid={Boolean(error && !violations.length)}
                onChange={(event) =>
                  revise(() => setSchema(event.target.value))
                }
              />
              <p className="text-xs leading-5 text-muted-foreground">
                The schema is bounded and validated by the service before it is
                saved.
              </p>
            </div>
            {error ? (
              <div
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive-emphasis"
              >
                <p>{error}</p>
                {violations.length ? (
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    {violations.map((violation, index) => (
                      <li key={`${violation.field}:${violation.code}:${index}`}>
                        <span className="font-medium">{violation.field}:</span>{" "}
                        {violation.message}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              loading={pending}
              disabled={pending || !key || !label || !primaryKey || !schema}
            >
              {pending
                ? "Saving…"
                : current
                  ? "Save new version"
                  : "Create type"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RecordBrowser({
  authority,
  type,
}: {
  authority: CustomObjectAdminAuthority | null;
  type: CustomObjectType;
}) {
  const [property, setProperty] = useState("");
  const [value, setValue] = useState("");
  const [searchResult, setSearchResult] =
    useState<CustomObjectRecordPage | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchController = useRef<AbortController | null>(null);
  const records = useQuery({
    queryKey: ["custom-object-records", type.tenantId, type.id],
    queryFn: ({ signal }) =>
      listCustomObjectRecords({
        tenantId: type.tenantId,
        typeId: type.id,
        limit: 100,
        signal,
      }),
    staleTime: 0,
    gcTime: 0,
  });

  useEffect(() => () => searchController.current?.abort(), []);

  async function runSearch(event: FormEvent) {
    event.preventDefault();
    if (searching) return;
    setSearchError(null);
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    setSearching(true);
    try {
      const result = await searchCustomObjectRecords({
        tenantId: type.tenantId,
        typeId: type.id,
        property,
        value,
        limit: 100,
        signal: controller.signal,
      });
      if (searchController.current === controller) setSearchResult(result);
    } catch (error) {
      if (controller.signal.aborted) return;
      setSearchError(apiErrorMessage(error, "Could not search these records."));
    } finally {
      if (searchController.current === controller) {
        searchController.current = null;
        setSearching(false);
      }
    }
  }

  function clearSearch() {
    searchController.current?.abort();
    searchController.current = null;
    setSearchResult(null);
    setSearchError(null);
    setSearching(false);
    setProperty("");
    setValue("");
  }

  async function refreshRecords() {
    clearSearch();
    await records.refetch();
  }

  const page = searchResult ?? records.data;
  const rows = Array.isArray(page?.items) ? page.items : [];
  const canWriteRecords = Boolean(authority) && type.status !== "disabled";

  return (
    <section aria-label={`${type.label} records`} className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <form
          className="grid flex-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
          onSubmit={(event) => void runSearch(event)}
        >
          <div className="space-y-1.5">
            <Label htmlFor={`record-property-${type.id}`}>Exact property</Label>
            <Input
              id={`record-property-${type.id}`}
              value={property}
              maxLength={96}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="status"
              disabled={searching}
              onChange={(event) => setProperty(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`record-value-${type.id}`}>Exact value</Label>
            <Input
              id={`record-value-${type.id}`}
              value={value}
              maxLength={1024}
              placeholder="open"
              disabled={searching}
              onChange={(event) => setValue(event.target.value)}
            />
          </div>
          <div className="flex gap-2 sm:pb-px">
            <Button
              type="submit"
              variant="outline"
              loading={searching}
              disabled={searching || !property || !value}
            >
              <Search aria-hidden="true" />
              {searching ? "Searching…" : "Search"}
            </Button>
            {searchResult || searchError ? (
              <Button
                type="button"
                variant="ghost"
                aria-label="Clear record search"
                onClick={clearSearch}
              >
                <X aria-hidden="true" />
              </Button>
            ) : null}
          </div>
        </form>
        {canWriteRecords && authority ? (
          <RecordEditorDialog
            authority={authority}
            type={type}
            onSaved={refreshRecords}
            trigger={
              <Button type="button">
                <Plus aria-hidden="true" />
                New record
              </Button>
            }
          />
        ) : null}
      </div>

      <p className="text-xs leading-5 text-muted-foreground">
        Search values are sent in an online-only request body, never in a URL,
        browser history entry, referrer, or query-cache key.
      </p>

      {type.status === "disabled" ? (
        <Alert variant="warning">
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>Record writes disabled</AlertTitle>
          <AlertDescription>
            Existing records remain inspectable. Reactivate the object type
            before creating or editing records.
          </AlertDescription>
        </Alert>
      ) : null}

      {searchError ? (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>Search failed</AlertTitle>
          <AlertDescription>{searchError}</AlertDescription>
        </Alert>
      ) : null}

      {records.isPending && !searchResult ? (
        <GovernanceLoading label={`Loading ${type.label} records…`} rows={3} />
      ) : records.isError && !records.data && !searchResult ? (
        <GovernanceError
          message="Could not load records. No empty result is being inferred."
          retrying={records.isFetching}
          onRetry={() => void records.refetch()}
        />
      ) : rows.length === 0 ? (
        <GovernanceEmpty>
          {searchResult
            ? "No records matched this exact property value."
            : "No records have been created for this object type."}
        </GovernanceEmpty>
      ) : (
        <div className="space-y-2">
          {records.isRefetchError && !searchResult ? (
            <Alert variant="warning" role="status">
              <AlertTriangle aria-hidden="true" className="h-4 w-4" />
              <AlertTitle>Showing the last verified records</AlertTitle>
              <AlertDescription>A background refresh failed.</AlertDescription>
            </Alert>
          ) : null}
          <TableContainer aria-label={`${type.label} record list`}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>External ID</TableHead>
                  <TableHead>Properties</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((record) => (
                  <TableRow key={record.id}>
                    <TableCell className="max-w-64 break-all font-mono text-xs">
                      {record.externalId}
                    </TableCell>
                    <TableCell>
                      {propertyKeySummary(record.properties)}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      v{record.version}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {displayDate(record.updatedAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1.5">
                        <JSONInspectDialog
                          title={`Record ${record.externalId}`}
                          description="Read-only record properties. Values are revealed only in this inspector."
                          value={record.properties}
                          triggerLabel="Inspect"
                        />
                        {canWriteRecords && authority ? (
                          <RecordEditorDialog
                            key={`${record.id}:${record.version}`}
                            authority={authority}
                            type={type}
                            current={record}
                            onSaved={refreshRecords}
                            trigger={
                              <Button type="button" variant="outline" size="sm">
                                <Pencil aria-hidden="true" />
                                Edit
                              </Button>
                            }
                          />
                        ) : null}
                        {authority ? (
                          <ConfirmDialog
                            trigger={
                              <Button
                                type="button"
                                variant="destructive"
                                size="sm"
                              >
                                <Trash2 aria-hidden="true" />
                                Delete
                              </Button>
                            }
                            title="Delete this record?"
                            description="This permanently deletes the exact loaded version. Type the external ID to confirm."
                            confirmationToken={record.externalId}
                            confirmLabel="Delete record"
                            onConfirm={async () => {
                              try {
                                const verified = await reauthorizeRecord(
                                  authority,
                                  type,
                                  record,
                                );
                                await deleteCustomObjectRecord({
                                  ...verified,
                                  confirmationExternalId: record.externalId,
                                  idempotencyKey: newUUIDv7(),
                                });
                                toast.success("Custom object record deleted.");
                                await refreshRecords();
                              } catch (error) {
                                await refreshRecords();
                                throw new Error(
                                  mutationError(
                                    error,
                                    "Could not delete the custom object record.",
                                  ),
                                );
                              }
                            }}
                          />
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          <p className="text-xs text-muted-foreground">
            Showing {rows.length.toLocaleString()} record
            {rows.length === 1 ? "" : "s"}
            {page?.hasMore
              ? "; more records exist beyond this bounded page. Narrow the result with an exact search."
              : "; this bounded result is complete."}
          </p>
        </div>
      )}
    </section>
  );
}

function propertyKeySummary(properties: Record<string, unknown>): string {
  const keys = Object.keys(properties);
  if (!keys.length) return "No properties";
  const visible = keys.slice(0, 4).join(", ");
  return keys.length > 4 ? `${visible} +${keys.length - 4}` : visible;
}

function RecordEditorDialog({
  authority,
  type,
  current,
  trigger,
  onSaved,
}: {
  authority: CustomObjectAdminAuthority;
  type: CustomObjectType;
  current?: CustomObjectRecord;
  trigger: ReactNode;
  onSaved: () => Promise<void>;
}) {
  const prefix = useId();
  const [open, setOpen] = useState(false);
  const [externalId, setExternalId] = useState(current?.externalId ?? "");
  const [properties, setProperties] = useState(
    JSON.stringify(current?.properties ?? {}, null, 2),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [violations, setViolations] = useState<CustomObjectViolation[]>([]);
  const pendingRef = useRef(false);
  const idempotencyRef = useRef<string | null>(null);

  function reset() {
    setExternalId(current?.externalId ?? "");
    setProperties(JSON.stringify(current?.properties ?? {}, null, 2));
    setError(null);
    setViolations([]);
    idempotencyRef.current = null;
  }

  function revise(action: () => void) {
    action();
    setError(null);
    setViolations([]);
    idempotencyRef.current = null;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pendingRef.current) return;
    setError(null);
    setViolations([]);
    let parsed: Record<string, unknown>;
    try {
      parsed = parseJSONObject(properties, "Record properties");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Properties are invalid.",
      );
      return;
    }
    pendingRef.current = true;
    setPending(true);
    idempotencyRef.current ??= newUUIDv7();
    try {
      if (current) {
        const verified = await reauthorizeRecord(authority, type, current);
        await upsertCustomObjectRecord({
          authority: verified.authority,
          typeId: type.id,
          current: verified.current,
          externalId,
          properties: parsed,
          idempotencyKey: idempotencyRef.current,
        });
        toast.success("Custom object record updated.");
      } else {
        const verified = await reauthorizeType(authority, type);
        if (verified.current.status === "disabled") {
          throw new Error(
            "This object type is disabled and cannot accept record writes.",
          );
        }
        await upsertCustomObjectRecord({
          authority: verified.authority,
          typeId: type.id,
          externalId,
          properties: parsed,
          idempotencyKey: idempotencyRef.current,
        });
        toast.success("Custom object record created.");
      }
      idempotencyRef.current = null;
      await onSaved();
      setOpen(false);
      reset();
    } catch (cause) {
      const safeViolations = customObjectViolations(cause);
      setViolations(safeViolations);
      setError(
        safeViolations.length
          ? "This record did not satisfy the saved schema."
          : mutationError(
              cause,
              current
                ? "Could not update the custom object record."
                : "Could not create the custom object record.",
            ),
      );
      await onSaved();
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && pendingRef.current) return;
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        closeDisabled={pending}
        aria-busy={pending}
        className="max-w-2xl"
      >
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>
              {current
                ? "Edit custom object record"
                : "New custom object record"}
            </DialogTitle>
            <DialogDescription>
              {current
                ? "The external ID is immutable. Saving requires the exact loaded record version."
                : `Create a ${type.label} record against schema version ${type.version}.`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor={`${prefix}-external`}>External ID</Label>
              <Input
                id={`${prefix}-external`}
                value={externalId}
                disabled={pending || Boolean(current)}
                maxLength={512}
                autoComplete="off"
                onChange={(event) =>
                  revise(() => setExternalId(event.target.value))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${prefix}-properties`}>Properties JSON</Label>
              <Textarea
                id={`${prefix}-properties`}
                value={properties}
                disabled={pending}
                className="min-h-64 font-mono text-xs"
                spellCheck={false}
                onChange={(event) =>
                  revise(() => setProperties(event.target.value))
                }
              />
            </div>
            {error ? (
              <div
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive-emphasis"
              >
                <p>{error}</p>
                {violations.length ? (
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    {violations.map((violation, index) => (
                      <li key={`${violation.field}:${violation.code}:${index}`}>
                        <span className="font-medium">{violation.field}:</span>{" "}
                        {violation.message}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              loading={pending}
              disabled={pending || !externalId || !properties}
            >
              {pending
                ? "Saving…"
                : current
                  ? "Save new version"
                  : "Create record"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function JSONInspectDialog({
  title,
  description,
  value,
  triggerLabel,
}: {
  title: string;
  description: string;
  value: Record<string, unknown>;
  triggerLabel: string;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <FileJson2 aria-hidden="true" />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <pre className="max-h-[55dvh] overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/40 p-4 text-xs">
          {JSON.stringify(value, null, 2)}
        </pre>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button">Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

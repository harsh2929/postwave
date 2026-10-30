// SPDX-License-Identifier: AGPL-3.0-only
//
// Custom-fields admin: list + create + edit + the per-tenant validator-mode
// toggle (strict / auto / off). The validator runs on every subscriber
// upsert; switching modes is a per-tenant policy decision so it lives here in
// Settings rather than per-field.
"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Plus, Tags } from "lucide-react";
import { toast } from "sonner";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { Skeleton } from "@/components/ui/skeleton";
import { invalidateCustomFieldDefinitions } from "@/lib/audience-invalidation";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import {
  canAdminCustomFieldMode,
  canEditCustomFields,
  customFieldAuthorityKey,
  verifyFreshCustomFieldAuthority,
} from "@/lib/custom-field-authority";
import type {
  CustomField,
  CustomFieldConfig,
  CustomFieldReference,
  CustomFieldReferences,
  CustomFieldsValidatorMode,
} from "@/lib/custom-fields-api";
import { qk, STALE } from "@/lib/query-keys";

// The custom-fields API module is imported where a query or mutation runs, so
// the route's eager chunk stays inside the bundle budget. One shared promise:
// the registry read and the usage read start in the same render, and two
// concurrent import() calls of a module that a test has mocked can hand one
// caller the original module (the mock factory is still loading it).
let customFieldsApiModule:
  | Promise<typeof import("@/lib/custom-fields-api")>
  | undefined;
const customFieldsApi = () =>
  (customFieldsApiModule ??= import("@/lib/custom-fields-api"));

// The limits card (caps, step-up flow) sits between the validator card and the
// registry; it loads after first paint for the same reason. The fallback keeps
// the card's heading so the page does not jump when it mounts.
const CustomFieldLimitsCard = dynamic(
  () =>
    import("@/components/settings/custom-field-limits-card").then(
      (m) => m.CustomFieldLimitsCard,
    ),
  {
    loading: () => (
      <Card aria-busy>
        <CardHeader>
          <CardTitle>Custom-field limits</CardTitle>
          <CardDescription>Loading the saved limits…</CardDescription>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    ),
  },
);

interface CustomFieldsSettingsData {
  fields: CustomField[];
  mode: CustomFieldsValidatorMode;
}

const MODES: Array<{
  mode: CustomFieldsValidatorMode;
  label: string;
  blurb: string;
}> = [
  {
    mode: "auto",
    label: "Auto-register",
    blurb:
      "Unknown keys auto-create a custom field on first write, with the type inferred from the value. Best for migration imports + low-friction onboarding. Default.",
  },
  {
    mode: "strict",
    label: "Strict",
    blurb:
      "Reject any write containing a key that isn't pre-declared. Use when this schema is the contract.",
  },
  {
    mode: "off",
    label: "Off",
    blurb:
      "Legacy passthrough. No validation, no auto-register. Kept for compatibility + ops emergencies.",
  },
];

const MODE_CONSEQUENCE: Record<CustomFieldsValidatorMode, string> = {
  auto: "",
  strict:
    "Strict mode starts REJECTING any subscriber write that contains a key not declared below. In-flight imports or integrations sending undeclared keys will start failing.",
  off: "Off disables validation entirely — undeclared keys are silently accepted and never auto-registered. You lose schema enforcement across every subscriber write.",
};

const CUSTOM_FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/u;

function customFieldDraftError(key: string, label: string): string | null {
  if (!key) return "Enter a key for this field.";
  if (!CUSTOM_FIELD_KEY_RE.test(key)) {
    return "Use 1–64 lowercase letters, numbers, or underscores, starting with a letter.";
  }
  if (!label) return "Enter a label for this field.";
  if (label.length > 200) return "Keep the label to 200 characters or fewer.";
  return null;
}

async function loadCustomFieldsSettings(
  signal?: AbortSignal,
): Promise<CustomFieldsSettingsData> {
  const { listCustomFields, getCustomFieldsMode } = await customFieldsApi();
  const [fields, response] = await Promise.all([
    listCustomFields(signal),
    getCustomFieldsMode(signal),
  ]);
  return { fields, mode: response.custom_fields_mode ?? "auto" };
}

// DeleteFieldDescription renders the delete-confirm body with the SETC-032
// where-used warning. It uses only inline/block <span>s because it renders
// inside DialogDescription's <p> (block/ul would trip hydration).
function DeleteFieldDescription({
  field,
  references,
  loading,
  error,
}: {
  field: CustomField | null;
  references: CustomFieldReferences | null;
  loading: boolean;
  error: boolean;
}) {
  if (!field) return null;
  const total = references
    ? references.segments.length +
      references.flows.length +
      references.forms.length
    : 0;
  const groups: Array<[string, CustomFieldReference[]]> = references
    ? [
        ["Segments", references.segments],
        ["Flows", references.flows],
        ["Forms", references.forms],
      ]
    : [];
  return (
    <span className="block space-y-2">
      <span className="block">
        Delete “{field.label}”? Existing subscriber values are not removed.
      </span>
      {loading ? (
        <span className="block text-muted-foreground">
          Checking for references…
        </span>
      ) : error ? (
        <span className="block text-muted-foreground">
          Couldn’t check references — verify segments, flows, and forms
          manually.
        </span>
      ) : references && total === 0 ? (
        <span className="block text-muted-foreground">
          No segments, flows, or forms reference “{field.key}”.
        </span>
      ) : references ? (
        <span className="block space-y-1">
          <span className="block font-medium text-destructive-emphasis">
            {total} object{total === 1 ? "" : "s"} reference “{field.key}” and
            may break:
          </span>
          {groups.map(([label, list]) =>
            list.length > 0 ? (
              <span key={label} className="block">
                <span className="font-medium">{label}:</span>{" "}
                {list.map((r) => r.name || r.id).join(", ")}
              </span>
            ) : null,
          )}
        </span>
      ) : null}
    </span>
  );
}

export default function CustomFieldsSettingsPage() {
  const queryClient = useQueryClient();
  const [showNew, setShowNew] = useState(false);
  const [draftKey, setDraftKey] = useState("");
  const [draftLabel, setDraftLabel] = useState("");
  const [draftType, setDraftType] = useState<CustomField["type"]>("string");
  const [draftPii, setDraftPii] = useState(false);
  const [draftChoices, setDraftChoices] = useState("");
  const [draftRequired, setDraftRequired] = useState(false);
  const [draftDefault, setDraftDefault] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [modeBusy, setModeBusy] = useState(false);
  const [pendingMode, setPendingMode] =
    useState<CustomFieldsValidatorMode | null>(null);
  const [editing, setEditing] = useState<CustomField | null>(null);
  const [deleting, setDeleting] = useState<CustomField | null>(null);
  const creatingRef = useRef(false);
  const modeBusyRef = useRef(false);
  const createErrorRef = useRef<HTMLParagraphElement>(null);
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreCreateFocusRef = useRef(false);
  const editReturnFocusRef = useRef<HTMLElement | null>(null);
  const deleteFocusRef = useRef<HTMLElement | null>(null);
  const modeFocusRef = useRef<HTMLElement | null>(null);
  const fieldsHeadingRef = useRef<HTMLHeadingElement>(null);
  const authorityKeyRef = useRef("unverified");
  const previousScopeRef = useRef<{
    key: readonly unknown[];
    stamp: string;
  } | null>(null);
  const localScopeRef = useRef("");
  const mutationControllerRef = useRef<AbortController | null>(null);
  const createErrorId = useId();

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const identity = meQuery.data;
  const tenantId = identity?.tenant_id ?? "anon";
  const userId = identity?.user_id ?? "anon";
  const role = identity ? effectiveAuthRole(identity) : null;
  const viewerMode = identity?.viewer_mode === true;
  const canEditFields = meQuery.isSuccess && canEditCustomFields(identity);
  const canAdminMode = meQuery.isSuccess && canAdminCustomFieldMode(identity);
  const authorityKey =
    meQuery.isSuccess && identity
      ? customFieldAuthorityKey(identity)
      : "unverified";
  authorityKeyRef.current = authorityKey;
  const customFieldsBaseKey = useMemo(
    () =>
      [
        ...qk.settings(tenantId, role, "custom-fields-authority"),
        userId,
        viewerMode,
      ] as const,
    [role, tenantId, userId, viewerMode],
  );
  const customFieldsKey = useMemo(
    () => [...customFieldsBaseKey, "settings"] as const,
    [customFieldsBaseKey],
  );
  const customFieldsQuery = useQuery({
    queryKey: customFieldsKey,
    queryFn: ({ signal }) => loadCustomFieldsSettings(signal),
    // Never issue tenant-scoped reads under the synthetic `anon` key after an
    // identity failure. The explicit identity error below owns recovery.
    enabled: meQuery.isSuccess,
    staleTime: STALE.list,
  });
  const fields = Array.isArray(customFieldsQuery.data?.fields)
    ? customFieldsQuery.data?.fields
    : [];
  const mode = customFieldsQuery.data?.mode ?? null;

  // SETC-043: per-field fill rate across subscribers. Best-effort — a failure
  // here must not blank the registry, so the column simply shows "—".
  const usageQuery = useQuery({
    queryKey: [...customFieldsBaseKey, "usage"] as const,
    queryFn: async ({ signal }) =>
      (await customFieldsApi()).getCustomFieldUsage(signal),
    enabled: meQuery.isSuccess,
    staleTime: STALE.list,
  });
  const fillByKey = useMemo(() => {
    const m = new Map<string, { filled: number; rate: number }>();
    for (const row of Array.isArray(usageQuery.data?.fields)
      ? usageQuery.data?.fields
      : []) {
      m.set(row.key, { filled: row.filled, rate: row.rate });
    }
    return m;
  }, [usageQuery.data]);
  const totalSubscribers = usageQuery.data?.total_subscribers ?? null;

  // SETC-032: fetch downstream references only while the delete dialog is open.
  const referencesQuery = useQuery({
    queryKey: [
      ...customFieldsBaseKey,
      "references",
      deleting?.id ?? "none",
    ] as const,
    queryFn: async ({ signal }) =>
      (await customFieldsApi()).getCustomFieldReferences(deleting!.id, signal),
    enabled: meQuery.isSuccess && deleting !== null,
    staleTime: 0,
  });
  const loading =
    meQuery.isLoading ||
    (customFieldsQuery.isPending && !customFieldsQuery.data);
  const loadError =
    customFieldsQuery.error instanceof Error
      ? customFieldsQuery.error.message
      : customFieldsQuery.isError
        ? "Could not load custom fields — this is a failed request, not a workspace without any."
        : null;

  useEffect(() => {
    if (createError) createErrorRef.current?.focus();
  }, [createError]);

  useEffect(() => {
    if (showNew || !restoreCreateFocusRef.current) return;
    restoreCreateFocusRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      createTriggerRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [showNew]);

  useEffect(() => {
    const previous = previousScopeRef.current;
    if (previous && previous.stamp !== authorityKey) {
      void queryClient.cancelQueries({ queryKey: previous.key, exact: false });
      queryClient.removeQueries({ queryKey: previous.key, exact: false });
    }
    previousScopeRef.current =
      authorityKey === "unverified"
        ? null
        : { key: customFieldsBaseKey, stamp: authorityKey };

    if (localScopeRef.current === authorityKey) return;
    localScopeRef.current = authorityKey;
    mutationControllerRef.current?.abort();
    mutationControllerRef.current = null;
    creatingRef.current = false;
    modeBusyRef.current = false;
    setCreating(false);
    setModeBusy(false);
    setShowNew(false);
    setPendingMode(null);
    setEditing(null);
    setDeleting(null);
    setDraftKey("");
    setDraftLabel("");
    setDraftType("string");
    setDraftPii(false);
    setDraftChoices("");
    setDraftRequired(false);
    setDraftDefault("");
    setCreateError(null);
  }, [authorityKey, customFieldsBaseKey, queryClient]);

  useEffect(
    () => () => {
      mutationControllerRef.current?.abort();
      mutationControllerRef.current = null;
    },
    [],
  );

  function beginMutation(
    level: "field" | "mode",
  ): { controller: AbortController; stamp: string } | null {
    const allowed = level === "mode" ? canAdminMode : canEditFields;
    if (
      !identity ||
      !allowed ||
      authorityKey === "unverified" ||
      mutationControllerRef.current
    ) {
      return null;
    }
    const controller = new AbortController();
    mutationControllerRef.current = controller;
    return { controller, stamp: authorityKey };
  }

  function mutationIsCurrent(operation: {
    controller: AbortController;
    stamp: string;
  }): boolean {
    return (
      !operation.controller.signal.aborted &&
      authorityKeyRef.current === operation.stamp
    );
  }

  function finishMutation(controller: AbortController): void {
    if (mutationControllerRef.current === controller) {
      mutationControllerRef.current = null;
    }
  }

  async function authorizeMutation(
    operation: { controller: AbortController; stamp: string },
    level: "field" | "mode",
  ): Promise<void> {
    if (!identity || !mutationIsCurrent(operation)) {
      throw new Error(
        "Workspace identity or custom-field authority changed. Nothing was written; reload and retry.",
      );
    }
    await verifyFreshCustomFieldAuthority(
      identity,
      level,
      operation.controller.signal,
    );
    if (!mutationIsCurrent(operation)) {
      throw new Error(
        "Workspace identity or custom-field authority changed. Nothing was written; reload and retry.",
      );
    }
    // An earlier successful action may still be reconciling. Cancel that read
    // before the next write so its older snapshot cannot land after this
    // mutation and resurrect a deleted field or roll back a newer edit/mode.
    await queryClient.cancelQueries({
      queryKey: customFieldsKey,
      exact: false,
    });
    if (!mutationIsCurrent(operation)) {
      throw new Error(
        "Workspace identity or custom-field authority changed. Nothing was written; reload and retry.",
      );
    }
  }

  // A definition write (create, edit, delete) makes stale this page's registry,
  // fill-rate and reference reads, and every other screen that offers the
  // definitions: the subscriber profile and edit dialog, the directory's bulk
  // field dialog and the segment builder.
  const invalidateCustomFields = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: customFieldsBaseKey }),
      invalidateCustomFieldDefinitions(queryClient, tenantId),
    ]);
  };

  // A validator-mode switch writes only the tenant's policy: no definition,
  // fill rate or reference changes, so only the registry read that carries
  // the mode is reconciled.
  const invalidateValidatorMode = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: customFieldsKey, exact: true });

  function resetCreateDraft(): void {
    setDraftKey("");
    setDraftLabel("");
    setDraftType("string");
    setDraftPii(false);
    setDraftChoices("");
    setDraftRequired(false);
    setDraftDefault("");
    setCreateError(null);
  }

  function toggleCreate(): void {
    if (creatingRef.current || !canEditFields) return;
    if (showNew) resetCreateDraft();
    else setCreateError(null);
    setShowNew(!showNew);
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (creatingRef.current) return;
    if (!canEditFields) {
      setCreateError("Your current role cannot create custom fields.");
      return;
    }
    const key = draftKey.trim().toLowerCase();
    const label = draftLabel.trim();
    const validation = customFieldDraftError(key, label);
    if (validation) {
      setCreateError(validation);
      return;
    }
    const options = [
      ...new Set(
        draftChoices
          .split(",")
          .map((choice) => choice.trim())
          .filter(Boolean),
      ),
    ];
    const config: CustomFieldConfig = {};
    if (draftPii) config.pii_flag = true;
    if (options.length > 0) config.options = options;
    if (draftRequired) config.required = true; // SETC-052
    if (draftDefault.trim()) config.default = draftDefault.trim();
    const intent = {
      key: key.toLowerCase(),
      label,
      type: draftType,
      ...(Object.keys(config).length > 0
        ? { config: structuredClone(config) }
        : {}),
    };
    const operation = beginMutation("field");
    if (!operation) {
      setCreateError(
        "Another custom-field change is already in progress. Wait for it to finish and retry.",
      );
      return;
    }
    creatingRef.current = true;
    setCreating(true);
    setCreateError(null);
    try {
      await authorizeMutation(operation, "field");
      const { createCustomField } = await customFieldsApi();
      const created = await createCustomField(
        intent,
        operation.controller.signal,
      );
      if (!mutationIsCurrent(operation)) return;
      queryClient.setQueryData<CustomFieldsSettingsData>(
        customFieldsKey,
        (cur) => ({
          mode: cur?.mode ?? "auto",
          fields: [created, ...(cur?.fields ?? [])],
        }),
      );
      toast.success("Custom field created.");
      restoreCreateFocusRef.current = true;
      setShowNew(false);
      resetCreateDraft();
      void invalidateCustomFields();
    } catch (cause) {
      if (operation.controller.signal.aborted) return;
      setCreateError(
        cause instanceof Error
          ? cause.message
          : "The custom field could not be created.",
      );
    } finally {
      creatingRef.current = false;
      if (mutationIsCurrent(operation)) setCreating(false);
      finishMutation(operation.controller);
    }
  }

  async function onDelete(id: string) {
    if (!canEditFields) {
      const message = "Your current role cannot delete custom fields.";
      toast.error(message);
      throw new Error(message);
    }
    const intent = { id } as const;
    const operation = beginMutation("field");
    if (!operation) {
      const message =
        "Another custom-field change is already in progress. Wait for it to finish and retry.";
      toast.error(message);
      throw new Error(message);
    }
    try {
      await authorizeMutation(operation, "field");
      const { deleteCustomField } = await customFieldsApi();
      await deleteCustomField(intent.id, operation.controller.signal);
      if (!mutationIsCurrent(operation)) return;
      queryClient.setQueryData<CustomFieldsSettingsData>(
        customFieldsKey,
        (cur) =>
          cur
            ? {
                ...cur,
                fields: cur.fields.filter((field) => field.id !== intent.id),
              }
            : cur,
      );
      toast.success("Custom field deleted.");
      deleteFocusRef.current = fieldsHeadingRef.current;
      void invalidateCustomFields();
    } catch (cause) {
      if (operation.controller.signal.aborted) return;
      const message =
        cause instanceof Error
          ? cause.message
          : "The custom field could not be deleted.";
      toast.error(message);
      throw cause instanceof Error ? cause : new Error(message);
    } finally {
      finishMutation(operation.controller);
    }
  }

  async function applyMode(next: CustomFieldsValidatorMode) {
    if (modeBusyRef.current) return;
    if (!canAdminMode) {
      throw new Error("Your current role cannot change validator mode.");
    }
    const intent = next;
    const operation = beginMutation("mode");
    if (!operation) {
      const message =
        "Another custom-field change is already in progress. Wait for it to finish and retry.";
      toast.error(message);
      throw new Error(message);
    }
    modeBusyRef.current = true;
    setModeBusy(true);
    const previous = customFieldsQuery.data;
    try {
      await authorizeMutation(operation, "mode");
      if (!mutationIsCurrent(operation)) return;
      queryClient.setQueryData<CustomFieldsSettingsData>(
        customFieldsKey,
        (cur) => ({
          fields: cur?.fields ?? [],
          mode: intent,
        }),
      );
      const { updateCustomFieldsMode } = await customFieldsApi();
      const out = await updateCustomFieldsMode(
        intent,
        operation.controller.signal,
      );
      if (!mutationIsCurrent(operation)) return;
      queryClient.setQueryData<CustomFieldsSettingsData>(
        customFieldsKey,
        (cur) => ({
          fields: cur?.fields ?? previous?.fields ?? [],
          mode: out.custom_fields_mode ?? intent,
        }),
      );
      toast.success("Validator mode updated.");
      void invalidateValidatorMode();
    } catch (cause) {
      if (operation.controller.signal.aborted) return;
      queryClient.setQueryData(customFieldsKey, previous);
      const message =
        cause instanceof Error
          ? cause.message
          : "The validator mode could not be updated.";
      toast.error(message);
      throw cause instanceof Error ? cause : new Error(message);
    } finally {
      modeBusyRef.current = false;
      if (mutationIsCurrent(operation)) setModeBusy(false);
      finishMutation(operation.controller);
    }
  }

  // Switching to a stricter/looser tenant-wide ingestion policy confirms first
  // (SETC-024). Auto-register applies directly.
  function requestMode(
    next: CustomFieldsValidatorMode,
    trigger: HTMLElement | null,
  ) {
    if (!canAdminMode || modeBusyRef.current || next === mode) return;
    modeFocusRef.current = trigger;
    if (next === "strict" || next === "off") {
      setPendingMode(next);
      return;
    }
    void applyMode(next).catch(() => undefined);
  }

  async function saveField(
    field: CustomField,
    input: { label: string; pii: boolean },
  ): Promise<CustomField | undefined> {
    if (!canEditFields) {
      throw new Error("Your current role cannot update custom fields.");
    }
    const operation = beginMutation("field");
    if (!operation) {
      throw new Error(
        "Another custom-field change is already in progress. Wait for it to finish and retry.",
      );
    }
    const intent = {
      id: field.id,
      label: input.label,
      config: {
        ...(field.config ? structuredClone(field.config) : {}),
        pii_flag: input.pii,
      },
    };
    try {
      await authorizeMutation(operation, "field");
      const { updateCustomField } = await customFieldsApi();
      const updated = await updateCustomField(
        intent.id,
        { label: intent.label, config: intent.config },
        operation.controller.signal,
      );
      return mutationIsCurrent(operation) ? updated : undefined;
    } catch (cause) {
      if (operation.controller.signal.aborted) return undefined;
      throw cause;
    } finally {
      finishMutation(operation.controller);
    }
  }

  if (meQuery.isPending) {
    return (
      <div className="max-w-4xl space-y-3" role="status">
        <span className="sr-only">Loading workspace identity…</span>
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (meQuery.isError) {
    return (
      <div className="max-w-4xl">
        <Card className="border-destructive/40" role="alert">
          <CardHeader>
            <CardTitle className="text-base text-destructive-emphasis">
              Workspace identity could not be loaded
            </CardTitle>
            <CardDescription>
              Custom-field reads and mutations are paused until the workspace
              context is verified.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 sm:min-h-9"
              onClick={() => void meQuery.refetch()}
            >
              Retry identity
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    // SETC-023: no local H1 — SettingsLayout already renders the tab title.
    <div className="max-w-4xl">
      <p className="text-muted-foreground text-sm mb-6">
        The schema layer for the data you store on subscribers. The validator
        mode below decides what happens when a write contains a key that
        isn&apos;t declared here.
      </p>

      {!canEditFields ? (
        <p className="mb-6 rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
          Custom fields are read-only for this session. Editor, admin, or owner
          access outside viewer mode is required to change them.
        </p>
      ) : canEditFields && !canAdminMode ? (
        <p className="mb-6 rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
          Editors can create, edit, and delete fields. Validator mode is an
          administrator-only workspace policy.
        </p>
      ) : null}

      <Card className="mb-8">
        <CardHeader>
          <CardTitle className="text-base">Validator mode</CardTitle>
          <CardDescription>
            What happens when a subscriber write contains an undeclared key.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading && mode === null ? (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : (
            <ValidatorModeRadioGroup
              current={mode}
              disabled={modeBusy || !canAdminMode}
              onSelect={requestMode}
            />
          )}
        </CardContent>
      </Card>

      <div className="mb-8">
        <CustomFieldLimitsCard
          identity={meQuery.isSuccess ? identity : null}
          queryBase={customFieldsBaseKey}
        />
      </div>

      <div className="mb-4 flex items-center justify-between gap-3">
        <h2
          ref={fieldsHeadingRef}
          tabIndex={-1}
          className="text-lg font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Declared fields
        </h2>
        <Button
          ref={createTriggerRef}
          type="button"
          variant={showNew ? "outline" : "default"}
          size="sm"
          className="min-h-11 sm:min-h-8"
          disabled={creating || !canEditFields}
          aria-expanded={showNew}
          aria-controls="new-custom-field"
          onClick={toggleCreate}
        >
          {showNew ? (
            "Cancel"
          ) : (
            <>
              <Plus aria-hidden="true" />
              Add field
            </>
          )}
        </Button>
      </div>

      {showNew && (
        <Card id="new-custom-field" className="mb-6">
          <CardContent className="pt-6">
            <form onSubmit={onCreate} className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="cf-key">Key</Label>
                  <Input
                    id="cf-key"
                    value={draftKey}
                    onChange={(e) => {
                      setDraftKey(e.target.value);
                      if (createError) setCreateError(null);
                    }}
                    disabled={creating}
                    autoFocus
                    maxLength={64}
                    aria-invalid={Boolean(createError)}
                    aria-describedby={createError ? createErrorId : undefined}
                    placeholder="loyalty_tier"
                    className="min-h-11 font-mono text-base sm:min-h-10 sm:text-sm"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cf-label">Label</Label>
                  <Input
                    id="cf-label"
                    value={draftLabel}
                    onChange={(e) => {
                      setDraftLabel(e.target.value);
                      if (createError) setCreateError(null);
                    }}
                    disabled={creating}
                    maxLength={200}
                    aria-invalid={Boolean(createError)}
                    aria-describedby={createError ? createErrorId : undefined}
                    placeholder="Loyalty tier"
                    className="min-h-11 text-base sm:min-h-10 sm:text-sm"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cf-type">Type</Label>
                  <select
                    id="cf-type"
                    value={draftType}
                    disabled={creating}
                    onChange={(e) => {
                      if (createError) setCreateError(null);
                      setDraftType(e.target.value as CustomField["type"]);
                    }}
                    className="min-h-11 w-full rounded-md border bg-background px-3 text-base sm:min-h-9 sm:text-sm"
                  >
                    <option value="string">string</option>
                    <option value="number">number</option>
                    <option value="boolean">boolean</option>
                    <option value="date">date</option>
                  </select>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cf-choices">
                  Allowed values (optional, comma-separated)
                </Label>
                <Input
                  id="cf-choices"
                  value={draftChoices}
                  onChange={(e) => {
                    setDraftChoices(e.target.value);
                    if (createError) setCreateError(null);
                  }}
                  disabled={creating}
                  placeholder="bronze, silver, gold"
                  className="min-h-11 text-base sm:min-h-10 sm:text-sm"
                />
              </div>
              <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md text-sm">
                <Checkbox
                  checked={draftPii}
                  disabled={creating}
                  onChange={(e) => setDraftPii(e.target.checked)}
                />
                Contains personal data (PII) — drives masking &amp; export
                policy
              </label>
              {/* SETC-052: required + default attributes. */}
              <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md text-sm">
                <Checkbox
                  checked={draftRequired}
                  disabled={creating}
                  onChange={(e) => setDraftRequired(e.target.checked)}
                />
                Required field
              </label>
              <div className="space-y-1">
                <Label htmlFor="cf-default" className="text-xs">
                  Default value (optional)
                </Label>
                <Input
                  id="cf-default"
                  value={draftDefault}
                  onChange={(e) => {
                    setDraftDefault(e.target.value);
                    if (createError) setCreateError(null);
                  }}
                  disabled={creating}
                  placeholder="e.g. bronze"
                  className="min-h-11 text-base sm:min-h-10 sm:text-sm"
                />
              </div>
              {createError ? (
                <p
                  ref={createErrorRef}
                  id={createErrorId}
                  role="alert"
                  tabIndex={-1}
                  className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {createError}
                </p>
              ) : null}
              <Button
                type="submit"
                size="sm"
                className="min-h-11 sm:min-h-8"
                loading={creating}
                aria-busy={creating}
              >
                {creating ? "Creating…" : "Create"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {loadError && (
        <Card className="mb-4 border-destructive/50" role="alert">
          <CardContent className="flex flex-col items-start gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-destructive-emphasis">{loadError}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-8"
              onClick={() => void customFieldsQuery.refetch()}
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {loading && !loadError && (
        <div className="border border-border rounded-md overflow-hidden">
          <div className="space-y-px p-1">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        </div>
      )}

      {!loading && !loadError && fields.length === 0 && (
        <EmptyState
          icon={Tags}
          title="No custom fields yet"
          description="Declare the keys you store on subscribers. With mode set to Auto-register, they also auto-create on first write."
        />
      )}

      {!loading && !loadError && fields.length > 0 && (
        <div
          role="region"
          aria-label="Custom fields"
          tabIndex={0}
          className="border border-border rounded-md overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <table className="w-full text-sm">
            <thead className="bg-card text-muted-foreground">
              <tr>
                <th scope="col" className="text-left px-4 py-2">
                  Key
                </th>
                <th scope="col" className="text-left px-4 py-2">
                  Label
                </th>
                <th scope="col" className="text-left px-4 py-2">
                  Type
                </th>
                <th scope="col" className="text-left px-4 py-2">
                  Fill rate
                  {totalSubscribers !== null ? (
                    <span className="ml-1 font-normal normal-case">
                      (of {totalSubscribers.toLocaleString()})
                    </span>
                  ) : null}
                </th>
                <th scope="col" className="text-right px-4 py-2">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {fields.map((f) => (
                <tr key={f.id} className="border-t border-border">
                  <td className="px-4 py-2 font-mono text-xs">{f.key}</td>
                  <td className="px-4 py-2">
                    <span className="inline-flex items-center gap-2">
                      {f.label}
                      {f.config?.pii_flag ? (
                        <Badge variant="outline" className="text-[10px]">
                          PII
                        </Badge>
                      ) : null}
                      {f.config?.required ? (
                        <Badge variant="outline" className="text-[10px]">
                          Required
                        </Badge>
                      ) : null}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">{f.type}</td>
                  <td className="px-4 py-2">
                    {(() => {
                      const usage = fillByKey.get(f.key);
                      if (usageQuery.isPending) {
                        return <span className="text-muted-foreground">…</span>;
                      }
                      // A failed usage call used to render the same "—" as a
                      // field no subscriber has filled, so an unreachable
                      // endpoint looked like a registry of unused fields.
                      if (usageQuery.isError && !usage) {
                        return (
                          <span
                            className="text-xs text-destructive-emphasis"
                            title="The fill-rate lookup failed; these fields may well be populated."
                          >
                            Could not load
                          </span>
                        );
                      }
                      if (!usage) {
                        return <span className="text-muted-foreground">—</span>;
                      }
                      const pct = Math.round(usage.rate * 100);
                      return (
                        <span className="inline-flex items-center gap-2">
                          <span
                            className="h-1.5 w-16 rounded-full bg-muted overflow-hidden"
                            aria-hidden
                          >
                            <span
                              className="block h-full bg-primary"
                              style={{ width: `${pct}%` }}
                            />
                          </span>
                          <span
                            className="tabular-nums text-xs text-muted-foreground"
                            title={`${usage.filled.toLocaleString()} subscribers`}
                          >
                            {pct}%
                          </span>
                        </span>
                      );
                    })()}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="min-h-11 sm:min-h-7"
                      disabled={!canEditFields}
                      onClick={(event) => {
                        editReturnFocusRef.current = event.currentTarget;
                        setEditing(f);
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="min-h-11 text-destructive-emphasis hover:text-destructive-emphasis sm:min-h-7"
                      disabled={!canEditFields}
                      onClick={(event) => {
                        deleteFocusRef.current = event.currentTarget;
                        setDeleting(f);
                      }}
                    >
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete custom field?"
        description={
          <DeleteFieldDescription
            field={deleting}
            references={referencesQuery.data ?? null}
            loading={referencesQuery.isPending}
            error={referencesQuery.isError}
          />
        }
        confirmLabel="Delete"
        confirmVariant="destructive"
        fallbackFocusRef={deleteFocusRef}
        onConfirm={() => (deleting ? onDelete(deleting.id) : Promise.resolve())}
      />

      <ConfirmDialog
        open={pendingMode !== null}
        onOpenChange={(open) => {
          if (!open) setPendingMode(null);
        }}
        title={`Switch validator mode to ${pendingMode ?? ""}?`}
        description={pendingMode ? MODE_CONSEQUENCE[pendingMode] : ""}
        confirmLabel="Switch mode"
        confirmVariant={pendingMode === "off" ? "destructive" : "default"}
        fallbackFocusRef={modeFocusRef}
        onConfirm={() =>
          pendingMode ? applyMode(pendingMode) : Promise.resolve()
        }
      />

      <EditFieldDialog
        // Remount per field so the dialog's form state is seeded from props
        // rather than adjusted in-place during render.
        key={`${authorityKey}:${editing?.id ?? "none"}`}
        field={editing}
        canWrite={canEditFields}
        onSave={saveField}
        returnFocusRef={editReturnFocusRef}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        onSaved={(updated) => {
          queryClient.setQueryData<CustomFieldsSettingsData>(
            customFieldsKey,
            (cur) =>
              cur
                ? {
                    ...cur,
                    fields: cur.fields.map((field) =>
                      field.id === updated.id ? updated : field,
                    ),
                  }
                : cur,
          );
          setEditing(null);
          void invalidateCustomFields();
        }}
      />
    </div>
  );
}

// SETC-047: a real radiogroup (role=radiogroup + role=radio children with
// arrow-key navigation), not three independent aria-pressed toggle buttons.
function ValidatorModeRadioGroup({
  current,
  disabled,
  onSelect,
}: {
  current: CustomFieldsValidatorMode | null;
  disabled: boolean;
  onSelect: (
    mode: CustomFieldsValidatorMode,
    trigger: HTMLElement | null,
  ) => void;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  function move(delta: number, fromIndex: number) {
    const next = (fromIndex + delta + MODES.length) % MODES.length;
    refs.current[next]?.focus();
    onSelect(MODES[next].mode, refs.current[next]);
  }

  return (
    <div role="radiogroup" aria-label="Validator mode" className="space-y-2">
      {MODES.map((option, index) => {
        const isActive = current === option.mode;
        return (
          <button
            key={option.mode}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            disabled={disabled}
            role="radio"
            aria-checked={isActive}
            tabIndex={isActive || (current === null && index === 0) ? 0 : -1}
            onClick={(event) => onSelect(option.mode, event.currentTarget)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowRight") {
                e.preventDefault();
                move(1, index);
              } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
                e.preventDefault();
                move(-1, index);
              }
            }}
            className={`w-full text-left p-3 rounded border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
              isActive
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/50"
            }`}
          >
            <div className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={`w-3 h-3 rounded-full ${
                  isActive ? "bg-primary" : "border border-border"
                }`}
              />
              <span className="font-medium text-sm">{option.label}</span>
              <span className="ml-auto text-xs text-muted-foreground font-mono">
                {option.mode}
              </span>
            </div>
            <div className="text-xs text-muted-foreground mt-1 ml-5">
              {option.blurb}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// SETC-042: edit a field's label + PII flag in place (key + type immutable).
function EditFieldDialog({
  field,
  canWrite,
  onSave,
  returnFocusRef,
  onOpenChange,
  onSaved,
}: {
  field: CustomField | null;
  canWrite: boolean;
  onSave: (
    field: CustomField,
    input: { label: string; pii: boolean },
  ) => Promise<CustomField | undefined>;
  returnFocusRef: React.RefObject<HTMLElement | null>;
  onOpenChange: (open: boolean) => void;
  onSaved: (updated: CustomField) => void;
}) {
  // Seeded from props via the initializer — the caller remounts this per field
  // (see the `key` on <EditFieldDialog>), which is React's own answer to
  // "reset all state when a prop changes".
  //
  // This previously mutated a ref DURING RENDER to decide whether to re-seed.
  // React forbids reading or writing refs while rendering: a render can be
  // discarded and retried, and the ref mutation survives, so the retry would
  // skip the seeding and leave the PREVIOUS field's label in state — which
  // save() then writes onto the newly-opened field.
  const [label, setLabel] = useState(field?.label ?? "");
  const [pii, setPii] = useState(Boolean(field?.config?.pii_flag));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const errorId = useId();
  const unchanged =
    label.trim() === (field?.label ?? "") &&
    pii === Boolean(field?.config?.pii_flag);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  async function save() {
    if (!field || savingRef.current) return;
    if (!canWrite) {
      setError("Your current role cannot update custom fields.");
      return;
    }
    const trimmed = label.trim();
    if (!trimmed) {
      setError("Enter a label for this field.");
      return;
    }
    if (unchanged) {
      setError("Nothing changed. Update the label or PII setting first.");
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const updated = await onSave(field, { label: trimmed, pii });
      if (!updated) return;
      toast.success("Custom field updated.");
      onSaved(updated);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The custom field could not be updated.",
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function requestClose(): void {
    if (savingRef.current || saving) return;
    onOpenChange(false);
  }

  return (
    <Dialog
      open={field !== null}
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
    >
      <DialogContent
        aria-busy={saving}
        closeDisabled={saving}
        className="[&_button]:min-h-11 [&_input]:min-h-11 [&_input]:text-base sm:[&_button]:min-h-0 sm:[&_input]:min-h-0 sm:[&_input]:text-sm"
        onEscapeKeyDown={(event) => {
          if (savingRef.current) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (savingRef.current) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          const target = returnFocusRef.current;
          if (!target?.isConnected) return;
          event.preventDefault();
          target.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Edit custom field</DialogTitle>
          <DialogDescription>
            The key (<code className="text-xs">{field?.key}</code>) and type are
            immutable — changing them would orphan stored subscriber values.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="edit-label">Label</Label>
            <Input
              id="edit-label"
              value={label}
              onChange={(e) => {
                setLabel(e.target.value);
                if (error) setError(null);
              }}
              disabled={saving || !canWrite}
              autoFocus
              maxLength={200}
              aria-invalid={Boolean(error && !label.trim())}
              aria-describedby={error ? errorId : undefined}
            />
          </div>
          <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 text-sm has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60">
            <Checkbox
              checked={pii}
              disabled={saving || !canWrite}
              onChange={(e) => {
                setPii(e.target.checked);
                if (error) setError(null);
              }}
            />
            Contains personal data (PII)
          </label>
          {error ? (
            <p
              ref={errorRef}
              id={errorId}
              role="alert"
              tabIndex={-1}
              className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {error}
            </p>
          ) : unchanged ? (
            <p role="status" className="text-sm text-muted-foreground">
              Change the label or PII setting to enable saving.
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={requestClose}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              loading={saving}
              disabled={saving || unchanged || !canWrite}
            >
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
